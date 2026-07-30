// ridges.js — Mountain ridge networks (geometry phase)
//
// Single global space colonization across all orogen land. One seed per
// anchor; all seeds share ONE pool of attractors (no per-anchor ownership).
//
// Intertwining mechanism: 2D JITTERED GRID SCATTER over the orogen+basin band.
// Anchors are placed by walking a regular grid (cell = `spacing`) and jittering
// each cell's anchor by `±jitter × cellSize / 2`. Anchors that fall outside the
// band, in ocean, or on a force-stamped perimeter segment are dropped. A small
// padding distance (cell × 0.4) ensures anchors don't co-locate at high jitter.
// Many small networks densely packed → visual interlocking by population, not
// by per-network reach.
//
// Cross-anchor avoidance: branches steer away from foreign-network nodes
// within stepSize × 4 radius (1/d² falloff, weight 0.5). Anticipates other
// networks instead of only reacting via the binary collision check.
//
// Edge midpoint check: when committing a new node, sample two points along
// the proposed parent→new edge (40% and 70%) and reject if either lands
// within stepSize × 0.4 of any non-parent node. Catches branch crossings.
//
// Attractors confined to the orogen+basin band (with a small platform feather)
// of the nearest active OR fossil boundary. Land-only by construction —
// anchors near coast just get fewer attractors and grow smaller networks.
//
// Output: per-anchor list of polylines (chains of {x, z, flowFrac}).
// flowFrac = relative descendant count (trunks ~1.0, leaf branches ~0.2).
//
// Algorithm based on Addons/Ridges/src/RidgeFactory.cs (space colonization)
// adapted for tiled-along-tectonic-line use case.

window.VIS = window.VIS || {};

