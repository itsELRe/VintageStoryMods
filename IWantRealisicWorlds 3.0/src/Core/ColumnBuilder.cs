using System;
using Vintagestory.API.Common;
using Vintagestory.API.Server;
using Vintagestory.ServerMods;
using Vintagestory.ServerMods.NoObf;
using IWantRealisticWorlds.Worldgen;

namespace IWantRealisticWorlds.Core
{
    // Sole author of land height. For every LAND column it reads the upheaval byte
    // smoothed across the chunk (cubic B-spline over a 4x4 block of map pixels —
    // see the interpolation section below), converts it to an altitude, and writes
    // the column outright: rock up to that height, air above, both height maps.
    //
    // There is exactly ONE surface path. The kernel is not configurable and there is
    // no bilinear fallback — a base surface with alternative shapes would mean the
    // features built on it could not assume what they sit on.
    //
    // Deliberately NO micro-variation: a pure smooth surface. With zero noise the
    // in-game world must match the visualiser, so any bump or step we see is a bug
    // rather than a texture. Roughness is added later as a feature pass, on purpose.
    //
    // ExecuteOrder 0.05 — AFTER vanilla GenTerra (0) so we overwrite a finished
    // column, and BEFORE GenRockStrataNew (0.1) so our rock gets stratified. v2 ran
    // at 0.14, after strata had already gone, so everything it built stayed
    // unstratified default stone. See docs/column_builder_design.md §2.
    //
    // Contract we owe the passes that follow (design doc §3, all silent failures):
    //   * solid cells must be EXACTLY gcfg.defaultRockId, or rock strata skips them
    //   * the block at WorldGenTerrainHeightMap must be stone, or block layers
    //     skips the whole column — no soil, no grass
    //   * RainHeightMap is where block layers starts scanning DOWNWARD
    //   * water lives in the fluid layer, never the block array
    //
    // Ocean columns are left exactly as vanilla built them: the ocean map we paint
    // already carries our real bathymetry, so the sea floor follows our depth field
    // for free. Owning the seabed is a later decision (design doc §6).
    public class ColumnBuilder : ModSystem
    {
        private const int CHUNK_SIZE = 32;

        private ICoreServerAPI sapi;
        private int worldHeight, seaLevel, regionChunkSize;
        private int rockBlockId, saltWaterBlockId;
        private double oceanicityFac;
        private bool initialized;
        private int chunksBuilt;

        public override double ExecuteOrder() => 0.05;
        public override bool ShouldLoad(EnumAppSide side) => side == EnumAppSide.Server;

        public override void StartServerSide(ICoreServerAPI api)
        {
            sapi = api;

            api.Event.InitWorldGenerator(() =>
            {
                worldHeight = api.WorldManager.MapSizeY;
                seaLevel = TerraGenConfig.seaLevel;
                regionChunkSize = api.WorldManager.RegionSize / CHUNK_SIZE;

                var gc = api.Assets.Get<GlobalConfig>(new AssetLocation("game:worldgen/global.json"));
                rockBlockId = api.World.GetBlock(gc.defaultRockCode)?.BlockId ?? 0;
                saltWaterBlockId = api.World.GetBlock(gc.saltWaterBlockCode)?.BlockId ?? 0;

                // Vanilla's own ocean-byte → blocks conversion (GenTerra line 327).
                // We reuse it so the depth the map advertises is the depth we cut:
                // marine life is gated on this value, so coral at 12-60 really does
                // land 5-25 blocks down.
                oceanicityFac = worldHeight / 256.0 * 0.33333;

                chunksBuilt = 0;
                initialized = rockBlockId != 0 && saltWaterBlockId != 0;
                if (!initialized)
                    api.Logger.Error("[IWRW] ColumnBuilder: could not resolve rock ({0}) or salt water ({1}) — terrain NOT built",
                        rockBlockId, saltWaterBlockId);
                else
                    api.Logger.Notification(
                        "[IWRW] ColumnBuilder ready: worldHeight={0}, seaLevel={1}, regionChunkSize={2}, rockId={3}, waterId={4}, oceanicityFac={5:F4}",
                        worldHeight, seaLevel, regionChunkSize, rockBlockId, saltWaterBlockId, oceanicityFac);
            }, "standard");

            api.Event.ChunkColumnGeneration(OnChunkColumnGen, EnumWorldGenPass.Terrain, "standard");
        }

