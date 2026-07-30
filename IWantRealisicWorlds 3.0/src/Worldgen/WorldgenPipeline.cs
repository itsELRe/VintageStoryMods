using System;
using IWantRealisticWorlds.Core;

namespace IWantRealisticWorlds.Worldgen
{
    // The one place the worldgen systems get built, in the one canonical order —
    // the C# counterpart of the visualiser's ui.js generate(). Every knob is read
    // from Settings here; the systems themselves keep their own Options defaults
    // and never touch the config.
    //
    // The mod (MapGenerators) and the parity harness both run THIS builder, so a
    // parity check verifies the code the game actually runs. With settings.json at
    // its defaults the result must stay bit-identical to the visualiser — the
    // config layer is a no-op at default values, which is what proves it is wired
    // to the right places.
    //
    // Vanilla world settings enter here too: seed / map size / world height,
    // landcover + landcoverScale (continents), polar distance (wind latitude),
    // global temperature + precipitation and geologic activity (climate).
    public sealed class WorldgenPipeline
    {
        public readonly Settings Cfg;

        public TectonicModel Tectonic { get; private set; }
        public LatticeMesh Mesh { get; private set; }
        public ContinentGen Continent { get; private set; }
        public CoastField Coast { get; private set; }
        public DistanceFields Distances { get; private set; }
        public ProvinceMap Provinces { get; private set; }
        public UpheavalMap Upheaval { get; private set; }
        public WindModel Wind { get; private set; }
        public CurrentsModel Currents { get; private set; }
        public ClimateModel Climate { get; private set; }

        public WorldgenPipeline(Settings cfg) { Cfg = cfg; }

