// rivers.js — Springs, checkpoints, endpoints, polyline connections,
// primitive hydrology.
//
// !! DORMANT AND CURRENTLY THROWING. Routing and hydrology still read the old
// upheaval band (`upheaval._primitiveAt`), which the upheaval rework deleted, so
// constructing RiverNetworks raises a TypeError. ui.js catches it and skips
// rivers; nothing else is affected. Expected, not a regression — rivers are
// being rebuilt on the drainage graph + anchor fields with the features pass.
//
// Pipeline (constructor order):
//
//   1. Deflectors — composable obstacle field along active + fossil
//      orogen polylines. Primitive infrastructure for future gorges /
//      passes / cheile to subtract from.
//   2. Coast endpoints — one per ocean Voronoi cell touching land.
//   3. Lake checkpoints — every `lakes.candidates` entry. Pure
//      routing stones now; actual lakes are a separate primitive
//      feature class in `lakes.lakes`, decoupled from this graph.
//   4. Springs — geo-density-modulated hex-grid scatter on platform
//      province only; band-fraction padded to clear ridges and the
//      shield edge.
//   5. Stone graph — sparse adjacency with progressive-relaxation tiers
//      (range → byte → SOI).
//   6. Reverse Dijkstra from coast inward — each node ends up with
//      cost-to-ocean + parent.
//   7. Trace per-spring paths along parent chains → emit connections.
//   8. Resolve watershed identity via union-find on shared non-coast
//      parents. Stellar formations stay separate.
//   9. Build polylines for each connection — Hermite cubic curve
//      with tangent matching at each connection's downstream endpoint
//      (so polylines meet junction nodes flowing in the same direction
//      they leave), perpendicular wander on top with sin² endpoint
//      taper, Laplacian-smoothed flow-weighted with floor. Spatial
//      index over subsegments for downstream consumers.
//  10. Compute PRIMITIVE hydrology — climate-free max-extent pass:
//      every spring routes to ocean, every segment is LIVE, lakes form
//      structurally on velocity+quantity rules with no rain/evap.
//
// Per the locked design rule (primitive = max extent, detail = current
// state): geometry + hydrology in this file are CLIMATE-INDEPENDENT.
// A future `_computeDetailHydrology` pass (queued behind a
// `climate.getSmoothedAt` prerequisite) will sample warped + smoothed
// climate at detail positions to mark live/dry per subsegment and
// wet/dry-basin per lake, modulating water level within the carved
// primitive bounds.
//
// All computation in PRIMITIVE space.

window.VIS = window.VIS || {};