        // Byte 0 = sea level, 255 = world height. Linear — v3 decoupled height from
        // provinces, so there is no tier/anchor table any more.
        public static int AltitudeForByte(double b, int seaLevel, int worldHeight)
        {
            double a = seaLevel + b / 255.0 * (worldHeight - seaLevel);
            int y = (int)WorldgenMath.Round(a);
            if (y < 1) y = 1; else if (y > worldHeight - 1) y = worldHeight - 1;
            return y;
        }

        private void OnChunkColumnGen(IChunkColumnGenerateRequest request)
        {
            if (!initialized) return;

            var chunks = request.Chunks;
            int chunkX = request.ChunkX, chunkZ = request.ChunkZ;
            var mapChunk = chunks[0].MapChunk;
            var terrainHeightMap = mapChunk.WorldGenTerrainHeightMap;
            var rainHeightMap = mapChunk.RainHeightMap;
            var region = mapChunk.MapRegion;
            if (region == null) return;

            // Both maps are one pixel per chunk, so the 4x4 block of pixels around
            // this chunk is what shapes the surface across it. The outer ring comes
            // out of the region map's own padding — nothing is generated ahead — and
            // neighbouring chunks read the same pixels, which is what makes the
            // surface continuous in value AND slope across every chunk edge.
            Span<double> uS = stackalloc double[16];
            Span<double> oS = stackalloc double[16];
            if (!Stencil16(region.UpheavelMap, chunkX, chunkZ, uS)) return;
            bool haveOcean = Stencil16(region.OceanMap, chunkX, chunkZ, oS);

            const float d = 1.0f / CHUNK_SIZE;
            int land = 0, sea = 0, hMin = int.MaxValue, hMax = 0, deepest = 0;

            for (int lz = 0; lz < CHUNK_SIZE; lz++)
            {
                for (int lx = 0; lx < CHUNK_SIZE; lx++)
                {
                    int mapIdx = lz * CHUNK_SIZE + lx;
                    int vanillaHeight = terrainHeightMap[mapIdx];

                    // The ocean byte decides, by its own definition: 0 is land, 1 is
                    // the shallowest water. Round the smoothed value to a byte first,
                    // so the shoreline ramps into the water naturally, then convert
                    // with vanilla's own factor.
                    //
                    // This byte does double duty — continuous depth AND the land/sea
                    // gate — so smoothing it also softens a categorical edge. Known
                    // and measured; see design doc §3.7.
                    //
                    // NOTE: no minimum depth. A byte of 1 converts to 0.4 blocks and
                    // rounds away, so water that shallow still builds as land — that
                    // is the honest symptom of depth having no data in narrow seas,
                    // and it gets fixed in the depth law (a coastline-derived term),
                    // not by flooring it here.
                    int oceanByte = haveOcean
                        ? (int)WorldgenMath.Round(SampleSurface(oS, lx * d, lz * d))
                        : 0;
                    int depth = (int)WorldgenMath.Round(oceanByte * oceanicityFac);

                    if (depth > 0)
                    {
                        // Sea column: cut the bed, fill to sea level. We own this
                        // outright now — vanilla's landforms only pushed terrain DOWN
                        // by this many blocks, which left anything taller standing out
                        // of the water.
                        int bed = seaLevel - depth;
                        if (bed < 1) bed = 1;
                        WriteColumn(chunks, lx, lz, bed, vanillaHeight, fillWaterTo: seaLevel - 1);

                        terrainHeightMap[mapIdx] = (ushort)bed;          // seafloor, per IMapChunk's contract
                        rainHeightMap[mapIdx] = (ushort)(seaLevel - 1);  // water surface
                        sea++;
                        if (depth > deepest) deepest = depth;
                    }
                    else
                    {
                        double upheavalByte = SampleSurface(uS, lx * d, lz * d);
                        int height = AltitudeForByte(upheavalByte, seaLevel, worldHeight);

                        WriteColumn(chunks, lx, lz, height, vanillaHeight, fillWaterTo: -1);

                        terrainHeightMap[mapIdx] = (ushort)height;
                        rainHeightMap[mapIdx] = (ushort)height;   // land sits at or above sea level
                        land++;
                        if (height < hMin) hMin = height;
                        if (height > hMax) hMax = height;
                    }
                }
            }

            // YMax must cover the whole chunk, including the sea columns we left alone.
            ushort yMax = 0;
            for (int i = 0; i < rainHeightMap.Length; i++) if (rainHeightMap[i] > yMax) yMax = rainHeightMap[i];
            mapChunk.YMax = yMax;

            chunksBuilt++;
            if (Log.Debug && (chunksBuilt <= 5 || chunksBuilt % 512 == 0))
            {
                // Stencil slots 5/6/9/10 are this chunk's own corner pixels; the rest
                // of the 16 are the surrounding ring that shapes the curve.
                Log.Dbg($"[IWRW] [verify] chunk #{chunksBuilt} ({chunkX},{chunkZ}): upheaval corners " +
                        $"{uS[5]}/{uS[6]}/{uS[9]}/{uS[10]}, " +
                        $"ocean {(haveOcean ? $"{oS[5]}/{oS[6]}/{oS[9]}/{oS[10]}" : "n/a")} — " +
                        $"{land} land (y {(land > 0 ? hMin : 0)}..{hMax}), {sea} sea (deepest {deepest} blocks), YMax={yMax}");
            }
        }

