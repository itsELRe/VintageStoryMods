using System;
using Vintagestory.API.Common;
using Vintagestory.API.Datastructures;
using Vintagestory.API.Server;
using IWantRealisticWorlds.Worldgen;

namespace IWantRealisticWorlds.Core
{
    // Builds the worldgen primitives once at world init, then paints our values
    // into VS's per-region maps as each region is generated.
    //
    // ExecuteOrder 0.12 — after vanilla GenMaps.initWorldGen (0.1), which both
    // assigns the generator slots and populates the static NoiseLandforms registry.
    // MapRegionGeneration is registered from InitWorldGenerator (not
    // StartServerSide) so it lands after vanilla's own handler and sees maps that
    // are already populated — we overwrite values rather than generate them, which
    // keeps us Harmony-free and gives exact control of the final bytes.
    //
    // Map formats (docs/990_vs_constraints.md):
    //   OceanMap   32 blk/px, 16x16 inner, padding 5, 0 = land / 1-255 = depth
    //   UpheavelMap 32 blk/px, 16x16 inner, padding 3   (next step)
    //   ClimateMap  32 blk/px, 16x16 inner, padding 2   (next step)
    //   GeologicProvinceMap 64 blk/px, 8x8 inner, padding 3 (next step)
    //
    // Our primitives live in ocean-map pixel space (mapW = MapSizeX / 32), so an
    // ocean/upheaval/climate pixel index IS one of our internal x/z coordinates —
    // no scale conversion. The province map is half that resolution and the
    // landform map twice it; those convert when they land.
    public class MapGenerators : ModSystem
    {
        // Kept static so later systems (column builder, feature factories) can read
        // the primitives without plumbing them through every constructor.
        public static WorldgenPipeline Pipeline { get; private set; }
        public static Settings Cfg { get; private set; }

        private ICoreServerAPI sapi;
        private int regionsPainted;
        private bool orderingChecked;

        public override double ExecuteOrder() => 0.12;
        public override bool ShouldLoad(EnumAppSide side) => side == EnumAppSide.Server;

        public override void StartServerSide(ICoreServerAPI api)
        {
            sapi = api;
            api.Event.InitWorldGenerator(InitWorldGen, "standard");
        }

        public override void Dispose()
        {
            Pipeline = null;
            Cfg = null;
            regionsPainted = 0;
            orderingChecked = false;
            base.Dispose();
        }

        private void InitWorldGen()
        {
            try
            {
                Log.Info = s => sapi.Logger.Notification(s);
                Log.Warn = s => sapi.Logger.Warning(s);
                regionsPainted = 0;
                orderingChecked = false;

                Cfg = Settings.Load(sapi);   // settings.json + the vanilla world knobs
                Log.Debug = Cfg.DebugLogging;

                sapi.Logger.Notification(
                    "[IWRW] world init: {0}x{1} px (32 blk/px), height {2}, seed {3}, landcover {4:F2}",
                    Cfg.MapW, Cfg.MapH, Cfg.WorldHeight, Cfg.Seed, Cfg.Landcover);

                // Verification block — proves what we actually read out of the game
                // rather than what we assume. Everything here is read at runtime.
                Log.Dbg("[IWRW] [verify] === vanilla world settings read from VS ===");
                Log.Dbg($"[IWRW] [verify]   seed={Cfg.Seed} mapSize={Cfg.MapW}x{Cfg.MapH}px worldHeight={Cfg.WorldHeight}");
                Log.Dbg($"[IWRW] [verify]   landcover={Cfg.Landcover:F3} landcoverScale={Cfg.LandcoverScale:F3}");
                Log.Dbg($"[IWRW] [verify]   globalTemperature={Cfg.GlobalTemperature:F3} globalPrecipitation={Cfg.GlobalPrecipitation:F3}");
                Log.Dbg($"[IWRW] [verify]   polarDistance={Cfg.PolarDistancePx}px geologicActivity={Cfg.GeologicActivity:F3} -> geoMult={Cfg.GeoActivityMult:F3}");
                Log.Dbg("[IWRW] [verify] === mod settings (non-default only) ===");
                int overridden = 0;
                foreach (var def in Settings.Schema)
                {
                    double v = Cfg.D(def.Key);
                    if (Math.Abs(v - def.Default) > 1e-12)
                    {
                        Log.Dbg($"[IWRW] [verify]   {def.Key} = {v} (default {def.Default})");
                        overridden++;
                    }
                }
                Log.Dbg($"[IWRW] [verify]   {overridden} of {Settings.Schema.Length} settings overridden");

                Pipeline = new WorldgenPipeline(Cfg);
                Pipeline.Build();
                // Hand back the full-map arrays that only existed to build the
                // primitives — nothing queries them, and on a large world they are
                // the bulk of what we hold for the rest of the session.
                Pipeline.ReleaseScaffolding();

                sapi.Event.MapRegionGeneration(OnMapRegionGen, "standard");
                Log.Dbg("[IWRW] [verify] region painter registered (from InitWorldGenerator, so it runs after vanilla's handler)");
            }
            catch (Exception ex)
            {
                sapi.Logger.Error("[IWRW] world init FAILED: {0}\n{1}", ex.Message, ex.StackTrace);
                Pipeline = null;   // leave vanilla's maps untouched rather than half-painting
            }
        }

