using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using Vintagestory.API.Common;
using Vintagestory.API.Datastructures;
using Vintagestory.API.Server;

namespace IWantRealisticWorlds.Core
{
    // The mod's settings manager. Schema-driven: each mod setting is one Def
    // (key, group, [min,max], default, comment = the visualiser slider's tooltip).
    // On first run it code-generates a commented settings.json in the UI order;
    // on load it clamps any out-of-range value to the cap. Systems keep their own
    // Options defaults and get values threaded in by MapGenerators via D()/I().
    //
    // MOD SETTINGS ONLY. The vanilla world knobs (seed, map size, world height,
    // landcover, landcoverScale, global temperature/precipitation, polar distance,
    // geologic activity) are read from the game (WorldConfiguration) in
    // ApplyVanilla — never stored in the config file.
    public sealed class Settings
    {
        public sealed class Def
        {
            public readonly string Key, Group, Comment;
            public readonly double Min, Max, Default;
            public readonly bool IsInt;
            public Def(string group, string key, double min, double max, double def, string comment, bool isInt = false)
            { Group = group; Key = key; Min = min; Max = max; Default = def; Comment = comment; IsInt = isInt; }
        }

        // ===== Schema (mod settings, in UI order/groups) =====
        public static readonly Def[] Schema =
        {
            // Tectonic Plates
            new("Tectonic Plates", "continentSize", 0.3, 3.0, 1.0, "Average plate size. Larger = fewer, bigger plates; smaller = many small plates."),
            new("Tectonic Plates", "plateCountMult", 0.5, 4.0, 1.0, "Multiplier on the derived plate count. Higher = more, smaller plates (min 2)."),
            new("Tectonic Plates", "seedJitter", 0.0, 1.0, 0.70, "How far each plate seed drifts from its grid cell. 0 = regular grid, 1 = chaotic."),
            new("Tectonic Plates", "warpPower", 0.0, 0.5, 0.12, "Organic warp on plate boundaries. 0 = straight Voronoi lines; higher = more curved."),
            new("Tectonic Plates", "plateSpeedMin", 0.0, 1.0, 0.30, "Minimum plate drift speed. Lower end of the collision-intensity speed spread."),
            new("Tectonic Plates", "plateSpeedMax", 0.5, 2.0, 1.00, "Maximum plate drift speed. Faster plates read modestly taller (sublinear)."),
            new("Tectonic Plates", "transformThreshold", 0.0, 1.0, 0.30, "|cos(relative motion, boundary)| below this = transform (glancing). Higher = more transforms."),

            // Data Lattice
            new("Data Lattice", "latticeSpacing", 0.5, 2.0, 1.00, "Multiplier on auto-calibrated data-point spacing. <1 = denser/finer/slower; >1 = sparser."),

            // Continental Primitives
            new("Continental Primitives", "seedOverride", 0, 200, 0, "Force the exact number of continent seeds. 0 = use landcoverScale.", isInt: true),
            new("Continental Primitives", "sizeVar", 0.0, 1.0, 0.50, "Variation in continent sizes. Higher = mix of very large and very small."),
            new("Continental Primitives", "plateBias", 0.0, 2.0, 1.00, "Growth bias toward continental plates (+ penalty on oceanic). Higher = continents follow plate outlines."),
            new("Continental Primitives", "separationBias", 0.0, 2.0, 1.00, "Separation pressure between continents. 1.5+ guarantees a 1-face strait; 0 = may merge."),
            new("Continental Primitives", "edgeBias", 0.0, 2.0, 1.00, "Penalty for growing near the map border, fading smoothly. Higher = wider avoidance."),
            new("Continental Primitives", "gapFill", 0.0, 2.0, 1.00, "How aggressively holes and jagged coast are closed. 0 = raw; 2 = hole-free, smooth."),

            // Emergent Coastline
            new("Emergent Coastline", "coastAmplitude", 0.0, 0.8, 0.45, "Emergent coast-noise amplitude (lattice-spacing units). 0 = faceted primitive coast; 0.45 = approved; hard bound ~0.87."),
            new("Emergent Coastline", "coastCoarseBlend", 0.0, 1.0, 0.00, "Blend weight of the coarse coast-noise stack vs fine. 0 = fine only (approved look)."),

            // Tectonic Provinces
            new("Tectonic Provinces", "orogenWidth", 2, 20, 8, "Width of the active orogen (mountain) band."),
            new("Tectonic Provinces", "extendedCrustWidth", 0, 30, 6, "Width of the extended-crust band on divergent active boundaries (rifts)."),
            new("Tectonic Provinces", "basinWidth", 1, 16, 6, "Width of the basin (foothill) band ringing the orogen."),
            new("Tectonic Provinces", "fossilWidth", 1, 12, 4, "Width of the fossil orogen band (older, eroded intra-plate peaks)."),
            new("Tectonic Provinces", "platformWidth", 5, 60, 25, "Width of the platform (broad sedimentary interior) band."),
            new("Tectonic Provinces", "provinceWarpPower", 0.0, 2.0, 0.60, "Smooth field scaling ALL band widths together. 0 = uniform; 2 = widths can double at noise peaks."),
            new("Tectonic Provinces", "widthFloor", 0.0, 0.5, 0.15, "Minimum band-width fraction at ~zero intensity, so no band vanishes. 0 = bow-tie waist."),
            new("Tectonic Provinces", "fossilBasinWidth", 1, 12, 4, "Basin band width on fossil boundaries. Narrower than active."),
            new("Tectonic Provinces", "fossilPlatformWidth", 5, 30, 12, "Platform band width on fossil boundaries. Narrower than active."),

            // Upheaval
            new("Upheaval", "landBaseCap", 0.0, 1.0, 0.40, "Land base height plateau (fraction of the byte range) reached inland before tectonic uplift."),
            new("Upheaval", "oceanBaseCap", 0.0, 1.0, 0.50, "Ocean base depth plateau (fraction of the byte range) reached in deep sea before trench deepening."),
            new("Upheaval", "baseRiseFrac", 0.1, 1.0, 0.35, "Coast distance (fraction of map size) over which the base rises/deepens to its cap."),
            new("Upheaval", "tectWeight", 0.0, 2.0, 1.00, "Weight of tectonic uplift/rifting on top of the base. Higher = taller mountains, deeper trenches."),
            new("Upheaval", "terrainFossilWeight", 0.0, 1.0, 0.60, "How much fossil boundaries contribute to height vs active ones. Fossils are discounted."),
            new("Upheaval", "terrainVarAmp", 0.0, 0.3, 0.10, "Amplitude of the coherent per-point height wiggle. Gives flat plateaus a downhill for drainage."),
            new("Upheaval", "terrainVarScaleFrac", 0.05, 0.3, 0.12, "Wavelength (fraction of map size) of the coherent height variance. Smaller = finer wiggle."),

            // Ocean
            new("Ocean", "shelfReach", 0.1, 2.0, 1.00, "How far from the shore the seabed reaches full shelf depth, as a multiple of the coast band. Computed per pixel from the warped coastline, so water narrower than the data lattice still gets a real seabed."),
            new("Ocean", "shelfDepth", 0.0, 1.0, 0.25, "The shelf's depth at its outer edge, as a fraction of the byte range. A FLOOR: the lattice bathymetry (trenches, rifts, basins) layers on top and keeps its full relief. 0 = lattice only."),

            // Climate
            new("Climate", "climateTropicalEnd", 0.10, 0.35, 0.20, "Latitude (0-1) where the tropical band ends. Larger = wider tropics."),
            new("Climate", "climateTemperateEnd", 0.50, 0.90, 0.70, "Latitude (0-1) where the temperate band ends and the polar zone begins."),
            new("Climate", "climateVariation", 0.0, 2.0, 1.00, "Per-point character variation. 0 = identical neighbours; 2 = double jitter."),
            new("Climate", "continentalityStrength", 0.0, 1.0, 0.23, "How much distance-from-coast cools and dries interiors. 0 = maritime everywhere."),
            new("Climate", "currentInfluence", 0.0, 0.5, 0.10, "How much warm/cold ocean currents nudge coastal temperature."),
            new("Climate", "orographicBoost", 0.0, 0.5, 0.20, "Extra rain on windward mountain slopes."),
            new("Climate", "rainShadowStrength", 0.0, 1.0, 0.30, "Drying on the leeward side of mountains (the rain-shadow desert effect)."),
            new("Climate", "windwardBonusStrength", 0.0, 0.5, 0.15, "Extra moisture where onshore wind meets a coast."),
            new("Climate", "tempJitter", 0.0, 0.1, 0.04, "Per-point temperature jitter (x Variation). Small deterministic noise."),
            new("Climate", "rainJitter", 0.0, 0.2, 0.08, "Per-point rainfall jitter (x Variation)."),

            // Features (inactive until the feature systems land)
            new("Features (inactive until the feature systems land)", "ridgeSpacing", 20, 150, 60, "Ridge anchor-scatter grid cell size (px). Smaller = more, tighter networks."),
            new("Features (inactive until the feature systems land)", "ridgeJitter", 0.0, 1.0, 0.70, "Per-cell ridge-anchor jitter."),
            new("Features (inactive until the feature systems land)", "ridgeShapeVariation", 0.0, 1.0, 0.40, "Per-network ridge shape variety (elongation)."),
            new("Features (inactive until the feature systems land)", "ridgeSpread", 0.5, 2.0, 1.00, "Per-network ridge spread multiplier."),
            new("Features (inactive until the feature systems land)", "lakeDensity", 0.0, 2.0, 1.00, "Lake population multiplier."),
            new("Features (inactive until the feature systems land)", "riverPoints", 0.0, 2.0, 1.00, "Spring (river source) density."),
            new("Features (inactive until the feature systems land)", "riverConnections", 0.0, 2.0, 1.00, "Spring activation threshold — higher = more rivers."),
            new("Features (inactive until the feature systems land)", "deflectorInfluence", 0.0, 2.0, 1.00, "Orogen river-blocking reach."),
            new("Features (inactive until the feature systems land)", "climateInfluence", 0.0, 2.0, 1.00, "Rainfall weight in spring activation."),
            new("Features (inactive until the feature systems land)", "geoInfluence", 0.0, 2.0, 1.00, "Geo-activity weight in spring activation."),
        };

