using System;
using Vintagestory.API.Common;
using Vintagestory.API.Server;
using Vintagestory.ServerMods;
using Vintagestory.ServerMods.NoObf;
using RealisticWorlds.Features;

namespace RealisticWorlds
{
    /// <summary>
    /// Delta-mode terrain handler. Runs AFTER vanilla GenTerra in the same pass.
    /// Reads GenTerra's heightmap, then for each feature-controlled column:
    ///   - Builds up (adds rock above vanilla surface), or
    ///   - Carves down (clears blocks, fills water below sea level).
    ///
    /// Two-phase blending:
    ///   Phase 1 — Absolute features compete (MAX wins), overriding vanilla.
    ///   Phase 2 — Relative offsets apply on top. Positive (MAX among builders)
    ///             and negative (MIN among carvers) combine additively.
    /// </summary>
    public class CustomGenTerra : ModSystem
    {
        private ICoreServerAPI sapi;
        private int mapSizeY;
        private int seaLevel;
        private int rockBlockId;
        private int waterBlockId;
        private bool initialized;

        public override double ExecuteOrder() => 0.1;
        public override bool ShouldLoad(EnumAppSide side) => side == EnumAppSide.Server;

        public override void StartServerSide(ICoreServerAPI api)
        {
            sapi = api;
            api.Event.InitWorldGenerator(InitWorldGen, "standard");
            api.Event.ChunkColumnGeneration(OnChunkColumnGen, EnumWorldGenPass.Terrain, "standard");
        }

        private void InitWorldGen()
        {
            mapSizeY = sapi.WorldManager.MapSizeY;
            seaLevel = TerraGenConfig.seaLevel;
            initialized = true;
            sapi.Logger.Notification("[IWRWCore] CustomGenTerra initialized (delta mode)");
        }

        // Block IDs aren't available during InitWorldGen — resolve on first use.
        private void LoadBlockIds()
        {
            var gc = sapi.Assets.Get<GlobalConfig>(new AssetLocation("game:worldgen/global.json"));
            rockBlockId = sapi.World.GetBlock(gc.defaultRockCode).BlockId;
            waterBlockId = sapi.World.GetBlock(new AssetLocation("water-still-7")).BlockId;
        }