        private void OnMapRegionGen(IMapRegion region, int regionX, int regionZ, ITreeAttribute chunkGenParams)
        {
            if (Pipeline == null) return;
            try
            {
                PaintOceanMap(region, regionX, regionZ);
                PaintUpheavalMap(region, regionX, regionZ);
                PaintClimateMap(region, regionX, regionZ);
                PaintProvinceMap(region, regionX, regionZ);
            }
            catch (Exception ex)
            {
                sapi.Logger.Error("[IWRW] region ({0},{1}) paint failed: {2}", regionX, regionZ, ex.Message);
            }
        }

        // Ocean map: 0 = land, 1-255 = water depth (VS turns the value into
        // submersion depth, and marine life — coral, kelp, seashells — is gated on
        // the resulting depth). So we export our real depth field rather than a
        // flat "255 = ocean": shallow shelves near shore, deep water offshore.
        private void PaintOceanMap(IMapRegion region, int regionX, int regionZ)
        {
            var map = region?.OceanMap;
            if (map?.Data == null)
            {
                sapi.Logger.Warning("[IWRW] region ({0},{1}): OceanMap is null — nothing painted", regionX, regionZ);
                return;
            }

            int size = map.Size, pad = map.TopLeftPadding, inner = size - 2 * pad;

            // LOAD-ORDER CHECK (once). If vanilla has already filled this map, its
            // values vary — which proves our handler runs AFTER vanilla's and our
            // overwrite is the one that survives. A uniform map means vanilla has
            // not run yet, so vanilla will overwrite US: that is a real defect and
            // is reported as a warning even with debug logging off.
            if (!orderingChecked)
            {
                orderingChecked = true;
                int vMin = int.MaxValue, vMax = int.MinValue;
                for (int i = 0; i < map.Data.Length; i++)
                {
                    int v = map.Data[i];
                    if (v < vMin) vMin = v;
                    if (v > vMax) vMax = v;
                }
                if (vMin == vMax)
                {
                    sapi.Logger.Warning(
                        "[IWRW] [verify] LOAD ORDER SUSPECT: vanilla's ocean map is uniform ({0}) before our paint — " +
                        "we may be running BEFORE vanilla's generator, which would overwrite our values. " +
                        "If the world looks vanilla, raise our ExecuteOrder or swap GenMaps.oceanGen instead.", vMin);
                }
                else
                {
                    Log.Dbg($"[IWRW] [verify] load order OK — vanilla ocean map already populated (values {vMin}..{vMax}); our paint runs after it");
                }
                Log.Dbg($"[IWRW] [verify] ocean map format: size={size} pad={pad} inner={inner} (expected 26/5/16)");
            }

            // Bounds check — catches a mismatch between our map dimensions and the
            // world's actual size, which would silently shift or wrap the world.
            int gx0 = regionX * inner - pad, gz0 = regionZ * inner - pad;
            int gx1 = gx0 + size - 1, gz1 = gz0 + size - 1;
            if (gx0 < -pad || gz0 < -pad || gx1 > Cfg.MapW + pad || gz1 > Cfg.MapH + pad)
            {
                sapi.Logger.Warning(
                    "[IWRW] [verify] region ({0},{1}) covers pixels x[{2}..{3}] z[{4}..{5}] — outside our {6}x{7} map",
                    regionX, regionZ, gx0, gx1, gz0, gz1, Cfg.MapW, Cfg.MapH);
            }

            PaintOcean(Pipeline, map.Data, size, pad, regionX, regionZ);
            regionsPainted++;

            // Per-region detail for the first few regions, then a periodic pulse —
            // a big world has tens of thousands of regions.
            if (Log.Debug && (regionsPainted <= 3 || regionsPainted % 256 == 0))
            {
                int land = 0, dMin = 255, dMax = 0; long dSum = 0; int ocean = 0;
                for (int i = 0; i < map.Data.Length; i++)
                {
                    int v = map.Data[i];
                    if (v == 0) { land++; continue; }
                    ocean++; dSum += v;
                    if (v < dMin) dMin = v;
                    if (v > dMax) dMax = v;
                }
                Log.Dbg($"[IWRW] [verify] region #{regionsPainted} ({regionX},{regionZ}) px x[{gx0}..{gx1}] z[{gz0}..{gz1}]: " +
                        $"{land} land / {ocean} ocean, depth {(ocean > 0 ? dMin : 0)}..{dMax} mean {(ocean > 0 ? dSum / (double)ocean : 0):F1}");
            }
        }