        private readonly Dictionary<string, double> _vals;
        private Settings(Dictionary<string, double> vals) { _vals = vals; }

        // Mod-setting accessors (clamped to schema on load).
        public double D(string key) => _vals[key];
        public int I(string key) => (int)Math.Round(_vals[key]);

        // ===== Vanilla (read from VS in ApplyVanilla) =====
        public long Seed;
        public int MapW, MapH;        // ocean-map pixels (blocks / 32)
        public int WorldHeight;       // blocks
        public double Landcover = 1.0, LandcoverScale = 1.0;
        public double GlobalTemperature = 1.0, GlobalPrecipitation = 1.0, GeologicActivity = 0.05;
        public int PolarDistancePx;   // polarEquatorDistance / 32, in ocean-map pixels

        // On by default, and GenerateJson writes it as true — the two must agree,
        // or a config that failed to load would quietly log differently from one
        // that parsed. Verbose per-region/per-chunk diagnostics hide behind this;
        // the per-system summaries do not.
        public bool DebugLogging = true;

        // Vanilla's `geologicActivity` is NOT a strength — it is the exponent of a
        // power law over random noise (`pow(rand, 1/value)`), which is what makes
        // vanilla's high-activity spots vanishingly rare. Our geo activity is a
        // structured field along active plate boundaries, not noise, so that curve
        // does not transfer. Instead the slider becomes a plain multiplier anchored
        // at vanilla's neutral point:
        //   0     → off
        //   0.05  → x1 (vanilla default; our field untouched, matches the visualiser)
        //   1.0   → x3 (the cap — stronger and wider, without saturating the map)
        // Piecewise linear through those three points, so the whole slider does
        // something instead of the top 85% being dead.
        public const double VanillaGeoDefault = 0.05;
        public const double GeoMultAtMax = 3.0;
        public double GeoActivityMult
        {
            get
            {
                double v = GeologicActivity;
                if (v <= 0) return 0;
                if (v <= VanillaGeoDefault) return v / VanillaGeoDefault;
                double t = Math.Min(1.0, (v - VanillaGeoDefault) / (1.0 - VanillaGeoDefault));
                return 1.0 + t * (GeoMultAtMax - 1.0);
            }
        }

