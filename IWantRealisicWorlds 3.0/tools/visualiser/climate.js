// climate.js — ClimateModel (per-point primitive)
//
// Three byte values per data point — temperature, rainfall, geo activity —
// computed once at worldinit. Land and ocean run the same algorithm with
// a few inputs swapped or skipped. All deterministic from worldinit data;
// bounded local reads only.
//
// Temperature:
//   1. Latitude → piecewise temp curve (hot equatorial plateau, transition,
//      temperate plateau, transition, cold polar).
//   2. Land only — subtract continentality (coastNorm × strength).
//   3. Land coastal — average ocean neighbours' current temp offset, add
//      currentInfluence × averageOffset.
//      Ocean — add own current temp offset directly.
//   4. × globalTemperature, clamp [0, 1], scale to byte.
//
// Rainfall:
//   1. Latitude → piecewise rain curve (ITCZ wet, trades, subtropics,
//      desert dip, westerlies, polar front, polar dry).
//   2. Land only — coast aridity with latitude-varying decay K and minRain.
//   3. Land orogen point — orographic boost scaled by capped elevation.
//   4. Land — rain shadow upwind ray cast (stops at first orogen hit, fade
//      by distance, subtract proportional penalty).
//   5. Land coastal — for each ocean neighbour, dot wind direction with
//      neighbour-to-this vector; if positive, add windward bonus.
//   6. × globalPrecipitation, clamp [0, 1], scale to byte.
//
// Geo activity (land + ocean):
//   1. Distance to nearest active boundary → exponential decay.
//   2. Hotspot proximity bump (max with step 1, no double-count).
//   3. Clamp [0, 255], byte.

window.VIS = window.VIS || {};

