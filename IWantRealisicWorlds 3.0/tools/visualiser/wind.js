// wind.js — WindModel
//
// A wind vector (direction + magnitude) from one law, evaluated per data
// point (computeAnchorWinds — the primitive the visualiser renders and
// climate reads). The law, at a position:
//   1. Latitude band base — 6-belt table (easterlies, westerlies, trades × 2
//      hemispheres; boundary latitudes carry zero magnitude).
//   2. Jet meander — fBm shifts the effective latitude (±~13°).
//   3. Cyclone rotation — orthogonal fBm reads, hemisphere-correct sign.
//   4. Land friction (land only) — bounded upwind ray; magnitude drops with the
//      over-land fraction.
//   5. Mountain shadow (land only, not in an orogen) — bounded upwind ray;
//      magnitude drops (distance-faded) if a range sits upwind.

window.VIS = window.VIS || {};

(function (V) {

  // Latitude → colour. Poles cold blue, equator warm orange.
  function latColor(lat) {
    const t = 1 - Math.abs(lat) / 90;
    const r = Math.round(60  + (250 - 60)  * t);
    const g = Math.round(130 + (160 - 130) * t);
    const b = Math.round(230 + (80  - 230) * t);
    return [r, g, b];
  }

  // 6-belt latitude wind anchor table. Boundary latitudes (0°, ±30°,
  // ±60°, ±90°) carry zero magnitude — doldrums, horse latitudes, polar
  // boundary, pole. +x east, +z south. Sorted high-latitude → low.
  const _ANCHORS = [
    { lat:  90, dx:  0,    dz:  0    },
    { lat:  75, dx: -0.38, dz:  0.12 },
    { lat:  60, dx:  0,    dz:  0    },
    { lat:  45, dx:  0.76, dz: -0.24 },
    { lat:  30, dx:  0,    dz:  0    },
    { lat:  15, dx: -0.67, dz:  0.21 },
    { lat:   0, dx:  0,    dz:  0    },
    { lat: -15, dx: -0.67, dz: -0.21 },
    { lat: -30, dx:  0,    dz:  0    },
    { lat: -45, dx:  0.76, dz:  0.24 },
    { lat: -60, dx:  0,    dz:  0    },
    { lat: -75, dx: -0.38, dz: -0.12 },
    { lat: -90, dx:  0,    dz:  0    },
  ];

  // Algorithm constants. Tunable; adjust here as we iterate visually.
  const RAY_STEPS = 8;
  const FRICTION_MAX_REDUCTION = 0.5;   // up to 50% magnitude loss when fully overland
  const SHADOW_MIN = 0.3;                // strongest shadow leaves 30% magnitude
  const CYCLONE_STRENGTH = 0.25;
  const MEANDER_DEGREES = 13.5;

  // Wind/current byte encoding (docs/14_vs_wind.md). Vector components are stored
  // as SIGNED 0–255 bytes — 128 = calm, ±WIND_MAX at the ends — so wind/currents
  // are consistent 0–255 with the other maps and readable by the future
  // wind-shader mod (which maps decoded (dx,dz) → VS's Vec3(dx,0,dz)). Fixed
  // scale, not self-scaled, so the mapping is a stable documented constant.
  // WIND_MAX ≈ VS's max wind component (~1.5; PModuleWind's 0.8 threshold —
  // VERIFY IN-GAME). Shared by wind + currents (currents.js reuses V.WIND_MAX).
  const WIND_MAX = 1.5;
  V.WIND_MAX = WIND_MAX;
  V.encodeSignedByte = (v, max) =>
    Math.max(0, Math.min(255, Math.round(v / max * 127) + 128));
  V.decodeSignedByte = (b, max) => (b - 128) / 127 * max;

  class WindModel {
    constructor(opts, continent, tectonic, provinces) {
      this.mapW = opts.mapW;
      this.mapH = opts.mapH;
      this.seed = opts.seed | 0;
      this.continent = continent;
      this.tectonic = tectonic;
      this.provinces = provinces;     // Read primitiveMap byte instead of
                                       // re-querying provinceAt.
      this.polarEquatorDistance = opts.polarEquatorDistance > 0
        ? opts.polarEquatorDistance
        : this.mapH / 2;

      this.jetMeander   = V.createFBM(this.seed + 9001, 1 / 150, 2, 0.5);
      this.cycloneNoise = V.createFBM(this.seed + 9002, 1 / 40,  3, 0.6);

    }

    // Per-point wind — the primitive. Runs the wind law at each lattice point
    // (a pure function of position + isLand); isLand comes from the point's
    // classification (COASTAL counts as land, consistent with upheaval).
    computeAnchorWinds(mesh) {
      if (!mesh || !this.continent) return;
      const n = mesh.numAnchors;
      // Primitive: signed component BYTES per point (128 = calm; ±WIND_MAX at
      // the ends). Consistent 0–255 with the other maps, readable by the mod.
      this.anchorWindDx = new Uint8Array(n).fill(128);
      this.anchorWindDz = new Uint8Array(n).fill(128);
      const pointClass = this.continent.pointClass;
      // Upwind ray step ≈ one data-point spacing (same physical reach the
      // cell-spacing-derived step gave before the lattice rework).
      const stepSize = Math.max(8, mesh.spacing);
      for (let t = 0; t < n; t++) {
        const ax = mesh.a_x[t], az = mesh.a_z[t];
        const isLand = pointClass[t] >= V.POINT_COASTAL;
        const w = this._computeWindAt(ax, az, isLand, stepSize);
        this.anchorWindDx[t] = V.encodeSignedByte(w.dx, WIND_MAX);
        this.anchorWindDz[t] = V.encodeSignedByte(w.dz, WIND_MAX);
      }

      // Detailed field: the interpolating READER. Decode the byte primitive back
      // to float components and interpolate to full rasters — the same barycentric
      // blend a per-pixel read would give, so it is a cache of the truth. Kept
      // float; the detailed arrows read these.
      //
      // NO BLUR (removed 2026-07-27, with climate's and currents'). Full-map blurs
      // are gone from the visualiser everywhere: they need the whole world to
      // exist, and we tune fields by painting values rather than diluting them
      // through an extra layer. Arrows are rawer for it, on purpose.
      const decDx = new Float32Array(n), decDz = new Float32Array(n);
      for (let t = 0; t < n; t++) {
        decDx[t] = V.decodeSignedByte(this.anchorWindDx[t], WIND_MAX);
        decDz[t] = V.decodeSignedByte(this.anchorWindDz[t], WIND_MAX);
      }
      const px = this.mapW * this.mapH;
      this.detailedWindDx = new Float32Array(px);
      this.detailedWindDz = new Float32Array(px);
      mesh.rasterizeAnchorField(decDx, this.detailedWindDx, false);
      mesh.rasterizeAnchorField(decDz, this.detailedWindDz, false);
    }

    // The wind law at one position, given its land state (the caller resolves
    // isLand from the point classification).
    _computeWindAt(cx, cz, isLand, stepSize) {
      const rawLat = this.latitudeAt(cz);

      // Step 2: jet meander shifts effective latitude.
      const meander = this.jetMeander(cx, cz) * MEANDER_DEGREES;
      let effLat = rawLat + meander;
      if (effLat > 90) effLat = 90;
      else if (effLat < -90) effLat = -90;

      // Step 1: latitude band base — interpolate between surrounding anchors.
      const ai = this._anchorIndexBelow(effLat);
      const a = _ANCHORS[ai];
      const b = _ANCHORS[ai + 1];
      const span = a.lat - b.lat;
      const t = span > 0 ? (a.lat - effLat) / span : 0;
      const ts = t * t * (3 - 2 * t);
      let dx = a.dx * (1 - ts) + b.dx * ts;
      let dz = a.dz * (1 - ts) + b.dz * ts;

      // Step 3: cyclone rotation. Hemisphere sign keeps spin Coriolis-correct.
      const cycX = this.cycloneNoise(cx, cz);
      const cycZ = this.cycloneNoise(cx + 7000, cz + 3000);
      const hemiSign = rawLat >= 0 ? 1 : -1;
      dx += cycZ * CYCLONE_STRENGTH;
      dz -= cycX * CYCLONE_STRENGTH * hemiSign;

      let magnitude = Math.sqrt(dx * dx + dz * dz);

      // Steps 4 + 5: land-only modifiers. Both share the same upwind ray.
      if (isLand && magnitude > 0.001) {
        const ux = dx / magnitude, uz = dz / magnitude;

        // Step 4: friction.
        let overLandCount = 0;
        for (let r = 1; r <= RAY_STEPS; r++) {
          const tx = cx - ux * r * stepSize;
          const tz = cz - uz * r * stepSize;
          if (this._isLandAt(tx, tz)) overLandCount++;
        }
        const overLandFraction = overLandCount / RAY_STEPS;
        magnitude *= 1 - overLandFraction * FRICTION_MAX_REDUCTION;

        // Step 5: mountain shadow. Skip if this point is itself in a range —
        // it's the wind-blocker, not the leeward side. Province lookups
        // read provinces.primitiveMap byte (precomputed at the unwarped
        // pixel) instead of re-running provinceAt — saves the exact
        // distance-query + plate-pair work per ray sample.
        const primMap = this.provinces && this.provinces.primitiveMap;
        const ownProv = primMap
          ? primMap[(Math.max(0, Math.min(this.mapH - 1, cz | 0))) * this.mapW
                    + (Math.max(0, Math.min(this.mapW - 1, cx | 0)))]
          : V.provinceAt(this.tectonic, cx, cz, true);
        const inOrogen = ownProv === V.PROVINCE_OROGEN || ownProv === V.PROVINCE_EXTENDED_CRUST;
        if (!inOrogen) {
          for (let r = 1; r <= RAY_STEPS; r++) {
            const tx = cx - ux * r * stepSize;
            const tz = cz - uz * r * stepSize;
            if (!this._isLandAt(tx, tz)) break;   // ocean upwind: no land range
            const upProv = primMap
              ? primMap[(tz | 0) * this.mapW + (tx | 0)]
              : V.provinceAt(this.tectonic, tx, tz, true);
            if (upProv === V.PROVINCE_OROGEN || upProv === V.PROVINCE_EXTENDED_CRUST) {
              const fade = r / RAY_STEPS;          // 0..1, 0 = closest range
              magnitude *= SHADOW_MIN + (1 - SHADOW_MIN) * fade;
              break;
            }
          }
        }
      }

      if (magnitude < 0) magnitude = 0;

      // Re-emit dx/dz with the reduced magnitude, preserving direction.
      const oldMag = Math.sqrt(dx * dx + dz * dz);
      if (oldMag > 0.001) {
        const scale = magnitude / oldMag;
        dx *= scale;
        dz *= scale;
      } else {
        dx = 0; dz = 0;
      }

      return { dx, dz };
    }

    _isLandAt(x, z) {
      const ix = Math.floor(x), iz = Math.floor(z);
      if (ix < 0 || ix >= this.mapW || iz < 0 || iz >= this.mapH) return false;
      const lg = this.continent && this.continent.landGrid;
      return !!(lg && lg[iz * this.mapW + ix] === 1);
    }

    latitudeAt(z) {
      const lat = (this.mapH / 2 - z) / this.polarEquatorDistance * 90;
      return lat > 90 ? 90 : (lat < -90 ? -90 : lat);
    }

    // Latitude with the same jet-meander warp wind belts use. Climate
    // reads through this so the wet equatorial band, subtropical desert
    // band, and mid-latitude westerlies belts all curve organically with
    // the wind belts (one underlying fBm field, both layers ride it).
    effectiveLatitudeAt(x, z) {
      const raw = this.latitudeAt(z);
      const meander = this.jetMeander(x, z) * MEANDER_DEGREES;
      let eff = raw + meander;
      if (eff > 90) eff = 90;
      else if (eff < -90) eff = -90;
      return eff;
    }

    _anchorIndexBelow(lat) {
      for (let i = 0; i < _ANCHORS.length - 1; i++) {
        if (_ANCHORS[i].lat >= lat && _ANCHORS[i + 1].lat <= lat) return i;
      }
      if (lat >= _ANCHORS[0].lat) return 0;
      return _ANCHORS.length - 2;
    }
  }

  V.WindModel = WindModel;
  V.latColor = latColor;

})(window.VIS);
