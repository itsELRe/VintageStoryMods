// mesh.js — LatticeMesh (the anchor layer)
//
// A regular triangular lattice: points at formulaic positions from integer
// indices (r, c) — rows spaced s·√3/2 apart, odd rows offset s/2 — so every
// query resolves by O(1) arithmetic, no triangulation library and no spatial
// index. The points ARE the anchors: continuous field data (height, climate,
// wind, …) attaches to them as parallel arrays keyed by point id, and they are
// immutable — never displaced, relaxed, or re-derived.
//
// The equilateral triangles BETWEEN the points are the faces: the categorical
// unit (land/ocean labels live on faces, in ContinentGen). Faces double as the
// interpolation triangles — a field value anywhere is the barycentric blend of
// the containing face's 3 corner points (linear, C0-seamless, exact at the
// points), so a LAND face only ever interpolates between land/coastal points.
//
// The lattice extends MARGIN points beyond the map on every side so each map
// pixel lies strictly inside a face and near-edge queries stay in-bounds.
//
// Geometry + topology only. Land/ocean labels, point classification, and the
// coast live in ContinentGen / CoastField, which consume this mesh.

window.VIS = window.VIS || {};

(function (V) {

  // Extra point rows/cols beyond the map rim on each side.
  const MARGIN = 2;

  // Interpolation is plain (linear) barycentric — see sampleAt.
  //
  // TRIED AND REVERTED 2026-07-27: easing the weights so each corner's influence
  // fades to zero smoothly at the opposite edge. It did what it promised on the
  // numbers (worst slope kink across a face edge 2.77 -> 0.36 blocks per pixel)
  // but it trades a straight crease for a curved one: the slope then varies 92%
  // WITHIN each face instead of 4%, so contour lines bulge around every point
  // and the map reads as scallops. The user preferred the straight version side
  // by side. A per-point tilt was measured too and is worse — it overshoots the
  // surrounding points by up to 19.6 blocks.
  //
  // The real conclusion (tasks/todo.md): no blend shape removes the artefact,
  // it only changes its shape, because the size of the artefact is set by how
  // much neighbouring POINT VALUES differ. The fix belongs in the field, not the
  // interpolation — keep the base gentle enough for the lattice to describe.

  class LatticeMesh {
    constructor(opts) {
      this.mapW = opts.mapW;
      this.mapH = opts.mapH;
      this.spacing = opts.spacing;

      const s = this.spacing;
      this.rowH = s * Math.sqrt(3) / 2;

      // Grid extents: cover [0, mapW]×[0, mapH] plus MARGIN points per side.
      this.x0 = -MARGIN * s;
      this.z0 = -MARGIN * this.rowH;
      this.numCols = Math.ceil(this.mapW / s) + 2 * MARGIN + 1;
      this.numRows = Math.ceil(this.mapH / this.rowH) + 2 * MARGIN + 1;

      this.numAnchors = this.numRows * this.numCols;
      // Faces: 2 per (row-strip, column) quad.
      this.facesPerStrip = (this.numCols - 1) * 2;
      this.numFaces = (this.numRows - 1) * this.facesPerStrip;

      this._buildPoints();
      this._buildFaces();
      this._verify();

      console.log(`[mesh] lattice ${this.numRows}×${this.numCols} — ` +
        `${this.numAnchors} points, ${this.numFaces} faces, spacing=${s.toFixed(2)}px`);
    }

    // Auto-calibrated spacing: keeps point density in the same range the
    // previous mesh produced (≈ 2 anchors per Voronoi cell, 480 cells at the
    // 512² base, φ-scaled with map size, divided by continent size), so every
    // downstream constant tuned against anchor spacing stays valid. `mult` is
    // the user's lattice-spacing knob (1 = auto).
    static autoSpacing(mapW, mapH, continentSize, mult) {
      const mapSize = Math.max(mapW, mapH);
      const cells = Math.round(480 * Math.pow(V.PHI, Math.log2(mapSize / 512)))
        / Math.max(0.01, continentSize || 1);
      const points = Math.max(32, cells * 2);
      // Area per lattice point is s²·√3/2.
      const s = Math.sqrt((mapW * mapH) / (points * Math.sqrt(3) / 2));
      return s * (mult || 1);
    }

    // ===== Points =====

    _buildPoints() {
      const n = this.numAnchors;
      const s = this.spacing;
      this.a_x = new Float64Array(n);
      this.a_z = new Float64Array(n);
      for (let r = 0; r < this.numRows; r++) {
        const off = (r & 1) ? s / 2 : 0;
        const z = this.z0 + r * this.rowH;
        for (let c = 0; c < this.numCols; c++) {
          const t = r * this.numCols + c;
          // 6-decimal round — JS/C# numeric parity (matches swirl-era convention).
          this.a_x[t] = Math.round((this.x0 + c * s + off) * 1e6) / 1e6;
          this.a_z[t] = Math.round(z * 1e6) / 1e6;
        }
      }
    }

    pointIndex(r, c) { return r * this.numCols + c; }
    pointRow(t) { return (t / this.numCols) | 0; }
    pointCol(t) { return t % this.numCols; }

    // The up-to-6 lattice neighbors of point t (fewer on the outer rim).
    // Row parity decides which two columns the adjacent rows contribute.
    neighborsOfAnchor(t) {
      const r = this.pointRow(t), c = this.pointCol(t);
      const odd = r & 1;
      const out = [];
      const push = (rr, cc) => {
        if (rr >= 0 && rr < this.numRows && cc >= 0 && cc < this.numCols)
          out.push(rr * this.numCols + cc);
      };
      push(r, c - 1); push(r, c + 1);
      // Adjacent rows: even rows pair with (c-1, c) above/below, odd with (c, c+1).
      const cA = odd ? c : c - 1;
      push(r - 1, cA); push(r - 1, cA + 1);
      push(r + 1, cA); push(r + 1, cA + 1);
      return out;
    }

    // Nearest lattice point to (x, z). The Voronoi cell of a lattice point is
    // the hexagon around it, which is fully covered by the point's 6 incident
    // faces — so the nearest point is always a corner of the containing face.
    nearestAnchor(x, z) {
      const f = this.faceAt(x, z);
      const s = f * 3;
      let best = this._faceCorner[s], bestD2 = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = this._faceCorner[s + i];
        const dx = this.a_x[t] - x, dz = this.a_z[t] - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = t; }
      }
      return best;
    }

    // ===== Faces =====

    // Corner triples per face, flat Int32 (face f → _faceCorner[3f..3f+2]).
    // Strip r (between point rows r and r+1), column c, k ∈ {0,1}; the diagonal
    // orientation alternates with row parity:
    //   even r: k=0 → (r,c)(r,c+1)(r+1,c)    k=1 → (r,c+1)(r+1,c+1)(r+1,c)
    //   odd  r: k=0 → (r,c)(r+1,c)(r+1,c+1)  k=1 → (r,c)(r,c+1)(r+1,c+1)
    _buildFaces() {
      const nF = this.numFaces;
      this._faceCorner = new Int32Array(nF * 3);
      for (let r = 0; r < this.numRows - 1; r++) {
        const odd = r & 1;
        for (let c = 0; c < this.numCols - 1; c++) {
          const base = (r * (this.numCols - 1) + c) * 2;
          const A = this.pointIndex(r, c), B = this.pointIndex(r, c + 1);
          const C = this.pointIndex(r + 1, c), D = this.pointIndex(r + 1, c + 1);
          let i = base * 3;
          if (!odd) {
            this._faceCorner[i++] = A; this._faceCorner[i++] = B; this._faceCorner[i++] = C;
            this._faceCorner[i++] = B; this._faceCorner[i++] = D; this._faceCorner[i++] = C;
          } else {
            this._faceCorner[i++] = A; this._faceCorner[i++] = C; this._faceCorner[i++] = D;
            this._faceCorner[i++] = A; this._faceCorner[i++] = B; this._faceCorner[i++] = D;
          }
        }
      }

      // Point → incident faces (≤ 6), for point classification + BFS adjacency.
      this._pointFaces = new Array(this.numAnchors);
      for (let t = 0; t < this.numAnchors; t++) this._pointFaces[t] = [];
      for (let f = 0; f < nF; f++) {
        this._pointFaces[this._faceCorner[3 * f]].push(f);
        this._pointFaces[this._faceCorner[3 * f + 1]].push(f);
        this._pointFaces[this._faceCorner[3 * f + 2]].push(f);
      }

      // Face → 3 edge-adjacent faces, via a shared-edge map (generic build —
      // no parity case analysis to get wrong).
      const edgeMap = new Map();
      this._faceEdgeNbrs = new Array(nF);
      for (let f = 0; f < nF; f++) this._faceEdgeNbrs[f] = [];
      for (let f = 0; f < nF; f++) {
        for (let e = 0; e < 3; e++) {
          const p = this._faceCorner[3 * f + e];
          const q = this._faceCorner[3 * f + (e + 1) % 3];
          const key = p < q ? p * this.numAnchors + q : q * this.numAnchors + p;
          const other = edgeMap.get(key);
          if (other === undefined) {
            edgeMap.set(key, f);
          } else {
            this._faceEdgeNbrs[f].push(other);
            this._faceEdgeNbrs[other].push(f);
          }
        }
      }
    }

    faceCorners(f) {
      const s = f * 3;
      return [this._faceCorner[s], this._faceCorner[s + 1], this._faceCorner[s + 2]];
    }

    faceCentroid(f) {
      const s = f * 3;
      const i0 = this._faceCorner[s], i1 = this._faceCorner[s + 1], i2 = this._faceCorner[s + 2];
      return {
        x: (this.a_x[i0] + this.a_x[i1] + this.a_x[i2]) / 3,
        z: (this.a_z[i0] + this.a_z[i1] + this.a_z[i2]) / 3,
      };
    }

    facesAtPoint(t) { return this._pointFaces[t]; }

    // The 3 faces sharing an edge with f.
    faceEdgeNeighbors(f) { return this._faceEdgeNbrs[f]; }

    // All faces sharing an edge OR a corner with f (12 for an interior face).
    // The BFS growth adjacency — matches the ~6-neighbor richness the Voronoi
    // scoring was tuned against, where edge-only (3) would grow stringier.
    // Precomputed lazily (one array pass), since the BFS scoring loops hit it
    // hard.
    faceGrowthNeighbors(f) {
      if (!this._faceGrowthNbrs) {
        this._faceGrowthNbrs = new Array(this.numFaces);
        for (let g = 0; g < this.numFaces; g++) {
          const out = [];
          const s = g * 3;
          for (let i = 0; i < 3; i++) {
            const inc = this._pointFaces[this._faceCorner[s + i]];
            for (let m = 0; m < inc.length; m++) {
              const h = inc[m];
              if (h !== g && out.indexOf(h) === -1) out.push(h);
            }
          }
          this._faceGrowthNbrs[g] = out;
        }
      }
      return this._faceGrowthNbrs[f];
    }

    // O(1) exact containing face for (x, z), by strip + skewed-column
    // arithmetic (clamped to the lattice, so out-of-range queries snap to the
    // rim face). Derivation: within strip r the two triangles of column c tile
    // a parallelogram whose left boundary skews by ±s/2 across the strip
    // height; normalizing x by that skew reduces the lookup to a floor() and
    // one diagonal test.
    faceAt(x, z) {
      let r = Math.floor((z - this.z0) / this.rowH);
      if (r < 0) r = 0; else if (r > this.numRows - 2) r = this.numRows - 2;
      const zf = Math.min(1, Math.max(0, (z - this.z0 - r * this.rowH) / this.rowH));
      const u = (x - this.x0) / this.spacing;
      let c, k;
      if (!(r & 1)) {
        const v = u - 0.5 * zf;
        c = Math.floor(v);
        if (c < 0) c = 0; else if (c > this.numCols - 2) c = this.numCols - 2;
        k = (v - c) <= (1 - zf) ? 0 : 1;
      } else {
        const v = u - 0.5 + 0.5 * zf;
        c = Math.floor(v);
        if (c < 0) c = 0; else if (c > this.numCols - 2) c = this.numCols - 2;
        k = (v - c) <= zf ? 0 : 1;
      }
      return (r * (this.numCols - 1) + c) * 2 + k;
    }

    // ===== Field interpolation (spec §7 sampleFields) =====
    // Field values live only at the points. To read a field anywhere: locate
    // the containing face (O(1)) and blend its 3 corners barycentrically.

    // Containing face's corners + barycentric weights at (x, z).
    sampleAt(x, z) {
      const f = this.faceAt(x, z);
      const s = f * 3;
      const i0 = this._faceCorner[s], i1 = this._faceCorner[s + 1], i2 = this._faceCorner[s + 2];
      const ax = this.a_x, az = this.a_z;
      const Ax = ax[i0], Az = az[i0], Bx = ax[i1], Bz = az[i1], Cx = ax[i2], Cz = az[i2];
      const d = (Bz - Cz) * (Ax - Cx) + (Cx - Bx) * (Az - Cz);
      const invD = 1 / d; // equilateral faces — never degenerate
      const w0 = ((Bz - Cz) * (x - Cx) + (Cx - Bx) * (z - Cz)) * invD;
      const w1 = ((Cz - Az) * (x - Cx) + (Ax - Cx) * (z - Cz)) * invD;
      return { i0, i1, i2, w0, w1, w2: 1 - w0 - w1 };
    }

    // Interpolate a per-point vector field (parallel dx/dz arrays) at (x, z).
    sampleVec(x, z, arrDx, arrDz) {
      const s = this.sampleAt(x, z);
      return {
        dx: s.w0 * arrDx[s.i0] + s.w1 * arrDx[s.i1] + s.w2 * arrDx[s.i2],
        dz: s.w0 * arrDz[s.i0] + s.w1 * arrDz[s.i1] + s.w2 * arrDz[s.i2],
      };
    }

    // Interpolate a per-point scalar field at (x, z).
    sampleScalar(x, z, arr) {
      const s = this.sampleAt(x, z);
      return s.w0 * arr[s.i0] + s.w1 * arr[s.i1] + s.w2 * arr[s.i2];
    }

    // Rasterize a per-point field to a full mapW×mapH raster by barycentric
    // interpolation over the faces (one pass; faces tile, so each pixel is
    // written once). `out` is length mapW*mapH; `round` (default true) rounds
    // to bytes, pass false + a Float32Array for signed fields (vectors).
    // JS-only: this whole-map bake is the visualiser's sampleFields; the C#
    // port evaluates sampleAt per column on demand — same face location +
    // barycentric + rounding ⇒ identical bytes.
    rasterizeAnchorField(values, out, round = true) {
      const ax = this.a_x, az = this.a_z;
      const mapW = this.mapW, mapH = this.mapH;
      const EPS = -1e-7; // pixels exactly on shared edges must not fall through
      for (let f = 0; f < this.numFaces; f++) {
        const s = f * 3;
        const iA = this._faceCorner[s], iB = this._faceCorner[s + 1], iC = this._faceCorner[s + 2];
        const Ax = ax[iA], Az = az[iA];
        const Bx = ax[iB], Bz = az[iB];
        const Cx = ax[iC], Cz = az[iC];
        const d = (Bz - Cz) * (Ax - Cx) + (Cx - Bx) * (Az - Cz);
        const invD = 1 / d;
        const vA = values[iA], vB = values[iB], vC = values[iC];
        let minX = Math.floor(Math.min(Ax, Bx, Cx)); if (minX < 0) minX = 0;
        let maxX = Math.ceil (Math.max(Ax, Bx, Cx)); if (maxX > mapW - 1) maxX = mapW - 1;
        let minZ = Math.floor(Math.min(Az, Bz, Cz)); if (minZ < 0) minZ = 0;
        let maxZ = Math.ceil (Math.max(Az, Bz, Cz)); if (maxZ > mapH - 1) maxZ = mapH - 1;
        if (minX > maxX || minZ > maxZ) continue; // face fully outside the map
        for (let z = minZ; z <= maxZ; z++) {
          const row = z * mapW;
          for (let x = minX; x <= maxX; x++) {
            const w1 = ((Bz - Cz) * (x - Cx) + (Cx - Bx) * (z - Cz)) * invD;
            if (w1 < EPS) continue;
            const w2 = ((Cz - Az) * (x - Cx) + (Ax - Cx) * (z - Cz)) * invD;
            if (w2 < EPS) continue;
            const w3 = 1 - w1 - w2;
            if (w3 < EPS) continue;
            const val = w1 * vA + w2 * vB + w3 * vC;
            out[row + x] = round ? Math.round(val) : val;
          }
        }
      }
    }

    // JS-only dev check: every face equilateral with side = spacing, faceAt
    // returns the face whose centroid it is asked about, map fully covered.
    // Logs only; no effect on output.
    _verify() {
      const s = this.spacing;
      let maxErr = 0, locErrs = 0;
      const step = Math.max(1, (this.numFaces / 500) | 0); // sample ~500 faces
      for (let f = 0; f < this.numFaces; f += step) {
        const [i0, i1, i2] = this.faceCorners(f);
        const side = (a, b) => Math.hypot(this.a_x[a] - this.a_x[b], this.a_z[a] - this.a_z[b]);
        maxErr = Math.max(maxErr,
          Math.abs(side(i0, i1) - s), Math.abs(side(i1, i2) - s), Math.abs(side(i2, i0) - s));
        const c = this.faceCentroid(f);
        if (this.faceAt(c.x, c.z) !== f) locErrs++;
      }
      if (maxErr > s * 1e-4) {
        console.warn(`[mesh] face side-length error ${maxErr.toFixed(6)}px — lattice construction is wrong`);
      }
      if (locErrs > 0) {
        console.warn(`[mesh] faceAt failed on ${locErrs} sampled face centroids — location arithmetic is wrong`);
      }
    }
  }

  V.LatticeMesh = LatticeMesh;
})(window.VIS);