        // Upheaval map: 0 = flat (at sea level), 255 = maximum height. This is the
        // channel our macro surface reaches the column through — the map is one
        // pixel per chunk, so VS's own bilinear read of the four chunk-corner
        // pixels IS the chunk-to-chunk interpolation, giving a smooth ramp rather
        // than a flat byte per chunk.
        //
        // We interpolate AnchorHeight everywhere and do NOT mask the sea: ocean
        // anchors carry height 0, so the field falls to zero across the shore on
        // its own. Masking would put a cliff at the coastline instead of a beach.
        private void PaintUpheavalMap(IMapRegion region, int regionX, int regionZ)
        {
            var map = region?.UpheavelMap;   // VS spells it "Upheavel"
            if (map?.Data == null)
            {
                sapi.Logger.Warning("[IWRW] region ({0},{1}): UpheavelMap is null — nothing painted", regionX, regionZ);
                return;
            }

            int size = map.Size, pad = map.TopLeftPadding;
            PaintUpheaval(Pipeline, map.Data, size, pad, regionX, regionZ);

            if (Log.Debug && (regionsPainted <= 3 || regionsPainted % 256 == 0))
            {
                int hMin = 255, hMax = 0; long hSum = 0;
                for (int i = 0; i < map.Data.Length; i++)
                {
                    int v = map.Data[i];
                    hSum += v;
                    if (v < hMin) hMin = v;
                    if (v > hMax) hMax = v;
                }
                Log.Dbg($"[IWRW] [verify] region #{regionsPainted} ({regionX},{regionZ}) upheaval: size={size} pad={pad} " +
                        $"height {hMin}..{hMax} mean {hSum / (double)map.Data.Length:F1}");
            }
        }

