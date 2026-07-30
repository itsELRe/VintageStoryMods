// upheaval.js — UpheavalMap
//
// The land-elevation primitive. Its real output is the per-anchor (height,
// depth) field (computePointTerrain, spec §6): two UNSIGNED 0–255 values per
// data point — height (0 = sea level, rising inland) and depth (0 = coast,
// deepening seaward), mutually exclusive per point. The detailed map
// interpolates + blurs those points into the raster.
//
// Differs from vanilla: vanilla derives the upheaval byte from the province
// band; here it is an independent point field driven by coast distance +
// collision intensity + coherent variance. The bytes are proportions, not block
// altitudes — the column builder owns the byte→altitude conversion.

window.VIS = window.VIS || {};

(function (V) {

  class UpheavalMap {
    constructor(opts, tectonic, continent, distanceFields, coastField) {
      this.p = { ...opts };
      this.tectonic = tectonic;
      this.continent = continent;
      this.distanceFields = distanceFields || null;
      this.coastField = coastField || null;
      this.seed = (opts.seed | 0) || 0;

      // === Base-terrain field (spec §6): (height, depth) per anchor from a
      // capped coast-distance base + tectonic intensity + coherent variance.
      // All scales world-relative so it holds at any map size / point density.
      // This IS the upheaval primitive — the legacy province-band byte path
      // (_primitiveAt / primitiveMap / detailedMap) was removed. ===
      const mapSize = Math.max(this.p.mapW, this.p.mapH);
      this.landBaseCap  = opts.landBaseCap  ?? 0.40;  // coast→inland plateau (raw, pre-scale)
      this.oceanBaseCap = opts.oceanBaseCap ?? 0.50;  // coast→seaward plateau
      this.baseRise     = mapSize * (opts.baseRiseFrac ?? 0.35); // distance to saturate the base
      this.tectWeight   = opts.tectWeight ?? 1.0;     // mountain/trench height vs base
      this.terrainFossilWeight = opts.terrainFossilWeight ?? 0.6;
      this.varAmp       = opts.terrainVarAmp ?? 0.10; // coherent variance amplitude
      this._varFbm = V.createFBM(this.seed + 61000, 1 / (mapSize * (opts.terrainVarScaleFrac ?? 0.12)), 3, 0.5);

      // Detailed-map smoothing (the interpolated raster, NOT the anchor points):
      // a light blur to hide the barycentric gradient creases — the visible
      // "triangles/cells" — without erasing the anchor-scale variation. Radius =
      // this fraction of the mean anchor spacing (data-driven → holds at any map
      // size), kept well under one spacing so the large relief survives. Its OWN
      // knob, independent of the (much wider) climate blur; 0 disables it (raw
      // interpolation, for A/B). Makes the detailed map a precomputed
      // interpolate-then-blur raster, matching VS's blurred Upheavel/Ocean maps.

      // Coastal shelf (per-pixel, sea side). reach = fraction of the coast band
      // over which the shelf reaches full depth; depth = that full depth as a
      // fraction of the byte range. Reach is expressed against the band because
      // beyond it the coast field returns Infinity — keeping the shelf inside the
      // band is what stops a visible ring where the two halves meet.
      this.shelfReach = opts.shelfReach ?? 1.0;
      this.shelfDepth = opts.shelfDepth ?? 0.25;
    }

    // Raw base-terrain magnitude at a pixel (spec §6), pre-self-scale. Capped
    // coast-distance base + summed tectonic intensity (convergent pushes the
    // extreme up, divergent down — SAME sign for land height and ocean depth,
    // so one term drives whichever field the pixel belongs to) + coherent
    // variance. Always ≥ 0. `kd` is the getKindDistancesAt result, passed in so
    // the exact query runs once per pixel; isLand only selects the base cap.
    _rawTerrainAt(x, z, isLand) {
      const dCoastRaw = this.distanceFields.getDistToOceanAt(x, z);
      const dCoast = (dCoastRaw === Infinity || dCoastRaw !== dCoastRaw) ? this.baseRise : dCoastRaw;
      const baseCap = isLand ? this.landBaseCap : this.oceanBaseCap;
      const base = baseCap * Math.min(1, dCoast / this.baseRise);

      // Tectonic term over the SAME footprint the provinces use (V.tectonicBands),
      // so height and province category stay synchronous — the height gradient
      // fills exactly the province belt. Reach = the belt's cumulative width
      // (intensity-scaled). Sign raises (convergent) / lowers (divergent);
      // fossils are discounted HERE (age lives in height, not in width/category).
      const b = V.tectonicBands(this.tectonic, x, z);
      // Nearest mountain / rift line of either age; fossils discounted (age in
      // height, not width). Reach = that line's belt width, so the height
      // gradient fills the province belt.
      const mtn  = b.mtnA.d  <= b.mtnF.d  ? b.mtnA  : b.mtnF;
      const rift = b.riftA.d <= b.riftF.d ? b.riftA : b.riftF;
      const mtnAge  = b.mtnF.d  < b.mtnA.d  ? this.terrainFossilWeight : 1;
      const riftAge = b.riftF.d < b.riftA.d ? this.terrainFossilWeight : 1;
      const mtnReach  = mtn.orogenW + mtn.basinW + mtn.platW;
      const riftReach = rift.extW + rift.basinW + rift.platW;
      const smooth = (d, reach) => {
        if (reach <= 0 || d >= reach) return 0;
        const t = d / reach;
        return 1 - t * t * (3 - 2 * t); // smoothstep: 1 at the line → 0 at the belt edge
      };
      const tect = mtn.sig  * mtnAge  * smooth(mtn.d,  mtnReach)
                 + rift.sig * riftAge * smooth(rift.d, riftReach);

      const variance = this.varAmp * this._varFbm(x, z);
      return Math.max(0, base + tect * this.tectWeight + variance);
    }

    // Base-terrain primitive, computed PER POINT (anchor) — this is the actual
    // primitive: each anchor carries (height, depth). Evaluated once at each
    // anchor centroid (thousands of points, not millions of pixels); the
    // full-resolution map is derived later by interpolating between points.
    // Self-scales each side to 255. Call after the mesh + collision intensity
    // exist (ui.js, right after generate()).
    computePointTerrain(mesh) {
      if (!mesh || !this.distanceFields) return;
      const n = mesh.numAnchors;
      this.anchorHeight = new Uint8Array(n);
      this.anchorDepth  = new Uint8Array(n);
      this.anchorIsLand = new Uint8Array(n);
      const rawH = new Float32Array(n), rawD = new Float32Array(n);
      let maxH = 1e-6, maxD = 1e-6;
      // COASTAL points evaluate on the LAND side at coast-distance 0: base
      // term 0, tectonic term free to be large — which is what puts real
      // height right at the shoreline where an orogen meets the sea (the
      // column-level mask-vs-height reconciliation turns that into cliffs;
      // quiet coasts stay near 0 and reconcile into shelf/beach ramps).
      const pointClass = this.continent.pointClass;
      for (let t = 0; t < n; t++) {
        const x = mesh.a_x[t], z = mesh.a_z[t];
        const isLand = pointClass[t] >= V.POINT_COASTAL;
        this.anchorIsLand[t] = isLand ? 1 : 0;
        const raw = this._rawTerrainAt(x, z, isLand);
        if (isLand) { rawH[t] = raw; if (raw > maxH) maxH = raw; }
        else        { rawD[t] = raw; if (raw > maxD) maxD = raw; }
      }
      const sh = 255 / maxH, sd = 255 / maxD;
      for (let t = 0; t < n; t++) {
        this.anchorHeight[t] = rawH[t] > 0 ? Math.min(255, Math.round(rawH[t] * sh)) : 0;
        // 0 is RESERVED for land. Every water point gets at least 1, so a shallow
        // inland sea — whose raw depth rounds to nothing against the world's
        // deepest trench — still reads as water rather than dry ground.
        this.anchorDepth[t]  = this.anchorIsLand[t] === 1
          ? 0
          : Math.max(1, Math.min(255, Math.round(rawD[t] * sd)));
      }

      // Detailed maps: interpolate the sparse per-anchor values into full
      // rasters (the "reader" half — spec §7 sampleFields) via the mesh anchor
      // triangulation. One pixel = one chunk (32×32 blocks). detailedHeight is
      // the smooth land-elevation surface, detailedDepth the ocean-depth
      // surface. Off-domain anchors sit at 0, so the coast interpolates as a
      // real ramp (ocean 0 → low coastal land) instead of a step.
      const px = this.p.mapW * this.p.mapH;
      this.detailedHeight = new Uint8Array(px);
      this.detailedDepth  = new Uint8Array(px);
      mesh.rasterizeAnchorField(this.anchorHeight, this.detailedHeight);
      mesh.rasterizeAnchorField(this.anchorDepth,  this.detailedDepth);

      // ===== Coastal shelf — the PER-PIXEL half of the depth field =====
      // The anchor field above cannot see water narrower than its own spacing: a
      // one-face inlet has no oceanic point inside it, so every anchor around it
      // reads "land" and its depth interpolates to 0 — water that generates as
      // dry ground. This term is evaluated at every PIXEL from the warped
      // coastline, which is defined everywhere, so depth can never be absent —
      // only small. Sea side only: the land field already tracks the visualiser.
      if (this.coastField && this.shelfDepth > 0) {
        const band = this.coastField.band;
        const reach = Math.max(0.5, this.shelfReach * band);
        const cap = this.shelfDepth * 255;
        const mapW = this.p.mapW, mapH = this.p.mapH;
        let deepened = 0;
        for (let z = 0; z < mapH; z++) {
          const row = z * mapW;
          for (let x = 0; x < mapW; x++) {
            const sdw = this.coastField.signedDistWarpedAt(x, z);
            if (sdw >= 0) continue;                       // land — untouched
            // Beyond the coast band the exact distance is unknown (the field
            // returns Infinity), so hold it AT the band: the shelf simply stops
            // ramping there instead of jumping to full depth, which is what would
            // draw a ring. With reach > band the shelf never tops out at all and
            // the lattice supplies the remaining depth.
            const d = sdw === -Infinity ? band : -sdw;
            const shelf = cap * Math.min(1, d / reach);
            const i = row + x;
            // The shelf is a FLOOR, not a competitor. The lattice bathymetry then
            // occupies the whole range ABOVE that floor, so trenches, rifts and
            // basins keep their full relief no matter how deep the shelf is set.
            // (max() made the two fight, and raising the shelf progressively
            // erased the lattice — which is exactly what the eye was seeing.)
            const lattice = this.detailedDepth[i];
            const v = Math.round(shelf + lattice * (255 - shelf) / 255);
            if (v > lattice) deepened++;
            this.detailedDepth[i] = v > 255 ? 255 : v;
          }
        }
        console.log(`[upheaval] coastal shelf: reach=${reach.toFixed(1)}px (${this.shelfReach.toFixed(2)}× the ${band.toFixed(1)}px coast band), ` +
          `floor=${cap | 0} byte, lattice layered above it — ${deepened}px deepened`);
      }

      // NO BLUR (removed 2026-07-27, along with its terrainBlurFrac /
      // terrainBlurPasses knobs). It softened the interpolation's gradient creases
      // by smoothing the whole map, which needs the entire world to exist and is
      // not something the mod can or should do per region. Creases are honest —
      // they are the lattice showing through — and the answer to them is the
      // field's own values, not a blanket over them.
      console.log(`[upheaval] point terrain: ${n} points — maxHeightRaw=${maxH.toFixed(3)} maxDepthRaw=${maxD.toFixed(3)}`);
    }
  }

  // Upheaval (height) palette: each entry is [byte, R, G, B], linearly
  // interpolated for a smooth low→high ELEVATION gradient — green (sea level)
  // through yellow to red, capped white at the peaks. Pure elevation now (the
  // decoupled point field), not province tiers; the byte is a height
  // proportion, not a band id. In the primitive Upheaval view a value of 0 is
  // drawn GRAY ("no value" — ocean / exact sea level), so the green 0-stop only
  // shows in the legacy detailed overlay's fill.
  const UPHEAVAL_STOPS = [
    [0,   100, 170, 100],   // sea level (green)
    [15,  140, 180, 105],   // low land
    [30,  180, 200, 120],   // lowland rise
    [50,  210, 215, 130],   // hills (pale yellow-green)
    [90,  225, 175, 105],   // higher hills (tan)
    [130, 220, 145,  85],   // uplands (warm tan)
    [170, 215, 110,  60],   // mountains (orange)
    [225, 175,  65,  45],   // high mountains (red-brown)
    [255, 255, 255, 255],   // peaks / snow (white)
  ];

  function upheavalRGB(v) {
    if (v <= UPHEAVAL_STOPS[0][0]) return UPHEAVAL_STOPS[0].slice(1);
    for (let i = 0; i < UPHEAVAL_STOPS.length - 1; i++) {
      const a = UPHEAVAL_STOPS[i], b = UPHEAVAL_STOPS[i + 1];
      if (v <= b[0]) {
        const t = (v - a[0]) / (b[0] - a[0]);
        return [
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t,
          a[3] + (b[3] - a[3]) * t,
        ];
      }
    }
    return UPHEAVAL_STOPS[UPHEAVAL_STOPS.length - 1].slice(1);
  }

  // Ocean-depth palette: mirrors the upheaval gradient the OTHER way around the
  // colour wheel — green (coast) → blue → violet → near-black (deepest trench).
  // Shares the green low-hue with upheaval so the shoreline reads the same on
  // both maps. Byte 0 = coast; drawn GRAY in the primitive Ocean view ("no
  // value" — land / exact sea level), so the green 0-stop shows only in the
  // legacy detailed overlay's fill.
  const OCEAN_DEPTH_STOPS = [
    [0,   90, 165, 100],  // coast (green)
    [70,  45, 115, 195],  // shelf (blue)
    [150, 95,  60, 185],  // slope / deep (violet)
    [210, 50,  28, 105],  // deep (dark violet)
    [255, 14,  10,  32],  // abyss (near-black)
  ];

  function oceanDepthRGB(v) {
    if (v <= OCEAN_DEPTH_STOPS[0][0]) return OCEAN_DEPTH_STOPS[0].slice(1);
    for (let i = 0; i < OCEAN_DEPTH_STOPS.length - 1; i++) {
      const a = OCEAN_DEPTH_STOPS[i], b = OCEAN_DEPTH_STOPS[i + 1];
      if (v <= b[0]) {
        const t = (v - a[0]) / (b[0] - a[0]);
        return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
      }
    }
    return OCEAN_DEPTH_STOPS[OCEAN_DEPTH_STOPS.length - 1].slice(1);
  }

  V.UpheavalMap = UpheavalMap;
  V.upheavalRGB = upheavalRGB;
  V.oceanDepthRGB = oceanDepthRGB;

})(window.VIS);
