// coast-field.js — CoastField (the emergent organic coastline)
//
// docs/continental-shape-spec.md §4, amended in discussion: NO mouth pinning —
// the field is fully decoupled from drainage/rivers. For a query column p:
//
//   land(p) = sd(p) + n(p) · A  >  0
//
// sd(p) = signed distance to the nearest primitive coast segment (+ inside a
// LAND face, − inside an OCEAN face); n(p) = seeded fractal noise in ≈[−1,1];
// A = amplitude. The coastline is the zero-crossing — never constructed as a
// curve, it emerges per column, which is what produces bays, inlets and
// offshore islets for free. The primitive's faceted geometry is never visible
// in output; it exists only as a distance inside this expression.
//
// Amplitude safety: every INTERIOR point is ≥ (√3/2)·s ≈ 0.866·s from the
// coast (its incident edges all have two LAND faces, so the nearest possible
// coast edge is an incident face's opposite side). A < that bound guarantees
// no data-carrying point ever ends up on the wrong side of the emergent
// coast. Non-INTERIOR guarantees don't exist for COASTAL points — they may
// land on either side, by design.
//
// Every column's answer is a pure function of (worldX, worldZ, seed): no
// iteration, no chunk-order dependence. The C# port evaluates isLandAt per
// column; the whole-map rasters here are the visualiser's bake of the same
// function (identical answers by construction).

window.VIS = window.VIS || {};