        public static void PaintUpheaval(WorldgenPipeline p, int[] data, int size, int pad, int regionX, int regionZ)
        {
            int inner = size - 2 * pad;
            var mesh = p.Mesh;
            var height = p.Upheaval.AnchorHeight;

            for (int pz = 0; pz < size; pz++)
            {
                int gz = regionZ * inner - pad + pz;
                for (int px = 0; px < size; px++)
                {
                    int gx = regionX * inner - pad + px;
                    int v = (int)WorldgenMath.Round(mesh.SampleScalar(gx, gz, height));
                    if (v < 0) v = 0; else if (v > 255) v = 255;
                    data[pz * size + px] = v;
                }
            }
        }

        // Climate map: three channels packed into one int per pixel —
        // temp<<16 | rain<<8 | geoActivity, each 0-255.
        //
        // The temperature byte is NOT degrees: VS maps 0-255 onto roughly
        // -20..+40 C at read time via Climate.GetScaledAdjustedTemperature, and
        // that call also applies altitude cooling from the column's distance above
        // sea level. Our climate model deliberately has no elevation term — the
        // lapse rate is the game's job, and adding our own would double-count it.
        private void PaintClimateMap(IMapRegion region, int regionX, int regionZ)
        {
            var map = region?.ClimateMap;
            if (map?.Data == null)
            {
                sapi.Logger.Warning("[IWRW] region ({0},{1}): ClimateMap is null — nothing painted", regionX, regionZ);
                return;
            }

            PaintClimate(Pipeline, map.Data, map.Size, map.TopLeftPadding, regionX, regionZ);

            if (Log.Debug && (regionsPainted <= 3 || regionsPainted % 256 == 0))
            {
                int tMin = 255, tMax = 0, rMin = 255, rMax = 0, gMax = 0;
                for (int i = 0; i < map.Data.Length; i++)
                {
                    int c = map.Data[i];
                    int t = (c >> 16) & 0xFF, r = (c >> 8) & 0xFF, g = c & 0xFF;
                    if (t < tMin) tMin = t; if (t > tMax) tMax = t;
                    if (r < rMin) rMin = r; if (r > rMax) rMax = r;
                    if (g > gMax) gMax = g;
                }
                Log.Dbg($"[IWRW] [verify] region #{regionsPainted} ({regionX},{regionZ}) climate: " +
                        $"size={map.Size} pad={map.TopLeftPadding} temp {tMin}..{tMax} rain {rMin}..{rMax} geo max {gMax}");
            }
        }

        public static void PaintClimate(WorldgenPipeline p, int[] data, int size, int pad, int regionX, int regionZ)
        {
            int inner = size - 2 * pad;
            var mesh = p.Mesh;
            var temp = p.Climate.AnchorTemp;
            var rain = p.Climate.AnchorRain;
            var geo = p.Climate.AnchorGeo;

            for (int pz = 0; pz < size; pz++)
            {
                int gz = regionZ * inner - pad + pz;
                for (int px = 0; px < size; px++)
                {
                    int gx = regionX * inner - pad + px;
                    var w = mesh.SampleAt(gx, gz);   // one face lookup for all three
                    int t = Chan(w.W0 * temp[w.I0] + w.W1 * temp[w.I1] + w.W2 * temp[w.I2]);
                    int r = Chan(w.W0 * rain[w.I0] + w.W1 * rain[w.I1] + w.W2 * rain[w.I2]);
                    int g = Chan(w.W0 * geo[w.I0] + w.W1 * geo[w.I1] + w.W2 * geo[w.I2]);
                    data[pz * size + px] = (t << 16) | (r << 8) | g;
                }
            }
        }

