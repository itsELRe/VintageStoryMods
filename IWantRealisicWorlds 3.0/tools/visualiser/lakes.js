// lakes.js — Stepping stones (river routing) + primitive lake features.
//
// TWO-PHASE PLACEMENT (decoupled from the river graph):
//
//   Phase A — `lakes.candidates` (in the constructor). Sparse grid
//             scatter on shield-province land. River routing graph
//             reads these as 'lake'-type stepping stones (data nodes
//             for min/max interpolation along chains). NOT actual
//             lakes; just routing infrastructure. The future river-
//             aligned lake placement pass will read these as candidate
//             seed positions when it lands.
//
//   Phase B — `lakes.lakes` (via `placeLakes(rivers)`, called from
//             ui.js AFTER the river network is built so the placement
//             can avoid river polylines). Two types in this pass:
//        • basin    — score-driven placement on shield (shield base +
//                     enclosed-shield bonus + coast-interior bonus).
//                     Sparse — one major lake per region.
//        • cluster  — pick cluster CENTERS sparsely, scatter a handful
//                     of small lakes inside each. Canadian-Shield-ish
//                     pattern; few clusters per continent.
//      Each lake = {type, center, outline, size, aspectRatio,
//                   rotation, maxDepth}.
//
// Structural rules in Phase B:
//   • Env-fit: outline never bleeds across a province boundary or
//     into ocean. Walks 16 radial directions, caps lake radius to the
//     minimum distance to a different province or ocean.
//   • River avoidance: lake center stays clear of river polylines by
//     (lakeRadius + basinRiverBuffer | clusterRiverBuffer).
//   • Cross-type spacing: basin lakes and cluster members keep
//     `crossTypeMinDist` between them.
//
// SIZE/SPACING ARE FIXED COORD UNITS — NOT scaled by mapScale. Lake
// dimensions stay consistent regardless of world size; bigger worlds
// get proportionally more lakes of the same size. Stepping-stone
// candidates DO still scale with mapScale (routing-graph density
// stays consistent per area).
//
// Primitive rule: lakes represent MAXIMUM extent. No climate filter at
// primitive level — these are CARVED BOWLS, not water bodies. Climate
// detail pass (queued, needs `climate.getSmoothedAt`) modulates fill
// (wet vs dry-basin) within the carved bounds — but never CREATES or
// REMOVES lakes. Lakes appear in dry areas too; they just don't fill
// with water in detail render.
//
// Outline construction mirrors the river polyline pattern:
// smoothstep-interpolated radial wobble around the perimeter +
// circular Laplacian smoothing with wrap-around. Same construction
// shape as rivers — natural curve, no display-time warp.
//
// `maxDepth` is data only at this stage. The upheaval carve hookup
// lives on the detail-upheaval-rebuild thread (queued); lakes don't
// modify upheaval bytes yet.
//
// Coords are continuous floats (1 unit = 32 in-game blocks per
// `TerraGenConfig.oceanMapScale`).

window.VIS = window.VIS || {};