(function (V) {

  // Per-network colour. Golden-angle hue rotation + hash for spread.
  function networkColor(idx) {
    const h = (idx * 137.508) % 360;
    return _hslToRgb(h, 65, 55);
  }

  function _hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  }

  class RidgeNetworks {
    constructor(opts, tectonic, continent) {
      this.mapW = opts.mapW;
      this.mapH = opts.mapH;
      this.worldSeed = opts.seed | 0;
      this.tectonic = tectonic;
      this.continent = continent;

      // Grid cell size for anchor scatter (pixels). Smaller = more anchors,
      // smaller per-network spread (since maxSpread auto-derives from spacing).
      this.spacing = opts.spacing ?? 60;

      // Per-cell jitter, fraction of cell size. 0 = perfectly regular grid,
      // 1 = anchor can land anywhere within ±half-cell of the cell centre.
      // High jitter + the min-distance padding causes some anchors to drop;
      // visual density falls slightly with jitter.
      this.jitter = opts.jitter ?? 0.7;

      // Platform feather: fraction of platform width allowed as the soft outer
      // edge of the attractor band. 0.15 = ridges fade ~15% into platform.
      this.platformFeather = opts.platformFeather ?? 0.15;

      // Attractor sampling step (pixels).
      this.attractorGridStep = opts.attractorGridStep ?? 5;

      // Algorithm constants.
      this.seedCount = opts.seedCount ?? 1;             // one trunk root per anchor
      this.stepSize = opts.stepSize ?? 3;
      this.killDist = opts.killDist ?? 5;
      this.influenceR = opts.influenceR ?? 22;
      this.maxIter = opts.maxIter ?? 80;
      this.wobble = opts.wobble ?? 0.4;
      this.outwardBias = opts.outwardBias ?? 0.5;
      this.coherenceThreshold = opts.coherenceThreshold ?? 0.7;
      this.coherenceKickInSteps = opts.coherenceKickInSteps ?? 1;
      this.antiReversalDot = opts.antiReversalDot ?? 0.3;
      this.minBranch = opts.minBranch ?? 4;
      // maxSpread auto-derived from spacing × 0.8, then scaled by the user's
      // `spread` slider (0.5 = half, 1.0 = current default, 2.0 = double).
      // Anchor density is unchanged; this only controls how far each network
      // grows from its seed before constraints stop it. Spread > 1 lets
      // networks reach across more of the band; spread < 1 keeps them tight
      // around their seed.
      this.spreadMul = opts.spread ?? 1.0;
      this.maxSpread = (opts.maxSpread ?? this.spacing * 0.8) * this.spreadMul;
      // Shape variation: per-anchor random aspect ratio applied as elliptical
      // maxSpread. 0 = all networks circular. 0.4 = moderate variety. 1 =
      // strong elongation (long axis up to 1.5×, short axis down to 0.5×).
      this.shapeVariation = opts.shapeVariation ?? 0.4;
      this.chainSmoothPasses = opts.chainSmoothPasses ?? 3;
      this.separationStrength = opts.separationStrength ?? 0.6;
      // Cross-anchor avoidance: branches steer away from foreign-network nodes
      // within this radius. Same shape as same-network separation, applied to
      // foreign nodes only. Lets branches anticipate other networks gracefully
      // instead of only reacting via the binary collision check.
      this.crossAnchorRadius = opts.crossAnchorRadius ?? this.stepSize * 4;
      this.crossAnchorWeight = opts.crossAnchorWeight ?? 0.5;
      // Edge midpoint overlap check: when committing a new node, sample two
      // points along the proposed parent→new edge (at 40% and 70%) and reject
      // if either is within edgeOverlapDist of any non-parent node. Catches
      // branch crossings that the point-only collision check misses.
      this.edgeOverlapDist = opts.edgeOverlapDist ?? this.stepSize * 0.4;

      this.anchors = [];
      this.networks = [];
      this._attractors = [];
      this._nodes = [];

      // Per-pixel scaling for band widths (mirrors upheaval / provinces).
      this._mapScale = V.phiScale(Math.max(this.mapW, this.mapH));
      this._activity = 1.0; // Tectonic Activity dropped

      this._placeAnchors();
      this._buildAnchorIndex();
      if (this.anchors.length === 0) return;

      this._initSeedNodes();
      this._buildNodeIndex();
      this._placeAttractors();
      this._growUnified();
      this._extractNetworks();
    }

    // === Anchor placement ===
    // Walk each tectonic segment's polyline at intervals of `spacing` blocks
    // of arc-length. At each along-line position, place anchors in PARALLEL
    // ROWS perpendicular to the segment tangent: row 0 sits on the line,
    // rows ±1, ±2, ... are offset by `spacing × row` perpendicular to it.
    // Rows continue outward until they fall outside the orogen+basin+
    // platformFeather band — `_isInBand` filters those out. With jitter > 0,
    // each anchor is jittered by ±half-cell so rows still fill gaps as the
    // jitter rises (vs the old line-only behaviour where seeds bunched on the
    // tectonic line). ALL anchors are kept (including ocean) and tagged with
    // `inOcean`. Ocean anchors are visible in the primitive view as faded
    // dots but seed no networks. Active vs fossil tag taken from the
    // segment. Min-distance padding (0.4 × cellSize) dedupes anchors at
    // junctions where multiple segments converge from different directions.
    _placeAnchors() {
      const { tectonic, continent } = this;
      const lg = continent.landGrid;
      if (!lg) return;
      const segs = tectonic.lines.segments;
      if (!segs) return;

      const cellSize = this.spacing;
      // Global min-distance for anchor dedupe. Kept SMALL (a few stepSizes)
      // so perpendicular rows in narrow bands can coexist instead of being
      // killed by the spacing-derived dedupe distance. Junctions may show
      // slight clustering but it's bounded by stepSize.
      const minDist = Math.max(2, this.stepSize * 1.5);
      const minDistSq = minDist * minDist;
      const kept = [];

      // Polyline tangent at arcParam — small forward/backward sample.
      const computeTangent = (poly, arcParam) => {
        const eps = 0.02;
        const ap = Math.max(0, arcParam - eps);
        const an = Math.min(1, arcParam + eps);
        if (an - ap < 0.001) return { x: 1, z: 0 };
        const before = tectonic.lines._polylinePosition(poly, ap);
        const after  = tectonic.lines._polylinePosition(poly, an);
        let tx = after.x - before.x;
        let tz = after.z - before.z;
        const tlen = Math.sqrt(tx * tx + tz * tz);
        if (tlen < 0.001) return { x: 1, z: 0 };
        return { x: tx / tlen, z: tz / tlen };
      };

      for (let segIdx = 0; segIdx < segs.length; segIdx++) {
        const seg = segs[segIdx];
        if (!seg || !seg.polyline || seg.onPerimeter) continue;
        const poly = seg.polyline;
        if (!poly.x || poly.x.length === 0) continue;

        const numAlong = poly.length > 0
          ? Math.max(1, Math.floor(poly.length / cellSize))
          : 1;
        const isActive = !!seg.isActive;

        for (let i = 0; i < numAlong; i++) {
          const arcParam = (i + 0.5) / numAlong;
          const pos = tectonic.lines._polylinePosition(poly, arcParam);
          const tangent = computeTangent(poly, arcParam);
          // Perpendicular = tangent rotated 90° CCW. Sign convention is
          // arbitrary — rows extend symmetrically on both sides, so flipping
          // perp doesn't change the set of anchors produced.
          const perpX = -tangent.z;
          const perpZ = tangent.x;

          // Band width perpendicular to the line at this point.
          const maxOffset = this._bandReachAt(pos.x, pos.z, isActive);
          // Always at least 1 row on each side (3 rows total). Scale up if
          // cellSize fits in the band width so wider bands get more rows.
          const numRowsPerSide = Math.max(1, Math.floor(maxOffset / cellSize));
          // Perpendicular spacing fits the rows inside the band edges. The
          // (numRowsPerSide + 0.5) divisor leaves a half-cell margin so the
          // outermost rows don't sit exactly on the band edge (where _isInBand
          // would reject them after any jitter).
          const perpSpacing = maxOffset / (numRowsPerSide + 0.5);

          // Iterate symmetric rows. Row 0 sits on the line; ±1, ±2, ... step
          // perpendicular by perpSpacing. Rows pushed outside the band by
          // jitter still get filtered by `_isInBand` below.
          for (let row = -numRowsPerSide; row <= numRowsPerSide; row++) {
            const offsetDist = row * perpSpacing;
            const baseX = pos.x + perpX * offsetDist;
            const baseZ = pos.z + perpZ * offsetDist;

            const aSeed = (this.worldSeed
              ^ Math.imul(segIdx + 1, 0x9E3779B9)
              ^ Math.imul(i + 1, 0xB7E15163)
              ^ Math.imul(row + 100, 0x85EBCA6B)) | 0;
            const jx = (V.hash2d(segIdx, i, aSeed) - 0.5) * this.jitter * cellSize;
            const jz = (V.hash2d(segIdx, i, aSeed ^ 0x12345678) - 0.5) * this.jitter * cellSize;

            const ax = baseX + jx;
            const az = baseZ + jz;
            const ix = ax | 0;
            const iz = az | 0;

            if (ix < 0 || iz < 0 || ix >= this.mapW || iz >= this.mapH) continue;
            // Drop anchors pushed outside the orogen+basin+platformFeather band.
            if (!this._isInBand(ax, az)) continue;

            // Tag (don't filter): is this anchor in unwarped ocean?
            const inOcean = lg[iz * this.mapW + ix] !== 1;

            // Min-distance enforcement — handles junctions where multiple
            // segments converge with different perpendicular directions.
            let tooClose = false;
            for (let j = 0; j < kept.length; j += 2) {
              const dx = ax - kept[j], dz = az - kept[j + 1];
              if (dx * dx + dz * dz < minDistSq) { tooClose = true; break; }
            }
            if (tooClose) continue;

            const idx = this.anchors.length;

            const aspectAngle = V.hash2d(idx, 0, aSeed ^ 0xACE0) * Math.PI;
            const aspectAxisX = Math.cos(aspectAngle);
            const aspectAxisZ = Math.sin(aspectAngle);
            const aspectStrength = V.hash2d(idx, 1, aSeed ^ 0xACE0) * this.shapeVariation;
            const longRadius  = this.maxSpread * (1 + aspectStrength * 0.5);
            const shortRadius = this.maxSpread * (1 - aspectStrength * 0.5);

            this.anchors.push({
              x: ax, z: az, index: idx,
              boundaryX: pos.x, boundaryZ: pos.z,
              seed: aSeed,
              isActive,
              inOcean,
              segmentId: segIdx,
              arcParam,
              row,
              color: networkColor(idx),
              aspectAxisX, aspectAxisZ,
              aspectStrength,
              longRadiusSq: longRadius * longRadius,
              shortRadiusSq: shortRadius * shortRadius,
            });
            kept.push(ax, az);
          }
        }
      }
    }

    _buildAnchorIndex() {
      const cs = this.spacing * 1.5;
      this._aCellSize = cs;
      this._aGridCols = Math.ceil(this.mapW / cs) + 4;
      this._aGridRows = Math.ceil(this.mapH / cs) + 4;
      this._aGridOff = 2;
      const len = this._aGridCols * this._aGridRows;
      this._aGrid = new Array(len);
      for (let i = 0; i < len; i++) this._aGrid[i] = [];
      for (const a of this.anchors) {
        const gcx = Math.floor(a.x / cs) + this._aGridOff;
        const gcz = Math.floor(a.z / cs) + this._aGridOff;
        if (gcx >= 0 && gcx < this._aGridCols && gcz >= 0 && gcz < this._aGridRows) {
          this._aGrid[gcz * this._aGridCols + gcx].push(a.index);
        }
      }
    }

    _isLand(x, z) {
      const ix = x | 0, iz = z | 0;
      if (ix < 0 || iz < 0 || ix >= this.mapW || iz >= this.mapH) return false;
      // Ridges are primitives — read the unwarped structural land grid. The
      // warp is a detail-layer concern and shouldn't gate primitive placement.
      const lg = this.continent.landGrid;
      return lg[iz * this.mapW + ix] === 1;
    }

    // Width-aware band reach at (x, z). Returns the maximum chamfer distance
    // (to active OR fossil boundary) that still counts as "in the ridge band."
    // Per-pixel widthMul makes ridges automatically denser in wide orogen
    // sections — width-responsive for free.
    _bandReachAt(x, z, isActiveBoundary) {
      const tec = this.tectonic;
      const widthMul = tec.lines.getProvinceWidthMultiplier(x, z);
      // widthMul scales only the orogen part of the stack; basin and platform
      // are fixed offsets — same convention provinces and upheaval use, so
      // ridge band-reach stays consistent with the visible band shapes.
      const orogenW = isActiveBoundary ? tec.orogenW : tec.fossilW;
      const basinW  = isActiveBoundary ? tec.basinW  : tec.fossilBasinW;
      const platfW  = isActiveBoundary ? tec.platformW : tec.fossilPlatformW;
      const stack = orogenW * widthMul + basinW + platfW * this.platformFeather;
      return stack * this._mapScale * this._activity;
    }

    // True if (x, z) is in the orogen+basin+platform-feather band of the
    // nearest active OR fossil boundary. This restricts attractors to the
    // "mountain zone" — never out in the platform/shield interior.
    _isInBand(x, z) {
      const ix = x | 0, iz = z | 0;
      if (ix < 0 || iz < 0 || ix >= this.mapW || iz >= this.mapH) return false;
      const bd = this.tectonic.lines.getBoundaryDistancesAt(x, z);
      if (bd.active < this._bandReachAt(x, z, true)) return true;
      if (bd.fossil < this._bandReachAt(x, z, false)) return true;
      return false;
    }

    // === Attractor placement ===
    // Regular grid covering the map. Each grid point: must be on land, must
    // be in the orogen+basin+platform-feather band. All attractors are SHARED
    // by construction (no per-anchor ownership, no deflectors) — the racing
    // dynamic during growth assigns them implicitly to whichever anchor's
    // branch reaches them first. Intertwining comes from the perpendicular
    // anchor offset, not from attractor ownership tricks.
    _placeAttractors() {
      const step = this.attractorGridStep;
      const rand = V.makePRNG(this.worldSeed ^ 0x12345678);
      for (let z = 0; z < this.mapH; z += step) {
        for (let x = 0; x < this.mapW; x += step) {
          const jx = (rand() - 0.5) * step * 0.5;
          const jz = (rand() - 0.5) * step * 0.5;
          const px = x + jx;
          const pz = z + jz;
          if (!this._isLand(px, pz)) continue;
          if (!this._isInBand(px, pz)) continue;
          this._attractors.push({ x: px, z: pz, alive: true });
        }
      }
    }

    // === Seed nodes ===
    // One node per anchor — including ocean anchors. Networks may grow into
    // adjacent land even from ocean seeds (growth's land/band check controls
    // where branches can extend). The detailed view's renderer clips polyline
    // segments per the warped silhouette, so an ocean-seeded network that
    // reaches into warped land remains visible there; the parts over warped
    // ocean are hidden. Primitive view shows all networks unclipped.
    _initSeedNodes() {
      for (const anchor of this.anchors) {
        this._nodes.push({
          x: anchor.x, z: anchor.z, parent: -1, dirX: 0, dirZ: 0,
          anchorIdx: anchor.index, alive: true,
        });
      }
    }

    // === Node spatial index ===
    // Bucket grid for fast attractor → nearest-node-of-owner lookups.
    // Updated incrementally as new nodes spawn each iteration.
    _buildNodeIndex() {
      const cs = Math.max(8, this.influenceR);
      this._nCellSize = cs;
      this._nGridCols = Math.ceil(this.mapW / cs) + 4;
      this._nGridRows = Math.ceil(this.mapH / cs) + 4;
      this._nGridOff = 2;
      const len = this._nGridCols * this._nGridRows;
      this._nGrid = new Array(len);
      for (let i = 0; i < len; i++) this._nGrid[i] = [];
      for (let i = 0; i < this._nodes.length; i++) this._addNodeToIndex(i);
    }

    _addNodeToIndex(nodeIdx) {
      const n = this._nodes[nodeIdx];
      const cs = this._nCellSize;
      const gcx = Math.floor(n.x / cs) + this._nGridOff;
      const gcz = Math.floor(n.z / cs) + this._nGridOff;
      if (gcx < 0 || gcx >= this._nGridCols || gcz < 0 || gcz >= this._nGridRows) return;
      this._nGrid[gcz * this._nGridCols + gcx].push(nodeIdx);
    }

    // Find nearest alive node to (x, z), optionally restricted to a specific
    // anchorIdx. Returns the node index, or -1 if none in range. Squared
    // distance returned in `out` for the caller to use.
    _nearestNode(x, z, requireAnchorIdx, out) {
      const cs = this._nCellSize;
      const gcx = Math.floor(x / cs) + this._nGridOff;
      const gcz = Math.floor(z / cs) + this._nGridOff;
      let bestIdx = -1, bestDsq = Infinity;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ci = gcz + dz, cj = gcx + dx;
          if (ci < 0 || ci >= this._nGridRows || cj < 0 || cj >= this._nGridCols) continue;
          const bucket = this._nGrid[ci * this._nGridCols + cj];
          for (let k = 0; k < bucket.length; k++) {
            const ni = bucket[k];
            const n = this._nodes[ni];
            if (!n.alive) continue;
            if (requireAnchorIdx >= 0 && n.anchorIdx !== requireAnchorIdx) continue;
            const ddx = x - n.x, ddz = z - n.z;
            const dsq = ddx * ddx + ddz * ddz;
            if (dsq < bestDsq) { bestDsq = dsq; bestIdx = ni; }
          }
        }
      }
      out.dsq = bestDsq;
      return bestIdx;
    }

    // === Unified growth loop ===
    // All anchors grow simultaneously each iteration. Attractors pull the
    // nearest node OF ANY ANCHOR (shared resource — branches race for them).
    // Per-node growth applies the standard constraints (anti-reversal, max
    // spread, coherence, land, band, collision, edge midpoint, loop reject).
    // Cross-anchor avoidance shapes growth direction so branches anticipate
    // foreign networks before colliding.
    _growUnified() {
      const killDistSq = this.killDist * this.killDist;
      const influenceRSq = this.influenceR * this.influenceR;
      const stepSize = this.stepSize;
      const out = { dsq: 0 };
      const rand = V.makePRNG(this.worldSeed ^ 0xDEADBEEF);

      for (let iter = 0; iter < this.maxIter; iter++) {
        const influence = new Map();
        let anyAlive = false;

        for (let ai = 0; ai < this._attractors.length; ai++) {
          const a = this._attractors[ai];
          if (!a.alive) continue;

          // Always look up the nearest node of ANY anchor (shared resource).
          const ni = this._nearestNode(a.x, a.z, -1, out);
          if (ni < 0 || out.dsq > influenceRSq) continue;

          // Shared attractors only — pull the nearest node toward the
          // attractor. Whoever gets close enough first consumes it. Branches
          // from different anchors race for boundary attractors. Cross-anchor
          // separation in the growth direction calc handles the don't-collide
          // dynamic; no deflectors needed.
          anyAlive = true;
          if (out.dsq < killDistSq) { a.alive = false; continue; }
          const node = this._nodes[ni];
          const adx = a.x - node.x, adz = a.z - node.z;
          const len = Math.sqrt(out.dsq);
          if (len < 0.001) continue;
          const inf = influence.get(ni) || { dx: 0, dz: 0, count: 0 };
          inf.dx += adx / len; inf.dz += adz / len; inf.count++;
          influence.set(ni, inf);
        }

        if (!anyAlive) break;

        const newNodes = [];
        for (const [ni, inf] of influence) {
          if (inf.count === 0) continue;
          const n = this._nodes[ni];
          const anchor = this.anchors[n.anchorIdx];

          let dx = inf.dx / inf.count;
          let dz = inf.dz / inf.count;

          // Outward bias (away from anchor — the trunk root).
          const fromRX = n.x - anchor.x;
          const fromRZ = n.z - anchor.z;
          const fromRLen = Math.sqrt(fromRX * fromRX + fromRZ * fromRZ);
          if (fromRLen > 0.01 && this.outwardBias > 0) {
            dx += (fromRX / fromRLen) * this.outwardBias;
            dz += (fromRZ / fromRLen) * this.outwardBias;
          }

          // Same-anchor separation: push away from sibling nodes (within own
          // network). Cross-anchor avoidance: push away from foreign-network
          // nodes within a wider radius. Both share the 1/d² falloff shape
          // and are scanned together in one pass over local node buckets.
          let sepX = 0, sepZ = 0;
          let foreignX = 0, foreignZ = 0;
          const sepR = stepSize * 2.5;
          const sepRSq = sepR * sepR;
          const xR = this.crossAnchorRadius;
          const xRSq = xR * xR;
          const cs = this._nCellSize;
          const gcx = Math.floor(n.x / cs) + this._nGridOff;
          const gcz = Math.floor(n.z / cs) + this._nGridOff;
          for (let bz = -1; bz <= 1; bz++) {
            for (let bx = -1; bx <= 1; bx++) {
              const ci = gcz + bz, cj = gcx + bx;
              if (ci < 0 || ci >= this._nGridRows || cj < 0 || cj >= this._nGridCols) continue;
              const bucket = this._nGrid[ci * this._nGridCols + cj];
              for (let k = 0; k < bucket.length; k++) {
                const j = bucket[k];
                if (j === ni) continue;
                const m = this._nodes[j];
                if (!m.alive) continue;
                const ddx = n.x - m.x, ddz = n.z - m.z;
                const dsq = ddx * ddx + ddz * ddz;
                if (dsq < 0.01) continue;
                if (m.anchorIdx === n.anchorIdx) {
                  // Same network — only sibling-separation force, ignore parent/child.
                  if (m.parent === ni || n.parent === j) continue;
                  if (dsq < sepRSq) {
                    const d = Math.sqrt(dsq);
                    sepX += (ddx / d) * (1 - d / sepR);
                    sepZ += (ddz / d) * (1 - d / sepR);
                  }
                } else {
                  // Foreign network — cross-anchor avoidance, wider radius.
                  if (dsq < xRSq) {
                    const d = Math.sqrt(dsq);
                    foreignX += (ddx / d) * (1 - d / xR);
                    foreignZ += (ddz / d) * (1 - d / xR);
                  }
                }
              }
            }
          }
          dx += sepX * this.separationStrength;
          dz += sepZ * this.separationStrength;
          dx += foreignX * this.crossAnchorWeight;
          dz += foreignZ * this.crossAnchorWeight;

          // Wobble.
          dx += (rand() * 2 - 1) * this.wobble;
          dz += (rand() * 2 - 1) * this.wobble;

          // Normalise.
          const nlen = Math.sqrt(dx * dx + dz * dz);
          if (nlen < 0.001) continue;
          const ndx = dx / nlen, ndz = dz / nlen;

          // Anti-reversal.
          if (n.parent >= 0) {
            const inLen = Math.sqrt(n.dirX * n.dirX + n.dirZ * n.dirZ);
            if (inLen > 0.01) {
              if ((n.dirX / inLen) * ndx + (n.dirZ / inLen) * ndz < this.antiReversalDot) continue;
            }
          }

          // Elliptical max spread from anchor. Project node-from-anchor onto
          // the anchor's aspect axis (along) and its perpendicular (perp).
          // Reject if the point falls outside the anchor's ellipse:
          //   (along/longRadius)² + (perp/shortRadius)² > 1
          // Anchors with low aspectStrength have nearly equal radii (round
          // network); high aspectStrength produces elongated ovals.
          const toRX = n.x - anchor.x, toRZ = n.z - anchor.z;
          const along = toRX * anchor.aspectAxisX + toRZ * anchor.aspectAxisZ;
          const perp  = -toRX * anchor.aspectAxisZ + toRZ * anchor.aspectAxisX;
          const ellipseRatio = (along * along) / anchor.longRadiusSq
                             + (perp  * perp ) / anchor.shortRadiusSq;
          if (ellipseRatio > 1) continue;

          // Coherence — must grow outward from anchor (uses circular distance).
          const toRLenSq = toRX * toRX + toRZ * toRZ;
          const kickInDist = stepSize * this.coherenceKickInSteps;
          if (this.coherenceThreshold > 0 && toRLenSq > kickInDist * kickInDist) {
            const toRLen = Math.sqrt(toRLenSq);
            const coherence = (toRX / toRLen) * ndx + (toRZ / toRLen) * ndz;
            if (coherence < this.coherenceThreshold * 2 - 1) continue;
          }

          // Step.
          const nx = n.x + ndx * stepSize;
          const nz = n.z + ndz * stepSize;

          // Land check.
          if (!this._isLand(nx, nz)) continue;
          // Band check — branches stay in the orogen+basin+feather zone.
          if (!this._isInBand(nx, nz)) continue;

          // Collision against ANY alive node (cross-anchor too — this is the
          // structural "no overlap" enforcement).
          let blocked = false;
          const halfStepSq = (stepSize * 0.5) * (stepSize * 0.5);
          for (let bz = -1; bz <= 1; bz++) {
            if (blocked) break;
            for (let bx = -1; bx <= 1; bx++) {
              const ci = gcz + bz, cj = gcx + bx;
              if (ci < 0 || ci >= this._nGridRows || cj < 0 || cj >= this._nGridCols) continue;
              const bucket = this._nGrid[ci * this._nGridCols + cj];
              for (let k = 0; k < bucket.length; k++) {
                const j = bucket[k];
                if (j === ni) continue;
                const m = this._nodes[j];
                if (!m.alive) continue;
                const ddx = nx - m.x, ddz = nz - m.z;
                const dsq = ddx * ddx + ddz * ddz;
                if (dsq < halfStepSq) { blocked = true; break; }
              }
              if (blocked) break;
            }
          }
          if (blocked) continue;

          // Same-chain ancestor proximity reject — catches self-loops where a
          // branch curves back near its own past path. Walk parent links 3+
          // steps back; reject if the new vertex would land within stepSize×1.5
          // of any of those ancestors. Skipping the immediate ancestors (they're
          // naturally close by definition).
          const loopThresholdSq = (stepSize * 1.5) * (stepSize * 1.5);
          let ancestorIdx = n.parent;
          let depth = 1;
          let loopBlocked = false;
          while (ancestorIdx >= 0 && depth <= 10) {
            if (depth >= 3) {
              const an = this._nodes[ancestorIdx];
              const ddx = nx - an.x, ddz = nz - an.z;
              if (ddx * ddx + ddz * ddz < loopThresholdSq) { loopBlocked = true; break; }
            }
            ancestorIdx = this._nodes[ancestorIdx].parent;
            depth++;
          }
          if (loopBlocked) continue;

          // Edge midpoint overlap check — sample two points along the proposed
          // parent→new edge and reject if either lands too close to a non-parent
          // node (any anchor). Catches branch crossings that the endpoint-only
          // collision check misses (the new node fits, but the segment between
          // parent and new node passes too close to another existing node).
          const edgeOverlapSq = this.edgeOverlapDist * this.edgeOverlapDist;
          let edgeBlocked = false;
          for (const t of [0.4, 0.7]) {
            const mx = n.x + (nx - n.x) * t;
            const mz = n.z + (nz - n.z) * t;
            const mgcx = Math.floor(mx / this._nCellSize) + this._nGridOff;
            const mgcz = Math.floor(mz / this._nCellSize) + this._nGridOff;
            for (let bz = -1; bz <= 1 && !edgeBlocked; bz++) {
              for (let bx = -1; bx <= 1 && !edgeBlocked; bx++) {
                const ci = mgcz + bz, cj = mgcx + bx;
                if (ci < 0 || ci >= this._nGridRows || cj < 0 || cj >= this._nGridCols) continue;
                const bucket = this._nGrid[ci * this._nGridCols + cj];
                for (let k = 0; k < bucket.length; k++) {
                  const j = bucket[k];
                  if (j === ni) continue; // skip the parent node we're growing from
                  const m = this._nodes[j];
                  if (!m.alive) continue;
                  const ddx = mx - m.x, ddz = mz - m.z;
                  if (ddx * ddx + ddz * ddz < edgeOverlapSq) { edgeBlocked = true; break; }
                }
              }
            }
            if (edgeBlocked) break;
          }
          if (edgeBlocked) continue;

          newNodes.push({
            x: nx, z: nz, parent: ni, dirX: ndx, dirZ: ndz,
            anchorIdx: n.anchorIdx, alive: true,
          });
        }

        // Commit new nodes and update spatial index.
        for (const nn of newNodes) {
          const idx = this._nodes.length;
          this._nodes.push(nn);
          this._addNodeToIndex(idx);
        }
        if (newNodes.length === 0 && influence.size === 0) break;
      }
    }

    // === Per-anchor network extraction ===
    // For each anchor, collect its subtree of nodes, prune short leaf chains,
    // extract chains, smooth (Laplacian), output polylines with flowFrac.
    _extractNetworks() {
      // Group nodes by anchorIdx.
      const nodesByAnchor = new Map();
      const indexMapByAnchor = new Map(); // anchorIdx → Map<globalIdx, localIdx>
      for (let i = 0; i < this._nodes.length; i++) {
        const n = this._nodes[i];
        if (!n.alive) continue;
        if (!nodesByAnchor.has(n.anchorIdx)) {
          nodesByAnchor.set(n.anchorIdx, []);
          indexMapByAnchor.set(n.anchorIdx, new Map());
        }
        const arr = nodesByAnchor.get(n.anchorIdx);
        const localIdx = arr.length;
        arr.push({
          x: n.x, z: n.z,
          parent: n.parent, // global; remap below
          dirX: n.dirX, dirZ: n.dirZ,
          alive: true,
        });
        indexMapByAnchor.get(n.anchorIdx).set(i, localIdx);
      }

      for (const anchor of this.anchors) {
        if (!nodesByAnchor.has(anchor.index)) continue;
        const valid = nodesByAnchor.get(anchor.index);
        const idxMap = indexMapByAnchor.get(anchor.index);

        // Remap parent indices to local-to-this-anchor.
        for (let i = 0; i < valid.length; i++) {
          const p = valid[i].parent;
          valid[i].parent = (p >= 0 && idxMap.has(p)) ? idxMap.get(p) : -1;
        }

        // Build children list.
        const children = valid.map(() => []);
        for (let i = 0; i < valid.length; i++) {
          if (valid[i].parent >= 0) children[valid[i].parent].push(i);
        }

        // Prune short leaf chains.
        let pruned = true;
        while (pruned) {
          pruned = false;
          for (let i = 0; i < valid.length; i++) {
            if (!valid[i].alive || children[i].length > 0) continue;
            let chainLen = 1, cur = i;
            while (true) {
              const p = valid[cur].parent;
              if (p < 0 || children[p].length > 1) break;
              chainLen++; cur = p;
            }
            if (chainLen < this.minBranch && valid[i].parent >= 0) {
              const p = valid[i].parent;
              const ix = children[p].indexOf(i);
              if (ix >= 0) children[p].splice(ix, 1);
              valid[i].alive = false;
              pruned = true;
            }
          }
        }

        // Compact (drop dead, remap parents).
        const validMap = new Array(valid.length).fill(-1);
        const compact = [];
        for (let i = 0; i < valid.length; i++) {
          if (valid[i].alive) { validMap[i] = compact.length; compact.push(valid[i]); }
        }
        for (let i = 0; i < compact.length; i++) {
          if (compact[i].parent >= 0) compact[i].parent = validMap[compact[i].parent];
        }
        const childrenFinal = compact.map(() => []);
        for (let i = 0; i < compact.length; i++) {
          if (compact[i].parent >= 0) childrenFinal[compact[i].parent].push(i);
        }
        if (compact.length < 2) continue;

        // Bottom-up flow counts.
        const childCount = new Array(compact.length).fill(0);
        for (let i = compact.length - 1; i >= 0; i--) {
          childCount[i] += 1;
          if (compact[i].parent >= 0) childCount[compact[i].parent] += childCount[i];
        }
        let maxFlow = 1;
        for (const c of childCount) if (c > maxFlow) maxFlow = c;

        // Extract chains.
        const chains = [];
        const visited = new Array(compact.length).fill(false);
        const traceChains = (ni) => {
          for (const kid of childrenFinal[ni]) {
            const chain = [ni, kid];
            visited[kid] = true;
            let cur = kid;
            while (childrenFinal[cur].length === 1) {
              cur = childrenFinal[cur][0];
              chain.push(cur);
              visited[cur] = true;
            }
            chains.push(chain);
            if (childrenFinal[cur].length > 1) traceChains(cur);
          }
        };
        for (let i = 0; i < compact.length; i++) {
          if (compact[i].parent < 0 && !visited[i]) {
            visited[i] = true;
            traceChains(i);
          }
        }

        // Chain smoothing (Laplacian, multiple passes).
        if (this.chainSmoothPasses > 0) {
          const isFixed = new Array(compact.length).fill(false);
          for (let i = 0; i < compact.length; i++) {
            if (compact[i].parent < 0 || childrenFinal[i].length !== 1) isFixed[i] = true;
          }
          for (let pass = 0; pass < this.chainSmoothPasses; pass++) {
            const ox = new Float64Array(compact.length);
            const oz = new Float64Array(compact.length);
            for (let i = 0; i < compact.length; i++) {
              ox[i] = compact[i].x; oz[i] = compact[i].z;
            }
            for (const chain of chains) {
              for (let ci = 1; ci < chain.length - 1; ci++) {
                const ni = chain[ci];
                if (isFixed[ni]) continue;
                const flowRatio = childCount[ni] / maxFlow;
                const alpha = 0.5 * (1.0 - Math.pow(flowRatio, 0.3));
                const pi = chain[ci - 1], qi = chain[ci + 1];
                compact[ni].x = ox[ni] + alpha * ((ox[pi] + ox[qi]) / 2.0 - ox[ni]);
                compact[ni].z = oz[ni] + alpha * ((oz[pi] + oz[qi]) / 2.0 - oz[ni]);
              }
            }
          }
        }

        // Convert chains to polylines.
        const polylines = chains.map(chain => {
          const points = chain.map(idx => ({
            x: compact[idx].x,
            z: compact[idx].z,
            flowFrac: Math.pow(childCount[idx] / maxFlow, 0.45),
          }));
          return { points };
        });

        this.networks.push({
          anchorIdx: anchor.index,
          isActive: anchor.isActive,
          color: anchor.color,
          polylines,
        });
      }
    }

    // === Step (b) — peak values + spatial index ===
    // Assigns a `peak` byte to every polyline point. The peak reads the
    // primitive upheaval byte at the point's position + a small structural
    // variation driven by widthMul (the province warp). NOT noise sampled at
    // world position — widthMul is a structural property of the band that
    // varies along the orogen line via the province warp, so the variation
    // is tied to a placed feature, not synthesised from noise. Magnitude
    // (widthMul-1)*15 → typically ±6 byte at default warp settings.
    //
    // Called from ui.js after upheaval.generate() since it reads primitiveMap.
    computePeakValues(upheaval) {
      if (!upheaval || !upheaval.primitiveMap) return;
      const mapW = this.mapW, mapH = this.mapH;
      const primMap = upheaval.primitiveMap;
      const tec = this.tectonic;
      for (let ni = 0; ni < this.networks.length; ni++) {
        const network = this.networks[ni];
        for (let pi = 0; pi < network.polylines.length; pi++) {
          const points = network.polylines[pi].points;
          // Pass 1 — read peaks per vertex.
          for (let i = 0; i < points.length; i++) {
            const p = points[i];
            const ix = p.x | 0, iz = p.z | 0;
            let base = 0;
            if (ix >= 0 && iz >= 0 && ix < mapW && iz < mapH) {
              base = primMap[iz * mapW + ix];
            }
            const widthMul = tec.lines.getProvinceWidthMultiplier(p.x, p.z);
            let peak = base + (widthMul - 1) * 15;
            if (peak < 0) peak = 0;
            else if (peak > 255) peak = 255;
            p.peak = peak;
          }
          // Pass 2 — smooth peaks along the polyline so band-crossing
          // transitions (e.g. orogen 225 → basin 90) spread over several
          // subsegments instead of stepping in one. [1, 2, 1]/4 kernel,
          // 2 passes. Endpoints fixed (no out-of-range neighbours).
          const n = points.length;
          if (n >= 3) {
            for (let pass = 0; pass < 2; pass++) {
              const orig = new Float32Array(n);
              for (let i = 0; i < n; i++) orig[i] = points[i].peak;
              for (let i = 1; i < n - 1; i++) {
                points[i].peak = (orig[i - 1] + 2 * orig[i] + orig[i + 1]) * 0.25;
              }
            }
          }
        }
      }
    }

    // Bucket grid over polyline subsegment midpoints. Mirrors rivers._segGrid
    // in structure. Used by Ridge.contributionAt (step c) and the Peaks marker
    // renderer (step d) to find ridges near a query point.
    buildSegmentIndex() {
      const cs = 10;
      this._segCellSize = cs;
      this._segGridCols = Math.ceil(this.mapW / cs) + 4;
      this._segGridRows = Math.ceil(this.mapH / cs) + 4;
      this._segGridOff = 2;
      const len = this._segGridCols * this._segGridRows;
      this._segGrid = new Array(len);
      for (let i = 0; i < len; i++) this._segGrid[i] = [];
      for (let ni = 0; ni < this.networks.length; ni++) {
        const network = this.networks[ni];
        for (let pi = 0; pi < network.polylines.length; pi++) {
          const points = network.polylines[pi].points;
          for (let si = 0; si < points.length - 1; si++) {
            const mx = (points[si].x + points[si + 1].x) * 0.5;
            const mz = (points[si].z + points[si + 1].z) * 0.5;
            const gcx = Math.floor(mx / cs) + this._segGridOff;
            const gcz = Math.floor(mz / cs) + this._segGridOff;
            if (gcx < 0 || gcx >= this._segGridCols ||
                gcz < 0 || gcz >= this._segGridRows) continue;
            this._segGrid[gcz * this._segGridCols + gcx].push({ ni, pi, si });
          }
        }
      }
    }

    // 3×3 bucket sweep — returns candidate subsegment refs near (x, z).
    // Caller computes perpendicular distance to each to find the true nearest.
    segmentsNear(x, z) {
      if (!this._segGrid) return null;
      const cs = this._segCellSize;
      const gcx = Math.floor(x / cs) + this._segGridOff;
      const gcz = Math.floor(z / cs) + this._segGridOff;
      const out = [];
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ci = gcz + dz, cj = gcx + dx;
          if (ci < 0 || ci >= this._segGridRows ||
              cj < 0 || cj >= this._segGridCols) continue;
          const bucket = this._segGrid[ci * this._segGridCols + cj];
          for (let k = 0; k < bucket.length; k++) out.push(bucket[k]);
        }
      }
      return out;
    }

    // Ridge lift contribution at (x, z) for the detail upheaval composition.
    // Returns a POSITIVE byte to ADD to baseline (peak at spine, descending
    // to baseline at skirt edge). Smoothstep descent shape. MAX-wins between
    // multiple ridges (no phantom plateaus from additive overlap).
    //
    // The peak at any point along a polyline is interpolated linearly between
    // the two endpoint anchors' `peak` values (computed by computePeakValues
    // from the primitive byte read at each point's position).
    //
    // SKIRT_WIDTH baked at 8 coord units (~256 blocks). Tunable later.
    contributionAt(x, z, baseline) {
      const cands = this.segmentsNear(x, z);
      if (!cands || cands.length === 0) return 0;
      const SKIRT_WIDTH = 8;
      const SKIRT_SQ = SKIRT_WIDTH * SKIRT_WIDTH;
      let maxLift = 0;
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        const polyline = this.networks[c.ni].polylines[c.pi];
        const p0 = polyline.points[c.si];
        const p1 = polyline.points[c.si + 1];
        const sdx = p1.x - p0.x;
        const sdz = p1.z - p0.z;
        const segLenSq = sdx * sdx + sdz * sdz;
        if (segLenSq < 0.001) continue;
        const px = x - p0.x;
        const pz = z - p0.z;
        let t = (px * sdx + pz * sdz) / segLenSq;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const projX = p0.x + t * sdx;
        const projZ = p0.z + t * sdz;
        const ddx = x - projX;
        const ddz = z - projZ;
        const perpSq = ddx * ddx + ddz * ddz;
        if (perpSq >= SKIRT_SQ) continue;
        const perpDist = Math.sqrt(perpSq);
        // Interpolated peak along the segment.
        const interpPeak = p0.peak + (p1.peak - p0.peak) * t;
        // Smoothstep descent: 1 at spine, 0 at skirt edge.
        const s = 1 - perpDist / SKIRT_WIDTH;
        const shape = s * s * (3 - 2 * s);
        // Lift above baseline (clamped ≥ 0 — ridge can't lower the floor).
        const lift = Math.max(0, (interpPeak - baseline) * shape);
        if (lift > maxLift) maxLift = lift;
      }
      return maxLift;
    }
  }

  V.RidgeNetworks = RidgeNetworks;
  V.ridgeNetworkColor = networkColor;

})(window.VIS);