        // Geologic province map: an INDEX into geologicprovinces.json, which sets
        // how thick each rock group is in the column — so exporting ours makes rock
        // follow our tectonics (granite-cored shields, volcanic rock along active
        // boundaries, thick sediment in basins).
        //
        // Verified against the shipped asset: VS's order is shield, platform,
        // orogen, basin, largeIgneousprovince, extendedcrust — identical to our six
        // constants, so the value maps across 1:1 with no translation.
        //
        // Two differences from the other maps. It is HALF our resolution (64 blk/px
        // vs 32), so a province pixel steps two of ours. And the value is a
        // CATEGORY: it is read at the sample point, never interpolated — blending
        // province 1 and 3 into 2 would invent an orogen between a platform and a
        // basin. VS does its own smoothing of the thickness budgets downstream.
        private void PaintProvinceMap(IMapRegion region, int regionX, int regionZ)
        {
            var map = region?.GeologicProvinceMap;
            if (map?.Data == null)
            {
                sapi.Logger.Warning("[IWRW] region ({0},{1}): GeologicProvinceMap is null — nothing painted", regionX, regionZ);
                return;
            }

            PaintProvince(Pipeline, map.Data, map.Size, map.TopLeftPadding, regionX, regionZ);

            if (Log.Debug && (regionsPainted <= 3 || regionsPainted % 256 == 0))
            {
                var counts = new int[6];
                int bad = 0;
                for (int i = 0; i < map.Data.Length; i++)
                {
                    int v = map.Data[i];
                    if (v >= 0 && v < 6) counts[v]++; else bad++;
                }
                Log.Dbg($"[IWRW] [verify] region #{regionsPainted} ({regionX},{regionZ}) province: " +
                        $"size={map.Size} pad={map.TopLeftPadding} shield={counts[0]} platform={counts[1]} " +
                        $"orogen={counts[2]} basin={counts[3]} lip={counts[4]} extcrust={counts[5]} out-of-range={bad}");
            }
        }

        public static void PaintProvince(WorldgenPipeline p, int[] data, int size, int pad, int regionX, int regionZ)
        {
            int inner = size - 2 * pad;
            var prov = p.Provinces;

            for (int pz = 0; pz < size; pz++)
            {
                int gz = regionZ * inner - pad + pz;
                int oz = gz * 2;                        // 64 blk/px -> our 32 blk/px
                for (int px = 0; px < size; px++)
                {
                    int gx = regionX * inner - pad + px;
                    // Detailed (emergent-coastline) signal — the same land signal the
                    // ocean map uses. Computed per pixel: 196 lookups per region,
                    // instead of baking 2.56M at world init.
                    data[pz * size + px] = prov.DetailedAt(gx * 2, oz);
                }
            }
        }

        private static int Chan(double v)
        {
            int b = (int)WorldgenMath.Round(v);
            return b < 0 ? 0 : (b > 255 ? 255 : b);
        }

        // Pure painting logic, separated from the VS types so the parity harness can
        // exercise the exact code the game runs (seam agreement, coordinate mapping,
        // value ranges) without a running server.
        public static void PaintOcean(WorldgenPipeline p, int[] data, int size, int pad, int regionX, int regionZ)
        {
            int inner = size - 2 * pad;
            var mesh = p.Mesh;
            var coast = p.Coast;
            var upheaval = p.Upheaval;

            for (int pz = 0; pz < size; pz++)
            {
                // Region pixel → our global pixel coordinate (both 32 blk/px).
                int gz = regionZ * inner - pad + pz;
                for (int px = 0; px < size; px++)
                {
                    int gx = regionX * inner - pad + px;

                    int v;
                    if (coast.IsLandAt(gx, gz))
                    {
                        v = 0;
                    }
                    else
                    {
                        // The depth law owns this: interpolated lattice bathymetry
                        // with the per-pixel coastal shelf as its floor, so water
                        // narrower than the lattice still gets a real seabed.
                        v = upheaval.DepthByteAt(mesh, gx, gz);
                        // An ocean pixel must never read back as 0 — that means land.
                        if (v < 1) v = 1; else if (v > 255) v = 255;
                    }
                    data[pz * size + px] = v;
                }
            }
        }
    }
}