(function (V) {

  // Per-candidate hue (golden-angle rotation). Each candidate's `color`
  // gets set at creation; routing will later promote watershed roots and
  // propagate colour through trees.
  function endColor(idx) {
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

  class RiverNetworks {
    constructor(opts, tectonic, continent, provinces, climate, lakes, upheaval) {
      this.mapW = opts.mapW;
      this.mapH = opts.mapH;
      this.worldSeed = opts.seed | 0;
      this.tectonic = tectonic;
      this.continent = continent;
      this.provinces = provinces;
      this.climate = climate;
      this.lakes = lakes;
      this.upheaval = upheaval;

      // Spring density slider — affects spring count via base spacing.
      this.riverPoints = opts.riverPoints ?? 1.0;
      this.baseSpacing = opts.baseSpacing ?? 36;

      // Per-spring flow modulator. Geo activity at the spring's polygon
      // multiplied by this weight + baseFlow gives the starting water
      // budget. Density is ALSO modulated by geo activity (per-cell keep
      // roll); the same slider boosts both effects.
      this.geoInfluence = opts.geoInfluence ?? 1.0;

      // Deflector radius multiplier. Routing-side (when re-added) will
      // honour this; for now it just controls the mask geometry.
      this.deflectorInfluence = opts.deflectorInfluence ?? 1.0;

      // riverConnections: structural reach control reserved for the
      // graph builder (currently inert — graph uses fixed PRIMARY_MAX /
      // FALLBACK_MAX).
      this.riverConnections = opts.riverConnections ?? 1.0;
      // climateInfluence: parked. Primitive hydrology is climate-free
      // per the primitive=max-extent / detail=current-state design
      // rule. Slider wires back into the future `_computeDetailHydrology`
      // pass that drives wet/dry overrides on warped climate.
      this.climateInfluence = opts.climateInfluence ?? 1.0;

      // Spring band as a fraction across the platform from the orogen side.
      // [0.30, 0.80] = 30% pad on the basin side (clears the ridges'
      // platformFeather ~15% with margin) + 50% active band + 20% pad on
      // the shield side. Picks active vs fossil orogen by whichever is the
      // closer chamfer dist; same convention provinces / upheaval use.
      this.bandInner = opts.bandInner ?? 0.30;
      this.bandOuter = opts.bandOuter ?? 0.80;

      // Per-pixel scaling (same convention upheaval / ridges use).
      this._mapScale = V.phiScale(Math.max(this.mapW, this.mapH));
      this._activity = 1.0; // Tectonic Activity dropped

      // Outputs.
      this.candidates = [];      // {x, z, type, index, color, active, score, flow, accumulatedFlow}
      this.springIdxs = [];      // indices of type === 'spring'
      this.endIdxs = [];         // indices of type ∈ {'coast', 'lake'}
      this.connections = [];     // empty — routing rebuild pending
      this.deflectors = [];      // {x, z, radius}
      this._deflectorMask = null;

      // Build order (see file header for the full pipeline write-up):
      //   1. Deflectors (composable obstacle field).
      //   2. Endpoints + checkpoints — coast + lake graph nodes.
      //   3. Springs + initial flow.
      //   4. Stone graph (sparse adjacency with relaxation tiers).
      //   5. Reverse Dijkstra from coast inward — parents + cost.
      //   6. Per-spring path trace → connections.
      //   7. Watershed identity (union-find on shared parents).
      //   8. Polyline geometry per connection — Hermite cubic with
      //      junction-tangent matching, tapered wander + Laplacian
      //      smoothing. Subsegment spatial index.
      //   9. Primitive hydrology — climate-free max-extent pass.
      this._buildDeflectors();
      this._placeCoastEnds();
      this._placeLakeEnds();
      this._placeSprings();
      this._scoreSprings();
      this._buildStoneGraph();
      this._runReverseDijkstra();
      this._traceSpringPaths();
      this._resolveTreeIdentity();
      this._buildPolylines();
      this._computePrimitiveHydrology();
    }

    // ===== Helpers =====

    _isLand(x, z) {
      const ix = x | 0, iz = z | 0;
      if (ix < 0 || iz < 0 || ix >= this.mapW || iz >= this.mapH) return false;
      const lg = this.continent.landGrid;
      return lg[iz * this.mapW + ix] === 1;
    }

    _pushCandidate(x, z, type, extras) {
      const idx = this.candidates.length;
      const isEnd = (type !== 'spring');
      // Distance to nearest active orogen line (kind-agnostic — exact,
      // anchor-hint accelerated, not chamfer). Used by the outward-flow
      // rule in Dijkstra.
      const distToOrogen = this.tectonic.lines.getBoundaryDistancesAt(x, z).active;
      const c = {
        x, z, type, index: idx,
        color: endColor(idx),
        active: isEnd,
        score: 0,
        flow: 0,
        accumulatedFlow: 0,
        pairedTo: -1,
        distToOrogen,
      };
      if (extras) Object.assign(c, extras);
      this.candidates.push(c);
      if (type === 'spring') this.springIdxs.push(idx);
      else this.endIdxs.push(idx);
    }

    // ===== Deflectors =====
    // Walk every orogen segment's polyline (active AND fossil) at fine
    // arc-length spacing and emit one deflector per sample. Each carries a
    // circle whose radius scales with local widthMul × mapScale × activity
    // × deflectorInfluence. The mask is the union of all such circles —
    // future valleys / passes / gorges will subtract from it.
    _buildDeflectors() {
      const tec = this.tectonic;
      const segs = tec.lines.segments;
      if (!segs || !this.mapW || !this.mapH) return;
      const mask = new Uint8Array(this.mapW * this.mapH);
      const arcSpacing = 3;

      for (const seg of segs) {
        if (!seg || !seg.polyline || seg.onPerimeter) continue;
        const poly = seg.polyline;
        if (!poly.length || poly.length <= 0) continue;
        const isActive = !!seg.isActive;
        const baseWidth = isActive ? tec.orogenW : tec.fossilW;
        const radiusBase = baseWidth * this._mapScale * this._activity;
        const numSamples = Math.max(2, Math.floor(poly.length / arcSpacing));
        for (let i = 0; i < numSamples; i++) {
          const arcParam = (i + 0.5) / numSamples;
          const pos = tec.lines._polylinePosition(poly, arcParam);
          const widthMul = tec.lines.getProvinceWidthMultiplier(pos.x, pos.z);
          const radius = radiusBase * widthMul * this.deflectorInfluence;
          if (radius <= 0) continue;
          this.deflectors.push({ x: pos.x, z: pos.z, radius, isActive });
          this._paintCircle(mask, pos.x, pos.z, radius);
        }
      }

      this._deflectorMask = mask;
    }

    _paintCircle(mask, cx, cz, radius) {
      const r = Math.ceil(radius);
      const rSq = radius * radius;
      const mapW = this.mapW, mapH = this.mapH;
      const minX = Math.max(0, (cx - r) | 0);
      const maxX = Math.min(mapW - 1, (cx + r) | 0);
      const minZ = Math.max(0, (cz - r) | 0);
      const maxZ = Math.min(mapH - 1, (cz + r) | 0);
      for (let z = minZ; z <= maxZ; z++) {
        const dz = z + 0.5 - cz;
        const dzSq = dz * dz;
        if (dzSq > rSq) continue;
        const rowStart = z * mapW;
        for (let x = minX; x <= maxX; x++) {
          const dx = x + 0.5 - cx;
          if (dx * dx + dzSq <= rSq) mask[rowStart + x] = 1;
        }
      }
    }

    // ===== Coast ends =====
    // Every ocean Voronoi cell that touches at least one land cell
    // contributes ONE end at its centroid.
    _placeCoastEnds() {
      const continent = this.continent;
      const state = continent._cellState;
      const centroids = continent._cellCentroids;
      const neighbors = continent._cellNeighbors;
      if (!state || !centroids || !neighbors) return;

      for (let i = 0; i < state.length; i++) {
        if (state[i] > 0) continue;
        const nbs = neighbors[i];
        if (!nbs || nbs.size === 0) continue;

        let touchesLand = false;
        for (const ni of nbs) {
          if (state[ni] > 0) { touchesLand = true; break; }
        }
        if (!touchesLand) continue;

        const c = centroids[i];
        if (!c) continue;
        if (c.x < 0 || c.z < 0 || c.x >= this.mapW || c.z >= this.mapH) continue;

        this._pushCandidate(c.x, c.z, 'coast', { cellId: i });
      }
    }

    // ===== Lake-type stepping stones =====
    // `lakes.candidates` is the grid scatter of stepping stones (NOT
    // actual lakes — those are now an independent feature class in
    // `lakes.lakes`, decoupled from the river graph). Each candidate
    // becomes a 'lake'-type node in the routing graph.
    _placeLakeEnds() {
      if (!this.lakes) return;
      const cands = this.lakes.candidates || [];
      for (const cand of cands) {
        this._pushCandidate(cand.x, cand.z, 'lake');
      }
    }

    // ===== Springs =====
    // Hex-packed grid scatter with per-cell geo-density modulation AND a
    // platform band-fraction padding so springs sit safely away from band
    // edges:
    //
    //   1. Compute the cell's jittered position (deterministic from seed).
    //   2. Skip if off-map or in ocean.
    //   3. Skip if the province at the cell isn't Platform — springs spawn
    //      ONLY on platform.
    //   4. Skip if the pixel's fraction across platform (from the orogen
    //      side) falls outside [bandInner, bandOuter]. Default [0.30, 0.80]
    //      gives a 30% pad on the basin/ridge side and a 20% pad on the
    //      shield side. Picks active vs fossil orogen by closer chamfer dist.
    //   5. Roll a deterministic per-cell hash in [0, 1]. Keep the spring
    //      iff hash < geoNorm × geoInfluence. Geo-high cells (near active
    //      tectonic boundaries) get dense springs; low-geo cells get few.
    _placeSprings() {
      const PROVINCE_PLATFORM = 1; // provinces.js: 0 Shield, 1 Platform, 2 Orogen, ...
      const spacing = this.baseSpacing / Math.max(0.1, this.riverPoints);
      const rowSpacing = spacing * Math.sqrt(3) / 2;
      const jitterAmt = spacing * 0.07;
      const tec = this.tectonic;
      const climate = this.climate;
      const cellGrid = this.continent ? this.continent._cellGrid : null;
      const provMap = this.provinces ? this.provinces.primitiveMap : null;
      if (!climate || !climate.polygonClimates || !cellGrid || !provMap) return;

      let rowIdx = 0;
      for (let z = rowSpacing * 0.5; z < this.mapH; z += rowSpacing) {
        const xOff = (rowIdx % 2 === 0) ? 0 : spacing * 0.5;
        let colIdx = 0;
        for (let x = spacing * 0.5 + xOff; x < this.mapW; x += spacing) {
          const cellSeed = (this.worldSeed
            ^ Math.imul(rowIdx + 1, 0x9E3779B9)
            ^ Math.imul(colIdx + 1, 0xB7E15163)) | 0;
          const jx = (V.hash2d(rowIdx, colIdx, cellSeed) - 0.5) * jitterAmt * 2;
          const jz = (V.hash2d(rowIdx, colIdx, cellSeed ^ 0xABCDEF) - 0.5) * jitterAmt * 2;
          const px = x + jx;
          const pz = z + jz;
          colIdx++;
          if (px < 0 || pz < 0 || px >= this.mapW || pz >= this.mapH) continue;

          const ix = px | 0, iz = pz | 0;
          const pIdx = iz * this.mapW + ix;
          if (!this._isLand(ix, iz)) continue;
          if (provMap[pIdx] !== PROVINCE_PLATFORM) continue;

          // Platform band-fraction padding: keep only pixels whose
          // fraction across platform from the orogen side lies in
          // [bandInner, bandOuter]. Mirrors the band-math provinces /
          // upheaval use so the padding is consistent across maps.
          const bd = tec.lines.getBoundaryDistancesAt(px, pz);
          const dA = bd.active;
          const dF = bd.fossil;
          const isActive = dA <= dF;
          const d = isActive ? dA : dF;
          const widthMul = tec.lines.getProvinceWidthMultiplier(px, pz);
          const orogenW = isActive ? tec.orogenW : tec.fossilW;
          const basinW  = isActive ? tec.basinW  : tec.fossilBasinW;
          const platfW  = isActive ? tec.platformW : tec.fossilPlatformW;
          const basinEnd  = (orogenW * widthMul + basinW) * this._mapScale * this._activity;
          const platformW = platfW * this._mapScale * this._activity;
          if (platformW < 0.001) continue;
          const distIntoPlatform = d - basinEnd;
          if (distIntoPlatform < 0) continue;
          if (distIntoPlatform > platformW) continue;
          const frac = distIntoPlatform / platformW;
          if (frac < this.bandInner || frac > this.bandOuter) continue;

          // Geo-density roll.
          const cd = climate.polygonClimates[cellGrid[pIdx]];
          const geoNorm = cd ? (cd.geoByte / 255) : 0;
          const keepRoll = V.hash2d(rowIdx, colIdx, cellSeed ^ 0xFEDCBA);
          if (keepRoll > geoNorm * this.geoInfluence) continue;

          this._pushCandidate(px, pz, 'spring');
        }
        rowIdx++;
      }
    }

    // ===== Spring scoring =====
    // Per-spring initial flow = baseFlow + geoNorm × geoWeight. Every
    // spring is active by default (no activation gate). Future routing
    // will use this flow as the starting water budget for the walk.
    _scoreSprings() {
      const baseFlow = 0.2;
      const climate = this.climate;
      const cellGrid = this.continent ? this.continent._cellGrid : null;
      const provinces = this.provinces;
      const enclosedGrid = provinces ? provinces.enclosedGrid : null;
      const geoWeight = this.geoInfluence;
      for (const sIdx of this.springIdxs) {
        const s = this.candidates[sIdx];
        s.active = true;
        const i = (s.z | 0) * this.mapW + (s.x | 0);
        s.inEnclosedShield = !!(enclosedGrid && enclosedGrid[i] === 1);
        let geoNorm = 0;
        if (climate && climate.polygonClimates && cellGrid) {
          const cd = climate.polygonClimates[cellGrid[i]];
          if (cd) geoNorm = cd.geoByte / 255;
        }
        s.score = geoNorm * geoWeight;
        s.flow = baseFlow + s.score;
        s.accumulatedFlow = s.flow;
      }
    }

    // ===== Stone graph =====
    // Sparse adjacency between nearby graph nodes (springs + lakes + coast
    // endpoints). Edges are bidirectional. Cost = upheaval-weighted samples
    // along the straight segment between the two nodes. Ocean traversal is
    // only allowed if one endpoint is a coast node — otherwise rivers
    // can't cross water between non-coast nodes.
    //
    // Sphere-of-influence filter: each spring claims a small geometric
    // sphere of radius SOI_RADIUS. Any edge whose straight-line segment
    // passes within SOI_RADIUS of a spring that ISN'T one of its
    // endpoints is forbidden. This pushes trunk paths to detour around
    // dense spring areas instead of running through them, so the
    // resulting tributary connection naturally lands tangent to the
    // sphere (≈ perpendicular merge instead of obtuse).
    _buildStoneGraph() {
      // Edge ranges. PRIMARY_MAX is the "normal" radius (stage 1).
      // FALLBACK_MAX extends to stage 2a — longer edges allowed but
      // tagged as range violations.
      const PRIMARY_MAX = 80;
      const FALLBACK_MAX = 160;
      const BUCKET = FALLBACK_MAX;
      const primaryMaxSq = PRIMARY_MAX * PRIMARY_MAX;
      const fallbackMaxSq = FALLBACK_MAX * FALLBACK_MAX;

      const buckets = new Map();
      for (const c of this.candidates) {
        const bx = (c.x / BUCKET) | 0;
        const bz = (c.z / BUCKET) | 0;
        const key = bz * 100003 + bx;
        let arr = buckets.get(key);
        if (!arr) { arr = []; buckets.set(key, arr); }
        arr.push(c.index);
      }

      // Spring-only spatial index for SOI checks. SOI_RADIUS=50 — bigger
      // sphere so trunks deflect strongly around spring clusters instead
      // of threading between them. The 3×3 bucket check still covers
      // because BUCKET (160) > SOI_RADIUS (50).
      const springBuckets = new Map();
      for (const sIdx of this.springIdxs) {
        const s = this.candidates[sIdx];
        const bx = (s.x / BUCKET) | 0;
        const bz = (s.z / BUCKET) | 0;
        const key = bz * 100003 + bx;
        let arr = springBuckets.get(key);
        if (!arr) { arr = []; springBuckets.set(key, arr); }
        arr.push(sIdx);
      }
      const SOI_RADIUS = 50;
      const SOI_RADIUS_SQ = SOI_RADIUS * SOI_RADIUS;

      // Progressive-relaxation tiers. Stage 1 (tier 0) = standard
      // constraints — preferred when reachable. Stage 2a (tier 1) =
      // range relaxed; byte ceiling + SOI still active. Stage 2b
      // (tier 2) = byte ceiling also dropped. Stage 2c (tier 3) = SOI
      // also dropped (last resort). Each tier's multiplier is large
      // enough that any reachable tier-N path beats any tier-(N+1)
      // edge — orphans only use higher tiers when truly cut off.
      const TIER_MULT = [1, 10, 1000, 100000];

      const N = this.candidates.length;
      this._adjacency = new Array(N);
      for (let i = 0; i < N; i++) this._adjacency[i] = [];
      for (const c of this.candidates) {
        const bx = (c.x / BUCKET) | 0;
        const bz = (c.z / BUCKET) | 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const key = (bz + dz) * 100003 + (bx + dx);
            const arr = buckets.get(key);
            if (!arr) continue;
            for (const otherIdx of arr) {
              if (otherIdx <= c.index) continue;
              const o = this.candidates[otherIdx];
              // Springs are SOURCES, not waypoints — skip spring-to-spring
              // edges so rivers can't chain through other springs along the
              // tectonic line. Springs only connect to lakes / coast.
              if (c.type === 'spring' && o.type === 'spring') continue;
              const ddx = o.x - c.x, ddz = o.z - c.z;
              const dsq = ddx * ddx + ddz * ddz;
              if (dsq > fallbackMaxSq) continue;
              const result = this._edgeCost(c.x, c.z, o.x, o.z, c.type, o.type);
              if (!result) continue;
              const isRangeViolation = dsq > primaryMaxSq;
              const isByteViolation = result.byteViolation;
              const isSoiViolation = this._edgeViolatesSOI(
                c.x, c.z, o.x, o.z, c.index, otherIdx,
                springBuckets, BUCKET, SOI_RADIUS_SQ);
              let tier = 0;
              if (isRangeViolation) tier = 1;
              if (isByteViolation) tier = Math.max(tier, 2);
              if (isSoiViolation) tier = Math.max(tier, 3);
              const cost = result.baseCost * TIER_MULT[tier];
              this._adjacency[c.index].push({ to: otherIdx, cost });
              this._adjacency[otherIdx].push({ to: c.index, cost });
            }
          }
        }
      }
    }

    // Returns true if the segment (x1,z1)→(x2,z2) passes within
    // SOI_RADIUS of any spring that isn't one of its endpoints.
    // Geometric segment-to-point min-distance check in float coords.
    _edgeViolatesSOI(x1, z1, x2, z2, fromIdx, toIdx, springBuckets, BUCKET, soiRSq) {
      const dx = x2 - x1, dz = z2 - z1;
      const lenSq = dx * dx + dz * dz;
      const visited = new Set();
      const endpoints = [[x1, z1], [x2, z2]];
      for (const [ex, ez] of endpoints) {
        const bx = (ex / BUCKET) | 0;
        const bz = (ez / BUCKET) | 0;
        for (let ddz = -1; ddz <= 1; ddz++) {
          for (let ddx = -1; ddx <= 1; ddx++) {
            const key = (bz + ddz) * 100003 + (bx + ddx);
            if (visited.has(key)) continue;
            visited.add(key);
            const arr = springBuckets.get(key);
            if (!arr) continue;
            for (const sIdx of arr) {
              if (sIdx === fromIdx || sIdx === toIdx) continue;
              const s = this.candidates[sIdx];
              let cx, cz;
              if (lenSq < 1e-9) {
                cx = x1; cz = z1;
              } else {
                let t = ((s.x - x1) * dx + (s.z - z1) * dz) / lenSq;
                if (t < 0) t = 0; else if (t > 1) t = 1;
                cx = x1 + dx * t;
                cz = z1 + dz * t;
              }
              const ex2 = s.x - cx, ez2 = s.z - cz;
              if (ex2 * ex2 + ez2 * ez2 < soiRSq) return true;
            }
          }
        }
      }
      return false;
    }

    // Sample _primitiveAt along the straight segment from (x1,z1) to (x2,z2)
    // every ~2 px. Returns { baseCost, byteViolation } or null if the edge
    // is fundamentally invalid (out of map, or crosses ocean without a
    // coast endpoint).
    //
    // The byte-ceiling violation is reported as a FLAG, not a hard reject.
    // _buildStoneGraph uses this flag to assign the edge to a relaxation
    // tier — byte-violating edges are kept in the graph at much higher
    // cost, used only as orphan-rescue fallback.
    //
    // Cost shape: length^LENGTH_POWER + terrain × length.
    //   • Length is superlinear (power > 1) so two short hops covering the
    //     same straight-line distance beat one long direct hop. Rivers
    //     prefer near-coast intermediates over straight jumps to ocean.
    //   • Terrain stays linear: each pixel of high upheaval / orogen
    //     proximity adds cost per length regardless of total edge length.
    _edgeCost(x1, z1, x2, z2, fromType, toType) {
      const allowOcean = (fromType === 'coast' || toType === 'coast');
      const dx = x2 - x1, dz = z2 - z1;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const steps = Math.max(2, Math.ceil(dist / 2));
      const stepLen = dist / steps;
      const lg = this.continent.landGrid;
      const L = this.tectonic.lines;
      const mapW = this.mapW, mapH = this.mapH;

      const sx = x1 | 0, sz = z1 | 0;
      const ex = x2 | 0, ez = z2 | 0;
      if (sx < 0 || sz < 0 || sx >= mapW || sz >= mapH) return null;
      if (ex < 0 || ez < 0 || ex >= mapW || ez >= mapH) return null;
      const sIdx = sz * mapW + sx;
      const eIdx = ez * mapW + ex;
      const skd = L.getKindDistancesAt(x1, z1);
      const ekd = L.getKindDistancesAt(x2, z2);
      const startByte = this.upheaval._primitiveAt(x1, z1, skd.mtnActive, skd.mtnFossil, skd.riftActive, skd.riftFossil, lg[sIdx] === 1);
      const endByte   = this.upheaval._primitiveAt(x2, z2, ekd.mtnActive, ekd.mtnFossil, ekd.riftActive, ekd.riftFossil, lg[eIdx] === 1);
      // Tolerance 20: a platform spring (~50) gets ceiling ~70 — minor
      // noise OK but anything rising into basin (90+) or orogen (170+) is
      // flagged as a byte violation.
      const UPHILL_TOLERANCE = 20;
      const uphillCeiling = Math.max(startByte, endByte) + UPHILL_TOLERANCE;

      let length = 0;
      let terrainCost = 0;
      let byteViolation = false;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const px = x1 + dx * t;
        const pz = z1 + dz * t;
        const ix = px | 0, iz = pz | 0;
        if (ix < 0 || iz < 0 || ix >= mapW || iz >= mapH) return null;
        const pIdx = iz * mapW + ix;
        const isLand = lg[pIdx] === 1;
        if (!isLand && !allowOcean) return null;
        const kd = L.getKindDistancesAt(px, pz);
        const byte = this.upheaval._primitiveAt(px, pz, kd.mtnActive, kd.mtnFossil, kd.riftActive, kd.riftFossil, isLand);
        if (byte > uphillCeiling) byteViolation = true;
        // Orogen-proximity penalty: pixels near any orogen line get extra
        // cost. Discourages lateral motion along the platform band — paths
        // naturally bend away from orogen toward shield / coast. (min of all
        // 4 kinds == min(active, fossil) plain boundary distance — min
        // distributes over the partition either way.)
        const distOrogen = Math.min(kd.mtnActive, kd.mtnFossil, kd.riftActive, kd.riftFossil);
        const orogenPenalty = Math.max(0, 50 - distOrogen) / 5;
        length += stepLen;
        terrainCost += (Math.max(0, byte - 60) / 20 + orogenPenalty) * stepLen;
      }
      const LENGTH_POWER = 1.5;
      const baseCost = Math.pow(length, LENGTH_POWER) + terrainCost;
      return { baseCost, byteViolation };
    }

    // Reverse Dijkstra from all coast endpoints inward. Each node ends up
    // with cost-to-ocean + parent (the neighbour it would step toward).
    _runReverseDijkstra() {
      const N = this.candidates.length;
      this._costToOcean = new Float64Array(N);
      this._parentNode = new Int32Array(N);
      for (let i = 0; i < N; i++) {
        this._costToOcean[i] = Infinity;
        this._parentNode[i] = -1;
      }
      // Binary min-heap of {c, idx}. Parallel arrays.
      const heapC = [];
      const heapI = [];
      const hPush = (c, idx) => {
        let i = heapC.length;
        heapC.push(c); heapI.push(idx);
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (heapC[p] <= heapC[i]) break;
          let t = heapC[i]; heapC[i] = heapC[p]; heapC[p] = t;
          t = heapI[i]; heapI[i] = heapI[p]; heapI[p] = t;
          i = p;
        }
      };
      const hPop = () => {
        const topC = heapC[0], topI = heapI[0];
        const lastC = heapC.pop(), lastI = heapI.pop();
        if (heapC.length > 0) {
          heapC[0] = lastC; heapI[0] = lastI;
          let i = 0;
          const n = heapC.length;
          for (;;) {
            const l = 2 * i + 1, r = 2 * i + 2;
            let s = i;
            if (l < n && heapC[l] < heapC[s]) s = l;
            if (r < n && heapC[r] < heapC[s]) s = r;
            if (s === i) break;
            let t = heapC[i]; heapC[i] = heapC[s]; heapC[s] = t;
            t = heapI[i]; heapI[i] = heapI[s]; heapI[s] = t;
            i = s;
          }
        }
        return { c: topC, idx: topI };
      };
      // Seed: coast endpoints at cost 0.
      for (let i = 0; i < N; i++) {
        if (this.candidates[i].type === 'coast') {
          this._costToOcean[i] = 0;
          hPush(0, i);
        }
      }

      // Spring-first-hop outward rule. When the relaxed node is a
      // SPRING, the parent (idx, downstream) must be at least as far
      // from the nearest active orogen line as the spring itself.
      // Otherwise the river's very first hop would point INWARD —
      // toward the tectonic feature it spawned next to. The rule
      // applies ONLY to spring relaxations: lake-to-anything and
      // coast-to-anything are unconstrained, so enclosed basins still
      // drain through saddle crossings (byte-ceiling permitting) via
      // lake-to-lake-across-saddle paths.
      //
      // The distance-to-orogen reference (getBoundaryDistancesAt) is
      // computed from the polyline geometry regardless of land/water,
      // so submarine orogen extensions still register — a coast
      // endpoint sitting close to an underwater tectonic line is
      // recognised as "near the line" even though the terrain above
      // is byte-0 ocean.
      while (heapC.length > 0) {
        const { c, idx } = hPop();
        if (c > this._costToOcean[idx]) continue;
        // Spring-as-leaf rule. Springs are pure sources: they have their
        // own parent (set by some non-spring node relaxing INTO them,
        // upstream-of-coast), but no node can use a spring as its
        // parent. Skip extending from springs so trunks never route
        // THROUGH a spring's position.
        const iCand = this.candidates[idx];
        if (iCand.type === 'spring') continue;
        const iDist = iCand.distToOrogen;
        for (const edge of this._adjacency[idx]) {
          const nc = c + edge.cost;
          if (nc < this._costToOcean[edge.to]) {
            const jCand = this.candidates[edge.to];
            if (jCand.type === 'spring' && iDist < jCand.distToOrogen) continue;
            this._costToOcean[edge.to] = nc;
            this._parentNode[edge.to] = idx;
            hPush(nc, edge.to);
          }
        }
      }
    }

    // Walk each spring's parent chain to ocean, emitting connections.
    // Dedup by (from→to) pair so trunks shared by multiple springs aren't
    // emitted multiple times. Spring count per edge → flow placeholder
    // (proxy for "how many springs feed this segment").
    _traceSpringPaths() {
      const edgeCount = new Map();
      // First pass: count spring traversals per edge.
      for (const sIdx of this.springIdxs) {
        if (!isFinite(this._costToOcean[sIdx])) continue;
        let current = sIdx;
        while (this._parentNode[current] >= 0) {
          const parent = this._parentNode[current];
          const key = current * 200003 + parent;
          edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
          current = parent;
          if (this.candidates[current].type === 'coast') break;
        }
      }
      // Second pass: emit each unique edge once with accumulated count.
      const emitted = new Set();
      for (const sIdx of this.springIdxs) {
        const spring = this.candidates[sIdx];
        if (!isFinite(this._costToOcean[sIdx])) {
          spring.active = false;
          spring.isOrphan = true;
          continue;
        }
        spring.active = true;
        let current = sIdx;
        while (this._parentNode[current] >= 0) {
          const parent = this._parentNode[current];
          const key = current * 200003 + parent;
          if (!emitted.has(key)) {
            emitted.add(key);
            const count = edgeCount.get(key) || 1;
            this.connections.push({
              fromIdx: current,
              toIdx: parent,
              flow: count * 0.5,
              velocity: 0,
              watershed: -1,
              isCrossing: false,
              isMerge: false,
            });
          }
          current = parent;
          if (this.candidates[current].type === 'coast') break;
        }
      }
    }

    // Union-find on shared non-coast nodes. Two springs share a watershed
    // iff their parent chains visit any common non-coast node. Stellar
    // formations (paths that only converge at a coast endpoint) stay as
    // separate watersheds — coast nodes don't bridge trees.
    _resolveTreeIdentity() {
      const N = this.candidates.length;
      const uf = new Int32Array(N);
      for (let i = 0; i < N; i++) uf[i] = i;
      const find = (x) => {
        while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; }
        return x;
      };
      const union = (a, b) => {
        const ra = find(a), rb = find(b);
        if (ra === rb) return;
        if (ra < rb) uf[rb] = ra; else uf[ra] = rb;
      };
      const visitedBy = new Int32Array(N).fill(-1);
      for (const sIdx of this.springIdxs) {
        if (!isFinite(this._costToOcean[sIdx])) continue;
        let current = sIdx;
        while (current >= 0) {
          const node = this.candidates[current];
          if (node.type === 'coast') break;
          const prev = visitedBy[current];
          if (prev >= 0 && prev !== sIdx) union(sIdx, prev);
          visitedBy[current] = sIdx;
          current = this._parentNode[current];
        }
      }
      // Each spring's pairedTo = its watershed root (a spring index).
      for (const sIdx of this.springIdxs) {
        const spring = this.candidates[sIdx];
        if (!isFinite(this._costToOcean[sIdx])) { spring.pairedTo = -1; continue; }
        spring.pairedTo = find(sIdx);
      }
      // Each connection's watershed = root of a spring that traversed it.
      for (const conn of this.connections) {
        const from = this.candidates[conn.fromIdx];
        if (from.type === 'spring') {
          conn.watershed = find(conn.fromIdx);
        } else {
          const visitor = visitedBy[conn.fromIdx];
          conn.watershed = visitor >= 0 ? find(visitor) : conn.fromIdx;
        }
      }
    }

    // ===== Polyline geometry =====
    // Replace each connection's implicit straight-line geometry with an
    // explicit multi-vertex polyline that flows smoothly through the
    // node graph:
    //
    //   1. HERMITE CUBIC BASELINE with tangent matching at endpoints.
    //      For a connection X→Y the curve uses:
    //        T0 (tangent at X) = direction X→Y itself, length =
    //          TANGENT_SCALE × |XY|. We leave X heading straight toward
    //          Y — natural start.
    //        T1 (tangent at Y) = direction Y→parent(Y), length =
    //          TANGENT_SCALE × |XY|. We ARRIVE at Y heading along the
    //          same direction Y's outgoing polyline LEAVES Y — tangents
    //          matched (asymptotically — O(1/N²) error for finite N)
    //          across consecutive polylines at a junction. The small
    //          residual error is washed by the smoothing pass below.
    //        Coast termini (no parent): T1 = T0. Straight termination.
    //
    //   2. PERPENDICULAR WANDER on top of the Hermite samples,
    //      deterministic from a per-connection hash. Amplitude is
    //      tapered by a sin²(π·t) window — wander is ~0 near endpoints
    //      and full in the middle. Preserves Hermite tangent direction
    //      cleanly at joints while letting curve character live in the
    //      middle. Without this, polylines between collinear connection
    //      points collapse to straight lines (Hermite has no tangent
    //      mismatch to bend through).
    //
    //   3. LAPLACIAN SMOOTHING, K passes, alpha shaped by flow ratio
    //      with a floor — trunks barely smooth, leaves smooth more,
    //      but trunks still get a baseline pass. Washes the wobble
    //      into a smooth curve and softens the residual junction
    //      angles from the asymptotic Hermite error.
    //
    // No endpoint pin — analysis showed it traded small junction
    // angles for larger interior kinks one vertex inside (for L-shape
    // routing: junction angle drops by 15° but vertex[N-1]→vertex[N-2]
    // angle JUMPS by ~40°). Net negative. The smoothing pass handles
    // junction residuals more cheaply.
    //
    // Units are COORD UNITS (continuous floats; 1 unit = 32 in-game
    // blocks per `TerraGenConfig.oceanMapScale`). The visualiser
    // happens to render 1 coord unit per pixel for debugging.
    //
    // Constants are baked (per the no-excessive-sliders rule); tune by
    // eye if output reads wrong.
    _buildPolylines() {
      if (!this.connections.length) return;

      const STEP = 1;                  // subdivision step. Smaller =
                                       // finer-grained polyline → last
                                       // subsegment direction closes
                                       // in on the exact Hermite
                                       // endpoint tangent (error scales
                                       // as 1/N). At STEP=1, junction
                                       // corner residuals are ~5° for
                                       // 90° turns — sub-visual.
      const WOBBLE_AMP = 1.0;          // absolute perpendicular jitter
                                       // amplitude in coord units
                                       // (decoupled from STEP so wander
                                       // character stays consistent
                                       // when STEP changes).
      const WOBBLE_WAVELENGTH = 3;     // coord units between wobble
                                       // hash samples. Sampling is
                                       // smoothstep-interpolated
                                       // between samples — wobble
                                       // frequency stays at this
                                       // wavelength regardless of STEP,
                                       // so finer STEP doesn't make
                                       // wobble jagged.
      const SMOOTH_PASSES = 3;
      const SMOOTH_ALPHA_K = 0.5;
      const SMOOTH_ALPHA_FLOOR = 0.3;  // ensures trunks still smooth.
                                       // Without it, a chain with no
                                       // merges has flowRatio = 1 for
                                       // every connection → alpha = 0
                                       // → wander shows through raw.
      const TANGENT_SCALE = 0.5;       // Hermite endpoint tangent
                                       // magnitude as fraction of |XY|.
                                       // Smaller = tighter bend near
                                       // endpoint, larger = wider S.

      let maxFlow = 0;
      for (const conn of this.connections) {
        if (conn.flow > maxFlow) maxFlow = conn.flow;
      }
      if (maxFlow < 0.001) maxFlow = 1;

      for (const conn of this.connections) {
        const from = this.candidates[conn.fromIdx];
        const to   = this.candidates[conn.toIdx];
        const dx = to.x - from.x;
        const dz = to.z - from.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        // Too short to subdivide — just the two endpoints.
        if (dist < STEP * 2) {
          conn.polyline = [
            { x: from.x, z: from.z },
            { x: to.x,   z: to.z   },
          ];
          continue;
        }

        const N = Math.max(2, Math.ceil(dist / STEP));

        // Hermite endpoint tangents (see header comment).
        const T0x = dx * TANGENT_SCALE;
        const T0z = dz * TANGENT_SCALE;

        let T1x = dx * TANGENT_SCALE;
        let T1z = dz * TANGENT_SCALE;
        const parentOfTo = this._parentNode[conn.toIdx];
        if (to.type !== 'coast' && parentOfTo >= 0) {
          const parent = this.candidates[parentOfTo];
          const pdx = parent.x - to.x;
          const pdz = parent.z - to.z;
          const plen = Math.sqrt(pdx * pdx + pdz * pdz);
          if (plen > 0.001) {
            T1x = (pdx / plen) * dist * TANGENT_SCALE;
            T1z = (pdz / plen) * dist * TANGENT_SCALE;
          }
        }

        const polyline = new Array(N + 1);
        polyline[0] = { x: from.x, z: from.z };
        polyline[N] = { x: to.x,   z: to.z   };

        const connSeed = (this.worldSeed
          ^ Math.imul(conn.fromIdx + 1, 0x9E3779B9)
          ^ Math.imul(conn.toIdx + 1,   0xB7E15163)) | 0;

        // Interior vertex layout — Hermite baseline + tapered
        // perpendicular wander relative to the local tangent.
        // P(t) = h00·P0 + h10·T0 + h01·P1 + h11·T1.
        for (let i = 1; i < N; i++) {
          const t = i / N;
          const t2 = t * t;
          const t3 = t2 * t;
          const h00 = 2 * t3 - 3 * t2 + 1;
          const h10 = t3 - 2 * t2 + t;
          const h01 = -2 * t3 + 3 * t2;
          const h11 = t3 - t2;
          const baseX = h00 * from.x + h10 * T0x + h01 * to.x + h11 * T1x;
          const baseZ = h00 * from.z + h10 * T0z + h01 * to.z + h11 * T1z;

          const prev = polyline[i - 1];
          let tx = baseX - prev.x;
          let tz = baseZ - prev.z;
          const tlen = Math.sqrt(tx * tx + tz * tz);
          if (tlen > 0.001) {
            tx /= tlen; tz /= tlen;
          } else {
            // Degenerate — fall back to global X→Y direction.
            tx = dx / dist; tz = dz / dist;
          }

          // Perpendicular = tangent rotated 90° CCW.
          const perpX = -tz;
          const perpZ = tx;

          // Wobble sample at coord-unit intervals of WOBBLE_WAVELENGTH,
          // smoothstep-interpolated. Decouples wobble frequency from
          // STEP so finer subdivision doesn't make wobble jagged.
          const wobbleSamplePos = (i * STEP) / WOBBLE_WAVELENGTH;
          const wobbleA = Math.floor(wobbleSamplePos);
          const blendT = wobbleSamplePos - wobbleA;
          const blendSmooth = blendT * blendT * (3 - 2 * blendT);
          const hA = V.hash2d(wobbleA, 0, connSeed);
          const hB = V.hash2d(wobbleA + 1, 0, connSeed);
          const h = hA * (1 - blendSmooth) + hB * blendSmooth;
          const signedOffset = (h - 0.5) * 2;          // [-1, +1]
          // sin²(π·t) window — 0 at endpoints, 1 in the middle.
          const taperBase = Math.sin(Math.PI * t);
          const taper = taperBase * taperBase;
          const offset = signedOffset * WOBBLE_AMP * taper;

          polyline[i] = {
            x: baseX + perpX * offset,
            z: baseZ + perpZ * offset,
          };
        }

        // Laplacian smoothing, endpoints pinned. alpha shaped by flow
        // ratio with a floor so trunks still get a baseline pass.
        const flowRatio = Math.min(1, conn.flow / maxFlow);
        const alpha = SMOOTH_ALPHA_K * Math.max(SMOOTH_ALPHA_FLOOR,
          1 - Math.pow(flowRatio, 0.3));

        for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
          const ox = new Float64Array(N + 1);
          const oz = new Float64Array(N + 1);
          for (let i = 0; i <= N; i++) {
            ox[i] = polyline[i].x;
            oz[i] = polyline[i].z;
          }
          for (let i = 1; i < N; i++) {
            polyline[i].x = ox[i] + alpha * ((ox[i - 1] + ox[i + 1]) / 2 - ox[i]);
            polyline[i].z = oz[i] + alpha * ((oz[i - 1] + oz[i + 1]) / 2 - oz[i]);
          }
        }

        conn.polyline = polyline;
      }

      this._buildSubsegmentIndex();
    }

    // Bucket grid over polyline subsegments, keyed by midpoint. 15
    // coord-unit cell — small enough that a 3×3 neighbour scan covers
    // any feature within ~22 units. Future consumers (warped-coast
    // clip, carving, overlap checks) read this index for nearest-
    // segment lookups.
    _buildSubsegmentIndex() {
      const CELL = 15;
      this._segGridCellSize = CELL;
      this._segGridCols = Math.ceil(this.mapW / CELL) + 4;
      this._segGridRows = Math.ceil(this.mapH / CELL) + 4;
      this._segGridOff = 2;
      const len = this._segGridCols * this._segGridRows;
      this._segGrid = new Array(len);
      for (let i = 0; i < len; i++) this._segGrid[i] = [];

      for (let ci = 0; ci < this.connections.length; ci++) {
        const conn = this.connections[ci];
        if (!conn.polyline) continue;
        for (let si = 0; si < conn.polyline.length - 1; si++) {
          const a = conn.polyline[si];
          const b = conn.polyline[si + 1];
          const mx = (a.x + b.x) * 0.5;
          const mz = (a.z + b.z) * 0.5;
          const gcx = Math.floor(mx / CELL) + this._segGridOff;
          const gcz = Math.floor(mz / CELL) + this._segGridOff;
          if (gcx >= 0 && gcx < this._segGridCols && gcz >= 0 && gcz < this._segGridRows) {
            this._segGrid[gcz * this._segGridCols + gcx].push({ connIdx: ci, segIdx: si });
          }
        }
      }
    }

    // ===== Primitive hydrology =====
    // Climate-free, max-extent pass. Topo-walks the tree (descending
    // costToOcean): each spring contributes its initial flow into the
    // chain; each downstream node combines inflows. Velocity evolves
    // per segment by `INERTIA × prior + slope × SLOPE_GAIN` (slope
    // from endpoint upheaval bytes — primitive).
    //
    // Lakes are NO LONGER part of the river graph — they're an
    // independent primitive feature class in `lakes.lakes` (see
    // lakes.js). Lake-type checkpoints here are pure stepping stones
    // for routing + data interpolation; they don't pool, don't form
    // basins, don't classify as wet/dry.
    //
    // Per the primitive=max-extent rule: NO rain, NO evap, NO climate
    // sampling. Every segment is LIVE for its full polyline length.
    // The detail-water pass (queued, needs `climate.getSmoothedAt`)
    // applies climate via `swirl.pixelAt → climate.getSmoothedAt` to
    // mark wet/dry per subsegment.
    _computePrimitiveHydrology() {
      const N = this.candidates.length;
      const candidates = this.candidates;

      const INERTIA = 0.7;
      const INITIAL_V = 1.0;
      const SLOPE_GAIN = 5.0;

      // Reset per-candidate state (overwriting placeholders).
      for (const c of candidates) {
        c.accumulatedFlow = 0;
        c._velAccum = 0;
        c.isWet = false;
        c.outFlow = 0;
        c.outVelocity = 0;
        c.maxOutgoingVelocity = 0;
        c.maxIncomingVelocity = 0;
      }

      // Springs start with their initial quantity and velocity.
      for (const sIdx of this.springIdxs) {
        const s = candidates[sIdx];
        s.accumulatedFlow = s.flow;
        s._velAccum = s.flow * INITIAL_V;
        s.maxOutgoingVelocity = INITIAL_V;
      }

      // Build connection lookup for per-segment liveLength updates.
      const connByPair = new Map();
      for (const conn of this.connections) {
        connByPair.set(conn.fromIdx * 200003 + conn.toIdx, conn);
        conn.flow = 0;          // overwrite count×0.5 placeholder
        conn.velocity = 0;
        conn.liveLength = 0;
        conn.liveFraction = 0;
      }

      // Sort processable candidates by costToOcean descending (springs
      // furthest, coast nearest). Skip orphans (Infinity cost).
      const sortedIdxs = [];
      for (let i = 0; i < N; i++) {
        if (isFinite(this._costToOcean[i])) sortedIdxs.push(i);
      }
      sortedIdxs.sort((a, b) => this._costToOcean[b] - this._costToOcean[a]);

      for (const idx of sortedIdxs) {
        const c = candidates[idx];
        const parentIdx = this._parentNode[idx];
        if (parentIdx < 0) continue;
        const parent = candidates[parentIdx];

        // Determine incoming quantity / velocity at this node.
        let q_in, v_in;
        if (c.type === 'spring') {
          q_in = c.flow;
          v_in = INITIAL_V;
        } else {
          q_in = c.accumulatedFlow;
          v_in = c.accumulatedFlow > 0 ? c._velAccum / c.accumulatedFlow : 0;
        }
        c.maxIncomingVelocity = v_in;

        // Lake-type checkpoints pass flow through unchanged — they're
        // routing stones, not water bodies. Quantity / velocity
        // continue downstream untouched.
        const q_out = q_in;
        const v_out = v_in;
        c.outFlow = q_out;
        c.outVelocity = v_out;
        c.maxOutgoingVelocity = v_out;
        c.isWet = q_in > 0;

        // Walk the connection's polyline from c (upstream) to parent
        // (downstream). Primitive pass: no rain/evap, so quantity is
        // unchanged along the polyline; velocity evolves per segment
        // via endpoint slope. Every segment is LIVE for its full
        // polyline length.
        const conn = connByPair.get(idx * 200003 + parentIdx);
        if (!conn) continue;
        const walk = this._walkPolylineHydrology(conn, q_out, v_out,
          INERTIA, SLOPE_GAIN);

        conn.flow = walk.qAtEnd;
        conn.velocity = walk.vAtEnd;
        conn.liveLength = walk.liveLength;
        conn.liveFraction = walk.dist > 0 ? walk.liveLength / walk.dist : 0;

        if (walk.qAtEnd > 0) {
          parent.accumulatedFlow += walk.qAtEnd;
          parent._velAccum += walk.qAtEnd * walk.vAtEnd;
        }
      }

      // Finalize isWet for all candidates that received water.
      for (const c of candidates) {
        if (c.accumulatedFlow > 0) c.isWet = true;
      }
    }

    // Walk the connection's polyline subsegment by subsegment. Primitive
    // pass: no rain/evap sampling — quantity is unchanged across the
    // walk (`qAtEnd = q0`) and the entire polyline is LIVE for its
    // full length (`liveLength = totalDist`). Velocity evolves once
    // per connection from endpoint upheaval-byte slope. Function still
    // walks the polyline to compute total length (sum of subsegment
    // lengths, slightly longer than the straight-line distance because
    // of wander) — the live fraction is reported against the polyline
    // length so the renderer's fraction-based drawing is consistent.
    //
    // When the detail-water pass lands, a sibling `_walkPolylineDetail`
    // will sample warped + smoothed climate per pixel along the same
    // polyline and produce wet/dry overlays.
    _walkPolylineHydrology(conn, q0, v0, INERTIA, SLOPE_GAIN) {
      const polyline = conn.polyline;
      if (!polyline || polyline.length < 2 || q0 <= 0) {
        return { qAtEnd: q0, vAtEnd: v0, liveLength: 0, dist: 0 };
      }

      let totalDist = 0;
      for (let si = 0; si < polyline.length - 1; si++) {
        const a = polyline[si];
        const b = polyline[si + 1];
        const ldx = b.x - a.x;
        const ldz = b.z - a.z;
        totalDist += Math.sqrt(ldx * ldx + ldz * ldz);
      }
      if (totalDist < 1e-6) {
        return { qAtEnd: q0, vAtEnd: v0, liveLength: 0, dist: 0 };
      }

      // Endpoint slope (positive = descending). Slope reads connection
      // endpoint upheaval bytes — wander shouldn't fake elevation.
      const fromCand = this.candidates[conn.fromIdx];
      const toCand   = this.candidates[conn.toIdx];
      const lg = this.continent.landGrid;
      const L = this.tectonic.lines;
      const mapW = this.mapW, mapH = this.mapH;
      const sx = fromCand.x | 0, sz = fromCand.z | 0;
      const ex = toCand.x | 0,   ez = toCand.z | 0;
      let startByte = 0, endByte = 0;
      if (sx >= 0 && sz >= 0 && sx < mapW && sz < mapH) {
        const sIdx = sz * mapW + sx;
        const skd = L.getKindDistancesAt(fromCand.x, fromCand.z);
        startByte = this.upheaval._primitiveAt(fromCand.x, fromCand.z,
          skd.mtnActive, skd.mtnFossil, skd.riftActive, skd.riftFossil, lg[sIdx] === 1);
      }
      if (ex >= 0 && ez >= 0 && ex < mapW && ez < mapH) {
        const eIdx = ez * mapW + ex;
        const ekd = L.getKindDistancesAt(toCand.x, toCand.z);
        endByte = this.upheaval._primitiveAt(toCand.x, toCand.z,
          ekd.mtnActive, ekd.mtnFossil, ekd.riftActive, ekd.riftFossil, lg[eIdx] === 1);
      }
      const slope = Math.max(0, (startByte - endByte) / totalDist);

      const vAtEnd = v0 * INERTIA + slope * SLOPE_GAIN;
      return { qAtEnd: q0, vAtEnd, liveLength: totalDist, dist: totalDist };
    }

    // Pre-compute per-vertex water level along each connection's polyline.
    // Per connection: startByte = primitiveByte at fromCand, endByte =
    // primitiveByte at toCand. Per polyline vertex: waterLevel = linear lerp
    // from startByte to endByte across (numVertices - 1). Junctions stay
    // consistent automatically: a junction node X has the same byte read by
    // every incoming tributary's end and every outgoing trunk's start, so
    // levels match across the join.
    //
    // Called from ui.js after upheaval.generate() (needs primitiveMap).
    _computeWaterLevels(upheaval) {
      if (!upheaval || !upheaval.primitiveMap) return;
      const mapW = upheaval.p.mapW, mapH = upheaval.p.mapH;
      const primMap = upheaval.primitiveMap;

      for (let ci = 0; ci < this.connections.length; ci++) {
        const conn = this.connections[ci];
        if (!conn || !conn.polyline || conn.polyline.length === 0) continue;
        const fromCand = this.candidates[conn.fromIdx];
        const toCand   = this.candidates[conn.toIdx];
        if (!fromCand || !toCand) continue;

        const fx = fromCand.x | 0, fz = fromCand.z | 0;
        const tx = toCand.x   | 0, tz = toCand.z   | 0;
        let startByte = 0, endByte = 0;
        if (fx >= 0 && fz >= 0 && fx < mapW && fz < mapH) {
          startByte = primMap[fz * mapW + fx];
        }
        if (tx >= 0 && tz >= 0 && tx < mapW && tz < mapH) {
          endByte = primMap[tz * mapW + tx];
        }

        const poly = conn.polyline;
        const n = poly.length;
        if (n === 1) {
          poly[0].waterLevel = startByte;
          continue;
        }
        for (let vi = 0; vi < n; vi++) {
          const t = vi / (n - 1);
          poly[vi].waterLevel = startByte + (endByte - startByte) * t;
        }
      }
    }

    // River carve contribution at (x, z) for the detail upheaval composition.
    // Returns a POSITIVE byte to SUBTRACT from preRiverByte. Carve adapts:
    //   - DEPTH driven by river WATER LEVEL (descending from spring byte at
    //     the upstream end to coast byte 0 downstream). Channel floor =
    //     waterLevel − BED_DEPTH. Carve = preRiverByte − channelFloor.
    //     Shallow channel where terrain ≈ water level (lowlands); deep gorge
    //     where terrain rises above water level (mountain crossings).
    //   - WIDTH driven by band at the segment midpoint (shield = wide
    //     shallow valley; orogen = narrow deep gorge) × accumulatedFlow
    //     scaling (narrow at spring, wider toward coast).
    //
    // Smoothstep cross-section: carve is deepest at spine, ramps to 0 at
    // the valley edge.
    contributionAt(x, z, preRiverByte, upheaval) {
      if (!this._segGrid || !upheaval || !upheaval.primitiveMap) return 0;
      const CELL = this._segGridCellSize;
      const gcx = Math.floor(x / CELL) + this._segGridOff;
      const gcz = Math.floor(z / CELL) + this._segGridOff;
      const mapW = upheaval.p.mapW, mapH = upheaval.p.mapH;
      const primMap = upheaval.primitiveMap;
      const BED_DEPTH = 5;  // small offset below water surface
      let maxCarve = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ci = gcz + dz, cj = gcx + dx;
          if (ci < 0 || ci >= this._segGridRows ||
              cj < 0 || cj >= this._segGridCols) continue;
          const bucket = this._segGrid[ci * this._segGridCols + cj];
          for (let k = 0; k < bucket.length; k++) {
            const ref = bucket[k];
            const conn = this.connections[ref.connIdx];
            if (!conn || !conn.polyline) continue;
            const a = conn.polyline[ref.segIdx];
            const b = conn.polyline[ref.segIdx + 1];
            if (!a || !b) continue;
            const sdx = b.x - a.x, sdz = b.z - a.z;
            const segLenSq = sdx * sdx + sdz * sdz;
            if (segLenSq < 0.001) continue;
            const px = x - a.x, pz = z - a.z;
            let t = (px * sdx + pz * sdz) / segLenSq;
            if (t < 0) t = 0;
            else if (t > 1) t = 1;
            const projX = a.x + t * sdx;
            const projZ = a.z + t * sdz;
            const ddx = x - projX;
            const ddz = z - projZ;
            const perpSq = ddx * ddx + ddz * ddz;

            // WIDTH from band at segment midpoint + flow scaling.
            const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
            const mix = mx | 0, miz = mz | 0;
            const bandByte = (mix >= 0 && miz >= 0 && mix < mapW && miz < mapH)
              ? primMap[miz * mapW + mix]
              : 50;
            let valleyWidth;
            if (bandByte >= 225)      valleyWidth = 1.5;  // orogen / rift
            else if (bandByte >= 170) valleyWidth = 2.0;  // fossil orogen
            else if (bandByte >= 130) valleyWidth = 2.5;  // extended crust
            else if (bandByte >=  90) valleyWidth = 3.0;  // basin
            else if (bandByte >=  50) valleyWidth = 3.5;  // platform
            else                      valleyWidth = 4.0;  // shield / sea-level
            const flow = conn.accumulatedFlow || 0;
            const flowScale = Math.min(1.4, Math.max(0.4, 0.4 + flow * 0.25));
            const w = valleyWidth * flowScale;
            if (perpSq >= w * w) continue;
            const perpDist = Math.sqrt(perpSq);

            // DEPTH from water level (per-vertex pre-computed by
            // _computeWaterLevels). Lerp between subsegment endpoints.
            const waterA = (a.waterLevel !== undefined) ? a.waterLevel : 0;
            const waterB = (b.waterLevel !== undefined) ? b.waterLevel : 0;
            const waterLevel = waterA + (waterB - waterA) * t;
            const channelFloor = waterLevel - BED_DEPTH;
            // Carve removes terrain above channel floor. If terrain is
            // already below floor (river surface above land — happens near
            // spring before river entrenches), carve = 0.
            const desiredCarve = Math.max(0, preRiverByte - channelFloor);

            // Smoothstep cross-section: full carve at spine, 0 at edge.
            const s = 1 - perpDist / w;
            const shape = s * s * (3 - 2 * s);
            const carve = desiredCarve * shape;
            if (carve > maxCarve) maxCarve = carve;
          }
        }
      }
      return maxCarve;
    }
  }

  V.RiverNetworks = RiverNetworks;
  V.riverEndColor = endColor;

})(window.VIS);
