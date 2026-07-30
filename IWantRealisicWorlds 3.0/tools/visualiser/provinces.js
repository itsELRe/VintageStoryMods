// provinces.js — ProvinceMap
// Per-pixel byte map of geologic provinces, queried via provinceAt (spec §7's
// third query entry point, alongside cellAt/sampleFields) using
// ContinentGen's landGrid for the land/ocean signal.
//
// Output: `provinceMap` (Uint8Array, values 0..5) — directly compatible with
// VS's GeologicProvinceMap byte format (indices into geologicprovinces.json).
//
// Every tectonic line is a "popsicle stick" (see tectonic-lines.js): a
// capsule around its polyline with a trapezoid width profile pinned to the
// shared joint value where arms meet. Classification is a priority UNION
// over ALL nearby sticks — never a nearest-only pick — so a wide band can't
// be cut by a nearer narrow one, and joints close into clean circles by
// construction. The detailed map's land/ocean signal is the emergent coast
// field's mask (coast-field.js) so coastlines line up with the visible
// continent map. Tectonic warp (warpPower) bakes into the segment polylines
// themselves at build time; when warpPower=0 the bands are straight.
//
// VS province byte values:
//   0 Shield, 1 Platform, 2 Orogen, 3 Basin, 4 Large Igneous, 5 Extended Crust

window.VIS = window.VIS || {};