(function (V) {

  // Hard bound from the interior-point distance proof; amplitudes at or above
  // this could flip an interior point. The approved calibration is 0.45.
  const AMPLITUDE_HARD_BOUND = Math.sqrt(3) / 2;

  class CoastField {
    constructor(opts, mesh, continent) {
      this.mapW = opts.mapW;
      this.mapH = opts.mapH;
      this.seed = opts.seed | 0;
      this.mesh = mesh;
      this.continent = continent;

      const s = mesh.spacing;
      this.spacing = s;

      let amp = opts.coastAmplitude ?? 0.45;
      if (amp >= AMPLITUDE_HARD_BOUND) {
        console.warn(`[coast-field] amplitude ${amp}·s ≥ hard bound ${AMPLITUDE_HARD_BOUND.toFixed(3)}·s — clamping`);
        amp = AMPLITUDE_HARD_BOUND - 0.01;
      }
      this.amplitude = amp * s;                 // px
      this.band = this.amplitude + 0.1 * s;     // evaluation radius R: beyond it the noise can't flip the sign

      // Two independent noise stacks (spec §4.2). Fine carries the approved
      // look; coarse (whole edges swinging together) is a knob defaulting 0.
      this.coarseBlend = opts.coastCoarseBlend ?? 0;
      this._fine   = V.createFBM(this.seed + 71001, 1 / (1.0 * s), 4, 0.5);
      this._coarse = V.createFBM(this.seed + 71002, 1 / (3.5 * s), 2, 0.5);

      this._buildCoastSegments();
      this._buildRasters();
      this._verify();
    }

    // ===== Primitive coast segments =====
    // A coast segment is a lattice edge shared by exactly one LAND and one
    // OCEAN face — derived from the labels, not stored as geometry anywhere
    // else. Binned (bin size = s) for the distance query.
    _buildCoastSegments() {
      const mesh = this.mesh;
      const state = this.continent.faceState;
      const segs = [];   // flat: x1, z1, x2, z2 per segment

      for (let f = 0; f < mesh.numFaces; f++) {
        const landF = state[f] > 0;
        const nbrs = mesh.faceEdgeNeighbors(f);
        for (let i = 0; i < nbrs.length; i++) {
          const g = nbrs[i];
          if (g < f) continue;                    // each shared edge once
          if ((state[g] > 0) === landF) continue; // same label — not coast
          // Shared edge = the two corners f and g have in common.
          const [a0, a1, a2] = mesh.faceCorners(f);
          const [b0, b1, b2] = mesh.faceCorners(g);
          let p = -1, q = -1;
          for (const c of [a0, a1, a2]) {
            if (c === b0 || c === b1 || c === b2) { if (p < 0) p = c; else q = c; }
          }
          segs.push(mesh.a_x[p], mesh.a_z[p], mesh.a_x[q], mesh.a_z[q]);
        }
      }
      this.coastSegments = new Float64Array(segs);
      this.numSegments = segs.length / 4;

      // Spatial bins over the map (+1 bin margin each side for off-map ends).
      const binSize = this.spacing;
      this._binSize = binSize;
      this._binCols = Math.ceil(this.mapW / binSize) + 2;
      this._binRows = Math.ceil(this.mapH / binSize) + 2;
      const bins = new Array(this._binCols * this._binRows);
      this._bins = bins;
      const binOf = (x, z) => {
        const bx = Math.max(0, Math.min(this._binCols - 1, Math.floor(x / binSize) + 1));
        const bz = Math.max(0, Math.min(this._binRows - 1, Math.floor(z / binSize) + 1));
        return bz * this._binCols + bx;
      };
      for (let i = 0; i < this.numSegments; i++) {
        const x1 = this.coastSegments[4 * i], z1 = this.coastSegments[4 * i + 1];
        const x2 = this.coastSegments[4 * i + 2], z2 = this.coastSegments[4 * i + 3];
        // Register into every bin the segment's bbox touches (≤ 4 — segments
        // are one lattice edge long).
        const bxA = Math.min(binOf(x1, z1) % this._binCols, binOf(x2, z2) % this._binCols);
        const bxB = Math.max(binOf(x1, z1) % this._binCols, binOf(x2, z2) % this._binCols);
        const bzA = Math.min((binOf(x1, z1) / this._binCols) | 0, (binOf(x2, z2) / this._binCols) | 0);
        const bzB = Math.max((binOf(x1, z1) / this._binCols) | 0, (binOf(x2, z2) / this._binCols) | 0);
        for (let bz = bzA; bz <= bzB; bz++) {
          for (let bx = bxA; bx <= bxB; bx++) {
            const b = bz * this._binCols + bx;
            if (!bins[b]) bins[b] = [];
            bins[b].push(i);
          }
        }
      }
    }

    // Distance from (x, z) to the nearest coast segment within the K-ring of
    // bins covering the evaluation band; Infinity when none is that close.
    _distToCoast(x, z) {
      const binSize = this._binSize;
      const K = Math.ceil(this.band / binSize) + 1;
      const bx = Math.floor(x / binSize) + 1;
      const bz = Math.floor(z / binSize) + 1;
      let best = Infinity;
      for (let dz = -K; dz <= K; dz++) {
        const rz = bz + dz;
        if (rz < 0 || rz >= this._binRows) continue;
        for (let dx = -K; dx <= K; dx++) {
          const rx = bx + dx;
          if (rx < 0 || rx >= this._binCols) continue;
          const bin = this._bins[rz * this._binCols + rx];
          if (!bin) continue;
          for (let m = 0; m < bin.length; m++) {
            const i = bin[m] * 4;
            const d = this._pointSegDist(x, z,
              this.coastSegments[i], this.coastSegments[i + 1],
              this.coastSegments[i + 2], this.coastSegments[i + 3]);
            if (d < best) best = d;
          }
        }
      }
      return best;
    }

    _pointSegDist(px, pz, x1, z1, x2, z2) {
      const dx = x2 - x1, dz = z2 - z1;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 0 ? ((px - x1) * dx + (pz - z1) * dz) / len2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const ex = x1 + t * dx - px, ez = z1 + t * dz - pz;
      return Math.sqrt(ex * ex + ez * ez);
    }

    // ===== The field =====

    // Blended noise in ≈[−1, 1].
    _noise(x, z) {
      const w = this.coarseBlend;
      if (w <= 0) return this._fine(x, z);
      return this._coarse(x, z) * w + this._fine(x, z) * (1 - w);
    }

    // Per-column land/ocean — the game-facing query. Outside the band the
    // noise term can't flip the sign, so the containing face's label answers
    // directly (spec §4.4).
    isLandAt(x, z) {
      const faceLand = this.continent.faceState[this.mesh.faceAt(x, z)] > 0;
      const d = this._distToCoast(x, z);
      if (d > this.band) return faceLand;
      const sd = faceLand ? d : -d;
      return sd + this._noise(x, z) * this.amplitude > 0;
    }

    // Signed distance (debug/inspection; + = land side).
    // Signed distance to the WARPED coastline — the one isLandAt actually draws,
    // so its zero contour IS the shoreline and its sign always agrees with
    // isLandAt. + = land side, - = water side. ±Infinity beyond the band, where
    // the noise can no longer flip the sign and the face label is the answer.
    // This is what gives depth to water narrower than the lattice: it is defined
    // at every pixel, so nothing depends on an anchor happening to fall inside.
    signedDistWarpedAt(x, z) {
      const faceLand = this.continent.faceState[this.mesh.faceAt(x, z)] > 0;
      const d = this._distToCoast(x, z);
      if (d > this.band) return faceLand ? Infinity : -Infinity;
      return (faceLand ? d : -d) + this._noise(x, z) * this.amplitude;
    }

    signedDistAt(x, z) {
      const faceLand = this.continent.faceState[this.mesh.faceAt(x, z)] > 0;
      const d = this._distToCoast(x, z);
      return faceLand ? d : -d;
    }

    // ===== Visualiser rasters =====
    // landMask: the Detailed land/ocean view (1 = land). coastMask: its edge
    // pixels, for drawing the emergent coastline. Band-limited: pixels beyond
    // the band copy the primitive landGrid, only the coastal band evaluates
    // noise.
    _buildRasters() {
      const { mapW, mapH } = this;
      const lg = this.continent.landGrid;
      this.landMask = new Uint8Array(mapW * mapH);
      this.landMask.set(lg);

      // Mark the evaluation band from the segments (bbox + band margin), then
      // evaluate only those pixels.
      const pad = Math.ceil(this.band) + 1;
      const band = new Uint8Array(mapW * mapH);
      for (let i = 0; i < this.numSegments; i++) {
        const x1 = this.coastSegments[4 * i], z1 = this.coastSegments[4 * i + 1];
        const x2 = this.coastSegments[4 * i + 2], z2 = this.coastSegments[4 * i + 3];
        const x0 = Math.max(0, Math.floor(Math.min(x1, x2)) - pad);
        const xE = Math.min(mapW - 1, Math.ceil(Math.max(x1, x2)) + pad);
        const z0 = Math.max(0, Math.floor(Math.min(z1, z2)) - pad);
        const zE = Math.min(mapH - 1, Math.ceil(Math.max(z1, z2)) + pad);
        for (let z = z0; z <= zE; z++) {
          const row = z * mapW;
          for (let x = x0; x <= xE; x++) band[row + x] = 1;
        }
      }

      let evaluated = 0;
      for (let z = 0; z < mapH; z++) {
        const row = z * mapW;
        for (let x = 0; x < mapW; x++) {
          if (!band[row + x]) continue;
          evaluated++;
          this.landMask[row + x] = this.isLandAt(x, z) ? 1 : 0;
        }
      }

      // Emergent coastline pixels (4-neighbor edge scan of the mask).
      this.coastMask = new Uint8Array(mapW * mapH);
      const lm = this.landMask;
      for (let z = 0; z < mapH; z++) {
        for (let x = 0; x < mapW; x++) {
          const i = z * mapW + x;
          if (lm[i] !== 1) continue;
          if ((x > 0        && lm[z * mapW + (x - 1)] === 0) ||
              (x < mapW - 1 && lm[z * mapW + (x + 1)] === 0) ||
              (z > 0        && lm[(z - 1) * mapW + x] === 0) ||
              (z < mapH - 1 && lm[(z + 1) * mapW + x] === 0)) {
            this.coastMask[i] = 1;
          }
        }
      }

      // Porting mirror — copy to the C# debug logs.
      console.log(`[coast-field] segments=${this.numSegments} A=${this.amplitude.toFixed(2)}px ` +
        `band=${this.band.toFixed(2)}px evaluated=${evaluated}px fieldMask=${V.checksum(this.landMask).toString(16)}`);
    }

    // JS-only dev check (spec §6 invariant 7): no INTERIOR point may evaluate
    // ocean, no OCEANIC point land — guaranteed by the amplitude bound, so a
    // hit means the bound proof's premise (or the field) is broken.
    _verify() {
      const mesh = this.mesh, pc = this.continent.pointClass;
      let flipped = 0;
      const step = Math.max(1, (mesh.numAnchors / 2000) | 0); // sample ~2000 points
      for (let t = 0; t < mesh.numAnchors; t += step) {
        const x = mesh.a_x[t], z = mesh.a_z[t];
        if (x < 0 || x >= this.mapW || z < 0 || z >= this.mapH) continue;
        if (pc[t] === V.POINT_INTERIOR && !this.isLandAt(x, z)) flipped++;
        if (pc[t] === V.POINT_OCEANIC  &&  this.isLandAt(x, z)) flipped++;
      }
      if (flipped > 0) {
        console.warn(`[coast-field] ${flipped} sampled interior/oceanic points flipped by the field — amplitude bound violated?`);
      }
    }
  }

  V.CoastField = CoastField;

})(window.VIS);
