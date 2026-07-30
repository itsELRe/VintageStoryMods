// tectonic-lines.js — TectonicLines (segment-context primitive)
//
// The shared "where am I relative to a tectonic line" primitive, lifted out of
// TectonicModel into its own subsystem file. Built from the plate net's
// boundary masks + seed grid; owns junctions, segments, polylines, joint nodes,
// per-segment collision intensity, the exact per-anchor kind-distance hints, the
// segment-context grids, and the province-width "breathing" grid. Read by
// ridges, rivers, upheaval, climate, and the province rule via `tectonic.lines.*`.
//
// It copies the plate-net state it needs from the TectonicModel using the SAME
// field names, so the methods below are verbatim moves (their `this.*` reads
// resolve against this object's copies). It owns its own noise fields.

window.VIS = window.VIS || {};

(function (V) {

  // Outward border normals for the four map sides [W, E, N, S] — the
  // structural "facing" of an edge line toward its phantom plate.
  const EDGE_NORMALS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  class TectonicLines {
    constructor(tec) {
      // Plate-net state copied from the model (same names → verbatim methods).
      this.mapW = tec.mapW;
      this.mapH = tec.mapH;
      this.seed = tec.seed;
      this.gridSpacing = tec.gridSpacing;
      this.allSeeds = tec.allSeeds;
      this._seedGrid = tec._seedGrid;
      this._seedGridStep = tec._seedGridStep;
      this._seedGridGw = tec._seedGridGw;
      this._seedGridGh = tec._seedGridGh;
      this.activeBoundaryGrid = tec.activeBoundaryGrid;
      this.fossilBoundaryGrid = tec.fossilBoundaryGrid;
      this.provinceWarpPower = tec.provinceWarpPower;
      this.orogenW = tec.orogenW;
      this.basinW = tec.basinW;
      this.platformW = tec.platformW;
      this.extendedCrustWidth = tec.extendedCrustWidth;
      this.widthFloor = tec.widthFloor;
      this._mapScale = V.phiScale(Math.max(this.mapW, this.mapH));
      // Real-distance ramp length for the trapezoid width profile
      // (bandProfileAt): how far from a joint an arm takes to relax from the
      // shared joint width to its own. Segments shorter than two ramps
      // degrade to a pure trapezoid between their two joint values.
      this._jointRampLen = this.gridSpacing * 0.35;
      // Plate motion vectors + speed range (spec §3.1) — read by
      // computeCollisionIntensity below. plateVectors is by plateId (active
      // boundaries); fossil vectors ride on allSeeds[i].vec (already copied).
      this.plateVectors = tec.plateVectors;
      this._edgePhantomVectors = tec.edgePhantomVectors;
      this._plateSpeedMax = tec.plateSpeedMax;
      this.transformThreshold = tec.transformThreshold;

      // Province width-warp broad noise field (keys off the tectonic seed + grid
      // spacing). Feeds getProvinceWidthMultiplier — consumed by ridge/river
      // feature widths.
      const broadFreq = 1 / (this.gridSpacing * 0.5);
      this._provinceWarpBroad = V.createFBM(this.seed + 9999, broadFreq, 1, 0.5);

      // Build order matches the original TectonicModel constructor (after
      // _extractBoundaryPixels, which stays in the model and feeds the masks +
      // seed grid this primitive reads).
      this._extractJunctions();
      this._extractSegments();
      this._buildNodes();
      this._snapPolylinesToNodes();
      this._buildTPins();
      this._buildSegmentContextGrids();
      this._buildWidthMulGrid();

      // Porting mirror — copy to the C# debug logs.
      console.log(`[tectonic-lines] segments=${this.segments.length} junctions=${this.junctions.length}`);
    }

    // Junction extraction. A junction is a point where 3+ Voronoi cells meet.
    // Walks the precomputed seed grid; at each cell checks its 3×3 neighbourhood
    // for distinct seed IDs and the distinct major plates among them.
    //   3+ distinct majors → 'active' junction (3+ active boundary lines meet)
    //   1 major, 3+ distinct seeds within it → 'fossil' (multiple fossil
    //   sub-plates of one major meet)
    // The 2-majors case ("mixed") is intentionally not classified — it fires
    // along every active boundary segment that has a minor seed nearby (which
    // is most of them), producing hundreds of overlapping false-positive
    // junctions whose contributions sum the per-pixel TI well past the byte
    // cap. Real mixed junctions are rare; if needed later, gate on a stricter
    // signal (e.g. 2 majors AND a fossil-boundary pixel within radius).
    // Connected junction pixels (same type) cluster into one junction object
    // (centroid + blob radius) via BFS, consumed by _buildNodes.
    _extractJunctions() {
      const grid = this._seedGrid;
      const step = this._seedGridStep;
      const gw = this._seedGridGw;
      const gh = this._seedGridGh;
      const allSeeds = this.allSeeds;
      const total = gw * gh;

      const T_NONE = 0, T_ACTIVE = 1, T_FOSSIL = 2;
      const typeMask = new Uint8Array(total);

      for (let gz = 1; gz < gh - 1; gz++) {
        for (let gx = 1; gx < gw - 1; gx++) {
          const seedSet = new Set();
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              const sid = grid[(gz + dz) * gw + (gx + dx)];
              if (sid >= 0) seedSet.add(sid);
            }
          }
          if (seedSet.size < 3) continue;

          const majors = new Set();
          for (const sid of seedSet) majors.add(allSeeds[sid].majorPlateId);

          if (majors.size >= 3) typeMask[gz * gw + gx] = T_ACTIVE;
          else if (majors.size === 1) typeMask[gz * gw + gx] = T_FOSSIL;
          // majors.size === 2 → not a junction (see comment above)
        }
      }

      this.junctions = [];
      const label = new Int32Array(total).fill(-1);
      const stack = [];

      for (let gz = 0; gz < gh; gz++) {
        for (let gx = 0; gx < gw; gx++) {
          const i0 = gz * gw + gx;
          if (typeMask[i0] === T_NONE || label[i0] >= 0) continue;
          const myType = typeMask[i0];
          const segId = this.junctions.length;
          label[i0] = segId;
          stack.length = 0;
          stack.push(i0);
          let sumX = 0, sumZ = 0, count = 0;
          const blobXs = [], blobZs = [];

          while (stack.length) {
            const j = stack.pop();
            const jx = j % gw;
            const jz = (j - jx) / gw;
            sumX += jx * step;
            sumZ += jz * step;
            blobXs.push(jx * step);
            blobZs.push(jz * step);
            count++;
            // 4-neighbour connectivity, same type only
            if (jx > 0) {
              const ni = j - 1;
              if (typeMask[ni] === myType && label[ni] < 0) { label[ni] = segId; stack.push(ni); }
            }
            if (jx < gw - 1) {
              const ni = j + 1;
              if (typeMask[ni] === myType && label[ni] < 0) { label[ni] = segId; stack.push(ni); }
            }
            if (jz > 0) {
              const ni = j - gw;
              if (typeMask[ni] === myType && label[ni] < 0) { label[ni] = segId; stack.push(ni); }
            }
            if (jz < gh - 1) {
              const ni = j + gw;
              if (typeMask[ni] === myType && label[ni] < 0) { label[ni] = segId; stack.push(ni); }
            }
          }

          // Blob extent: how far the junction's pixel cluster reaches from
          // its centroid. Data-driven association radius for node building +
          // endpoint snapping (_buildNodes / _snapPolylinesToNodes) — arm
          // polylines stop at the blob's rim, so "ends at this junction"
          // means "within blobR plus walk slack", not a fixed magic distance.
          const cx = sumX / count, cz = sumZ / count;
          let blobR = 0;
          for (let b = 0; b < count; b++) {
            const d = Math.hypot(blobXs[b] - cx, blobZs[b] - cz);
            if (d > blobR) blobR = d;
          }

          this.junctions.push({
            x: cx,
            z: cz,
            blobR,
            type: myType === T_ACTIVE ? 'active' : 'fossil',
          });
        }
      }
    }

    // Segment extraction. A segment is a connected run of boundary pixels with
    // the same plate-pair. Active segments separate two distinct majors; fossil
    // segments separate two minors of the same major. Each segment stores its
    // length (in pixels) and its plate-pair key/type; collision intensity and
    // the band widths are derived later (assignPairTypes / computeCollisionIntensity).
    _extractSegments() {
      const { mapW, mapH, allSeeds } = this;
      const grid = this._seedGrid;
      const step = this._seedGridStep;
      const gw = this._seedGridGw;
      const gh = this._seedGridGh;
      const total = mapW * mapH;

      // Per-pixel pair label and active flag. -1 = not a boundary pixel.
      const pairLabel = new Int32Array(total).fill(-1);
      const pairActive = new Uint8Array(total);
      const pairKeys = new Map(); // canonical key string → integer pair ID
      const labelToKey = [];      // integer pair ID → key string (for tagging segment pairType)

      for (let gz = 1; gz < gh - 1; gz++) {
        for (let gx = 1; gx < gw - 1; gx++) {
          const px = gx * step, pz = gz * step;
          if (px >= mapW || pz >= mapH) continue;
          const pi = pz * mapW + px;
          const isActive = this.activeBoundaryGrid[pi] === 1;
          const isFossil = this.fossilBoundaryGrid[pi] === 1;
          if (!isActive && !isFossil) continue;

          const idx = grid[gz * gw + gx];
          if (idx < 0) continue;
          const myPlate = allSeeds[idx].majorPlateId;

          // Find a differing neighbour matching the boundary type.
          // For active: differing major plate. For fossil: same major, different seed.
          let key = null;
          const ns = [
            grid[gz * gw + (gx - 1)],
            grid[gz * gw + (gx + 1)],
            grid[(gz - 1) * gw + gx],
            grid[(gz + 1) * gw + gx],
          ];
          for (const ni of ns) {
            if (ni < 0 || ni === idx) continue;
            const otherPlate = allSeeds[ni].majorPlateId;
            if (isActive && otherPlate !== myPlate) {
              const a = Math.min(myPlate, otherPlate), b = Math.max(myPlate, otherPlate);
              key = 'A' + a + ',' + b;
              break;
            }
            if (isFossil && otherPlate === myPlate) {
              const a = Math.min(idx, ni), b = Math.max(idx, ni);
              key = 'F' + a + ',' + b;
              break;
            }
          }
          if (key === null) {
            // Perimeter pixels (the force-stamped edge frame) have no differing-
            // plate neighbour, so they'd be dropped here. Register each plate's
            // edge frontage as a REAL active pair against that side's PHANTOM
            // plate (the imagined plate beyond the border — its motion vector
            // lives in edgePhantomVectors): same collision math, same bands,
            // same joints as every other line. The side index goes into the
            // key so a plate's frontage splits per border and each edge
            // segment faces exactly one phantom. Position stays pinned at the
            // border — no positional warp, since the border IS the line. Only
            // the inner perimeter ring (gx/gz == 1 or gw/gh-2) is processed by
            // this loop, so the edge line sits one cell inside the literal
            // border and its innermost band reaches out to the edge.
            const onEdgeFrame = gx <= 1 || gx >= gw - 2 || gz <= 1 || gz >= gh - 2;
            if (isActive && onEdgeFrame) {
              const side = gx <= 1 ? 0 : gx >= gw - 2 ? 1 : gz <= 1 ? 2 : 3;
              key = 'E' + side + ':' + myPlate;
            } else {
              continue;
            }
          }

          let pid = pairKeys.get(key);
          if (pid === undefined) { pid = pairKeys.size; pairKeys.set(key, pid); labelToKey[pid] = key; }
          pairLabel[pi] = pid;
          pairActive[pi] = isActive ? 1 : 0;
        }
      }

      // Connected-components grouping. Same pair, 8-neighbour adjacency.
      this.segments = [];
      const segmentLabel = new Int32Array(total).fill(-1);
      const stack = [];

      for (let z = 0; z < mapH; z++) {
        for (let x = 0; x < mapW; x++) {
          const i0 = z * mapW + x;
          if (pairLabel[i0] === -1 || segmentLabel[i0] >= 0) continue;
          const myPair = pairLabel[i0];
          const myActive = pairActive[i0] === 1;
          const segId = this.segments.length;
          segmentLabel[i0] = segId;
          stack.length = 0;
          stack.push(i0);
          let count = 0;
          let onPerimeter = false;

          while (stack.length) {
            const j = stack.pop();
            const jx = j % mapW;
            const jz = (j - jx) / mapW;
            count++;
            if (jx <= 1 || jx >= mapW - 2 || jz <= 1 || jz >= mapH - 2) onPerimeter = true;
            // BFS reach matches the boundary-pixel sampling step. For maps
            // larger than 1024 px the boundary mask is sampled every other
            // pixel (step=2), so 1-px reach can't bridge labelled neighbours
            // and every labelled pixel becomes its own singleton segment.
            // Scaling the reach with step keeps the same 8-neighbour idea
            // at every map size.
            const r = this._seedGridStep;
            for (let dz = -r; dz <= r; dz++) {
              for (let dx = -r; dx <= r; dx++) {
                if (dx === 0 && dz === 0) continue;
                const nx = jx + dx, nz = jz + dz;
                if (nx < 0 || nx >= mapW || nz < 0 || nz >= mapH) continue;
                const ni = nz * mapW + nx;
                if (pairLabel[ni] === myPair && segmentLabel[ni] < 0) {
                  segmentLabel[ni] = segId;
                  stack.push(ni);
                }
              }
            }
          }

          this.segments.push({
            length: count,
            isActive: myActive,
            onPerimeter,
            pairKey: labelToKey[myPair],
            pairType: 'convergent', // real value set in assignPairTypes() once platePairTypes exists
          });
        }
      }

      this._segmentLabel = segmentLabel;
      this._buildSegmentSpatialIndex();
      this._buildSegmentPolylines();
    }

    // Tag each segment with its plate-pair interaction type. Called by the model
    // AFTER _computePlatePairTypes (which runs after this subsystem is built).
    // Provinces + upheaval read seg.pairType instead of the per-pixel
    // getPlateRelationship: same answer, but stable along the whole segment (the
    // per-pixel query flips to a third plate near junctions and cuts rift bands
    // off unevenly), and it's an array lookup instead of a spatial search.
    assignPairTypes(platePairTypes) {
      for (let i = 0; i < this.segments.length; i++) {
        const k = this.segments[i].pairKey;
        if (k && k[0] === 'A') {
          // Active pair: convergent / divergent / transform from platePairTypes.
          this.segments[i].pairType = platePairTypes[k.slice(1)] || 'convergent';
        } else if (k && k[0] === 'F') {
          // Fossil pair: two seeds of the same major plate. Same vector-sign
          // rule as active, on the two fossil seeds' own motion vectors — an
          // old suture replays its ancient interaction (spec §3.1). Replaces
          // the old ~25%-divergent hash.
          const p = k.slice(1).split(',');
          const sa = this.allSeeds[+p[0]], sb = this.allSeeds[+p[1]];
          this.segments[i].pairType = (sa && sb && sa.vec && sb.vec)
            ? V.classifyClosing(sa.vec, sb.vec, sa.x, sa.z, sb.x, sb.z, this.transformThreshold)
            : 'convergent';
        } else if (k && k[0] === 'E') {
          // Edge frontage vs its side's phantom plate: same vector-sign rule
          // as real pairs; the facing normal is the border's outward normal.
          const side = +k[1];
          const plateId = +k.slice(3);
          const sa = this.allSeeds[plateId];
          const vB = this._edgePhantomVectors && this._edgePhantomVectors[side];
          const n = EDGE_NORMALS[side];
          this.segments[i].pairType = (sa && sa.vec && vB)
            ? V.classifyClosing(sa.vec, vB, sa.x, sa.z, sa.x + n[0], sa.z + n[1], this.transformThreshold)
            : 'convergent';
        } else {
          this.segments[i].pairType = 'convergent';
        }
      }
    }

    // For each segment, walk its pixel cluster into an ordered polyline with
    // a cumulative arc-length parameterization. The polyline is the structural
    // primitive every "where on this line am I?" query reads from — warp
    // sampling along the spine, future column-builder identity lookups, ridge
    // descent direction, river drainage origin. Built once at worldinit;
    // queried per pixel afterward.
    //
    // Walk is deterministic: start at the pixel with fewest same-segment
    // 8-neighbours (a natural endpoint for a line), tiebreak by lowest scan
    // index. Then greedy nearest-unvisited until no segment pixel is within
    // 8-neighbour reach. Closed loops walk from their lowest-index pixel and
    // terminate when the walk can't extend further. Same seed → same start →
    // same walk → same arcParam at every point. JS and C# match byte-for-byte.
    _buildSegmentPolylines() {
      const { mapW, mapH } = this;
      const segs = this.segments;
      const labels = this._segmentLabel;
      const n = segs.length;

      const pixelsBySeg = new Array(n);
      for (let i = 0; i < n; i++) pixelsBySeg[i] = [];
      const total = labels.length;
      for (let i = 0; i < total; i++) {
        const sid = labels[i];
        if (sid < 0) continue;
        const x = i % mapW;
        const z = (i - x) / mapW;
        pixelsBySeg[sid].push(x, z);
      }

      for (let sid = 0; sid < n; sid++) {
        const pix = pixelsBySeg[sid];
        const m = pix.length / 2;
        if (m === 0) { segs[sid].polyline = null; continue; }
        if (m === 1) {
          segs[sid].polyline = {
            x: new Float32Array([pix[0]]),
            z: new Float32Array([pix[1]]),
            t: new Float32Array([0]),
            length: 0,
          };
          continue;
        }
        segs[sid].polyline = this._walkSegment(pix, m, sid);
      }
    }

    // Greedy walk from a deterministic endpoint. Bounded gap reach scales
    // with the boundary-sampling step so step=2 maps can still walk their
    // 2-pixel-spaced labels. Disconnected pixels of the same segment that
    // sit further than the gap threshold are dropped.
    _walkSegment(pix, m, segId) {
      const { mapW, mapH } = this;
      const labels = this._segmentLabel;
      const r = this._seedGridStep;
      // Same-segment neighbour-count window matches BFS reach.
      // Walk gap threshold accepts diagonal step distance (r√2 → r²×2)
      // plus a touch of slack for noise.
      const gapSq = r * r * 2 + r;

      // Walk the segment's pixels into an ordered polyline. A single greedy pass
      // from one endpoint can strand the bulk of a segment when it starts on a
      // small spur or hits a branch (observed: a real active line walked only 3
      // of 227 px, dropping the 224-px body → its ctx band cut mid-line). So
      // walk EVERY connected run and keep the longest as the polyline; tiny
      // stranded spurs (a few px) drop out — correct, they shouldn't drive a
      // band. If a segment ever has two genuinely large runs the shorter still
      // drops, and the warn below flags it so we can move to multi-polyline.
      const visited = new Uint8Array(m);
      const neighbourCount = (i) => {
        const x = pix[2 * i], z = pix[2 * i + 1];
        let count = 0;
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (dx === 0 && dz === 0) continue;
            const nx = x + dx, nz = z + dz;
            if (nx < 0 || nx >= mapW || nz < 0 || nz >= mapH) continue;
            if (labels[nz * mapW + nx] === segId) count++;
          }
        }
        return count;
      };

      let order = null;
      while (true) {
        // Start each run at the lowest-neighbour unvisited pixel (an endpoint).
        let start = -1, startNb = Infinity;
        for (let i = 0; i < m; i++) {
          if (visited[i]) continue;
          const c = neighbourCount(i);
          if (c < startNb) { startNb = c; start = i; if (c <= 1) break; }
        }
        if (start < 0) break;

        const run = [start];
        visited[start] = 1;
        let cur = start;
        while (true) {
          const cx = pix[2 * cur], cz = pix[2 * cur + 1];
          let bestJ = -1, bestD2 = Infinity;
          for (let j = 0; j < m; j++) {
            if (visited[j]) continue;
            const dx = pix[2 * j] - cx, dz = pix[2 * j + 1] - cz;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD2) { bestD2 = d2; bestJ = j; }
          }
          if (bestJ < 0 || bestD2 > gapSq) break;
          visited[bestJ] = 1;
          run.push(bestJ);
          cur = bestJ;
        }
        if (!order || run.length > order.length) order = run;
      }

      const k = order.length;
      if (k < m * 0.5) {
        // log, not warn: a segment splitting into runs is a band-quality note,
        // not a fault. Mirrors Log.Dbg in TectonicLines.cs.
        console.log(`[walkSegment] seg ${segId}: longest run ${k}/${m}px — multiple large runs, band may still cut (consider multi-polyline).`);
      }
      const xArr = new Float32Array(k);
      const zArr = new Float32Array(k);
      const tArr = new Float32Array(k);
      xArr[0] = pix[2 * order[0]];
      zArr[0] = pix[2 * order[0] + 1];
      tArr[0] = 0;
      let cumLen = 0;
      for (let i = 1; i < k; i++) {
        xArr[i] = pix[2 * order[i]];
        zArr[i] = pix[2 * order[i] + 1];
        const dx = xArr[i] - xArr[i - 1], dz = zArr[i] - zArr[i - 1];
        cumLen += Math.sqrt(dx * dx + dz * dz);
        tArr[i] = cumLen;
      }
      return { x: xArr, z: zArr, t: tArr, length: cumLen };
    }

    // ===== Joint nodes (type-less) =====
    // THE rule (user, asked repeatedly): every line meeting at a joint —
    // active, fossil, or edge frame — shares the SAME joint value. Junction
    // blobs are extracted per TYPE (the TI system needs that), so one
    // geometric node can yield two blob objects (an active and a fossil one
    // side by side) — merged here into a single node. Then endpoint clusters
    // add nodes for meetings that have no junction blob at all: edge
    // frontage corners, boundaries hitting the map border, mixed 2-major
    // spots. Without a node, arms end capped short of each other and the
    // union of their offset circles leaves a pinch/waist in the bands (the
    // "tiny breakage", worst along the edge frame).
    _buildNodes() {
      const slack = this._seedGridStep * 8;

      // Union-find; used for both merge passes.
      const mergeGroups = (count, closeFn) => {
        const parent = new Int32Array(count);
        for (let i = 0; i < count; i++) parent[i] = i;
        const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
        for (let i = 0; i < count; i++) {
          for (let j = i + 1; j < count; j++) {
            if (closeFn(i, j)) parent[find(i)] = find(j);
          }
        }
        const groups = new Map();
        for (let i = 0; i < count; i++) {
          const r = find(i);
          if (!groups.has(r)) groups.set(r, []);
          groups.get(r).push(i);
        }
        return groups;
      };

      // 1. Junction blobs, merged across type when they overlap.
      this.nodes = [];
      const jxs = this.junctions;
      const jGroups = mergeGroups(jxs.length, (i, j) => {
        const a = jxs[i], b = jxs[j];
        return Math.hypot(a.x - b.x, a.z - b.z) <= a.blobR + b.blobR + slack;
      });
      for (const members of jGroups.values()) {
        let sx = 0, sz = 0;
        for (const i of members) { sx += jxs[i].x; sz += jxs[i].z; }
        const x = sx / members.length, z = sz / members.length;
        let radius = 0;
        for (const i of members) {
          radius = Math.max(radius, Math.hypot(jxs[i].x - x, jxs[i].z - z) + jxs[i].blobR);
        }
        this.nodes.push({ x, z, radius });
      }
      const blobNodes = this.nodes.length;

      // 2. Endpoint clusters: polyline ends not covered by any blob node.
      // Two or more ends terminating together IS a joint, whether or not the
      // seed grid classified a junction there. Singles stay free (a line
      // genuinely petering out keeps its rounded cap).
      const loose = [];
      for (const seg of this.segments) {
        const poly = seg.polyline;
        if (!poly || poly.x.length < 2) continue;
        const L = poly.x.length - 1;
        for (const [ex, ez] of [[poly.x[0], poly.z[0]], [poly.x[L], poly.z[L]]]) {
          let covered = false;
          for (const n of this.nodes) {
            if (Math.hypot(n.x - ex, n.z - ez) <= n.radius + slack) { covered = true; break; }
          }
          if (!covered) loose.push([ex, ez]);
        }
      }
      const eGroups = mergeGroups(loose.length, (i, j) =>
        Math.hypot(loose[i][0] - loose[j][0], loose[i][1] - loose[j][1]) <= slack);
      for (const members of eGroups.values()) {
        if (members.length < 2) continue;
        let sx = 0, sz = 0;
        for (const i of members) { sx += loose[i][0]; sz += loose[i][1]; }
        const x = sx / members.length, z = sz / members.length;
        let radius = 0;
        for (const i of members) {
          radius = Math.max(radius, Math.hypot(loose[i][0] - x, loose[i][1] - z));
        }
        this.nodes.push({ x, z, radius });
      }

      // Porting mirror — copy to the C# debug logs.
      console.log(`[tectonic-lines] joint nodes: ${this.nodes.length} (${blobNodes} merged junction blobs + ${this.nodes.length - blobNodes} endpoint clusters)`);
    }

    // Snap each arm's endpoints to the node it terminates against. The pixel
    // walk stops at the rim of the junction blob (junction pixels are
    // dropped from the boundary masks so lines don't glue together), so
    // every arm ends a few px short of the actual meeting point. Appending
    // the node as the final vertex reconnects all arms to ONE shared point —
    // their equal-width round end caps (see bandProfileAt) then merge into a
    // single clean circle by construction. Applies to EVERY segment,
    // perimeter frame included (its nodes sit on the border, so the frame
    // stays a frame — and gets clean corners). Free ends keep their cap.
    _snapPolylinesToNodes() {
      const slack = this._seedGridStep * 8;
      const nodes = this.nodes;
      let snapped = 0, free = 0;

      const nearestNode = (px, pz) => {
        let best = -1, bestD = Infinity;
        for (let n = 0; n < nodes.length; n++) {
          const d = Math.hypot(nodes[n].x - px, nodes[n].z - pz);
          if (d < bestD) { bestD = d; best = n; }
        }
        return (best >= 0 && bestD <= nodes[best].radius + slack) ? best : -1;
      };

      for (const seg of this.segments) {
        seg.nodeStart = -1;
        seg.nodeEnd = -1;
        const poly = seg.polyline;
        if (!poly || poly.x.length < 2) continue;

        const L = poly.x.length - 1;
        const ns = nearestNode(poly.x[0], poly.z[0]);
        const ne = nearestNode(poly.x[L], poly.z[L]);
        if (ns >= 0) snapped++; else free++;
        if (ne >= 0) snapped++; else free++;
        if (ns >= 0) this._snapEndToNode(seg, 0, ns);
        if (ne >= 0) this._snapEndToNode(seg, 1, ne);
      }

      // Porting mirror — copy to the C# debug logs. "free" ends here get a
      // second chance as T-joints (_buildTPins); truly free ends are real
      // map-interior line endings (e.g. a fossil line petering out).
      console.log(`[tectonic-lines] polyline ends snapped to nodes: ${snapped} snapped, ${free} free`);
    }

    // Tie one polyline end to a node: add the node as the final vertex and
    // rebuild the cumulative arc lengths. Prepending shifts every arc
    // position along the line, so any width pins already on this segment
    // are shifted with it.
    _snapEndToNode(seg, end, nodeId) {
      const node = this.nodes[nodeId];
      const poly = seg.polyline;
      const xs = Array.from(poly.x), zs = Array.from(poly.z);
      let prependLen = 0;
      if (end === 0) {
        seg.nodeStart = nodeId;
        const d = Math.hypot(xs[0] - node.x, zs[0] - node.z);
        if (d > 1e-3) {
          prependLen = d;
          xs.unshift(node.x); zs.unshift(node.z);
        }
      } else {
        seg.nodeEnd = nodeId;
        if (Math.hypot(xs[xs.length - 1] - node.x, zs[zs.length - 1] - node.z) > 1e-3) {
          xs.push(node.x); zs.push(node.z);
        }
      }
      const k = xs.length;
      const xArr = new Float32Array(xs), zArr = new Float32Array(zs);
      const tArr = new Float32Array(k);
      let cum = 0;
      for (let i = 1; i < k; i++) {
        cum += Math.hypot(xArr[i] - xArr[i - 1], zArr[i] - zArr[i - 1]);
        tArr[i] = cum;
      }
      seg.polyline = { x: xArr, z: zArr, t: tArr, length: cum };
      if (prependLen > 0 && seg.pins) {
        for (const p of seg.pins) p.arc += prependLen;
      }
    }

    // T-joints: EVERY place lines touch is a joint (user rule, no
    // exceptions) — including a line ending against the SIDE of another
    // line: a fossil line dying against an active one, any line arriving at
    // an edge line, a crossing that the mask extraction cut into two arms.
    // For each polyline end still free after node snapping: find the
    // nearest OTHER segment's polyline within the walk slack, put a node AT
    // the contact point ON that line, tie the ending arm to it, and PIN the
    // through-line's width profile there (bandProfileAt) so both lines
    // arrive at the shared joint value — the through-line's band swells to
    // meet the arriving cap and relaxes back, same trapezoid rules.
    _buildTPins() {
      const slack = this._seedGridStep * 8;
      const segs = this.segments;
      let tJoints = 0;
      for (let sid = 0; sid < segs.length; sid++) {
        const seg = segs[sid];
        for (const end of [0, 1]) {
          const poly = seg.polyline; // re-read: snapping replaces the object
          if (!poly || poly.x.length < 2) continue;
          if ((end === 0 ? seg.nodeStart : seg.nodeEnd) >= 0) continue;
          const L = poly.x.length - 1;
          const ex = end === 0 ? poly.x[0] : poly.x[L];
          const ez = end === 0 ? poly.z[0] : poly.z[L];

          let best = -1, bestProj = null;
          for (let os = 0; os < segs.length; os++) { // worldinit-only; segments are few
            if (os === sid) continue;
            const op = segs[os].polyline;
            if (!op || op.x.length < 2) continue;
            const proj = this._projectOntoPolyline(ex, ez, op);
            if (proj.dist <= slack && (best < 0 || proj.dist < bestProj.dist)) {
              best = os; bestProj = proj;
            }
          }
          if (best < 0) continue;

          const through = segs[best];
          const pos = this._polylinePosition(through.polyline, bestProj.t);
          // Reuse a node if the contact lands next to one, else create it.
          let nodeId = -1;
          for (let n = 0; n < this.nodes.length; n++) {
            if (Math.hypot(this.nodes[n].x - pos.x, this.nodes[n].z - pos.z) <= this.nodes[n].radius + slack) { nodeId = n; break; }
          }
          if (nodeId < 0) {
            nodeId = this.nodes.length;
            this.nodes.push({ x: pos.x, z: pos.z, radius: 0 });
          }
          this._snapEndToNode(seg, end, nodeId);
          if (!through.pins) through.pins = [];
          if (!through.pins.some((p) => p.node === nodeId)) {
            through.pins.push({ node: nodeId, arc: bestProj.t * through.polyline.length });
          }
          tJoints++;
        }
      }
      // Porting mirror — copy to the C# debug logs.
      console.log(`[tectonic-lines] T-joints: ${tJoints} line-into-line connections`);
    }

    _buildSegmentSpatialIndex() {
      const { mapW, mapH } = this;
      const cellSize = Math.max(20, this.gridSpacing * 0.3);
      this._segCellSize = cellSize;
      this._segGridCols = Math.ceil(mapW / cellSize) + 4;
      this._segGridRows = Math.ceil(mapH / cellSize) + 4;
      this._segGridOff = 2;
      const len = this._segGridCols * this._segGridRows;
      this._segGrid = new Array(len);
      for (let i = 0; i < len; i++) this._segGrid[i] = [];

      for (let z = 0; z < mapH; z++) {
        for (let x = 0; x < mapW; x++) {
          const i = z * mapW + x;
          const segId = this._segmentLabel[i];
          if (segId < 0) continue;
          const gcx = Math.floor(x / cellSize) + this._segGridOff;
          const gcz = Math.floor(z / cellSize) + this._segGridOff;
          if (gcx >= 0 && gcx < this._segGridCols && gcz >= 0 && gcz < this._segGridRows) {
            this._segGrid[gcz * this._segGridCols + gcx].push(x, z, segId);
          }
        }
      }
    }

    // Province width multiplier — single smooth scalar field that scales ALL
    // band widths together at each pixel. Provinces and upheaval both consume
    // this so geology and elevation stay in lockstep. Cached at integer pixels
    // (provinces / upheaval generation hits this every call); direct compute
    // for non-integer queries.
    getProvinceWidthMultiplier(x, z) {
      if (this.provinceWarpPower <= 0) return 1.0;
      const ix = x | 0, iz = z | 0;
      if (ix === x && iz === z && ix >= 0 && ix < this.mapW && iz >= 0 && iz < this.mapH && this._widthMulGrid) {
        return this._widthMulGrid[iz * this.mapW + ix];
      }
      return this._computeWidthMulDirect(x, z);
    }

    // Closest-pick widthMul without smoothing. Used for non-integer queries
    // and as the source the cache build samples per pixel before blurring.
    _computeWidthMulDirect(x, z) {
      const s = this.provinceWarpPower;
      if (s <= 0) return 1.0;
      const ctxA = this.getSegmentContext(x, z, true);
      const ctxF = this.getSegmentContext(x, z, false);
      let ctx = null;
      if (ctxA && ctxF) ctx = ctxA.dist <= ctxF.dist ? ctxA : ctxF;
      else if (ctxA) ctx = ctxA;
      else if (ctxF) ctx = ctxF;
      if (!ctx) return 1.0;

      const seg = this.segments[ctx.segmentId];
      if (!seg.polyline || seg.polyline.length === 0) return 1.0;
      const pos = this._polylinePosition(seg.polyline, ctx.arcParam);
      const broadAmp = s * 0.65;
      const broad = this._provinceWarpBroad(pos.x, pos.z);
      const raw = 1.0 + broadAmp * broad;
      return raw < 0.5 ? 0.5 : raw;
    }

    // Per-pixel "where am I relative to a tectonic line" lookup. The shared
    // primitive every spine-relative consumer reads from: warp sampling, future
    // mountain area-erosion, ridge descent direction, river drainage origin,
    // column-builder mountain identity. Returns null if no segment of the
    // requested type sits in this pixel's neighbourhood.
    //
    //   segmentId — which segment owns this pixel's perpendicular slice
    //   arcParam  — 0..1 along the segment's length, where the projection lands
    //   dist      — perpendicular distance to the spine (Euclidean from
    //               polyline projection — finer than chamfer; matches C# port)
    //   side      — +1 / −1 according to a signed cross product of edge × offset
    //
    // Pure function of (x, z, seed) given worldinit state. JS visualiser reads
    // a precomputed cache filled at worldinit (built by _buildSegmentContextGrids
    // which calls _computeSegmentContext for every relevant pixel). C# port
    // calls _computeSegmentContext directly each query — both routes produce
    // identical bytes at integer pixel coords.
    getSegmentContext(x, z, isActive) {
      if (!this._activeSegIdGrid) return this._computeSegmentContext(x, z, isActive);
      const ix = x | 0, iz = z | 0;
      if (ix !== x || iz !== z || ix < 0 || ix >= this.mapW || iz < 0 || iz >= this.mapH) {
        return this._computeSegmentContext(x, z, isActive);
      }
      const i = iz * this.mapW + ix;
      const segId = isActive ? this._activeSegIdGrid[i] : this._fossilSegIdGrid[i];
      if (segId < 0) return null;
      const arcGrid = isActive ? this._activeArcParamGrid : this._fossilArcParamGrid;
      const distGrid = isActive ? this._activeCtxDistGrid : this._fossilCtxDistGrid;
      const sideGrid = isActive ? this._activeSideGrid : this._fossilSideGrid;
      return { segmentId: segId, arcParam: arcGrid[i], dist: distGrid[i], side: sideGrid[i] };
    }

    // Direct compute path. Spatial-index lookup over candidate segment IDs in
    // the local cell window, project the query point onto each candidate's
    // polyline, pick the closest. Plain-array dedup (small candidate count
    // makes linear scan faster than Set in the hot loop).
    //
    // wantRift (optional): null = don't filter by kind (existing behaviour,
    // all current callers). true/false = also require the segment be a rift
    // (pairType === 'divergent') or not — convergent AND transform both
    // count as "mountain". Used by the per-anchor kind hints below.
    _computeSegmentContext(x, z, isActive, wantRift = null) {
      if (!this._segGrid) return null;
      const segs = this.segments;
      const cs = this._segCellSize;
      const gcx = Math.floor(x / cs) + this._segGridOff;
      const gcz = Math.floor(z / cs) + this._segGridOff;
      const wantActive = isActive ? 1 : 0;

      let bestDist = Infinity;
      let bestSegId = -1, bestT = 0, bestSide = 0;
      const seenIds = []; // small array dedup — typically ≤10 unique segIds in window

      for (let pass = 0; pass < 2; pass++) {
        const reach = pass === 0 ? 1 : 2;
        for (let dz = -reach; dz <= reach; dz++) {
          for (let dx = -reach; dx <= reach; dx++) {
            const ci = gcz + dz, cj = gcx + dx;
            if (ci < 0 || ci >= this._segGridRows || cj < 0 || cj >= this._segGridCols) continue;
            const bucket = this._segGrid[ci * this._segGridCols + cj];
            for (let k = 0; k < bucket.length; k += 3) {
              const segId = bucket[k + 2];
              let already = false;
              for (let s = 0; s < seenIds.length; s++) {
                if (seenIds[s] === segId) { already = true; break; }
              }
              if (already) continue;
              seenIds.push(segId);
              const seg = segs[segId];
              if ((seg.isActive ? 1 : 0) !== wantActive) continue;
              if (wantRift !== null && (seg.pairType === 'divergent') !== wantRift) continue;
              if (!seg.polyline) continue;
              const proj = this._projectOntoPolyline(x, z, seg.polyline);
              if (proj.dist < bestDist) {
                bestDist = proj.dist;
                bestSegId = segId;
                bestT = proj.t;
                bestSide = proj.side;
              }
            }
          }
        }
        if (bestSegId >= 0) break;
      }

      if (bestSegId < 0) return null;
      return { segmentId: bestSegId, arcParam: bestT, dist: bestDist, side: bestSide };
    }

    // Per-anchor nearest-segment-id cache, one per kind (mountain/rift ×
    // active/fossil — 4 ids per anchor, not 1). Acceleration structure for
    // getKindDistancesAt below; replaces _buildKindDistGrids's chamfer
    // approximation. Called once from ui.js after the anchor mesh exists —
    // segments already have their final pairType by then (assignPairTypes
    // runs during TectonicModel's own constructor, long before the mesh).
    //
    // Also stores the mesh so getKindDistancesAt/getBoundaryDistancesAt (and
    // provinceAt in provinces.js, which calls them) don't need every caller
    // across the codebase to thread it through — this subsystem is built
    // before the mesh exists, so it can't take it as a constructor arg; this
    // is the first point in the pipeline where it safely can hold onto it.
    computeAnchorKindHints(mesh) {
      this.mesh = mesh;
      const n = mesh.numAnchors;
      this._anchorMtnActiveSeg  = new Int32Array(n).fill(-1);
      this._anchorMtnFossilSeg  = new Int32Array(n).fill(-1);
      this._anchorRiftActiveSeg = new Int32Array(n).fill(-1);
      this._anchorRiftFossilSeg = new Int32Array(n).fill(-1);

      for (let t = 0; t < n; t++) {
        const x = mesh.a_x[t], z = mesh.a_z[t];
        const mA = this._computeSegmentContext(x, z, true, false);
        const mF = this._computeSegmentContext(x, z, false, false);
        const rA = this._computeSegmentContext(x, z, true, true);
        const rF = this._computeSegmentContext(x, z, false, true);
        this._anchorMtnActiveSeg[t]  = mA ? mA.segmentId : -1;
        this._anchorMtnFossilSeg[t]  = mF ? mF.segmentId : -1;
        this._anchorRiftActiveSeg[t] = rA ? rA.segmentId : -1;
        this._anchorRiftFossilSeg[t] = rF ? rF.segmentId : -1;
      }

      // Ongoing health signal, not a one-time migration check: coverage per
      // kind. A kind reading 0/n across a whole world would mean that kind
      // of boundary doesn't exist anywhere reachable — plausible for a
      // world with no rifts, but worth being able to see.
      let mA = 0, mF = 0, rA = 0, rF = 0;
      for (let t = 0; t < n; t++) {
        if (this._anchorMtnActiveSeg[t]  >= 0) mA++;
        if (this._anchorMtnFossilSeg[t]  >= 0) mF++;
        if (this._anchorRiftActiveSeg[t] >= 0) rA++;
        if (this._anchorRiftFossilSeg[t] >= 0) rF++;
      }
      console.log(`[tectonic-lines] anchor kind hints: ${n} anchors — mtnActive=${mA} mtnFossil=${mF} riftActive=${rA} riftFossil=${rF}`);
    }

    // Collision intensity per segment (spec §3.1). Writes two fields per
    // segment, stored but NOT yet consumed (item 5 reads them for
    // classification + height painting):
    //   seg.intensity  — signed proportion, roughly [-1, 1]. + = converging
    //                    (mountain), - = diverging (rift), ≈0 = glancing
    //                    (transform, no feature). Its magnitude is "how tall".
    //   seg.tallerSide — subduction asymmetry: +1 = A side taller, -1 = B side
    //                    taller, 0 = same crust type (symmetric). A/B are the
    //                    two entities in the segment's pairKey; mapping to the
    //                    rendered side is item 5's job.
    // Runs AFTER continent exists (needs land/ocean per plate) — called from
    // ui.js right after computeAnchorKindHints, same post-continent pattern.
    computeCollisionIntensity(continent) {
      const landPlates = (continent && continent.continentalPlates) || new Set();
      const seeds = this.allSeeds;
      const PV = this.plateVectors;

      // Type ceiling (first-order): continental crust piles highest, oceanic
      // subducts. cont-cont > ocean-cont > ocean-ocean. Tunable (item 5 / config).
      const typeFactor = (landA, landB) =>
        (landA && landB) ? 1.0 : (landA || landB) ? 0.85 : 0.7;

      for (const seg of this.segments) {
        seg.intensity = 0;
        seg.tallerSide = 0;
        const key = seg.pairKey;
        if (!key) continue;
        if (key[0] === 'E') {
          // Edge line vs its side's phantom plate — the SAME collision math
          // as real pairs (edge dice, agreed 2026-07-10): head-on-ness ×
          // speed × crust type, sign included, so an edge stretch can be a
          // mountain wall, a rift, or glancing, per world. Phantom crust is
          // oceanic (the void beyond the border).
          const side = +key[1];
          const plateId = +key.slice(3);
          const vA = PV[plateId];
          const vB = this._edgePhantomVectors && this._edgePhantomVectors[side];
          if (!vA || !vB) continue;
          const n = EDGE_NORMALS[side];
          const rvx = vA[0] - vB[0], rvz = vA[1] - vB[1];
          const relSpeed = Math.hypot(rvx, rvz);
          const headOn = relSpeed < 1e-9 ? 0 : (rvx * n[0] + rvz * n[1]) / relSpeed;
          const speedNorm = Math.min(1, relSpeed / (2 * this._plateSpeedMax));
          const landA = landPlates.has(plateId);
          seg.intensity = headOn * (0.75 + 0.25 * speedNorm) * typeFactor(landA, false);
          seg.tallerSide = landA ? +1 : 0;
          continue;
        }

        const kind = key[0];
        const parts = key.slice(1).split(',');
        const a = +parts[0], b = +parts[1];
        let vA, vB, sa, sb, landA, landB;
        if (kind === 'A') {
          // Active: a,b are plateIds. Each plate's one major seed is seeds[a]
          // (majors are the first plateCount entries, seedId === plateId).
          vA = PV[a]; vB = PV[b];
          sa = seeds[a]; sb = seeds[b];
          landA = landPlates.has(a); landB = landPlates.has(b);
        } else {
          // Fossil: a,b are allSeeds indices (two seeds of the same major
          // plate) — same crust type, so no subduction asymmetry.
          sa = seeds[a]; sb = seeds[b];
          vA = sa && sa.vec; vB = sb && sb.vec;
          landA = landB = landPlates.has(sa ? sa.majorPlateId : -1);
        }
        if (!vA || !vB || !sa || !sb) continue;

        // Boundary facing: unit vector between the two seed centres —
        // structural, warp-free (the drawn line's curve plays no part).
        let nx = sb.x - sa.x, nz = sb.z - sa.z;
        const nlen = Math.hypot(nx, nz);
        if (nlen < 1e-9) continue;
        nx /= nlen; nz /= nlen;

        // Relative motion of A w.r.t. B (two plates drifting the same way
        // barely collide even if both are fast — this is why it's relative,
        // not raw speed).
        const rvx = vA[0] - vB[0], rvz = vA[1] - vB[1];
        const relSpeed = Math.hypot(rvx, rvz);
        // Head-on-ness = cos(angle) between relative motion and facing. Signed
        // (+ closing, - opening), full [-1, 1] — the strong, linear lever, and
        // its sign is the whole mountain/rift split.
        const headOn = relSpeed < 1e-9 ? 0 : (rvx * nx + rvz * nz) / relSpeed;
        // Speed: gentle. Combined relative speed → small [0.75, 1.0] factor so
        // it nudges but never dominates. relSpeed ∈ ~[0, 2·speedMax].
        const speedNorm = Math.min(1, relSpeed / (2 * this._plateSpeedMax));
        const speedFactor = 0.75 + 0.25 * speedNorm;

        seg.intensity = headOn * speedFactor * typeFactor(landA, landB);
        // Subduction: at ocean-meets-land the land side rises. Same crust type
        // ⇒ symmetric (0). Meaningful for converging segments; stored regardless.
        seg.tallerSide = (landA === landB) ? 0 : (landA ? +1 : -1);
      }

      // Joint common value (the shared end-circle size): each NODE takes the
      // MAX |intensity| across ALL arms snapped to it — active, fossil, and
      // edge frame alike (nodes are type-less by construction, _buildNodes) —
      // so every arm arrives at the SAME width and their concentric end caps
      // read as one clean circle. (Which layer paints on top is still the
      // age layering.) Arm↔node association comes from the endpoint
      // snapping (seg.nodeStart/nodeEnd), not from distance matching.
      for (const n of this.nodes) n.commonInt = 0;
      for (const seg of this.segments) {
        const a = Math.abs(seg.intensity);
        if (seg.nodeStart >= 0 && a > this.nodes[seg.nodeStart].commonInt) this.nodes[seg.nodeStart].commonInt = a;
        if (seg.nodeEnd   >= 0 && a > this.nodes[seg.nodeEnd].commonInt)   this.nodes[seg.nodeEnd].commonInt   = a;
        if (seg.pins) {
          for (const p of seg.pins) {
            if (a > this.nodes[p.node].commonInt) this.nodes[p.node].commonInt = a;
          }
        }
      }

      // Arm ends AND through-line pins inherit their joint's common value
      // (the width profile's pinned points — bandProfileAt); free ends keep
      // their own width.
      for (const seg of this.segments) {
        const own = Math.abs(seg.intensity);
        seg.jStartInt = seg.nodeStart >= 0 ? this.nodes[seg.nodeStart].commonInt : own;
        seg.jEndInt   = seg.nodeEnd   >= 0 ? this.nodes[seg.nodeEnd].commonInt   : own;
        if (seg.pins) for (const p of seg.pins) p.val = this.nodes[p.node].commonInt;
      }

      // Stick lookup grid needs the intensities above (band reach scales
      // with them), so it builds here, not in the constructor.
      this._buildStickIndex();

      // Ongoing health signal (like the kind-hint / distance-field logs), not a
      // migration artifact. Kept unconditional here — the visualiser is a dev
      // tool and its console is the point. The C# counterpart logs it at Info
      // (TectonicLines.Query.cs), one line per generate.
      let conv = 0, rift = 0, glancing = 0, total = 0;
      for (const seg of this.segments) {
        if (!seg.pairKey || seg.pairKey[0] === 'E') continue;
        total++;
        if (seg.intensity > 0.15) conv++;
        else if (seg.intensity < -0.15) rift++;
        else glancing++;
      }
      console.log(`[tectonic-lines] collision intensity: ${total} segments — converging=${conv} rifting=${rift} glancing=${glancing}`);
    }

    // ===== The stick query (province rework 2026-07-09) =====
    // Each tectonic line is a "popsicle stick": a capsule around its polyline
    // whose width follows a trapezoid profile — pinned to the shared joint
    // value where arms meet (jStartInt/jEndInt), own |intensity| along the
    // middle. Because arms END at the joint node (endpoint snapping) and all
    // arrive at the same width, their round end caps are concentric and merge
    // into one clean circle — no separate junction-disk primitive needed.

    // Width multiplier of a stick at normalized arc t ∈ [0, 1]. Pinned to
    // the shared joint value at each tied end AND at every T-pin along the
    // line (a joint where another line ends against this one's side). Ramps
    // are measured in REAL distance (not a length fraction): long lines
    // keep a plateau at their own width between joints, short stretches
    // degrade to a pure blend of the surrounding joint values. widthFloor
    // is the minimum core — a glancing (transform) line pinches toward it
    // mid-line; 0 = bow-tie.
    bandProfileAt(segId, tNorm) {
      const seg = this.segments[segId];
      const own = Math.abs(seg.intensity || 0);
      let a = own;
      const poly = seg.polyline;
      if (poly && poly.length > 0 && seg.jStartInt !== undefined) {
        const ramp = this._jointRampLen;
        const ds = tNorm * poly.length;
        let wsum = 0, vsum = 0;
        const pull = (dist, val) => {
          const w = Math.max(0, 1 - dist / ramp);
          wsum += w; vsum += w * val;
        };
        pull(ds, seg.jStartInt);
        pull(poly.length - ds, seg.jEndInt);
        if (seg.pins) for (const p of seg.pins) pull(Math.abs(ds - p.arc), p.val || 0);
        if (wsum > 1) { vsum /= wsum; wsum = 1; }
        a = (1 - wsum) * own + vsum;
      }
      return this.widthFloor + (1 - this.widthFloor) * Math.min(1, a);
    }

    // Stick lookup grid: which segments' band stacks could reach a pixel.
    // Cell size ≥ the largest possible stack reach, so a 3×3 neighbourhood
    // query covers every candidate exactly (the projection afterwards is
    // still exact math — the grid only narrows which sticks get checked).
    // Built once per generate, AFTER intensities exist.
    _buildStickIndex() {
      const maxStackBase = Math.max(
        this.orogenW + this.basinW + this.platformW,
        this.extendedCrustWidth + this.basinW + this.platformW,
      );
      // +4px margin: the index stores polyline VERTICES (walk pixels, up to
      // ~1.5px from the true nearest point on the line), so the cell must
      // cover reach + that quantization for the 3×3 guarantee to hold.
      const cell = Math.max(24, maxStackBase * this._mapScale + 4);
      this._stickCellSize = cell;
      this._stickCols = Math.ceil(this.mapW / cell) + 2;
      this._stickRows = Math.ceil(this.mapH / cell) + 2;
      const grid = new Array(this._stickCols * this._stickRows);
      for (let i = 0; i < grid.length; i++) grid[i] = [];
      const insert = (px, pz, sid) => {
        const cx = Math.floor(px / cell), cz = Math.floor(pz / cell);
        if (cx < 0 || cx >= this._stickCols || cz < 0 || cz >= this._stickRows) return;
        const bucket = grid[cz * this._stickCols + cx];
        if (!bucket.includes(sid)) bucket.push(sid);
      };
      // Register the whole LINE, not just its stored vertices: joint
      // snapping adds straight connectors whose two endpoints can lie a
      // full cell apart, and a cell crossed by a connector with no vertex
      // in it would never learn the stick exists — its bands silently
      // vanish there (the wedge-shaped holes seen at junctions, and the
      // phantom "wrong ordering" where lower bands showed through). Step
      // along every stretch at half-cell resolution so no crossed cell is
      // missed.
      for (let sid = 0; sid < this.segments.length; sid++) {
        const poly = this.segments[sid].polyline;
        if (!poly) continue;
        let px = poly.x[0], pz = poly.z[0];
        insert(px, pz, sid);
        for (let v = 1; v < poly.x.length; v++) {
          const qx = poly.x[v], qz = poly.z[v];
          const elen = Math.hypot(qx - px, qz - pz);
          const steps = Math.max(1, Math.ceil(elen / (cell * 0.5)));
          for (let s = 1; s <= steps; s++) {
            insert(px + (qx - px) * s / steps, pz + (qz - pz) * s / steps, sid);
          }
          px = qx; pz = qz;
        }
      }
      this._stickGrid = grid;
    }

    // All segments whose band stack could reach (x, z). Union query: the
    // caller tests EVERY returned stick — no nearest-only selection, so a
    // wide band can never be cut by a nearer narrow one.
    sticksNear(x, z) {
      const out = [];
      if (!this._stickGrid) return out;
      const cell = this._stickCellSize;
      const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nx >= this._stickCols || nz < 0 || nz >= this._stickRows) continue;
          const bucket = this._stickGrid[nz * this._stickCols + nx];
          for (let k = 0; k < bucket.length; k++) {
            if (!out.includes(bucket[k])) out.push(bucket[k]);
          }
        }
      }
      return out;
    }

    // Public exact projection onto one segment's polyline (provinces.js reads
    // this per stick; end caps included — distance to an endpoint vertex).
    projectOntoSegment(segId, x, z) {
      const poly = this.segments[segId].polyline;
      if (!poly) return { dist: Infinity, t: 0, side: 0 };
      return this._projectOntoPolyline(x, z, poly);
    }

    // Exact kind-split distances at (x, z): {mtnActive, mtnFossil, riftActive,
    // riftFossil}. Replaces reading _buildKindDistGrids's chamfer arrays.
    // Candidates come from the nearest anchor's cached hints plus its graph
    // neighbours' hints (a handful of segments, not a full scan); the actual
    // distance is always exact (_projectOntoPolyline against the real
    // polyline) — the hint only narrows which segments get checked.
    getKindDistancesAt(x, z) {
      const { mesh } = this;
      const anchor = mesh.nearestAnchor(x, z);

      const mtnActiveIds = new Set(), mtnFossilIds = new Set();
      const riftActiveIds = new Set(), riftFossilIds = new Set();
      const addHints = (t) => {
        if (this._anchorMtnActiveSeg[t]  >= 0) mtnActiveIds.add(this._anchorMtnActiveSeg[t]);
        if (this._anchorMtnFossilSeg[t]  >= 0) mtnFossilIds.add(this._anchorMtnFossilSeg[t]);
        if (this._anchorRiftActiveSeg[t] >= 0) riftActiveIds.add(this._anchorRiftActiveSeg[t]);
        if (this._anchorRiftFossilSeg[t] >= 0) riftFossilIds.add(this._anchorRiftFossilSeg[t]);
      };
      addHints(anchor);
      for (const t2 of mesh.neighborsOfAnchor(anchor)) addHints(t2);

      const nearestOf = (segIds) => {
        let best = Infinity, bestSeg = -1, bestArc = 0;
        for (const segId of segIds) {
          const seg = this.segments[segId];
          if (!seg.polyline) continue;
          const proj = this._projectOntoPolyline(x, z, seg.polyline);
          if (proj.dist < best) { best = proj.dist; bestSeg = segId; bestArc = proj.t; }
        }
        return [best, bestSeg, bestArc];
      };

      // Distance to the nearest segment of each kind, plus WHICH segment won and
      // WHERE along it (arc ∈ [0,1]) — callers read the segment's intensity and
      // ramp the width toward the joint. Distance fields unchanged; *Seg/*Arc additive.
      const [mtnActive, mtnActiveSeg, mtnActiveArc]     = nearestOf(mtnActiveIds);
      const [mtnFossil, mtnFossilSeg, mtnFossilArc]     = nearestOf(mtnFossilIds);
      const [riftActive, riftActiveSeg, riftActiveArc]  = nearestOf(riftActiveIds);
      const [riftFossil, riftFossilSeg, riftFossilArc]  = nearestOf(riftFossilIds);
      return {
        mtnActive, mtnFossil, riftActive, riftFossil,
        mtnActiveSeg, mtnFossilSeg, riftActiveSeg, riftFossilSeg,
        mtnActiveArc, mtnFossilArc, riftActiveArc, riftFossilArc,
      };
    }

    // Plain (kind-agnostic) boundary distance — exactly min(mountain, rift)
    // of the same age. "Active mountain" and "active rift" segments are a
    // complete, non-overlapping partition of "active segments" (every
    // segment is convergent/transform OR divergent, never both, never
    // neither) — same for fossil. For any partition A∪B,
    // dist(x, A∪B) = min(dist(x,A), dist(x,B)) always, so this needs no new
    // anchor data, just 2b's existing output. Replaces
    // _buildBoundaryDistGrids's activeBoundaryDistGrid/fossilBoundaryDistGrid.
    getBoundaryDistancesAt(x, z) {
      const kd = this.getKindDistancesAt(x, z);
      return {
        active: Math.min(kd.mtnActive, kd.riftActive),
        fossil: Math.min(kd.mtnFossil, kd.riftFossil),
      };
    }

    // Ongoing health check, not a one-time migration comparison. Samples a
    // spread of positions and logs the resolved exact distances' range, so the
    // console gives a quick "does this look sane" signal on every generate.
    // Ported as LogDistanceFieldsSample (TectonicLines.Query.cs), one Info line.
    _logDistanceFieldsSample() {
      const { mapW, mapH } = this;
      const cols = 4, rows = 4;
      let minKind = Infinity, maxKind = 0, kindSamples = 0;
      let minBoundary = Infinity, maxBoundary = 0, boundarySamples = 0;
      const anyFiniteKind = { mtnActive: false, mtnFossil: false, riftActive: false, riftFossil: false };

      for (let gz = 0; gz < rows; gz++) {
        for (let gx = 0; gx < cols; gx++) {
          const x = Math.floor((gx + 0.5) / cols * mapW);
          const z = Math.floor((gz + 0.5) / rows * mapH);

          const kd = this.getKindDistancesAt(x, z);
          for (const k of ['mtnActive', 'mtnFossil', 'riftActive', 'riftFossil']) {
            if (kd[k] === Infinity) continue;
            anyFiniteKind[k] = true;
            kindSamples++;
            if (kd[k] < minKind) minKind = kd[k];
            if (kd[k] > maxKind) maxKind = kd[k];
          }

          const bd = this.getBoundaryDistancesAt(x, z);
          for (const k of ['active', 'fossil']) {
            if (bd[k] === Infinity) continue;
            boundarySamples++;
            if (bd[k] < minBoundary) minBoundary = bd[k];
            if (bd[k] > maxBoundary) maxBoundary = bd[k];
          }
        }
      }

      console.log(`[tectonic-lines] distance fields sample (${cols * rows} points): kind-split range=[${minKind.toFixed(1)}, ${maxKind.toFixed(1)}]px (${kindSamples} finite)  boundary range=[${minBoundary.toFixed(1)}, ${maxBoundary.toFixed(1)}]px (${boundarySamples} finite)`);
      for (const k of ['mtnActive', 'mtnFossil', 'riftActive', 'riftFossil']) {
        if (!anyFiniteKind[k]) console.log(`[tectonic-lines] note: no ${k} segment reachable from any sampled point (may be a genuine feature of this world, or a bug — worth a look if unexpected)`);
      }
    }

    // Precompute per-pixel segment context for active and fossil. JS-only
    // speed optimization — turns each per-pixel getSegmentContext call into
    // one array read. C# port skips this and calls _computeSegmentContext on
    // demand (chunks are small enough that on-demand is fine).
    //
    // Algorithm: per segment polyline, rasterize a band of width 2×maxBandReach
    // around each edge (AABB iteration with perpendicular-distance cull).
    // Each pixel keeps the segment whose polyline projection is closest. Far
    // cheaper than asking every pixel "which segment am I closest to" — we
    // visit each pixel once per nearby segment edge instead of doing a full
    // spatial-index lookup for every pixel.
    _buildSegmentContextGrids() {
      const { mapW, mapH } = this;
      const len = mapW * mapH;

      this._activeSegIdGrid    = new Int16Array(len);
      this._activeArcParamGrid = new Float32Array(len);
      this._activeCtxDistGrid  = new Float32Array(len);
      this._activeSideGrid     = new Int8Array(len);
      this._fossilSegIdGrid    = new Int16Array(len);
      this._fossilArcParamGrid = new Float32Array(len);
      this._fossilCtxDistGrid  = new Float32Array(len);
      this._fossilSideGrid     = new Int8Array(len);
      this._activeSegIdGrid.fill(-1);
      this._fossilSegIdGrid.fill(-1);
      // Sentinel: any real polyline-projection distance beats Infinity.
      for (let i = 0; i < len; i++) {
        this._activeCtxDistGrid[i] = Infinity;
        this._fossilCtxDistGrid[i] = Infinity;
      }

      const mapScale = V.phiScale(Math.max(mapW, mapH));
      const activity = 1.0; // Tectonic Activity dropped
      const maxBandReach = (this.orogenW + this.basinW + this.platformW) * mapScale * activity * 2.0;
      const maxBandReachSq = maxBandReach * maxBandReach;

      for (let segId = 0; segId < this.segments.length; segId++) {
        const seg = this.segments[segId];
        if (!seg.polyline) continue;
        const isActive = seg.isActive;
        const segIdGrid = isActive ? this._activeSegIdGrid : this._fossilSegIdGrid;
        const arcGrid   = isActive ? this._activeArcParamGrid : this._fossilArcParamGrid;
        const distGrid  = isActive ? this._activeCtxDistGrid : this._fossilCtxDistGrid;
        const sideGrid  = isActive ? this._activeSideGrid : this._fossilSideGrid;
        this._stampPolylineBand(seg, segId, segIdGrid, arcGrid, distGrid, sideGrid, maxBandReach, maxBandReachSq);
      }
    }

    // widthMul grid for the warp, RAW (blur removed 2026-07-27).
    //
    // Built from the segment-context cache: per pixel pick the closer of
    // active/fossil, sample noise at the projected polyline position, get
    // widthMul. The raw segment-context cache stays intact for future
    // column-builder/ridge/river consumers — the widthMul grid is a separate
    // downstream product.
    //
    // There used to be two 3x3 box passes here, to hide a one-pixel speckle where
    // two segments compete for "closest" far from any spine. That is a whole-map
    // smoothing pass, and the rule now is that fields are tuned by their own
    // values, not by a blanket over them. The speckle comes back with it; its real
    // fix belongs in the ridges/rivers rework that consumes this grid — those are
    // the only two consumers (ridges.js, rivers.js) and both are being redesigned.
    _buildWidthMulGrid() {
      const { mapW, mapH } = this;
      const len = mapW * mapH;
      const raw = new Float32Array(len);
      raw.fill(1.0);

      if (this.provinceWarpPower <= 0) {
        this._widthMulGrid = raw;
        return;
      }

      const s = this.provinceWarpPower;
      const broadAmp = s * 0.65;

      for (let z = 0; z < mapH; z++) {
        for (let x = 0; x < mapW; x++) {
          const i = z * mapW + x;
          const segIdA = this._activeSegIdGrid[i];
          const segIdF = this._fossilSegIdGrid[i];
          let segId = -1, arcParam = 0;
          if (segIdA >= 0 && segIdF >= 0) {
            if (this._activeCtxDistGrid[i] <= this._fossilCtxDistGrid[i]) {
              segId = segIdA; arcParam = this._activeArcParamGrid[i];
            } else {
              segId = segIdF; arcParam = this._fossilArcParamGrid[i];
            }
          } else if (segIdA >= 0) {
            segId = segIdA; arcParam = this._activeArcParamGrid[i];
          } else if (segIdF >= 0) {
            segId = segIdF; arcParam = this._fossilArcParamGrid[i];
          }
          if (segId < 0) continue;

          const seg = this.segments[segId];
          if (!seg.polyline || seg.polyline.length === 0) continue;
          const pos = this._polylinePosition(seg.polyline, arcParam);
          const broad = this._provinceWarpBroad(pos.x, pos.z);
          const wm = 1.0 + broadAmp * broad;
          raw[i] = wm < 0.5 ? 0.5 : wm;
        }
      }

      this._widthMulGrid = raw;
    }

    // Stamp every pixel within `maxBandReach` of any edge of this segment's
    // polyline with (segId, arcParam, dist, side). Pixels keep the closest
    // segment when multiple polylines overlap. Edge AABB plus perpendicular
    // distance cull keeps each pixel touched at most once per nearby edge.
    _stampPolylineBand(seg, segId, segIdGrid, arcGrid, distGrid, sideGrid, maxBandReach, maxBandReachSq) {
      const { mapW, mapH } = this;
      const poly = seg.polyline;
      const xs = poly.x, zs = poly.z, ts = poly.t;
      const m = xs.length;
      const polyLen = poly.length;

      // Single-pixel polyline: stamp a disk.
      if (m === 1 || polyLen === 0) {
        const ax = xs[0], az = zs[0];
        const minX = Math.max(0, Math.floor(ax - maxBandReach));
        const maxX = Math.min(mapW - 1, Math.ceil(ax + maxBandReach));
        const minZ = Math.max(0, Math.floor(az - maxBandReach));
        const maxZ = Math.min(mapH - 1, Math.ceil(az + maxBandReach));
        for (let z = minZ; z <= maxZ; z++) {
          for (let x = minX; x <= maxX; x++) {
            const dx = x - ax, dz = z - az;
            const d2 = dx * dx + dz * dz;
            if (d2 > maxBandReachSq) continue;
            const i = z * mapW + x;
            const d = Math.sqrt(d2);
            if (d < distGrid[i]) {
              segIdGrid[i] = segId;
              arcGrid[i]   = 0;
              distGrid[i]  = d;
              sideGrid[i]  = 0;
            }
          }
        }
        return;
      }

      for (let k = 0; k < m - 1; k++) {
        const ax = xs[k], az = zs[k];
        const bx = xs[k + 1], bz = zs[k + 1];
        const ex = bx - ax, ez = bz - az;
        const lenSq = ex * ex + ez * ez;
        if (lenSq < 1e-9) continue;
        const tA = ts[k], tB = ts[k + 1];

        const minX = Math.max(0, Math.floor(Math.min(ax, bx) - maxBandReach));
        const maxX = Math.min(mapW - 1, Math.ceil (Math.max(ax, bx) + maxBandReach));
        const minZ = Math.max(0, Math.floor(Math.min(az, bz) - maxBandReach));
        const maxZ = Math.min(mapH - 1, Math.ceil (Math.max(az, bz) + maxBandReach));

        for (let z = minZ; z <= maxZ; z++) {
          for (let x = minX; x <= maxX; x++) {
            const dxa = x - ax, dza = z - az;
            let s = (dxa * ex + dza * ez) / lenSq;
            if (s < 0) s = 0;
            else if (s > 1) s = 1;
            const px = ax + s * ex, pz = az + s * ez;
            const ddx = x - px, ddz = z - pz;
            const d2 = ddx * ddx + ddz * ddz;
            if (d2 > maxBandReachSq) continue;
            const i = z * mapW + x;
            const d = Math.sqrt(d2);
            if (d < distGrid[i]) {
              segIdGrid[i] = segId;
              arcGrid[i]   = (tA + s * (tB - tA)) / polyLen;
              distGrid[i]  = d;
              sideGrid[i]  = (ex * ddz - ez * ddx) >= 0 ? 1 : -1;
            }
          }
        }
      }
    }

    // Closest point on a polyline. Walks each edge, projects (x, z) onto the
    // edge clamped to [0, 1], picks the smallest perpendicular distance.
    // Returns Euclidean distance (not chamfer), normalized arcParam, and side.
    _projectOntoPolyline(x, z, poly) {
      const xs = poly.x, zs = poly.z, ts = poly.t;
      const m = xs.length;
      if (m === 0) return { dist: Infinity, t: 0, side: 0 };
      if (m === 1) {
        const dx = x - xs[0], dz = z - zs[0];
        return { dist: Math.sqrt(dx * dx + dz * dz), t: 0, side: 0 };
      }

      let bestD2 = Infinity, bestArc = 0, bestSide = 0;
      for (let k = 0; k < m - 1; k++) {
        const ax = xs[k], az = zs[k];
        const ex = xs[k + 1] - ax, ez = zs[k + 1] - az;
        const lenSq = ex * ex + ez * ez;
        if (lenSq < 1e-9) continue;
        const dxa = x - ax, dza = z - az;
        let s = (dxa * ex + dza * ez) / lenSq;
        if (s < 0) s = 0;
        else if (s > 1) s = 1;
        const px = ax + s * ex, pz = az + s * ez;
        const ddx = x - px, ddz = z - pz;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestArc = ts[k] + s * (ts[k + 1] - ts[k]);
          // Sign of edge × pixel-offset cross product.
          bestSide = (ex * ddz - ez * ddx) >= 0 ? 1 : -1;
        }
      }

      return {
        dist: Math.sqrt(bestD2),
        t: poly.length > 0 ? bestArc / poly.length : 0,
        side: bestSide,
      };
    }

    // Returns the (x, z) point at a given arcParam ∈ [0, 1] along a polyline.
    // Binary search over cumulative arc-lengths, then linear interpolation
    // between the two surrounding sample points.
    _polylinePosition(poly, arcParam) {
      const xs = poly.x, zs = poly.z, ts = poly.t;
      const m = xs.length;
      if (m === 1) return { x: xs[0], z: zs[0] };
      const target = arcParam * poly.length;
      let lo = 0, hi = m - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >>> 1;
        if (ts[mid] <= target) lo = mid;
        else hi = mid;
      }
      const seg = ts[hi] - ts[lo];
      const s = seg > 0 ? (target - ts[lo]) / seg : 0;
      return {
        x: xs[lo] + s * (xs[hi] - xs[lo]),
        z: zs[lo] + s * (zs[hi] - zs[lo]),
      };
    }
  }

  V.TectonicLines = TectonicLines;

})(window.VIS);