(function (V) {

  // Province byte (matches provinces.js naming table — 0 = shield).
  const PROV_SHIELD = 0;

  // Small HSL→RGB used for endorheic lake colours (lakes with no river
  // connection nearby). Lakes WITH a nearby river inherit that river's
  // watershed colour instead; this is just for the standalone case.
  function _hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  }

  // Standard ray-cast point-in-polygon. Used by Lake.contributionAt to
  // confirm a query point is actually inside a lake's outline (bbox passes
  // false positives for non-rectangular outlines).
  function _pointInPolygon(x, z, polygon) {
    let inside = false;
    const n = polygon.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i].x, zi = polygon[i].z;
      const xj = polygon[j].x, zj = polygon[j].z;
      const intersect = ((zi > z) !== (zj > z)) &&
                        (x < (xj - xi) * (z - zi) / (zj - zi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  class LakeFeatures {
    constructor(opts, tectonic, continent, climate, provinces, distanceFields) {
      this.mapW = opts.mapW;
      this.mapH = opts.mapH;
      this.worldSeed = opts.seed | 0;
      this.tectonic = tectonic;
      this.continent = continent;
      this.climate = climate;
      this.provinces = provinces;
      this.distanceFields = distanceFields;  // distToOcean — see distance-fields.js

      // ===== Stepping-stone candidate grid =====
      // Spacing for the routing-graph nodes. Smaller = denser routing
      // options for rivers. `riverPoints` slider scales inversely so
      // slider 2.0 doubles density.
      const baseGridSpacing = opts.gridSpacing ?? 18;
      const riverPoints = opts.riverPoints ?? 1.0;
      this.gridSpacing = baseGridSpacing / Math.max(0.1, riverPoints);

      // ===== Basin lake constants =====
      // Radii in coord units (1 unit = 32 blocks). 4-10 ≈ 130-320
      // blocks radius (260-640 blocks across) — small-to-medium real-
      // world lake scale. Size distribution skewed toward MIN via
      // `scoreNorm^1.5` so most lakes are small with a few hitting MAX.
      //
      // Lake size and spacing are NOT scaled by `mapScale` — lake
      // sizes stay fixed in coord units regardless of world size, and
      // spacing stays fixed too (so bigger worlds get proportionally
      // MORE lakes of the same size, not bigger lakes).
      this.basinSpacing = opts.basinSpacing ?? 80;        // grid for candidates
      this.basinScoreThreshold = opts.basinScoreThreshold ?? 1.0;
      this.basinMinDist = opts.basinMinDist ?? 80;
      this.basinMinRadius = opts.basinMinRadius ?? 4;
      this.basinMaxRadius = opts.basinMaxRadius ?? 10;
      this.basinSizeExponent = opts.basinSizeExponent ?? 1.5;
      this.basinAspectMax = opts.basinAspectMax ?? 2.0;   // long:short ratio cap
      this.basinMaxDepth = opts.basinMaxDepth ?? 70;
      // Minimum distance (coord units) between a basin lake CENTER and
      // any river polyline (added to lake radius). Keeps basin lakes
      // clear of the river network so river-aligned lakes (future
      // third type) get unclaimed terrain.
      this.basinRiverBuffer = opts.basinRiverBuffer ?? 5;

      // ===== Cluster lake constants =====
      // Pond-scale members. Aspect kept rounder than basins (clusters
      // are scour ponds, not rift valleys).
      this.clusterSpacing = opts.clusterSpacing ?? 220;   // grid for centers
      this.clusterMembersMin = 3;
      this.clusterMembersMax = 7;
      this.clusterMemberSpread = 28;                      // member scatter radius
      this.clusterMemberMinDist = 5;
      this.clusterMemberMinRadius = 2;
      this.clusterMemberMaxRadius = 5;
      this.clusterMemberAspectMax = 1.5;
      this.clusterMemberMaxDepth = 25;
      // River-distance buffer (coord units) — same purpose as basin's,
      // smaller since cluster ponds are smaller features.
      this.clusterRiverBuffer = opts.clusterRiverBuffer ?? 3;

      // ===== Cross-type avoidance =====
      // Min distance (coord units) between any basin lake and any
      // cluster member. Stops a basin from sitting on top of / right
      // next to a cluster pond, which reads as confused geometry.
      this.crossTypeMinDist = opts.crossTypeMinDist ?? 25;

      // ===== Outline construction =====
      // Mirrors the river polyline approach: many small points around
      // the perimeter, smoothstep-interpolated radial wobble (so
      // adjacent angular samples correlate), circular Laplacian
      // smoothing with wrap-around. Natural curve, no display warp.
      this.outlinePoints = opts.outlinePoints ?? 60;
      // Radial wobble amplitude as a fraction of base radius.
      this.outlineWobbleAmp = opts.outlineWobbleAmp ?? 0.25;
      // Angular spacing (in vertex count) between independent hash
      // samples. Larger = lower-frequency wobble, smoother shape.
      this.outlineWobbleStride = opts.outlineWobbleStride ?? 8;
      this.outlineSmoothPasses = opts.outlineSmoothPasses ?? 3;
      this.outlineSmoothAlpha = opts.outlineSmoothAlpha ?? 0.5;

      // Global density multiplier (UI slider).
      this.density = opts.density ?? 1.0;

      this._mapScale = V.phiScale(Math.max(this.mapW, this.mapH));

      this.candidates = [];
      this.lakes = [];
      this.rivers = null;

      // Phase A — stepping-stone candidates only. Rivers consume these
      // immediately after construction. Basin + cluster placement
      // (Phase B) waits for `placeLakes(rivers)` so it can avoid the
      // river polylines that get built in between.
      this._placeCandidates();
    }

    // ===== Phase B — basin + cluster lake placement =====
    // Called from ui.js AFTER the river network is built. Reads
    // `rivers._segGrid` (subsegment spatial index) so lake placement
    // can reject any candidate within river-buffer distance of a
    // river polyline. Cross-type basin↔cluster spacing also enforced.
    placeLakes(rivers) {
      this.rivers = rivers || null;
      this._placeBasinLakes();
      this._placeClusterLakes();
      this._buildLakeIndex();
      this._assignFamilyColors();
    }

    // Assign a colour to each lake based on its FAMILY SEED (structural
    // placement seed, not nearby-feature scan):
    //   • Basin lakes — each lake is its own family. familySeed = the
    //     per-lake seed used during placement. Different basin lakes →
    //     different colours.
    //   • Cluster lakes — all members of one cluster share clusterSeed
    //     (the seed of the cluster centre). So pond clusters read as
    //     one family — every member of a cluster the same colour,
    //     different clusters different colours.
    //
    // No proximity-to-river scanning. Future river-aligned lakes will
    // attach to the river they're generated ON (direct structural link),
    // taking on that river's watershed colour at placement time — same
    // pattern, just a different familySeed source.
    _assignFamilyColors() {
      for (const lake of this.lakes) {
        const seed = (lake.familySeed | 0) >>> 0;
        // Golden-angle hue rotation off the seed → well-spread distinct
        // hues across families. Hue range covers full circle so families
        // are visually distinguishable.
        const h = (seed * 137.508) % 360;
        lake.familyColor = _hslToRgb(((h % 360) + 360) % 360, 60, 55);
      }
    }

    // Bucket grid over lake outline bounding boxes. Each lake is added to
    // every bucket cell its bbox overlaps. Used by Lake.contributionAt
    // (step c) to find candidate lakes near a query point.
    _buildLakeIndex() {
      const lakes = this.lakes;
      // Cache per-lake bbox (computed once, reused by lakesNear queries).
      for (const lake of lakes) {
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        const outline = lake.outline;
        for (let i = 0; i < outline.length; i++) {
          const p = outline[i];
          if (p.x < minX) minX = p.x;
          if (p.z < minZ) minZ = p.z;
          if (p.x > maxX) maxX = p.x;
          if (p.z > maxZ) maxZ = p.z;
        }
        lake._bbox = { minX, minZ, maxX, maxZ };
      }
      const cs = 20;
      this._lakeCellSize = cs;
      this._lakeGridCols = Math.ceil(this.mapW / cs) + 4;
      this._lakeGridRows = Math.ceil(this.mapH / cs) + 4;
      this._lakeGridOff = 2;
      const len = this._lakeGridCols * this._lakeGridRows;
      this._lakeGrid = new Array(len);
      for (let i = 0; i < len; i++) this._lakeGrid[i] = [];
      for (let li = 0; li < lakes.length; li++) {
        const bb = lakes[li]._bbox;
        const minGcx = Math.floor(bb.minX / cs) + this._lakeGridOff;
        const minGcz = Math.floor(bb.minZ / cs) + this._lakeGridOff;
        const maxGcx = Math.floor(bb.maxX / cs) + this._lakeGridOff;
        const maxGcz = Math.floor(bb.maxZ / cs) + this._lakeGridOff;
        for (let gcz = minGcz; gcz <= maxGcz; gcz++) {
          for (let gcx = minGcx; gcx <= maxGcx; gcx++) {
            if (gcx < 0 || gcx >= this._lakeGridCols ||
                gcz < 0 || gcz >= this._lakeGridRows) continue;
            this._lakeGrid[gcz * this._lakeGridCols + gcx].push(li);
          }
        }
      }
    }

    // Returns lake indices whose bbox overlaps the bucket at (x, z).
    // Caller point-in-polygon-tests against outline to confirm membership.
    lakesNear(x, z) {
      if (!this._lakeGrid) return null;
      const cs = this._lakeCellSize;
      const gcx = Math.floor(x / cs) + this._lakeGridOff;
      const gcz = Math.floor(z / cs) + this._lakeGridOff;
      if (gcx < 0 || gcx >= this._lakeGridCols ||
          gcz < 0 || gcz >= this._lakeGridRows) return null;
      return this._lakeGrid[gcz * this._lakeGridCols + gcx];
    }

    // Carve contribution at (x, z) for the detail upheaval composition.
    // Returns a POSITIVE byte to SUBTRACT from baseline (deeper at center,
    // ramping to 0 at the lake outline). Quadratic bowl: 1 - t² where
    // t = distFromCenter / lake.size. MAX-wins if multiple lakes overlap.
    contributionAt(x, z) {
      const cands = this.lakesNear(x, z);
      if (!cands || cands.length === 0) return 0;
      let maxCarve = 0;
      for (let i = 0; i < cands.length; i++) {
        const lake = this.lakes[cands[i]];
        const bb = lake._bbox;
        if (x < bb.minX || x > bb.maxX || z < bb.minZ || z > bb.maxZ) continue;
        if (!_pointInPolygon(x, z, lake.outline)) continue;
        const dx = x - lake.center.x;
        const dz = z - lake.center.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const t = Math.min(1, dist / Math.max(0.001, lake.size));
        const carve = lake.maxDepth * (1 - t * t);
        if (carve > maxCarve) maxCarve = carve;
      }
      return maxCarve;
    }

    // ===== Stepping stones =====
    // Sparse grid on shield-province land. NOT climate-filtered (primitive
    // = max extent — rivers must be able to route through arid regions too).
    _placeCandidates() {
      const { tectonic, continent } = this;
      const lg = continent.landGrid;
      if (!lg) return;
      const cellSize = this.gridSpacing * this._mapScale;
      if (cellSize < 1) return;
      const cols = Math.ceil(this.mapW / cellSize);
      const rows = Math.ceil(this.mapH / cellSize);

      for (let gz = 0; gz < rows; gz++) {
        for (let gx = 0; gx < cols; gx++) {
          const cellSeed = (this.worldSeed
            ^ Math.imul(gx + 1, 0x9E3779B9)
            ^ Math.imul(gz + 1, 0xB7E15163)) | 0;
          const jx = (V.hash2d(gx, gz, cellSeed) - 0.5) * cellSize * 0.7;
          const jz = (V.hash2d(gx, gz, cellSeed ^ 0x12345678) - 0.5) * cellSize * 0.7;
          const cx = (gx + 0.5) * cellSize + jx;
          const cz = (gz + 0.5) * cellSize + jz;
          const ix = cx | 0, iz = cz | 0;

          if (ix < 0 || iz < 0 || ix >= this.mapW || iz >= this.mapH) continue;
          if (lg[iz * this.mapW + ix] !== 1) continue;
          if (V.provinceAt(tectonic, cx, cz, true) !== PROV_SHIELD) continue;

          this.candidates.push({ x: cx, z: cz });
        }
      }
    }

    // ===== Basin lakes =====
    // Large lakes placed by structural score (shield province +
    // enclosed-shield bonus + coast-interior bonus). One score-and-
    // dedupe pass, sized by score (bigger score → bigger lake). Sizes
    // and spacing are in fixed coord units (NOT scaled by mapScale),
    // so lake size stays consistent regardless of world size and
    // bigger worlds get proportionally more lakes.
    _placeBasinLakes() {
      const { tectonic, continent, provinces, distanceFields } = this;
      const lg = continent.landGrid;
      const enclosedGrid = provinces && provinces.enclosedGrid;
      if (!lg) return;

      const cellSize = this.basinSpacing;
      if (cellSize < 1) return;
      const cols = Math.ceil(this.mapW / cellSize);
      const rows = Math.ceil(this.mapH / cellSize);

      const candidates = [];
      for (let gz = 0; gz < rows; gz++) {
        for (let gx = 0; gx < cols; gx++) {
          const cellSeed = (this.worldSeed
            ^ Math.imul(gx + 31, 0x9E3779B9)
            ^ Math.imul(gz + 31, 0xB7E15163)) | 0;
          const jx = (V.hash2d(gx, gz, cellSeed) - 0.5) * cellSize * 0.5;
          const jz = (V.hash2d(gx, gz, cellSeed ^ 0xACDF) - 0.5) * cellSize * 0.5;
          const cx = (gx + 0.5) * cellSize + jx;
          const cz = (gz + 0.5) * cellSize + jz;
          const ix = cx | 0, iz = cz | 0;
          if (ix < 0 || iz < 0 || ix >= this.mapW || iz >= this.mapH) continue;
          if (lg[iz * this.mapW + ix] !== 1) continue;
          if (V.provinceAt(tectonic, cx, cz, true) !== PROV_SHIELD) continue;

          const pIdx = iz * this.mapW + ix;
          let score = 1.0;
          if (enclosedGrid && enclosedGrid[pIdx] === 1) score += 1.0;
          if (distanceFields) {
            score += Math.min(0.5, distanceFields.getDistToOceanAt(cx, cz) / 80);
          }
          candidates.push({ x: cx, z: cz, score });
        }
      }

      candidates.sort((a, b) => b.score - a.score);
      const minDist = this.basinMinDist;
      const minDistSq = minDist * minDist;
      const wobbleHeadroom = 1 + this.outlineWobbleAmp;
      const minRadius = this.basinMinRadius;
      const maxRadius = this.basinMaxRadius;

      for (const cand of candidates) {
        if (cand.score * this.density < this.basinScoreThreshold) continue;
        let tooClose = false;
        for (const lake of this.lakes) {
          const dx = cand.x - lake.center.x, dz = cand.z - lake.center.z;
          if (dx * dx + dz * dz < minDistSq) { tooClose = true; break; }
        }
        if (tooClose) continue;

        // Score-driven target size (skewed toward MIN — most basins
        // small, occasional ones hit MAX).
        const scoreNorm = Math.min(1, cand.score / 2.5);
        const scoreRadius = minRadius
          + (maxRadius - minRadius) * Math.pow(scoreNorm, this.basinSizeExponent);

        // Environment fit — cap so outline never bleeds into a
        // different province or ocean. Divide by wobble headroom so
        // the wobbled perimeter still stays inside the env.
        const envFit = this._getEnvFitRadius(cand.x, cand.z, maxRadius * wobbleHeadroom);
        const cappedRadius = Math.min(scoreRadius, envFit / wobbleHeadroom);
        if (cappedRadius < minRadius * 0.6) continue; // not even minimum fit

        // River avoidance — basin center must be at least
        // (lakeRadius × wobbleHeadroom + basinRiverBuffer) from any
        // river polyline. Keeps basins clear of the river network.
        const riverClearDist = cappedRadius * wobbleHeadroom + this.basinRiverBuffer;
        const distSqToRiver = this._distanceToNearestRiverSq(
          cand.x, cand.z, riverClearDist * riverClearDist);
        if (distSqToRiver < riverClearDist * riverClearDist) continue;

        const lakeSeed = (this.worldSeed
          ^ Math.imul((cand.x | 0) + 1, 0x9E3779B9)
          ^ Math.imul((cand.z | 0) + 1, 0xB7E15163)) | 0;

        // Aspect (1.0 = circle, basinAspectMax = max elongation) +
        // rotation. Hash-driven, deterministic per lake.
        const aspectH = V.hash2d(0, 0, lakeSeed ^ 0xACDF);
        const aspectRatio = 1.0 + aspectH * (this.basinAspectMax - 1.0);
        const rotation = V.hash2d(1, 0, lakeSeed ^ 0xACDF) * Math.PI;

        const longAxis = cappedRadius;
        const shortAxis = cappedRadius / aspectRatio;

        const outline = this._generateOutline(
          cand.x, cand.z, longAxis, shortAxis, rotation, lakeSeed);

        this.lakes.push({
          type: 'basin',
          center: { x: cand.x, z: cand.z },
          outline,
          size: longAxis,  // bounding-circle radius for culling
          aspectRatio,
          rotation,
          maxDepth: this.basinMaxDepth,
          familySeed: lakeSeed,
        });
      }
    }

    // ===== Cluster lakes =====
    // Pick cluster CENTERS sparsely on a coarse grid. At each viable
    // center, scatter `clusterMembersMin..clusterMembersMax` small
    // lakes within a `clusterMemberSpread` radius (rejection-sampled
    // so members don't pile up). Sizes + spacing fixed in coord units
    // (NOT scaled by mapScale).
    _placeClusterLakes() {
      const { tectonic, continent } = this;
      const lg = continent.landGrid;
      if (!lg) return;

      const cellSize = this.clusterSpacing;
      if (cellSize < 1) return;
      const cols = Math.ceil(this.mapW / cellSize);
      const rows = Math.ceil(this.mapH / cellSize);

      const spread = this.clusterMemberSpread;
      const memberMinDist = this.clusterMemberMinDist;
      const memberMinDistSq = memberMinDist * memberMinDist;
      const crossMinDist = this.crossTypeMinDist;
      const crossMinDistSq = crossMinDist * crossMinDist;

      for (let gz = 0; gz < rows; gz++) {
        for (let gx = 0; gx < cols; gx++) {
          const clusterSeed = (this.worldSeed
            ^ Math.imul(gx + 101, 0x9E3779B9)
            ^ Math.imul(gz + 101, 0xB7E15163)) | 0;
          const jx = (V.hash2d(gx, gz, clusterSeed) - 0.5) * cellSize * 0.6;
          const jz = (V.hash2d(gx, gz, clusterSeed ^ 0xACBD) - 0.5) * cellSize * 0.6;
          const cx = (gx + 0.5) * cellSize + jx;
          const cz = (gz + 0.5) * cellSize + jz;
          const ix = cx | 0, iz = cz | 0;
          if (ix < 0 || iz < 0 || ix >= this.mapW || iz >= this.mapH) continue;
          if (lg[iz * this.mapW + ix] !== 1) continue;
          if (V.provinceAt(tectonic, cx, cz, true) !== PROV_SHIELD) continue;

          const memberH = V.hash2d(gx, gz, clusterSeed ^ 0x1234);
          const memberCount = this.clusterMembersMin
            + Math.floor(memberH * (this.clusterMembersMax - this.clusterMembersMin + 1));

          const members = [];
          let attempts = 0;
          while (members.length < memberCount && attempts < 60) {
            attempts++;
            const memberSeed = (clusterSeed
              ^ Math.imul(attempts + 1, 0x12345678)) | 0;
            const ang = V.hash2d(attempts, 0, memberSeed) * Math.PI * 2;
            const dist = V.hash2d(attempts, 1, memberSeed) * spread;
            const mx = cx + Math.cos(ang) * dist;
            const mz = cz + Math.sin(ang) * dist;
            const mix = mx | 0, miz = mz | 0;
            if (mix < 0 || miz < 0 || mix >= this.mapW || miz >= this.mapH) continue;
            if (lg[miz * this.mapW + mix] !== 1) continue;
            if (V.provinceAt(tectonic, mx, mz, true) !== PROV_SHIELD) continue;

            let tooClose = false;
            for (const m of members) {
              const ddx = mx - m.x, ddz = mz - m.z;
              if (ddx * ddx + ddz * ddz < memberMinDistSq) { tooClose = true; break; }
            }
            if (tooClose) continue;

            members.push({ x: mx, z: mz, seed: memberSeed });
          }

          const wobbleHeadroom = 1 + this.outlineWobbleAmp;
          const memberMinR = this.clusterMemberMinRadius;
          const memberMaxR = this.clusterMemberMaxRadius;
          for (const m of members) {
            // Cross-type avoidance — cluster member must keep its
            // distance from any already-placed basin lake.
            let tooCloseToBasin = false;
            for (const lake of this.lakes) {
              if (lake.type !== 'basin') continue;
              const dx = m.x - lake.center.x, dz = m.z - lake.center.z;
              if (dx * dx + dz * dz < crossMinDistSq) {
                tooCloseToBasin = true; break;
              }
            }
            if (tooCloseToBasin) continue;

            const rH = V.hash2d(0, 0, m.seed ^ 0xACDF);
            const targetRadius = memberMinR
              + rH * (memberMaxR - memberMinR);

            // Environment fit — same logic as basin: outline never
            // bleeds across province / coast.
            const envFit = this._getEnvFitRadius(m.x, m.z, memberMaxR * wobbleHeadroom);
            const cappedRadius = Math.min(targetRadius, envFit / wobbleHeadroom);
            if (cappedRadius < memberMinR * 0.5) continue;

            // River avoidance — smaller buffer than basins since
            // members are small features.
            const riverClearDist = cappedRadius * wobbleHeadroom + this.clusterRiverBuffer;
            const distSqToRiver = this._distanceToNearestRiverSq(
              m.x, m.z, riverClearDist * riverClearDist);
            if (distSqToRiver < riverClearDist * riverClearDist) continue;

            // Mild aspect variation — cluster ponds, not rift valleys.
            const aspectH = V.hash2d(1, 0, m.seed ^ 0xACDF);
            const aspectRatio = 1.0 + aspectH * (this.clusterMemberAspectMax - 1.0);
            const rotation = V.hash2d(2, 0, m.seed ^ 0xACDF) * Math.PI;

            const longAxis = cappedRadius;
            const shortAxis = cappedRadius / aspectRatio;

            const outline = this._generateOutline(
              m.x, m.z, longAxis, shortAxis, rotation, m.seed);

            this.lakes.push({
              type: 'cluster',
              center: { x: m.x, z: m.z },
              outline,
              size: longAxis,
              aspectRatio,
              rotation,
              maxDepth: this.clusterMemberMaxDepth,
              familySeed: clusterSeed,
            });
          }
        }
      }
    }

    // ===== Outline construction =====
    // Closed-loop irregular polygon around (cx, cz), with elliptical
    // shape (longAxis / shortAxis with `rotation`). aspect=1 ⇒ circle.
    // Mirrors the river polyline pattern: N points around the
    // perimeter, smoothstep-interpolated radial wobble at fixed angular
    // stride, circular Laplacian smoothing with wrap-around.
    _generateOutline(cx, cz, longAxis, shortAxis, rotation, seed) {
      const N = this.outlinePoints;
      const wobbleAmp = this.outlineWobbleAmp;
      const stride = Math.max(1, this.outlineWobbleStride);
      const totalSamples = Math.max(2, Math.floor(N / stride));
      const cosR = Math.cos(rotation);
      const sinR = Math.sin(rotation);

      const pts = new Array(N);
      for (let i = 0; i < N; i++) {
        // Smoothstep-interpolated radial wobble — adjacent angular
        // samples correlate; closed loop joins seamlessly via the
        // wrap-around hash sampling at `totalSamples`.
        const samplePos = i / stride;
        const a = Math.floor(samplePos);
        const blendT = samplePos - a;
        const blendSmooth = blendT * blendT * (3 - 2 * blendT);
        const hA = V.hash2d(a % totalSamples, 0, seed);
        const hB = V.hash2d((a + 1) % totalSamples, 0, seed);
        const h = hA * (1 - blendSmooth) + hB * blendSmooth;
        const wobbleFactor = 1 + (h - 0.5) * 2 * wobbleAmp;

        // Parametric ellipse in local (un-rotated) frame, then rotate.
        const angle = (i / N) * Math.PI * 2;
        const lx = longAxis * Math.cos(angle) * wobbleFactor;
        const lz = shortAxis * Math.sin(angle) * wobbleFactor;
        const dx = lx * cosR - lz * sinR;
        const dz = lx * sinR + lz * cosR;
        pts[i] = { x: cx + dx, z: cz + dz };
      }

      // Circular Laplacian smoothing — wrap neighbors at i=0 / i=N-1.
      const alpha = this.outlineSmoothAlpha;
      for (let pass = 0; pass < this.outlineSmoothPasses; pass++) {
        const ox = new Float64Array(N);
        const oz = new Float64Array(N);
        for (let i = 0; i < N; i++) {
          ox[i] = pts[i].x; oz[i] = pts[i].z;
        }
        for (let i = 0; i < N; i++) {
          const prev = (i - 1 + N) % N;
          const next = (i + 1) % N;
          pts[i].x = ox[i] + alpha * ((ox[prev] + ox[next]) / 2 - ox[i]);
          pts[i].z = oz[i] + alpha * ((oz[prev] + oz[next]) / 2 - oz[i]);
        }
      }

      return pts;
    }

    // Find the maximum radial extent around (cx, cz) that stays within
    // the SAME province AND on land. Walks 16 radial directions in
    // 1-unit steps, returns the minimum hit distance (bounded by
    // `maxSearch`). Caller uses this to cap lake size so the outline
    // never bleeds across a province boundary or into ocean.
    _getEnvFitRadius(cx, cz, maxSearch) {
      const { tectonic, continent } = this;
      const lg = continent.landGrid;
      const ix0 = cx | 0, iz0 = cz | 0;
      if (ix0 < 0 || iz0 < 0 || ix0 >= this.mapW || iz0 >= this.mapH) return 0;
      if (lg[iz0 * this.mapW + ix0] !== 1) return 0;
      const centerProvince = V.provinceAt(tectonic, cx, cz, true);

      const N = 16;
      const limit = Math.ceil(maxSearch);
      let minDist = limit;
      for (let i = 0; i < N; i++) {
        const angle = (i / N) * Math.PI * 2;
        const dx = Math.cos(angle), dz = Math.sin(angle);
        let dist = limit;
        for (let step = 1; step <= limit; step++) {
          const x = cx + dx * step;
          const z = cz + dz * step;
          const ix = x | 0, iz = z | 0;
          if (ix < 0 || iz < 0 || ix >= this.mapW || iz >= this.mapH) {
            dist = step;
            break;
          }
          if (lg[iz * this.mapW + ix] !== 1) { dist = step; break; }
          if (V.provinceAt(tectonic, x, z, true) !== centerProvince) {
            dist = step; break;
          }
        }
        if (dist < minDist) minDist = dist;
      }
      return minDist;
    }

    // Squared distance from (x, z) to the nearest river-polyline
    // subsegment, capped at `maxDsq`. Uses `rivers._segGrid` (the
    // subsegment bucket index built by rivers._buildSubsegmentIndex)
    // for O(1) candidate lookup. Returns Infinity if rivers haven't
    // been built yet, so calling this before placeLakes() is safe
    // (no river → no rejection).
    _distanceToNearestRiverSq(x, z, maxDsq) {
      const rivers = this.rivers;
      if (!rivers || !rivers._segGrid) return Infinity;
      const cs = rivers._segGridCellSize;
      const off = rivers._segGridOff;
      const cols = rivers._segGridCols;
      const rows = rivers._segGridRows;
      const grid = rivers._segGrid;
      const conns = rivers.connections;

      const gcx0 = Math.floor(x / cs) + off;
      const gcz0 = Math.floor(z / cs) + off;
      const reach = Math.ceil(Math.sqrt(maxDsq) / cs) + 1;

      let minDsq = maxDsq;
      for (let dz = -reach; dz <= reach; dz++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const gcx = gcx0 + dx, gcz = gcz0 + dz;
          if (gcx < 0 || gcx >= cols || gcz < 0 || gcz >= rows) continue;
          const bucket = grid[gcz * cols + gcx];
          if (!bucket) continue;
          for (let k = 0; k < bucket.length; k++) {
            const entry = bucket[k];
            const conn = conns[entry.connIdx];
            if (!conn || !conn.polyline) continue;
            const a = conn.polyline[entry.segIdx];
            const b = conn.polyline[entry.segIdx + 1];
            if (!a || !b) continue;
            const segDx = b.x - a.x, segDz = b.z - a.z;
            const lenSq = segDx * segDx + segDz * segDz;
            let t = lenSq > 1e-12
              ? ((x - a.x) * segDx + (z - a.z) * segDz) / lenSq
              : 0;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            const px = a.x + segDx * t, pz = a.z + segDz * t;
            const ddx = x - px, ddz = z - pz;
            const dsq = ddx * ddx + ddz * ddz;
            if (dsq < minDsq) minDsq = dsq;
          }
        }
      }
      return minDsq;
    }

    // Point-in-lake query — returns the lake feature containing (x, z),
    // or null. Coarse bbox check via bounding circle (size × 1+wobble),
    // then exact point-in-polygon.
    getLakeAt(x, z) {
      for (const lake of this.lakes) {
        const dx = x - lake.center.x, dz = z - lake.center.z;
        const rExt = lake.size * (1 + this.outlineWobbleAmp);
        if (dx * dx + dz * dz > rExt * rExt) continue;
        if (lake.outline && this._pointInPolygon(x, z, lake.outline)) return lake;
      }
      return null;
    }

    _pointInPolygon(x, z, poly) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, zi = poly[i].z;
        const xj = poly[j].x, zj = poly[j].z;
        const intersect = ((zi > z) !== (zj > z))
          && (x < (xj - xi) * (z - zi) / (zj - zi) + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    }
  }

  V.LakeFeatures = LakeFeatures;

})(window.VIS);
