// currents.js — CurrentsModel
//
// A current vector + temperature offset from one law, per OCEANIC data point
// (computeAnchorCurrents — the primitive the visualiser renders and climate
// reads). Land and coastal points carry no current.
//
// Direction: take the wind vector → Ekman-rotate 45° (right in N, left in S) →
// near a coast, project onto the coast tangent and drop the into-land normal, so
// boundary currents run along the coast at full speed (hash tiebreak when the
// wind is exactly perpendicular). Coast normal = the mean direction toward the
// point's COASTAL lattice neighbors (an oceanic point one step off the coast).
//
// Temp offset: walk backward along -current, average the latitude base-temp of
// the samples, subtract the own-latitude temp. Surfaces through climate temp.

window.VIS = window.VIS || {};

(function (V) {

  // Latitude → base temperature [0, 1]. Piecewise linear curve, used only for
  // the current's temp-offset lineage — climate.js has its own curve, built
  // from its band knobs. latNorm = abs(latDeg)/90; equator = 0, pole = 1.
  const TEMP_CURVE = [
    [0.00, 1.00],   // equator
    [0.30, 0.85],   // hot plateau end
    [0.35, 0.65],   // fast drop into temperate
    [0.65, 0.35],   // temperate plateau end
    [0.70, 0.20],   // fast drop into cold
    [1.00, 0.08],   // pole
  ];

  function piecewiseLerp(x, curve) {
    const n = Math.max(0, Math.min(1, x));
    for (let i = 0; i < curve.length - 1; i++) {
      const [x0, y0] = curve[i];
      const [x1, y1] = curve[i + 1];
      if (n <= x1) {
        const t = (n - x0) / (x1 - x0);
        return y0 + t * (y1 - y0);
      }
    }
    return curve[curve.length - 1][1];
  }

  function latToTemp(rawLatDeg) {
    return piecewiseLerp(Math.abs(rawLatDeg) / 90, TEMP_CURVE);
  }

  // Algorithm constants. Tunable; adjust here as we iterate visually.
  const RAY_STEPS = 8;
  const ROT45 = Math.SQRT1_2;   // cos(45°) = sin(45°) = √2/2

  // Temp-offset byte scale (docs/14_vs_wind.md). tempOff is a difference of two
  // normalized [0,1] temperatures, so it lives in [-1,1] → signed byte around
  // 128. Components reuse V.WIND_MAX (currents share the wind component scale).
  const CURRENT_TEMP_MAX = 1.0;
  V.CURRENT_TEMP_MAX = CURRENT_TEMP_MAX;

  class CurrentsModel {
    // `tectonic` is accepted to keep the constructor shape of its siblings
    // (wind/climate); the current law reads nothing from it.
    constructor(opts, continent, tectonic, wind) {
      this.mapW = opts.mapW;
      this.mapH = opts.mapH;
      this.seed = opts.seed | 0;
      this.continent = continent;
      this.wind = wind;
    }

    // Per-point current — the primitive. Runs the current law at each OCEANIC
    // lattice point: its own wind → Ekman → coastal deflection → temp-offset
    // lineage. Land/coastal points carry no current. Reads the point wind
    // computed in wind.computeAnchorWinds.
    computeAnchorCurrents(mesh) {
      if (!mesh || !this.wind || !this.wind.anchorWindDx) return;
      const pointClass = this.continent && this.continent.pointClass;
      if (!pointClass) return;

      const n = mesh.numAnchors;
      // Primitive: signed component BYTES per point (128 = calm). Land/coastal
      // points carry no current → stay 128. tempOff is its own signed byte.
      this.anchorCurrentDx = new Uint8Array(n).fill(128);
      this.anchorCurrentDz = new Uint8Array(n).fill(128);
      this.anchorCurrentTempOff = new Uint8Array(n).fill(128);
      const wdx = this.wind.anchorWindDx, wdz = this.wind.anchorWindDz; // byte-encoded
      const WMAX = V.WIND_MAX;
      // Lineage ray step ≈ one data-point spacing (same physical reach the
      // cell-spacing-derived step gave before the lattice rework).
      const stepSize = Math.max(8, mesh.spacing);

      for (let t = 0; t < n; t++) {
        const ax = mesh.a_x[t], az = mesh.a_z[t];
        if (pointClass[t] !== V.POINT_OCEANIC) continue;   // land/coastal — no current
        const wx = V.decodeSignedByte(wdx[t], WMAX), wz = V.decodeSignedByte(wdz[t], WMAX);
        if (Math.sqrt(wx * wx + wz * wz) < 0.001) continue;
        const rawLat = this.wind.latitudeAt(az);

        // Ekman rotation — CW 45° north, CCW 45° south.
        const isNorth = rawLat >= 0;
        let dx, dz;
        if (isNorth) { dx = wx * ROT45 - wz * ROT45; dz = wx * ROT45 + wz * ROT45; }
        else         { dx = wx * ROT45 + wz * ROT45; dz = -wx * ROT45 + wz * ROT45; }
        const ekmanMag = Math.sqrt(dx * dx + dz * dz);

        // Coast normal: mean direction toward COASTAL lattice neighbors (an
        // OCEANIC point can only neighbor OCEANIC or COASTAL points, so this
        // is exactly "toward the shoreline" one step out).
        const nbrs = mesh.neighborsOfAnchor(t);
        let lnx = 0, lnz = 0, landCount = 0;
        for (let k = 0; k < nbrs.length; k++) {
          const nb = nbrs[k];
          if (pointClass[nb] === V.POINT_COASTAL) {
            lnx += mesh.a_x[nb] - ax; lnz += mesh.a_z[nb] - az; landCount++;
          }
        }
        if (landCount > 0 && ekmanMag > 1e-6) {
          const nLen = Math.sqrt(lnx * lnx + lnz * lnz) || 1;
          const normX = lnx / nLen, normZ = lnz / nLen;
          const tanX = -normZ, tanZ = normX;
          const projection = dx * tanX + dz * tanZ;
          let sTanX, sTanZ;
          if (Math.abs(projection) > 1e-6) {
            const sign = projection > 0 ? 1 : -1;
            sTanX = tanX * sign; sTanZ = tanZ * sign;
          } else {
            const h = V.hash2d ? V.hash2d(t, 0, this.seed + 7777) : 0.5;
            const sign = h >= 0.5 ? 1 : -1;
            sTanX = tanX * sign; sTanZ = tanZ * sign;
          }
          dx = sTanX * ekmanMag; dz = sTanZ * ekmanMag;
        }

        this.anchorCurrentDx[t] = V.encodeSignedByte(dx, WMAX);
        this.anchorCurrentDz[t] = V.encodeSignedByte(dz, WMAX);

        // Temp offset — backward lineage trace along -current, latitude → temp.
        const magnitude = Math.sqrt(dx * dx + dz * dz);
        if (magnitude > 0.001) {
          const uz = dz / magnitude;
          let lineageSum = 0;
          for (let r = 1; r <= RAY_STEPS; r++) {
            lineageSum += latToTemp(this.wind.latitudeAt(az - uz * r * stepSize));
          }
          const off = (lineageSum / RAY_STEPS) - latToTemp(rawLat);
          this.anchorCurrentTempOff[t] = V.encodeSignedByte(off, CURRENT_TEMP_MAX);
        }
      }

      // Detailed field: the interpolating READER. Decode the byte primitive back
      // to float components and interpolate to full rasters — a cache of exactly
      // what a per-pixel read would give. Kept float.
      //
      // NO BLUR (removed 2026-07-27) — see wind.js for the reasoning; full-map
      // blurs are gone from the visualiser everywhere.
      const decDx = new Float32Array(n), decDz = new Float32Array(n);
      for (let t = 0; t < n; t++) {
        decDx[t] = V.decodeSignedByte(this.anchorCurrentDx[t], WMAX);
        decDz[t] = V.decodeSignedByte(this.anchorCurrentDz[t], WMAX);
      }
      const px = this.mapW * this.mapH;
      this.detailedCurrentDx = new Float32Array(px);
      this.detailedCurrentDz = new Float32Array(px);
      mesh.rasterizeAnchorField(decDx, this.detailedCurrentDx, false);
      mesh.rasterizeAnchorField(decDz, this.detailedCurrentDz, false);
    }
  }

  V.CurrentsModel = CurrentsModel;

})(window.VIS);