        // Parse config JSON (comments + trailing commas tolerated) → clamp to the
        // schema → Settings. Missing/invalid keys fall back to the default.
        public static Settings FromJson(string json)
        {
            var vals = new Dictionary<string, double>();
            JsonElement root = default;
            bool ok = false;
            try
            {
                var opts = new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };
                using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json, opts);
                root = doc.RootElement.Clone();
                ok = root.ValueKind == JsonValueKind.Object;
            }
            catch { ok = false; }

            foreach (var def in Schema)
            {
                double v = def.Default;
                if (ok && root.TryGetProperty(def.Key, out var el) && el.ValueKind == JsonValueKind.Number && el.TryGetDouble(out double dv))
                    v = dv;
                if (v < def.Min) v = def.Min; else if (v > def.Max) v = def.Max; // clamp to cap
                if (def.IsInt) v = Math.Round(v);
                vals[def.Key] = v;
            }
            var s = new Settings(vals);
            if (ok && root.TryGetProperty("debugLogging", out var dbg) && (dbg.ValueKind == JsonValueKind.True || dbg.ValueKind == JsonValueKind.False))
                s.DebugLogging = dbg.GetBoolean();
            return s;
        }

        public static Settings Defaults() => FromJson("{}");

        // The commented settings.json written on first run: grouped by UI section,
        // one line per setting with its [min, max] and tooltip.
        public static string GenerateJson()
        {
            var sb = new StringBuilder();
            sb.AppendLine("// IWantRealisticWorlds — mod settings (auto-generated; edit values below).");
            sb.AppendLine("// Out-of-range values are clamped to the [min, max] shown in each comment.");
            sb.AppendLine("// Vanilla world knobs (seed, map size, world height, landcover, landcoverScale,");
            sb.AppendLine("// temperature, precipitation, polar distance, geologic activity) are read from");
            sb.AppendLine("// the game's world-creation settings, not here.");
            sb.AppendLine("{");
            string group = null;
            for (int i = 0; i < Schema.Length; i++)
            {
                var d = Schema[i];
                if (d.Group != group)
                {
                    if (group != null) sb.AppendLine();
                    sb.AppendLine($"  // ===== {d.Group} =====");
                    group = d.Group;
                }
                string val = Num(d.Default);
                sb.AppendLine($"  \"{d.Key}\": {val},   // [{Num(d.Min)}, {Num(d.Max)}] {d.Comment}");
            }
            sb.AppendLine();
            sb.AppendLine("  // Prints the [IWRW] [verify] worldgen logs to the server log: the vanilla");
            sb.AppendLine("  // world settings we actually read, which mod settings differ from default,");
            sb.AppendLine("  // map load order, and per-region paint stats. ON during development —");
            sb.AppendLine("  // set false for a quiet log once the world generates correctly.");
            sb.AppendLine("  \"debugLogging\": true");
            sb.AppendLine("}");
            return sb.ToString();
        }

        private static string Num(double v) => v.ToString("0.####", CultureInfo.InvariantCulture);

        // ===== VS integration (Phase 2; verified in-game) =====

        // Load from ModConfig/iwantrealisticworlds/settings.json, creating it from
        // GenerateJson() on first run, then read the vanilla world settings.
        public static Settings Load(ICoreServerAPI api)
        {
            string json;
            try
            {
                string path = Path.Combine(api.GetOrCreateDataPath("ModConfig"), "iwantrealisticworlds", "settings.json");
                if (File.Exists(path))
                {
                    json = File.ReadAllText(path);
                }
                else
                {
                    json = GenerateJson();
                    Directory.CreateDirectory(Path.GetDirectoryName(path));
                    File.WriteAllText(path, json);
                }
            }
            catch (Exception ex)
            {
                api.Logger.Warning("[IWRW] Settings.Load failed ({0}); using defaults", ex.Message);
                json = "{}";
            }
            var s = FromJson(json);
            s.ApplyVanilla(api);
            return s;
        }

        // Read the vanilla world knobs from the game. Map/world sizes are exact;
        // WorldConfiguration values are read by reflection for version robustness.
        public void ApplyVanilla(ICoreServerAPI api)
        {
            const int oceanMapScale = 32; // TerraGenConfig.oceanMapScale
            Seed = api.World.Seed;
            MapW = api.WorldManager.MapSizeX / oceanMapScale;
            MapH = api.WorldManager.MapSizeZ / oceanMapScale;
            WorldHeight = api.WorldManager.MapSizeY;

            try
            {
                var wc = api.WorldManager.SaveGame?.WorldConfiguration;
                if (wc is ITreeAttribute tree)
                {
                    Landcover = ReadFloat(tree, "landcover", 1.0);
                    LandcoverScale = ReadFloat(tree, "landcoverScale", ReadFloat(tree, "oceanscale", 1.0));
                    GlobalTemperature = ReadFloat(tree, "globalTemperature", 1.0);
                    GlobalPrecipitation = ReadFloat(tree, "globalPrecipitation", 1.0);
                    GeologicActivity = ReadFloat(tree, "geologicActivity", 0.05);
                    double polarBlk = ReadFloat(tree, "polarEquatorDistance", 50000);
                    PolarDistancePx = (int)Math.Round(polarBlk / oceanMapScale);
                }
                else
                {
                    PolarDistancePx = 50000 / oceanMapScale;
                }
            }
            catch (Exception ex)
            {
                api.Logger.Warning("[IWRW] Settings.ApplyVanilla failed ({0}); using vanilla defaults", ex.Message);
                if (PolarDistancePx == 0) PolarDistancePx = 50000 / oceanMapScale;
            }
        }

        private static double ReadFloat(ITreeAttribute tree, string key, double fallback)
        {
            string s = tree.GetString(key);
            if (!string.IsNullOrEmpty(s) && double.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out double v))
            {
                // landcover may come as 0-100 in some VS builds.
                if (key == "landcover" && v > 1.5) v /= 100.0;
                return v;
            }
            return fallback;
        }
    }
}
