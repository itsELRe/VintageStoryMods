// ui.js — settings persistence + Generate orchestration

(function (V) {

  const SETTINGS_KEY = 'iwrw_settings';

  // List of every input we read/write. Keep in one place so persistence is
  // declarative and we can grow this without touching multiple sites.
  const FIELDS = [
    // World Settings (vanilla — the mod reads these from VS)
    { id: 'seed', kind: 'text' },
    { id: 'mapW', kind: 'number' },
    { id: 'mapH', kind: 'number' },
    { id: 'worldHeight', kind: 'number' },
    { id: 'polarDist', kind: 'number' },
    { id: 'landcover', kind: 'range', valId: 'landcoverV', fmt: 2 },
    { id: 'landcoverScale', kind: 'range', valId: 'landcoverScaleV', fmt: 2 },
    { id: 'globalTemperature', kind: 'range', valId: 'globalTemperatureV', fmt: 2 },
    { id: 'globalPrecipitation', kind: 'range', valId: 'globalPrecipitationV', fmt: 2 },
    // Tectonic Plates
    { id: 'continentSize', kind: 'range', valId: 'continentSizeV', fmt: 2 },
    { id: 'plateCountMult', kind: 'range', valId: 'plateCountMultV', fmt: 2 },
    { id: 'seedJitter', kind: 'range', valId: 'seedJitterV', fmt: 2 },
    { id: 'warpPower', kind: 'range', valId: 'warpPowerV', fmt: 2 },
    { id: 'plateSpeedMin', kind: 'range', valId: 'plateSpeedMinV', fmt: 2 },
    { id: 'plateSpeedMax', kind: 'range', valId: 'plateSpeedMaxV', fmt: 2 },
    { id: 'transformThreshold', kind: 'range', valId: 'transformThresholdV', fmt: 2 },
    // Data Lattice
    { id: 'latticeSpacing', kind: 'range', valId: 'latticeSpacingV', fmt: 2 },
    // Continental Primitives
    { id: 'seedOverride', kind: 'number' },
    { id: 'sizeVar', kind: 'range', valId: 'sizeVarV', fmt: 2 },
    { id: 'plateBias', kind: 'range', valId: 'plateBiasV', fmt: 2 },
    { id: 'separationBias', kind: 'range', valId: 'separationBiasV', fmt: 2 },
    { id: 'edgeBias', kind: 'range', valId: 'edgeBiasV', fmt: 2 },
    { id: 'gapFill', kind: 'range', valId: 'gapFillV', fmt: 2 },
    // Emergent Coastline
    { id: 'coastAmplitude', kind: 'range', valId: 'coastAmplitudeV', fmt: 2 },
    { id: 'coastCoarseBlend', kind: 'range', valId: 'coastCoarseBlendV', fmt: 2 },
    // Tectonic Provinces
    { id: 'orogenWidth', kind: 'range', valId: 'orogenWidthV', fmt: 1 },
    { id: 'extendedCrustWidth', kind: 'range', valId: 'extendedCrustWidthV', fmt: 1 },
    { id: 'basinWidth', kind: 'range', valId: 'basinWidthV', fmt: 1 },
    { id: 'fossilWidth', kind: 'range', valId: 'fossilWidthV', fmt: 1 },
    { id: 'platformWidth', kind: 'range', valId: 'platformWidthV', fmt: 0 },
    { id: 'provinceWarpPower', kind: 'range', valId: 'provinceWarpPowerV', fmt: 2 },
    { id: 'widthFloor', kind: 'range', valId: 'widthFloorV', fmt: 2 },
    { id: 'fossilBasinWidth', kind: 'range', valId: 'fossilBasinWidthV', fmt: 1 },
    { id: 'fossilPlatformWidth', kind: 'range', valId: 'fossilPlatformWidthV', fmt: 0 },
    // Upheaval
    { id: 'landBaseCap', kind: 'range', valId: 'landBaseCapV', fmt: 2 },
    { id: 'oceanBaseCap', kind: 'range', valId: 'oceanBaseCapV', fmt: 2 },
    { id: 'baseRiseFrac', kind: 'range', valId: 'baseRiseFracV', fmt: 2 },
    { id: 'tectWeight', kind: 'range', valId: 'tectWeightV', fmt: 2 },
    { id: 'terrainFossilWeight', kind: 'range', valId: 'terrainFossilWeightV', fmt: 2 },
    { id: 'terrainVarAmp', kind: 'range', valId: 'terrainVarAmpV', fmt: 2 },
    { id: 'terrainVarScaleFrac', kind: 'range', valId: 'terrainVarScaleFracV', fmt: 2 },
    { id: 'shelfReach', kind: 'range', valId: 'shelfReachV', fmt: 2 },
    { id: 'shelfDepth', kind: 'range', valId: 'shelfDepthV', fmt: 2 },
    // Climate
    { id: 'climateTropicalEnd', kind: 'range', valId: 'climateTropicalEndV', fmt: 2 },
    { id: 'climateTemperateEnd', kind: 'range', valId: 'climateTemperateEndV', fmt: 2 },
    { id: 'climateVariation', kind: 'range', valId: 'climateVariationV', fmt: 2 },
    { id: 'continentalityStrength', kind: 'range', valId: 'continentalityStrengthV', fmt: 2 },
    { id: 'currentInfluence', kind: 'range', valId: 'currentInfluenceV', fmt: 2 },
    { id: 'orographicBoost', kind: 'range', valId: 'orographicBoostV', fmt: 2 },
    { id: 'rainShadowStrength', kind: 'range', valId: 'rainShadowStrengthV', fmt: 2 },
    { id: 'windwardBonusStrength', kind: 'range', valId: 'windwardBonusStrengthV', fmt: 2 },
    { id: 'tempJitter', kind: 'range', valId: 'tempJitterV', fmt: 3 },
    { id: 'rainJitter', kind: 'range', valId: 'rainJitterV', fmt: 2 },
    // Features (deferred)
    { id: 'ridgeSpacing', kind: 'range', valId: 'ridgeSpacingV', fmt: 0 },
    { id: 'ridgeJitter', kind: 'range', valId: 'ridgeJitterV', fmt: 2 },
    { id: 'ridgeShapeVariation', kind: 'range', valId: 'ridgeShapeVariationV', fmt: 2 },
    { id: 'ridgeSpread', kind: 'range', valId: 'ridgeSpreadV', fmt: 2 },
    { id: 'lakeDensity', kind: 'range', valId: 'lakeDensityV', fmt: 2 },
    { id: 'riverPoints', kind: 'range', valId: 'riverPointsV', fmt: 2 },
    { id: 'riverConnections', kind: 'range', valId: 'riverConnectionsV', fmt: 2 },
    { id: 'deflectorInfluence', kind: 'range', valId: 'deflectorInfluenceV', fmt: 2 },
    { id: 'climateInfluence', kind: 'range', valId: 'climateInfluenceV', fmt: 2 },
    { id: 'geoInfluence', kind: 'range', valId: 'geoInfluenceV', fmt: 2 },
  ];

  const MARKERS = ['showPlates', 'showFossils', 'showHotspots', 'showContBounds', 'showLattice', 'showSeeds', 'showAnchors', 'showAnchorValues', 'showVectors', 'showRidges', 'showDrainage', 'showRivers', 'showLakes', 'showHydrology', 'showEnclosedShields', 'showSpawn'];

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY) || localStorage.getItem('iwrw_v2_settings'); // fallback: migrate settings saved before the rename
      if (!raw) return;
      const obj = JSON.parse(raw);
      for (const f of FIELDS) {
        if (obj[f.id] !== undefined) {
          const el = document.getElementById(f.id);
          if (el) el.value = obj[f.id];
        }
      }
      for (const m of MARKERS) {
        if (obj[m] !== undefined) {
          const el = document.getElementById(m);
          if (el) el.checked = !!obj[m];
        }
      }
      if (obj.overlay) {
        const el = document.getElementById(obj.overlay);
        if (el) el.checked = true;
      }
    } catch (_) { /* corrupt cache — ignore */ }
  }

  function saveSettings() {
    const obj = {};
    for (const f of FIELDS) {
      const el = document.getElementById(f.id);
      if (el) obj[f.id] = el.value;
    }
    for (const m of MARKERS) {
      const el = document.getElementById(m);
      if (el) obj[m] = el.checked;
    }
    const overlay = document.querySelector('input[name="overlay"]:checked');
    if (overlay) obj.overlay = overlay.id;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj)); } catch (_) {}
  }

  // Keep the numeric badges next to range sliders in sync with their inputs.
  function refreshValueBadges() {
    for (const f of FIELDS) {
      if (f.kind !== 'range' || !f.valId) continue;
      const el = document.getElementById(f.id);
      const out = document.getElementById(f.valId);
      if (el && out) out.textContent = parseFloat(el.value).toFixed(f.fmt);
    }
    // Also the block-equivalent labels next to map size / polar distance.
    const mw = parseInt(document.getElementById('mapW').value);
    const mh = parseInt(document.getElementById('mapH').value);
    const pd = parseInt(document.getElementById('polarDist').value);
    document.getElementById('mapWBlk').textContent = pxToBlk(mw);
    document.getElementById('mapHBlk').textContent = pxToBlk(mh);
    document.getElementById('polarDistBlk').textContent = pxToBlk(pd);
    const wh = parseInt(document.getElementById('worldHeight').value) || 320;
    const whBadge = document.getElementById('worldHeightV');
    if (whBadge) whBadge.textContent = `${wh} blk`;
    // Seed override badge: "off" when 0, otherwise "N forced".
    const so = parseInt(document.getElementById('seedOverride').value) || 0;
    const soBadge = document.getElementById('seedOverrideV');
    if (soBadge) soBadge.textContent = so > 0 ? `${so} forced` : 'off';
  }

  function pxToBlk(px) {
    const blk = px * 32;
    if (blk >= 1000) return Math.round(blk / 1000) + 'k blk';
    return blk + ' blk';
  }

  function readSettings() {
    const num = id => parseFloat(document.getElementById(id).value);
    return {
      seedRaw: document.getElementById('seed').value,
      mapW: parseInt(document.getElementById('mapW').value),
      mapH: parseInt(document.getElementById('mapH').value),
      worldHeight: parseInt(document.getElementById('worldHeight').value) || 320,
      landcover: num('landcover'),
      landcoverScale: num('landcoverScale'),
      globalTemperature: num('globalTemperature'),
      globalPrecipitation: num('globalPrecipitation'),
      continentSize: num('continentSize'),
      plateCountMult: num('plateCountMult'),
      seedJitter: num('seedJitter'),
      warpPower: num('warpPower'),
      plateSpeedMin: num('plateSpeedMin'),
      plateSpeedMax: num('plateSpeedMax'),
      transformThreshold: num('transformThreshold'),
      latticeSpacing: num('latticeSpacing'),
      seedOverride: parseInt(document.getElementById('seedOverride').value) || 0,
      sizeVar: num('sizeVar'),
      plateBias: num('plateBias'),
      separationBias: num('separationBias'),
      edgeBias: num('edgeBias'),
      gapFill: num('gapFill'),
      coastAmplitude: num('coastAmplitude'),
      coastCoarseBlend: num('coastCoarseBlend'),
      orogenWidth: num('orogenWidth'),
      extendedCrustWidth: num('extendedCrustWidth'),
      basinWidth: num('basinWidth'),
      fossilWidth: num('fossilWidth'),
      platformWidth: num('platformWidth'),
      provinceWarpPower: num('provinceWarpPower'),
      widthFloor: num('widthFloor'),
      fossilBasinWidth: num('fossilBasinWidth'),
      fossilPlatformWidth: num('fossilPlatformWidth'),
      landBaseCap: num('landBaseCap'),
      oceanBaseCap: num('oceanBaseCap'),
      baseRiseFrac: num('baseRiseFrac'),
      tectWeight: num('tectWeight'),
      terrainFossilWeight: num('terrainFossilWeight'),
      terrainVarAmp: num('terrainVarAmp'),
      terrainVarScaleFrac: num('terrainVarScaleFrac'),
      shelfReach: num('shelfReach'),
      shelfDepth: num('shelfDepth'),
      climateTropicalEnd: num('climateTropicalEnd'),
      climateTemperateEnd: num('climateTemperateEnd'),
      climateVariation: num('climateVariation'),
      continentalityStrength: num('continentalityStrength'),
      currentInfluence: num('currentInfluence'),
      orographicBoost: num('orographicBoost'),
      rainShadowStrength: num('rainShadowStrength'),
      windwardBonusStrength: num('windwardBonusStrength'),
      tempJitter: num('tempJitter'),
      rainJitter: num('rainJitter'),
      ridgeSpacing: num('ridgeSpacing'),
      ridgeJitter: num('ridgeJitter'),
      ridgeShapeVariation: num('ridgeShapeVariation'),
      ridgeSpread: num('ridgeSpread'),
      lakeDensity: num('lakeDensity'),
      riverPoints: num('riverPoints'),
      riverConnections: num('riverConnections'),
      deflectorInfluence: num('deflectorInfluence'),
      climateInfluence: num('climateInfluence'),
      geoInfluence: num('geoInfluence'),
    };
  }

  let renderer = null;
  let tectonic = null;
  let continent = null;
  let mesh = null;
  let coastField = null;
  let distanceFields = null;
  let provinces = null;
  let upheaval = null;
  let drainage = null;
  let wind = null;
  let currents = null;
  let climate = null;
  let ridges = null;
  let lakes = null;
  let rivers = null;

  function generate() {
    const stats = document.getElementById('statsBox');
    try {
      const cfg = readSettings();
      const seed = V.seedStringToInt(cfg.seedRaw);

      const t0 = performance.now();
      tectonic = new V.TectonicModel({
        mapW: cfg.mapW, mapH: cfg.mapH, seed,
        continentSize: cfg.continentSize,
        plateCountMult: cfg.plateCountMult,
        seedJitter: cfg.seedJitter,
        warpPower: cfg.warpPower,
        orogenWidth: cfg.orogenWidth,
        basinWidth: cfg.basinWidth,
        fossilWidth: cfg.fossilWidth,
        platformWidth: cfg.platformWidth,
        provinceWarpPower: cfg.provinceWarpPower,
        extendedCrustWidth: cfg.extendedCrustWidth,
        widthFloor: cfg.widthFloor,
        fossilBasinWidth: cfg.fossilBasinWidth,
        fossilPlatformWidth: cfg.fossilPlatformWidth,
        plateSpeedMin: cfg.plateSpeedMin,
        plateSpeedMax: cfg.plateSpeedMax,
        transformThreshold: cfg.transformThreshold,
      });
      const tTec = performance.now();

      // The lattice mesh — the data points (anchors) and the faces between
      // them. Built FIRST: the continent fill labels its faces — see mesh.js.
      const spacing = V.LatticeMesh.autoSpacing(
        cfg.mapW, cfg.mapH, cfg.continentSize, cfg.latticeSpacing);
      mesh = new V.LatticeMesh({ mapW: cfg.mapW, mapH: cfg.mapH, spacing });

      continent = new V.ContinentGen({
        mapW: cfg.mapW, mapH: cfg.mapH, seed,
        continentSize: cfg.continentSize,
        landcover: cfg.landcover,
        landcoverScale: cfg.landcoverScale,
        seedOverride: cfg.seedOverride,
        sizeVar: cfg.sizeVar,
        fragmentation: 0, // disabled for now (we'll re-enable when discussed)
        plateBias: cfg.plateBias,
        separationBias: cfg.separationBias,
        edgeBias: cfg.edgeBias,
        gapFill: cfg.gapFill,
      }, tectonic, mesh);
      continent.calibrate();
      const tCon = performance.now();

      // Emergent coast field — the organic Detailed coastline as a pure
      // per-column function of the face labels + seed (coast-field.js).
      coastField = new V.CoastField({
        mapW: cfg.mapW, mapH: cfg.mapH, seed,
        coastAmplitude: cfg.coastAmplitude,
        coastCoarseBlend: cfg.coastCoarseBlend,
      }, mesh, continent);

      // Per-point distance fields (distToOcean so far) — see distance-fields.js.
      distanceFields = new V.DistanceFields(mesh, continent);

      // Per-point nearest-segment-id hints (mountain/rift × active/fossil)
      // — acceleration structure for tectonic.lines.getKindDistancesAt.
      // Also stores the mesh on tectonic.lines so getKindDistancesAt /
      // getBoundaryDistancesAt / provinceAt don't need every caller across
      // the codebase to thread it through.
      tectonic.lines.computeAnchorKindHints(mesh);
      // Per-segment collision intensity + taller side from plate motion
      // vectors (spec §3.1). Stored on segments; not yet consumed (item 5
      // reads it for classification + height). Runs here because it needs
      // land/ocean per plate (continent), same as the kind hints above.
      tectonic.lines.computeCollisionIntensity(continent);
      // Ongoing health-check log (not a migration artifact) — see
      // _logDistanceFieldsSample's own comment. Ported; the C# logs the same
      // line once per generate.
      tectonic.lines._logDistanceFieldsSample();

      provinces = new V.ProvinceMap({
        mapW: cfg.mapW, mapH: cfg.mapH,
      }, tectonic, continent, coastField);
      provinces.generate();
      const tProv = performance.now();

      upheaval = new V.UpheavalMap({
        mapW: cfg.mapW, mapH: cfg.mapH, seed,
        worldHeight: cfg.worldHeight,
        landBaseCap: cfg.landBaseCap,
        oceanBaseCap: cfg.oceanBaseCap,
        baseRiseFrac: cfg.baseRiseFrac,
        tectWeight: cfg.tectWeight,
        terrainFossilWeight: cfg.terrainFossilWeight,
        terrainVarAmp: cfg.terrainVarAmp,
        terrainVarScaleFrac: cfg.terrainVarScaleFrac,
        shelfReach: cfg.shelfReach,
        shelfDepth: cfg.shelfDepth,
      }, tectonic, continent, distanceFields, coastField);
      // Base-terrain primitive per point (anchor): (height, depth) per point.
      // Rendered by the primitive Upheaval / Ocean maps (colored dots, gray at
      // 0) and the "Anchor Values" marker (labels). Cheap — one eval per anchor.
      upheaval.computePointTerrain(mesh);

      // Drainage direction graph — the primitive downhill web on the data
      // points (its own system, drainage.js). Reads the per-anchor height field,
      // so it runs after computePointTerrain.
      drainage = new V.DrainageGraph(mesh, upheaval);

      const t1 = performance.now();

      // Failsafe wrapper: each FEATURE build runs inside this, so one broken
      // subsystem logs + is skipped (left null) instead of aborting generate()
      // or freezing the visualiser. Deliberately light (pipeline-seam only) — a
      // deeper per-system hardening pass comes after the feature rework.
      const safe = (name, fn) => {
        try { return fn(); }
        catch (e) { console.error(`[gen] ${name} failed — skipped:`, e); return null; }
      };

      // Wind: one vector per data point. Reads continent.landGrid (friction)
      // + provinces.primitiveMap (mtn shadow).
      wind = safe('wind', () => {
        const w = new V.WindModel({
          mapW: cfg.mapW, mapH: cfg.mapH, seed,
          polarEquatorDistance: parseInt(document.getElementById('polarDist').value) || (cfg.mapH / 2),
        }, continent, tectonic, provinces);
        w.computeAnchorWinds(mesh);
        return w;
      });

      // Currents: one vector + temp offset per OCEANIC data point. Reads wind
      // for direction (Ekman + coastal deflection) and lineage.
      currents = safe('currents', () => {
        const c = new V.CurrentsModel({
          mapW: cfg.mapW, mapH: cfg.mapH, seed,
        }, continent, tectonic, wind);
        c.computeAnchorCurrents(mesh);
        return c;
      });

      // Climate: three bytes per data point (temp, rain, geo).
      // Reads wind + currents, upheaval (orographic), provinces.primitiveMap
      // (rain shadow + own-province), tectonic (geo distance, hotspots).
      climate = safe('climate', () => {
        const c = new V.ClimateModel({
          mapW: cfg.mapW, mapH: cfg.mapH, seed,
          tropicalEnd: cfg.climateTropicalEnd,
          temperateEnd: cfg.climateTemperateEnd,
          variationStrength: cfg.climateVariation,
          globalTemperature: cfg.globalTemperature,
          globalPrecipitation: cfg.globalPrecipitation,
          continentalityStrength: cfg.continentalityStrength,
          currentInfluence: cfg.currentInfluence,
          orographicBoost: cfg.orographicBoost,
          rainShadowStrength: cfg.rainShadowStrength,
          windwardBonusStrength: cfg.windwardBonusStrength,
          tempJitter: cfg.tempJitter,
          rainJitter: cfg.rainJitter,
        }, continent, tectonic, wind, currents, upheaval, provinces, distanceFields);
        c.computeAnchorClimate(mesh);
        return c;
      });

      // Ridges: geometry phase — anchor scatter + network growth → polylines.
      // (The peak-value / segment-index passes retired with the legacy upheaval
      // band; ridge HEIGHT gets rebuilt on the anchor fields in the feature
      // rework.)
      const tRidges0 = performance.now();
      ridges = safe('ridges', () => new V.RidgeNetworks({
        mapW: cfg.mapW, mapH: cfg.mapH, seed,
        spacing: cfg.ridgeSpacing,
        jitter: cfg.ridgeJitter,
        shapeVariation: cfg.ridgeShapeVariation,
        spread: cfg.ridgeSpread,
      }, tectonic, continent));
      const tRidges = performance.now() - tRidges0;

      // Lakes Phase A — stepping-stone candidates only (basin/cluster placement
      // is Phase B, after rivers). `riverPoints` scales candidate density.
      const tLakesA0 = performance.now();
      lakes = safe('lakes', () => new V.LakeFeatures({
        mapW: cfg.mapW, mapH: cfg.mapH, seed,
        density: cfg.lakeDensity,
        riverPoints: cfg.riverPoints,
      }, tectonic, continent, climate, provinces, distanceFields));
      const tLakesA = performance.now() - tLakesA0;

      // Rivers: springs + coast/lake ends → routed connections. NOTE: routing +
      // hydrology still ride on the legacy upheaval band (_primitiveAt), now
      // removed — so this THROWS and is skipped by the failsafe until rivers are
      // rebuilt on the drainage graph + anchor fields. Expected, not a bug.
      const tRivers0 = performance.now();
      rivers = safe('rivers', () => new V.RiverNetworks({
        mapW: cfg.mapW, mapH: cfg.mapH, seed,
        riverPoints: cfg.riverPoints,
        riverConnections: cfg.riverConnections,
        deflectorInfluence: cfg.deflectorInfluence,
        climateInfluence: cfg.climateInfluence,
        geoInfluence: cfg.geoInfluence,
      }, tectonic, continent, provinces, climate, lakes, upheaval));
      const tRivers = performance.now() - tRivers0;

      // Lakes Phase B — basin + cluster placement (reads rivers._segGrid). Skips
      // cleanly when rivers didn't build.
      const tLakesB0 = performance.now();
      safe('lakes-place', () => { if (lakes && rivers) lakes.placeLakes(rivers); });
      const tLakes = (performance.now() - tLakesB0) + tLakesA;

      // Landform painter — two pixel maps (primitive + warped) via the
      // multi-condition picker. Reads provinces, climate, upheaval
      // (detailedHeight), continent, tectonic. Pre-built for O(1) render lookup.
      const primLandformMap = safe('landforms-prim', () => V.buildPixelLandformMap
        ? V.buildPixelLandformMap(cfg.mapW, cfg.mapH, provinces, climate, upheaval, continent, tectonic, true, distanceFields, coastField)
        : null);
      const detailedLandformMap = safe('landforms-det', () => V.buildPixelLandformMap
        ? V.buildPixelLandformMap(cfg.mapW, cfg.mapH, provinces, climate, upheaval, continent, tectonic, false, distanceFields, coastField)
        : null);

      renderer.setSize(cfg.mapW, cfg.mapH);
      renderer.setModel(tectonic);
      renderer.setContinent(continent);
      renderer.setWorldHeight(cfg.worldHeight);   // hover strip reports blocks, not just bytes
      renderer.setCoastField(coastField);
      renderer.setMesh(mesh);
      renderer.setProvinces(provinces);
      renderer.setUpheaval(upheaval);
      renderer.setDrainage(drainage);
      renderer.setWind(wind);
      renderer.setCurrents(currents);
      renderer.setClimate(climate);
      renderer.setRidges(ridges);
      renderer.setLakes(lakes);
      renderer.setRivers(rivers);
      renderer.setLandformMaps(primLandformMap, detailedLandformMap);
      renderer.render();

      if (stats) {
        const activePts = (tectonic.activeBoundaryPixels.length / 2) | 0;
        const fossilPts = (tectonic.fossilBoundaryPixels.length / 2) | 0;
        // Land coverage actually achieved (pixels of landGrid set to 1).
        let landPx = 0;
        for (let i = 0; i < continent.landGrid.length; i++) if (continent.landGrid[i] === 1) landPx++;
        const landPct = (landPx / continent.landGrid.length * 100).toFixed(1);
        const springCount = rivers ? rivers.springIdxs.length : 0;
        const endCount = rivers ? rivers.endIdxs.length : 0;
        const connCount = rivers ? rivers.connections.length : 0;
        stats.innerHTML = `<b>Stats:</b> ${tectonic.majorSeeds.length} plates · ` +
          `${tectonic.minorSeeds.length} fossils · ${tectonic.hotspots.length} hotspots · ` +
          `${mesh.numAnchors} points / ${mesh.numFaces} faces · ${ridges.networks.length} ridge networks · ` +
          `${springCount} springs / ${endCount} ends / ${connCount} rivers<br>` +
          `${landPct}% land · ${activePts} active · ${fossilPts} fossil · ` +
          `tec ${(tTec - t0).toFixed(0)}ms · ocean ${(tCon - tTec).toFixed(0)}ms · ` +
          `prov ${(tProv - tCon).toFixed(0)}ms · uph ${(t1 - tProv).toFixed(0)}ms · ` +
          `ridges ${tRidges.toFixed(0)}ms · lakes ${tLakes.toFixed(0)}ms · rivers ${tRivers.toFixed(0)}ms`;
      }
      saveSettings();
    } catch (err) {
      console.error('[generate] error:', err);
      if (stats) stats.innerHTML = `<b style="color:#ff6b6b">Error:</b> ${err.message}`;
    }
  }

  function init() {
    renderer = new V.Renderer();
    loadSettings();
    refreshValueBadges();

    // Keep value badges + persistence in sync as the user touches inputs.
    for (const f of FIELDS) {
      const el = document.getElementById(f.id);
      if (!el) continue;
      el.addEventListener('input', () => {
        refreshValueBadges();
        saveSettings();
      });
    }
    for (const m of MARKERS) {
      const el = document.getElementById(m);
      if (!el) continue;
      el.addEventListener('change', () => {
        // Pixel markers (plate/fossil/coast) live in the
        // background pass now, so any marker toggle is a full render.
        if (renderer) renderer.render();
        saveSettings();
      });
    }
    document.querySelectorAll('input[name="overlay"]').forEach(r => {
      r.addEventListener('change', () => {
        // Primitive vs Detailed → repaint background AND markers.
        if (renderer) renderer.render();
        saveSettings();
      });
    });

    const genBtn = document.getElementById('genBtn');
    if (genBtn) genBtn.addEventListener('click', generate);

    // Enter triggers generate, but only when the focus isn't inside a slider/checkbox
    // (which already use Enter for their own toggles).
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && document.activeElement?.tagName !== 'BUTTON') {
        generate();
      }
    });

    // Auto-generate on first load so the user sees plates without needing to click.
    generate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window.VIS);