        private void OnChunkColumnGen(IChunkColumnGenerateRequest request)
        {
            if (!initialized) return;
            if (rockBlockId == 0) LoadBlockIds();

            var chunks = request.Chunks;
            int chunkX = request.ChunkX;
            int chunkZ = request.ChunkZ;

            // Cache this chunk's MapRegion OceanMap before feature queries.
            // Plates are generated lazily — they need OceanMap for placement checks.
            var mapRegion = chunks[0].MapChunk.MapRegion;
            int regionSize = sapi.WorldManager.RegionSize;
            FeatureRegistry.CacheRegion(mapRegion,
                chunkX * 32 / regionSize, chunkZ * 32 / regionSize);

            var features = FeatureRegistry.QueryFeaturesNearChunk(chunkX, chunkZ);
            if (features.Count == 0) return;

            var mapChunk = chunks[0].MapChunk;
            var terrainHeightMap = mapChunk.WorldGenTerrainHeightMap;
            var rainHeightMap = mapChunk.RainHeightMap;
            int peakHeight = mapSizeY - 1;

            for (int lz = 0; lz < 32; lz++)
            {
                for (int lx = 0; lx < 32; lx++)
                {
                    double worldX = chunkX * 32 + lx;
                    double worldZ = chunkZ * 32 + lz;
                    int mapIdx = lz * 32 + lx;
                    int vanillaHeight = terrainHeightMap[mapIdx];

                    // Two-phase blending.
                    // Phase 1: Absolute features compete — MAX wins.
                    // Phase 2: Relative offsets apply on top of resolved base.
                    int bestAbsolute = -1;
                    ILayeredFeature winnerLayered = null;
                    int bestRelativeUp = 0;
                    int bestRelativeDown = 0;

                    foreach (var f in features)
                    {
                        HeightOutput? ho = f.GetDirectHeight(worldX, worldZ, vanillaHeight, peakHeight);
                        if (ho == null) continue;
                        var val = ho.Value;

                        if (val.IsRelative)
                        {
                            if (val.Height > 0 && val.Height > bestRelativeUp)
                                bestRelativeUp = val.Height;
                            else if (val.Height < 0 && val.Height < bestRelativeDown)
                                bestRelativeDown = val.Height;
                        }
                        else
                        {
                            if (val.Height > bestAbsolute)
                            {
                                bestAbsolute = val.Height;
                                winnerLayered = f as ILayeredFeature;
                            }
                        }
                    }

                    bool hasAbsolute = bestAbsolute >= 0;
                    bool hasRelative = bestRelativeUp > 0 || bestRelativeDown < 0;
                    if (!hasAbsolute && !hasRelative) continue;

                    // Resolve: absolute overrides vanilla, then relative offsets stack.
                    int featureHeight = hasAbsolute ? bestAbsolute : vanillaHeight;
                    featureHeight += bestRelativeUp + bestRelativeDown;

                    if (featureHeight >= mapSizeY) featureHeight = mapSizeY - 1;
                    if (featureHeight < 1) featureHeight = 1;

                    if (featureHeight > vanillaHeight)
                    {
                        // BUILD UP: fill rock above vanilla surface
                        for (int y = vanillaHeight + 1; y <= featureHeight; y++)
                        {
                            int cy = y / 32;
                            if (cy >= chunks.Length) break;
                            int idx = ((y % 32) * 32 + lz) * 32 + lx;
                            chunks[cy].Data[idx] = rockBlockId;
                            chunks[cy].Data.SetFluid(idx, 0);
                        }
                    }
                    else if (featureHeight < vanillaHeight)
                    {
                        // CARVE DOWN: clear blocks above feature surface.
                        // Layered features: suppress auto water — Phase 1 places
                        // feature-requested water below, giving full control.
                        // Non-layered: fill ocean water below seaLevel as before.
                        for (int y = featureHeight + 1; y <= vanillaHeight; y++)
                        {
                            int cy = y / 32;
                            if (cy >= chunks.Length) break;
                            int idx = ((y % 32) * 32 + lz) * 32 + lx;
                            chunks[cy].Data[idx] = 0;
                            chunks[cy].Data.SetFluid(idx,
                                (winnerLayered == null && y < seaLevel) ? waterBlockId : 0);
                        }
                    }

                    // Phase 1 water: place feature-requested water layers.
                    // This runs in the Terrain pass so GenBlockLayers sees water
                    // and generates gravel/sand under water surfaces naturally.
                    // Both Data[idx] (solid) and SetFluid() must be set:
                    //   Data[idx] = waterBlockId  → minimap reads this, GenBlockLayers
                    //     detects water here for beach/gravel placement.
                    //   SetFluid(idx, waterBlockId) → fluid simulation layer for
                    //     water flow, rendering, and gameplay interaction.
                    int waterTopY = -1;
                    if (winnerLayered != null)
                    {
                        var layers = winnerLayered.GetColumnLayers(
                            worldX, worldZ, featureHeight, peakHeight);
                        if (layers != null)
                        {
                            for (int li = 0; li < layers.Length; li++)
                            {
                                if (layers[li].BlockType != ColumnBlockType.Water) continue;
                                int topY = Math.Min(layers[li].TopY, peakHeight);
                                for (int y = featureHeight + 1; y <= topY; y++)
                                {
                                    int cy = y / 32;
                                    if (cy >= chunks.Length) break;
                                    int idx = ((y % 32) * 32 + lz) * 32 + lx;
                                    chunks[cy].Data[idx] = waterBlockId;
                                    chunks[cy].Data.SetFluid(idx, waterBlockId);
                                }
                                if (topY > waterTopY) waterTopY = topY;
                            }
                        }
                    }

                    terrainHeightMap[mapIdx] = (ushort)featureHeight;

                    if (waterTopY > featureHeight)
                    {
                        // Layered feature water (lakes): point to the actual water
                        // surface so the minimap samples the water block there.
                        rainHeightMap[mapIdx] = (ushort)waterTopY;
                    }
                    else
                    {
                        // No feature water. Non-layered carves below sea level
                        // auto-fill ocean water (via SetFluid) up to seaLevel-1.
                        rainHeightMap[mapIdx] = (ushort)(
                            featureHeight >= seaLevel ? featureHeight : seaLevel - 1);
                    }
                }
            }

            // Recalculate YMax from modified heightmap
            ushort yMax = 0;
            for (int i = 0; i < rainHeightMap.Length; i++)
                yMax = Math.Max(yMax, rainHeightMap[i]);
            mapChunk.YMax = yMax;
        }
    }
}