(function (V) {

  // Curve generators. `tropicalEnd` is the latNorm where the hot/wet
  // equatorial plateau ends; `temperateEnd` is the latNorm where the
  // temperate plateau ends and polar dryness/cold begins. Shape stays
  // constant; breakpoints rescale with these two so the user can shrink
  // tropical and widen temperate (or vice versa) from sliders.

  function makeTempCurve(tropicalEnd, temperateEnd) {
    return [
      [0.0,                  1.00],
      [tropicalEnd,          0.85],   // hot plateau end
      [tropicalEnd + 0.05,   0.65],   // fast drop into temperate
      [temperateEnd,         0.35],   // temperate plateau end
      [temperateEnd + 0.05,  0.20],   // fast drop into cold
      [1.0,                  0.08],
    ];
  }

  function makeRainCurve(tropicalEnd, temperateEnd) {
    const span = Math.max(0.02, temperateEnd - tropicalEnd);
    return [
      [0.0,                                    1.00],   // ITCZ
      [tropicalEnd * 0.4,                      0.85],   // trade winds
      [tropicalEnd,                            0.50],   // subtropics start
      [tropicalEnd + span * 0.25,              0.40],   // desert dip
      [tropicalEnd + span * 0.30,              0.55],   // recovery to westerlies
      [tropicalEnd + span * 0.65,              0.70],   // temperate peak
      [temperateEnd,                           0.50],   // polar front
      [temperateEnd + (1 - temperateEnd) * 0.6, 0.25],  // subarctic
      [1.0,                                    0.05],   // polar desert
    ];
  }

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

  // Colour gradients for the three byte views. Stop-list lookup, same
  // shape as upheavalRGB.
  const TEMP_STOPS = [
    [0,     20,  40, 120],   // deep blue (polar cold)
    [64,   110, 170, 220],   // light blue (subarctic)
    [128,  180, 220, 160],   // pale green (temperate)
    [180,  240, 200, 100],   // yellow-orange (warm temperate)
    [220,  240, 130,  60],   // orange (subtropical)
    [255,  180,  30,  30],   // deep red (equatorial hot)
  ];
  const RAIN_STOPS = [
    [0,    120,  80,  40],   // dark brown (true desert)
    [40,   200, 170, 110],   // tan (semi-arid)
    [80,   220, 220, 150],   // pale yellow (Mediterranean)
    [120,  140, 200, 130],   // light green (temperate moist)
    [180,   70, 170, 180],   // blue-green (humid)
    [255,   20,  60, 160],   // deep blue (rainforest)
  ];
  const GEO_STOPS = [
    [0,     40,  40,  50],   // dark grey (calm)
    [100,  100,  70,  50],   // brown (mild)
    [180,  220, 130,  50],   // orange (active)
    [220,  255, 170,  50],   // bright orange (very active)
    [255,  255, 230, 100],   // yellow-white (volcanic peak)
  ];

  function gradientLookup(byte, stops) {
    if (byte <= stops[0][0]) return stops[0].slice(1);
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      if (byte <= b[0]) {
        const t = (byte - a[0]) / (b[0] - a[0]);
        return [
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t,
          a[3] + (b[3] - a[3]) * t,
        ];
      }
    }
    return stops[stops.length - 1].slice(1);
  }

  function climateTempRGB(byte) { return gradientLookup(byte, TEMP_STOPS); }
  function climateRainRGB(byte) { return gradientLookup(byte, RAIN_STOPS); }
  function climateGeoRGB(byte)  { return gradientLookup(byte, GEO_STOPS); }

  const RAY_STEPS = 8;

  class ClimateModel {
    constructor(opts, continent, tectonic, wind, currents, upheaval, provinces, distanceFields) {
      this.mapW = opts.mapW;
      this.mapH = opts.mapH;
      this.seed = opts.seed | 0;
      this.continent = continent;
      this.tectonic = tectonic;
      this.wind = wind;
      this.currents = currents;
      this.upheaval = upheaval;
      this.provinces = provinces;     // For primitiveMap byte lookups in
                                      // place of provinceAt calls.
      this.distanceFields = distanceFields;  // distToOcean — see distance-fields.js

      // Latitude band shape — slider-driven. Curves rebuilt once at
      // construction; per-point lookups read from the cached arrays.
      const tropicalEnd  = opts.tropicalEnd  ?? 0.20;
      const temperateEnd = opts.temperateEnd ?? 0.70;
      this.tempCurve = makeTempCurve(tropicalEnd, temperateEnd);
      this.rainCurve = makeRainCurve(tropicalEnd, temperateEnd);

      // Tunable strengths (defaults match v1 conventions where applicable).
      this.globalTemperature      = opts.globalTemperature      ?? 1.0;
      this.globalPrecipitation    = opts.globalPrecipitation    ?? 1.0;
      this.continentalityStrength = opts.continentalityStrength ?? 0.23;
      this.currentInfluence       = opts.currentInfluence       ?? 0.10;
      this.orographicBoost        = opts.orographicBoost        ?? 0.20;
      this.rainShadowStrength     = opts.rainShadowStrength     ?? 0.30;
      this.windwardBonusStrength  = opts.windwardBonusStrength  ?? 0.15;
      // Per-point character: deterministic hash on (pointId, seed) gives
      // a small ± offset on the curve value. Adjacent points at the same
      // effective latitude pick up slightly different bytes — local texture
      // without resorting to per-pixel noise. `variationStrength` is the
      // slider-driven multiplier on top.
      const variationStrength     = opts.variationStrength      ?? 1.0;
      this.tempJitter             = (opts.tempJitter ?? 0.04) * variationStrength;
      this.rainJitter             = (opts.rainJitter ?? 0.08) * variationStrength;
    }

    _latToTemp(lat) { return piecewiseLerp(Math.abs(lat) / 90, this.tempCurve); }
    _latToRain(lat) { return piecewiseLerp(Math.abs(lat) / 90, this.rainCurve); }

    // ===== Per-point climate (the primitive) =====
    // The law evaluated at each data point, reading per-point inputs —
    // latitude, distToOcean, the per-point wind/currents, anchorHeight.
    // Neighbour-based bits (coastal current nudge, windward bonus) read
    // neighbour points — only COASTAL points have OCEANIC neighbours, so the
    // maritime effects land exactly on the shoreline points. Geo additionally
    // scales by the nearest active boundary's |intensity|. Builds detailed
    // rasters (interpolate + climate-wide blur) alongside.
    computeAnchorClimate(mesh) {
      if (!mesh) return;
      const n = mesh.numAnchors;
      this.anchorTemp = new Uint8Array(n);
      this.anchorRain = new Uint8Array(n);
      this.anchorGeo  = new Uint8Array(n);
      const isLandArr = this.upheaval && this.upheaval.anchorIsLand;
      const df = this.distanceFields;
      // Ray step ≈ one data-point spacing (same physical reach the
      // cell-spacing-derived step gave before the lattice rework).
      const stepSize = Math.max(8, mesh.spacing);

      // Pass 1: coast distance per anchor + max over land (normalisation).
      const coastDist = new Float32Array(n);
      let maxCoast = 1;
      for (let t = 0; t < n; t++) {
        let d = df ? df.getDistToOceanAt(mesh.a_x[t], mesh.a_z[t]) : 0;
        if (!isFinite(d)) d = 0;
        coastDist[t] = d;
        const isLand = isLandArr ? isLandArr[t] === 1 : true;
        if (isLand && d > maxCoast) maxCoast = d;
      }

      // Pass 2: per-anchor temp / rain / geo.
      for (let t = 0; t < n; t++) {
        const ax = mesh.a_x[t], az = mesh.a_z[t];
        const isLand = isLandArr ? isLandArr[t] === 1 : true;
        const coastNorm = isLand ? Math.min(1, coastDist[t] / maxCoast) : 0;
        const lat = this.wind.effectiveLatitudeAt(ax, az);
        this.anchorTemp[t] = this._anchorTempByte(mesh, t, isLand, coastNorm, lat);
        this.anchorRain[t] = this._anchorRainByte(mesh, t, ax, az, isLand, coastNorm, lat, stepSize);
        this.anchorGeo[t]  = this._anchorGeoByte(ax, az);
      }

      // Detailed rasters: the interpolating READER. Each pixel is the barycentric
      // blend of its face's 3 points — exactly what the mod computes per pixel, so
      // these are a cache of the truth, not a derivation of it.
      //
      // NO BLUR (removed 2026-07-27). There used to be a full-map box blur here
      // (radius W/40, 3 passes) and it was the ONLY place the visualiser and the
      // game disagreed: 90.3% of temperature pixels differed, mean 0.96 C, worst
      // 7.3 C. It was also useless for what it was blamed for — measured, it
      // removed 10% of the in-game climate bands and left the rest just as hard,
      // because those bands are the 8-bit channel quantising, not a lack of
      // smoothing (docs/03_vs_climate_map.md §16). Crude values are what we want:
      // climate gets tuned by painting values, not by diluting them through an
      // extra layer.
      const px = this.mapW * this.mapH;
      this.detailedTemp = new Uint8Array(px);
      this.detailedRain = new Uint8Array(px);
      this.detailedGeo  = new Uint8Array(px);
      mesh.rasterizeAnchorField(this.anchorTemp, this.detailedTemp);
      mesh.rasterizeAnchorField(this.anchorRain, this.detailedRain);
      mesh.rasterizeAnchorField(this.anchorGeo,  this.detailedGeo);
    }

    _anchorTempByte(mesh, t, isLand, coastNorm, lat) {
      let temp = this._latToTemp(lat);
      const off = this.currents && this.currents.anchorCurrentTempOff;
      const isLandArr = this.upheaval && this.upheaval.anchorIsLand;
      if (isLand) {
        temp -= coastNorm * this.continentalityStrength;
        // Coastal current nudge — average ocean neighbour anchors' temp offset.
        if (off && isLandArr) {
          let sum = 0, count = 0;
          for (const nt of mesh.neighborsOfAnchor(t)) {
            if (isLandArr[nt] === 1) continue;   // want ocean neighbours
            sum += V.decodeSignedByte(off[nt], V.CURRENT_TEMP_MAX); count++;
          }
          if (count > 0) temp += this.currentInfluence * (sum / count);
        }
      } else if (off) {
        temp += this.currentInfluence * V.decodeSignedByte(off[t], V.CURRENT_TEMP_MAX);  // ocean — own offset
      }
      const h = V.hash2d ? V.hash2d(t, 0, this.seed + 8881) : 0.5;
      temp += (h - 0.5) * this.tempJitter;
      temp *= this.globalTemperature;
      return Math.round(Math.max(0, Math.min(1, temp)) * 255);
    }

    _anchorRainByte(mesh, t, ax, az, isLand, coastNorm, lat, stepSize) {
      let rain = this._latToRain(lat);
      const latDeg = Math.abs(lat);
      const primMap = this.provinces && this.provinces.primitiveMap;
      const landGrid = this.continent && this.continent.landGrid;
      const mapW = this.mapW;

      if (isLand) {
        const decayK = latDeg < 15 ? 0.5 : (latDeg < 35 ? 2.5 : 1.2);
        const minRain = latDeg < 15 ? 0.6 : (latDeg < 35 ? 0.45 : 0.55);
        rain *= minRain + (1 - minRain) / (1 + coastNorm * decayK);

        // Orographic — province at the anchor, scaled by anchor height.
        const provAt = (px, pz) => primMap
          ? primMap[Math.max(0, Math.min(this.mapH - 1, pz | 0)) * mapW + Math.max(0, Math.min(mapW - 1, px | 0))]
          : V.provinceAt(this.tectonic, px, pz, true);
        const prov = provAt(ax, az);
        if (prov === V.PROVINCE_OROGEN || prov === V.PROVINCE_EXTENDED_CRUST) {
          const elev = (this.upheaval && this.upheaval.anchorHeight) ? this.upheaval.anchorHeight[t] / 255 : 0;
          rain += this.orographicBoost * Math.min(0.7, elev);
        }

        // Rain shadow — upwind ray (this anchor's wind), stop at first orogen.
        const wdx = this.wind.anchorWindDx, wdz = this.wind.anchorWindDz; // byte-encoded
        const wx = wdx ? V.decodeSignedByte(wdx[t], V.WIND_MAX) : 0;
        const wz = wdz ? V.decodeSignedByte(wdz[t], V.WIND_MAX) : 0;
        const wmag = Math.sqrt(wx * wx + wz * wz);
        if (wmag > 0.001) {
          const ux = wx / wmag, uz = wz / wmag;
          for (let s = 1; s <= RAY_STEPS; s++) {
            const tx = ax - ux * s * stepSize, tz = az - uz * s * stepSize;
            if (tx < 0 || tx >= mapW || tz < 0 || tz >= this.mapH) break;
            if (landGrid && landGrid[(tz | 0) * mapW + (tx | 0)] !== 1) break;
            const up = provAt(tx, tz);
            if (up === V.PROVINCE_OROGEN || up === V.PROVINCE_EXTENDED_CRUST) {
              rain -= this.rainShadowStrength * (1 - s / RAY_STEPS);
              break;
            }
          }
          // Windward bonus — wind onshore from ocean neighbour anchors.
          const isLandArr = this.upheaval && this.upheaval.anchorIsLand;
          if (isLandArr) {
            for (const nt of mesh.neighborsOfAnchor(t)) {
              if (isLandArr[nt] === 1) continue;   // ocean neighbours only
              const dxn = ax - mesh.a_x[nt], dzn = az - mesh.a_z[nt];
              const len = Math.sqrt(dxn * dxn + dzn * dzn) || 1;
              const align = (wx * dxn + wz * dzn) / len;
              if (align > 0) rain += this.windwardBonusStrength * align * wmag;
            }
          }
        }
      }

      const h = V.hash2d ? V.hash2d(t, 0, this.seed + 8882) : 0.5;
      rain += (h - 0.5) * this.rainJitter;
      rain *= this.globalPrecipitation;
      return Math.round(Math.max(0, Math.min(1, rain)) * 255);
    }

    _anchorGeoByte(ax, az) {
      // Distance to nearest active boundary × that boundary's |intensity| (new):
      // stronger collision → more geologic activity; transforms (≈0) stay calm.
      const L = this.tectonic.lines;
      const kd = L.getKindDistancesAt(ax, az);
      const dActive = Math.min(kd.mtnActive, kd.riftActive);
      let geo = 0;
      if (isFinite(dActive)) {
        const segId = kd.mtnActive <= kd.riftActive ? kd.mtnActiveSeg : kd.riftActiveSeg;
        const seg = (segId >= 0 && L.segments) ? L.segments[segId] : null;
        const intensity = seg ? Math.abs(seg.intensity || 0) : 0;
        const mapScale = Math.sqrt(Math.max(this.mapW, this.mapH) / 512);
        geo = intensity * 255 * Math.exp(-dActive / (20 * mapScale));
      }
      const hs = this.tectonic.getHotspotInfo(ax, az);
      if (hs && hs.inHotspot) geo = Math.max(geo, 255 * (1 - hs.dist / hs.hotspot.radius));
      return Math.max(0, Math.min(255, Math.round(geo)));
    }
  }

  V.ClimateModel = ClimateModel;
  V.climateTempRGB = climateTempRGB;
  V.climateRainRGB = climateRainRGB;
  V.climateGeoRGB  = climateGeoRGB;

})(window.VIS);