(function (V) {

  // Display palette (RGB). Same as v1's PROVINCE_COLORS.
  const PROVINCE_RGB = [
    [212, 160, 160], // 0 Shield        — pinkish granite
    [212, 192, 144], // 1 Platform      — sedimentary tan
    [139, 105,  20], // 2 Orogen        — dark olive (mountain belt)
    [212, 208, 112], // 3 Basin         — yellow tan (foothills)
    [139,  32,  32], // 4 Large Igneous — deep red (ocean floor)
    [192,  64,  32], // 5 Extended Crust— orange-red (rift / volcanic)
  ];

  const PROVINCE_NAMES = [
    'Shield',
    'Platform',
    'Orogen',
    'Basin',
    'Large Igneous',
    'Extended Crust',
  ];

  class ProvinceMap {
    constructor(opts, tectonic, continent, coastField) {
      this.p = { ...opts };
      this.tectonic = tectonic;
      this.continent = continent;
      this.coastField = coastField;
    }

    // Two maps: primitive (faceted landGrid → structural continents,
    // straight face-aligned coastlines) and detailed (coast-field mask →
    // organic coastlines that match the visible continent map). Both share
    // the same stick-union province query — only the land/ocean signal
    // differs. Pixels that flip land↔ocean between the two masks land in
    // different province bytes (a coastal sliver may read Shield in
    // primitive but Orogen in detailed if the field pulls it under a range).
    //
    // Most pixels (interior land, deep ocean) classify the same in both
    // masks; the field only differs inside the coastal band. Only call
    // provinceAt twice when the classifications actually disagree.
    generate() {
      const { mapW, mapH } = this.p;
      this.provinceMap = new Uint8Array(mapW * mapH);
      this.primitiveMap = new Uint8Array(mapW * mapH);
      const wlg = this.coastField.landMask;
      const lg = this.continent.landGrid;
      for (let z = 0; z < mapH; z++) {
        for (let x = 0; x < mapW; x++) {
          const i = z * mapW + x;
          const isWLand = wlg[i] === 1;
          const isLand  = lg[i] === 1;
          if (isWLand === isLand) {
            const p = V.provinceAt(this.tectonic, x, z, isLand);
            this.provinceMap[i]  = p;
            this.primitiveMap[i] = p;
          } else {
            this.provinceMap[i]  = V.provinceAt(this.tectonic, x, z, isWLand);
            this.primitiveMap[i] = V.provinceAt(this.tectonic, x, z, isLand);
          }
        }
      }
      this._buildEnclosedGrid();
    }

    // ===== Enclosed shields =====
    // A shield region is "enclosed" if it cannot reach the ocean via a path
    // that stays inside shield province — i.e. it's ringed by ANY province
    // that's higher than shield (platform / extended-crust / basin / orogen).
    // Shield byte 30 is the lowest land province; everything else is uphill
    // from it. A shield surrounded by higher terrain is the structural
    // prerequisite for Tibetan / Transylvanian / Tarim-style elevated basins.
    // A future iteration will raise the upheaval byte for these regions so
    // springs there can downhill-traverse the surrounding higher terrain
    // (or a gorge primitive will carve a corridor through it).
    //
    // Algorithm: multi-source BFS through SHIELD pixels only, seeded from
    // every shield pixel that has at least one ocean 4-neighbour. Each
    // connected shield region is either fully reached (some pixel touches
    // ocean) or fully unreached (entirely walled in by higher provinces).
    //
    // Computed in PRIMITIVE space (faceted landGrid + primitiveMap) since
    // it describes structural geology, not the emergent surface appearance.
    _buildEnclosedGrid() {
      const { mapW, mapH } = this.p;
      const lg = this.continent.landGrid;
      const provMap = this.primitiveMap;
      const SHIELD = 0;
      const enclosed = new Uint8Array(mapW * mapH);
      const visited = new Uint8Array(mapW * mapH);
      const queue = [];

      // Seeds: shield pixels touching ocean (any 4-neighbour is ocean).
      for (let z = 0; z < mapH; z++) {
        for (let x = 0; x < mapW; x++) {
          const i = z * mapW + x;
          if (lg[i] !== 1) continue;
          if (provMap[i] !== SHIELD) continue;
          let touchesOcean = false;
          if (x > 0          && lg[i - 1]    === 0) touchesOcean = true;
          else if (x < mapW-1 && lg[i + 1]    === 0) touchesOcean = true;
          else if (z > 0      && lg[i - mapW] === 0) touchesOcean = true;
          else if (z < mapH-1 && lg[i + mapW] === 0) touchesOcean = true;
          if (touchesOcean) {
            visited[i] = 1;
            queue.push(i);
          }
        }
      }

      // BFS through SHIELD-only land, 4-neighbours.
      let head = 0;
      while (head < queue.length) {
        const i = queue[head++];
        const x = i % mapW;
        const z = (i / mapW) | 0;
        const candidates = [];
        if (x > 0)        candidates.push(i - 1);
        if (x < mapW - 1) candidates.push(i + 1);
        if (z > 0)        candidates.push(i - mapW);
        if (z < mapH - 1) candidates.push(i + mapW);
        for (const ni of candidates) {
          if (visited[ni]) continue;
          if (lg[ni] !== 1) continue;
          if (provMap[ni] !== SHIELD) continue;
          visited[ni] = 1;
          queue.push(ni);
        }
      }

      // Shield pixels not reached by the BFS are enclosed.
      for (let i = 0; i < mapW * mapH; i++) {
        if (lg[i] === 1 && provMap[i] === SHIELD && !visited[i]) {
          enclosed[i] = 1;
        }
      }

      this.enclosedGrid = enclosed;
    }
  }

  // All band claims at (x, z): one entry per nearby stick whose stack could
  // reach the point. d = exact distance to the stick's polyline (end caps
  // included — arms end AT their joint node, so equal-width caps merge into
  // one circle). Widths follow the stick's trapezoid profile at the
  // projected arc position (bandProfileAt: pinned to the shared joint value
  // at snapped ends, own |intensity| mid-line, widthFloor minimum). Age is
  // NOT in the widths (orogen is orogen); it only layers the painting.
  function stickClaimsAt(tec, x, z) {
    const L = tec.lines;
    const mapScale = V.phiScale(Math.max(tec.mapW, tec.mapH));
    const claims = [];
    for (const segId of L.sticksNear(x, z)) {
      const seg = L.segments[segId];
      if (!seg.polyline) continue;
      const proj = L.projectOntoSegment(segId, x, z);
      const m = L.bandProfileAt(segId, proj.t);
      claims.push({
        d: proj.dist,
        sig: seg.intensity || 0,
        isActive: seg.isActive,
        isRift: seg.pairType === 'divergent',
        orogenW: tec.orogenW            * mapScale * m,
        basinW:  tec.basinW             * mapScale * m,
        platW:   tec.platformW          * mapScale * m,
        extW:    tec.extendedCrustWidth * mapScale * m,
      });
    }
    return claims;
  }

  // One STRATUM = one (age, kind) group of sticks. Strata paint in strict
  // top-to-bottom order (user rule 2026-07-10, image 9/10 round):
  //   1 active mountain  (orogen + its bands)
  //   2 active rift      (extended crust + its bands)
  //   3 fossil mountain
  //   4 fossil rift      — always overwritten by everything above.
  // A whole stratum beats everything below it, band for band. Within a
  // stratum the bands are concentric, so core > ring2 > ring3 (orogen >
  // basin > platform; ext crust > shoulder > platform). Shoulder ABOVE
  // platform in-stratum is what lets the shoulder ring survive at joints —
  // the old unified ladder ranked platform above shoulder, so a sibling
  // rift segment's swollen platform disk ate the shoulder ring at every
  // junction ("the empty band doesn't get written"). Elsewhere the
  // shoulder IS written but invisible by design: shield beside interior
  // shield on land, igneous beside interior igneous at sea — same byte.
  // Every band paints on BOTH sides of the coast — no band is ever "skip
  // at sea": the rift shoulder swaps its byte (shield on land, large
  // igneous at sea) and platform paints at sea too (continental shelf).
  // Returns a province byte, or -1 if this stratum claims nothing here.
  function stratumFromClaims(claims, wantActive, wantRift, isLand) {
    let core = false, ring2 = false, ring3 = false;
    for (const c of claims) {
      if (c.isActive !== wantActive || c.isRift !== wantRift) continue;
      const coreW = wantRift ? c.extW : c.orogenW;
      if (c.d < coreW) core = true;
      else if (c.d < coreW + c.basinW) ring2 = true;
      else if (c.d < coreW + c.basinW + c.platW) ring3 = true;
    }
    if (core) return wantRift ? V.PROVINCE_EXTENDED_CRUST : V.PROVINCE_OROGEN;
    if (ring2) {
      return wantRift
        ? (isLand ? V.PROVINCE_SHIELD : V.PROVINCE_LARGE_IGNEOUS) // rift shoulder
        : V.PROVINCE_BASIN;
    }
    if (ring3) return V.PROVINCE_PLATFORM;
    return -1;
  }

  // provinceAt — spec §7's third query entry point, alongside cellAt and
  // sampleFields. Direct per-position function: never stored on anchors,
  // never interpolated (anchor storage would quantize band edges to anchor
  // spacing). Hotspots override (extended crust). The line's bands run
  // CONTINUOUSLY across the coast; only the stable interior differs —
  // continental shield/platform on land, oceanic large igneous (the ocean's
  // "counter-shield") at sea. Returns the VS GeologicProvinceMap byte (0–5).
  function provinceAt(tec, x, z, isLand) {
    const hs = tec.getHotspotInfo(x, z);
    if (hs.inHotspot) return V.PROVINCE_EXTENDED_CRUST;

    const claims = stickClaimsAt(tec, x, z);

    // Strata top to bottom: active mountain, active rift, fossil mountain,
    // fossil rift (the fossil rift is always overwritten). Age still wins
    // within a kind; kind splits the ages.
    let p = stratumFromClaims(claims, true, false, isLand);
    if (p >= 0) return p;
    p = stratumFromClaims(claims, true, true, isLand);
    if (p >= 0) return p;
    p = stratumFromClaims(claims, false, false, isLand);
    if (p >= 0) return p;
    p = stratumFromClaims(claims, false, true, isLand);
    if (p >= 0) return p;

    // INTERIOR — continental shield / oceanic large igneous.
    return isLand ? V.PROVINCE_SHIELD : V.PROVINCE_LARGE_IGNEOUS;
  }

  // tectonicBands — compatibility shim for upheaval.js's height law: nearest
  // claim per kind (mountain/rift × active/fossil), same return shape as before
  // the stick rework. Kinds with no stick in reach report d: Infinity + floor
  // widths (the height falloff reads that as zero contribution, same as a far
  // distance).
  function tectonicBands(tec, x, z) {
    const mapScale = V.phiScale(Math.max(tec.mapW, tec.mapH));
    const mFloor = tec.widthFloor;
    const empty = () => ({
      d: Infinity, sig: 0,
      orogenW: tec.orogenW            * mapScale * mFloor,
      basinW:  tec.basinW             * mapScale * mFloor,
      platW:   tec.platformW          * mapScale * mFloor,
      extW:    tec.extendedCrustWidth * mapScale * mFloor,
    });
    const out = { mtnA: empty(), mtnF: empty(), riftA: empty(), riftF: empty() };
    for (const c of stickClaimsAt(tec, x, z)) {
      const slot = c.isRift ? (c.isActive ? 'riftA' : 'riftF')
                            : (c.isActive ? 'mtnA'  : 'mtnF');
      if (c.d < out[slot].d) out[slot] = c;
    }
    return out;
  }

  V.ProvinceMap = ProvinceMap;
  V.provinceAt = provinceAt;
  V.tectonicBands = tectonicBands;
  V.PROVINCE_RGB = PROVINCE_RGB;
  V.PROVINCE_NAMES = PROVINCE_NAMES;

})(window.VIS);