        // Build every primitive system, in dependency order. Long-running: this is
        // the whole world-init cost, paid once.
        public void Build()
        {
            var cfg = Cfg;
            int mapW = cfg.MapW, mapH = cfg.MapH;
            long seed = cfg.Seed;
            Log.Debug = cfg.DebugLogging;

            var sw = System.Diagnostics.Stopwatch.StartNew();

            // Per-stage timing. World init is the one place the player waits, so
            // knowing WHICH system costs the wait is worth one stopwatch.
            long lastMark = 0;
            var stages = new System.Collections.Generic.List<(string Name, long Ms)>();
            void Mark(string name)
            {
                long now = sw.ElapsedMilliseconds;
                stages.Add((name, now - lastMark));
                lastMark = now;
            }

            Tectonic = new TectonicModel(new TectonicModel.TectonicOptions
            {
                Seed = seed, MapW = mapW, MapH = mapH,
                ContinentSize = cfg.D("continentSize"),
                PlateCountMult = cfg.D("plateCountMult"),
                SeedJitter = cfg.D("seedJitter"),
                WarpPower = cfg.D("warpPower"),
                PlateSpeedMin = cfg.D("plateSpeedMin"),
                PlateSpeedMax = cfg.D("plateSpeedMax"),
                TransformThreshold = cfg.D("transformThreshold"),
                OrogenWidth = cfg.D("orogenWidth"),
                BasinWidth = cfg.D("basinWidth"),
                FossilWidth = cfg.D("fossilWidth"),
                PlatformWidth = cfg.D("platformWidth"),
                FossilBasinWidth = cfg.D("fossilBasinWidth"),
                FossilPlatformWidth = cfg.D("fossilPlatformWidth"),
                ProvinceWarpPower = cfg.D("provinceWarpPower"),
                ExtendedCrustWidth = cfg.D("extendedCrustWidth"),
                WidthFloor = cfg.D("widthFloor"),
            });
            // The visualiser builds these inside the TectonicModel constructor; in
            // C# the caller attaches them (see TectonicModel.Lines).
            Mark("tectonic model");
            Tectonic.Lines = new TectonicLines(Tectonic);
            Tectonic.Lines.AssignPairTypes(Tectonic.PlatePairTypes);
            Mark("tectonic lines");

            // The lattice — the data points (anchors) and the faces between them.
            // Built before the continent fill, which labels its faces.
            double spacing = LatticeMesh.AutoSpacing(mapW, mapH, cfg.D("continentSize"), cfg.D("latticeSpacing"));
            Mesh = new LatticeMesh(mapW, mapH, spacing);
            Mark("lattice mesh");

            Continent = new ContinentGen(new ContinentGen.ContinentOptions
            {
                MapW = mapW, MapH = mapH, Seed = seed,
                ContinentSize = cfg.D("continentSize"),
                Landcover = cfg.Landcover,               // vanilla
                LandcoverScale = cfg.LandcoverScale,     // vanilla
                SeedOverride = cfg.I("seedOverride"),
                SizeVar = cfg.D("sizeVar"),
                Fragmentation = 0,                       // dormant (islands system unported)
                PlateBias = cfg.D("plateBias"),
                SeparationBias = cfg.D("separationBias"),
                EdgeBias = cfg.D("edgeBias"),
                GapFill = cfg.D("gapFill"),
            }, Tectonic, Mesh);
            Continent.Calibrate();
            Mark("continent fill");

            // Emergent coastline — a pure per-column function of the face labels.
            Coast = new CoastField(new CoastField.CoastOptions
            {
                MapW = mapW, MapH = mapH, Seed = seed,
                CoastAmplitude = cfg.D("coastAmplitude"),
                CoastCoarseBlend = cfg.D("coastCoarseBlend"),
            }, Mesh, Continent);
            Mark("coast field");

            Distances = new DistanceFields(Mesh, Continent);
            Mark("distance fields");

            // Per-point nearest-segment hints, then per-segment collision intensity
            // (needs land/ocean per plate, so it runs after the continent fill).
            Tectonic.Lines.ComputeAnchorKindHints(Mesh);
            Tectonic.Lines.ComputeCollisionIntensity(Continent.ContinentalPlates);
            Tectonic.Lines.LogDistanceFieldsSample();
            Mark("kind hints + collision");

            // No Generate() — provinces are queried on demand (see ProvinceMap).
            Provinces = new ProvinceMap(new ProvinceMap.ProvinceOptions { MapW = mapW, MapH = mapH },
                Tectonic, Continent, Coast);
            Mark("provinces");

            Upheaval = new UpheavalMap(new UpheavalMap.UpheavalOptions
            {
                MapW = mapW, MapH = mapH, Seed = seed,
                WorldHeight = cfg.WorldHeight,           // vanilla
                LandBaseCap = cfg.D("landBaseCap"),
                OceanBaseCap = cfg.D("oceanBaseCap"),
                BaseRiseFrac = cfg.D("baseRiseFrac"),
                TectWeight = cfg.D("tectWeight"),
                TerrainFossilWeight = cfg.D("terrainFossilWeight"),
                TerrainVarAmp = cfg.D("terrainVarAmp"),
                TerrainVarScaleFrac = cfg.D("terrainVarScaleFrac"),
                ShelfReach = cfg.D("shelfReach"),
                ShelfDepth = cfg.D("shelfDepth"),
            }, Tectonic, Continent, Distances, Coast);
            Upheaval.ComputePointTerrain(Mesh);
            Mark("upheaval");

            Wind = new WindModel(new WindModel.WindOptions
            {
                MapW = mapW, MapH = mapH, Seed = seed,
                PolarEquatorDistance = cfg.PolarDistancePx,   // vanilla
            }, Continent, Tectonic, Provinces);
            Wind.ComputeAnchorWinds(Mesh);
            Mark("wind");

            Currents = new CurrentsModel(new CurrentsModel.CurrentsOptions
            {
                MapW = mapW, MapH = mapH, Seed = seed,
            }, Continent, Tectonic, Wind);
            Currents.ComputeAnchorCurrents(Mesh);
            Mark("currents");

            Climate = new ClimateModel(new ClimateModel.ClimateOptions
            {
                MapW = mapW, MapH = mapH, Seed = seed,
                TropicalEnd = cfg.D("climateTropicalEnd"),
                TemperateEnd = cfg.D("climateTemperateEnd"),
                VariationStrength = cfg.D("climateVariation"),
                GlobalTemperature = cfg.GlobalTemperature,       // vanilla
                GlobalPrecipitation = cfg.GlobalPrecipitation,   // vanilla
                GeoActivityMult = cfg.GeoActivityMult,           // vanilla (remapped)
                ContinentalityStrength = cfg.D("continentalityStrength"),
                CurrentInfluence = cfg.D("currentInfluence"),
                OrographicBoost = cfg.D("orographicBoost"),
                RainShadowStrength = cfg.D("rainShadowStrength"),
                WindwardBonusStrength = cfg.D("windwardBonusStrength"),
                TempJitter = cfg.D("tempJitter"),
                RainJitter = cfg.D("rainJitter"),
            }, Continent, Tectonic, Wind, Currents, Upheaval, Provinces, Distances);
            Climate.ComputeAnchorClimate(Mesh);
            Mark("climate");

            // Deliberately not consumed yet: the whole "Features" group
            // (ridges/lakes/rivers are a later rework). Everything else in the
            // schema is threaded above.

            sw.Stop();
            Log.Info($"[IWRW] worldgen primitives built in {sw.ElapsedMilliseconds}ms " +
                     $"({Mesh.NumAnchors} points, {Mesh.NumFaces} faces, map {mapW}x{mapH})");
            stages.Sort((a, b) => b.Ms.CompareTo(a.Ms));
            Log.Info("[IWRW]   by stage: " + string.Join(", ", stages.ConvertAll(s => $"{s.Name} {s.Ms}ms")));
        }

        // Free the full-map arrays that only existed to BUILD the primitives. They
        // dominate our memory (137 of 158 MB on a 8000x2000 map) and nothing reads
        // them once the build is done — every query goes through the polylines,
        // nodes, lookup grids and anchor fields derived from them.
        //
        // Deliberately NOT part of Build(): the parity harness checksums some of
        // these grids, and a build that silently destroyed its own evidence would
        // make parity unverifiable. The mod calls this explicitly instead.
        public void ReleaseScaffolding()
        {
            long before = GC.GetTotalMemory(false);

            Tectonic?.Lines?.ReleaseScaffolding();   // borrowed refs first...
            Tectonic?.ReleaseScaffolding();          // ...then the owner
            Continent?.ReleaseScaffolding();

            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            long after = GC.GetTotalMemory(true);
            Log.Info($"[IWRW] released build scaffolding: {(before - after) / 1048576.0:F1} MB freed, " +
                     $"{after / 1048576.0:F1} MB still held");
        }
    }
}