        // Own the column outright: rock from bedrock to `height`, then air — or
        // water up to `fillWaterTo` when this is a sea column. We rewrite up to the
        // taller of our height, vanilla's, and the water line, which also clears any
        // overhang or air pocket vanilla's 3D noise left behind.
        private void WriteColumn(IServerChunk[] chunks, int lx, int lz, int height, int vanillaHeight, int fillWaterTo)
        {
            int yTop = Math.Max(Math.Max(height, vanillaHeight), fillWaterTo);
            if (yTop >= worldHeight) yTop = worldHeight - 1;

            for (int y = 1; y <= yTop; y++)
            {
                int cy = y / CHUNK_SIZE;
                if (cy >= chunks.Length) break;
                int idx = ((y % CHUNK_SIZE) * CHUNK_SIZE + lz) * CHUNK_SIZE + lx;
                var data = chunks[cy].Data;

                if (y <= height)
                {
                    data[idx] = rockBlockId;      // must be exactly defaultRockId for strata
                    data.SetFluid(idx, 0);
                }
                else
                {
                    data[idx] = 0;
                    // Water lives in the fluid layer only, never the block array.
                    data.SetFluid(idx, y <= fillWaterTo ? saltWaterBlockId : 0);
                }
            }
        }

        // ===== Surface interpolation: cubic B-spline over a 4x4 stencil =====
        //
        // Our maps are one pixel per 32-block chunk, so the kernel that blends those
        // pixels IS the shape of the terrain. Two properties decide it, in order:
        //
        // 1. NO RINGING — the reason this kernel was changed (2026-07-27). The
        //    previous Catmull-Rom fit passed exactly through every pixel value, and
        //    paid for it with two NEGATIVE weights in its 4-tap kernel. A negative
        //    weight means a neighbour pushes the surface the WRONG way: every local
        //    high dug a shallow trench one pixel out and every local low raised a rim
        //    around itself. In game that read as 1-block pits (which then filled as
        //    tiny lakes) and 1-block mounds, in parallel lines, exactly 32 blocks
        //    apart. The B-spline's four weights are all NON-NEGATIVE and sum to 1, so
        //    every sample is a weighted average of the 16 stencil pixels and can
        //    never leave their min..max range. Ringing is impossible by construction,
        //    not merely reduced.
        //
        // 2. CONTINUOUS SLOPE ACROSS CHUNKS. Plain bilinear agrees with the next
        //    chunk on the shared VALUES but not on the SLOPE, so contours kink at
        //    every chunk edge — the diagonal staircase. This surface is C2: value,
        //    slope and curvature all match at every seam, over the whole map.
        //
        // THE PRICE, ACCEPTED DELIBERATELY: a non-negative kernel APPROXIMATES rather
        // than interpolates. The surface no longer passes exactly through the pixel
        // values — an isolated one-pixel spike keeps only (4/6)^2 = 44% of its
        // prominence, while anything spanning several pixels is essentially
        // untouched — and extremes are gently rounded off. That is the very same
        // property that removes the ringing; the two cannot be separated. The base
        // is meant to be a smooth sinuous blanket to build features on, so roughness
        // belongs in a later FEATURE pass, never in this kernel.
        //
        // Still separable (X then Z), so a lone raised pixel resolves as a slightly
        // diamond-ish cone rather than a perfectly circular one. If that bias shows
        // in game the next step is a radial kernel over the 9 surrounding pixels.

        // The 4x4 block of map pixels around this chunk: its own two corner pixels
        // per axis plus one further ring, taken from the region map's padding
        // (upheaval 3, ocean 5 — both ample). Both maps are 32 blk/px with
        // InnerSize == regionChunkSize, i.e. exactly one pixel per chunk.
        private bool Stencil16(Vintagestory.API.Datastructures.IntDataMap2D map, int chunkX, int chunkZ, Span<double> s)
        {
            if (map == null || regionChunkSize <= 0) return false;

            int rlX = chunkX % regionChunkSize, rlZ = chunkZ % regionChunkSize;
            if (rlX < 0) rlX += regionChunkSize;
            if (rlZ < 0) rlZ += regionChunkSize;

            float fac = (float)map.InnerSize / regionChunkSize;
            int bx = (int)(rlX * fac), bz = (int)(rlZ * fac);
            int step = Math.Max(1, (int)fac);

            for (int j = 0; j < 4; j++)
                for (int i = 0; i < 4; i++)
                    s[j * 4 + i] = map.GetUnpaddedInt(bx + (i - 1) * step, bz + (j - 1) * step);
            return true;
        }

        // Uniform cubic B-spline basis over p0..p3, t in [0,1) spanning p1 to p2.
        // Every weight stays in [0, 4/6] for any t in that range and the four sum to
        // exactly 1 — that is the whole point, so do not "simplify" these back into
        // the Catmull-Rom form.
        internal static double BSpline(double p0, double p1, double p2, double p3, double t)
        {
            double t2 = t * t, t3 = t2 * t;
            double w0 = 1 - 3 * t + 3 * t2 - t3;        // (1-t)^3
            double w1 = 4 - 6 * t2 + 3 * t3;
            double w2 = 1 + 3 * t + 3 * t2 - 3 * t3;
            double w3 = t3;
            return (w0 * p0 + w1 * p1 + w2 * p2 + w3 * p3) / 6.0;
        }

        // Sample the 4x4 stencil at (fx, fz), both in [0,1) across the chunk. Needs
        // no range clamp: a weighted average of bytes with non-negative weights that
        // sum to 1 is already inside 0..255.
        //
        // internal, not private, so the offline harness verifies THIS function rather
        // than a copy of it (same reason AltitudeForByte is public).
        internal static double SampleSurface(ReadOnlySpan<double> s, double fx, double fz)
        {
            double r0 = BSpline(s[0], s[1], s[2], s[3], fx);
            double r1 = BSpline(s[4], s[5], s[6], s[7], fx);
            double r2 = BSpline(s[8], s[9], s[10], s[11], fx);
            double r3 = BSpline(s[12], s[13], s[14], s[15], fx);
            return BSpline(r0, r1, r2, r3, fz);
        }
    }
}
