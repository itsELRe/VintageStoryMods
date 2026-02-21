using System;
using Vintagestory.API.Common;
using Vintagestory.API.Datastructures;
using Vintagestory.API.Server;
using Vintagestory.ServerMods;
using RealisticWorlds.Features;

namespace RealisticWorlds
{
    /// <summary>
    /// Paints "land" on the OceanMap where features will exist.
    /// Runs during MapRegionGeneration, BEFORE GenTerra reads the map.
    /// This makes GenTerra generate land terrain (not ocean) at feature sites,
    /// so features build on a land baseline with natural beach transitions.
    /// </summary>
    public class OceanMapPainter : ModSystem
    {
        private ICoreServerAPI sapi;
        private int seaLevel;
        private int mapSizeY;

        // Extra land pixels beyond feature edges for beach transitions
        private const int BeachBufferBlocks = 32;

        public override double ExecuteOrder() => 0.1;
        public override bool ShouldLoad(EnumAppSide side) => side == EnumAppSide.Server;

        public override void StartServerSide(ICoreServerAPI api)
        {
            sapi = api;
            api.Event.InitWorldGenerator(InitWorldGen, "standard");
            api.Event.MapRegionGeneration(OnMapRegionGenerated, "standard");
        }

        private void InitWorldGen()
        {
            seaLevel = TerraGenConfig.seaLevel;
            mapSizeY = sapi.WorldManager.MapSizeY;
        }

        private void OnMapRegionGenerated(IMapRegion mapRegion, int regionX, int regionZ, ITreeAttribute chunkGenParams)
        {
            IntDataMap2D oceanMap = mapRegion.OceanMap;
            if (oceanMap == null) return;

            int centerChunkX = regionX * 16 + 8;
            int centerChunkZ = regionZ * 16 + 8;
            var features = FeatureRegistry.QueryFeaturesNearChunk(centerChunkX, centerChunkZ);
            if (features.Count == 0) return;

            int size = oceanMap.Size;
            int pad = oceanMap.TopLeftPadding;
            int noiseSize = size - 2 * pad;
            double mapScale = 512.0 / noiseSize;
            int peakHeight = mapSizeY - 1;

            // Pass 1: mark pixels covered by any feature (precise per-pixel, not bounding box)
            bool[] covered = new bool[size * size];
            bool anyHit = false;

            for (int pz = 0; pz < size; pz++)
            {
                for (int px = 0; px < size; px++)
                {
                    int idx = pz * size + px;
                    if (oceanMap.Data[idx] <= 1) continue; // Already land

                    double worldX = (regionX * noiseSize - pad + px) * mapScale;
                    double worldZ = (regionZ * noiseSize - pad + pz) * mapScale;

                    foreach (var feature in features)
                    {
                        if (feature.GetDirectHeight(worldX, worldZ, seaLevel, peakHeight) != null)
                        {
                            covered[idx] = true;
                            anyHit = true;
                            break;
                        }
                    }
                }
            }

            if (!anyHit) return;

            // Pass 2: paint land on covered pixels + buffer ring for beach transitions
            int bufferPixels = (int)Math.Ceiling(BeachBufferBlocks / mapScale);
            int painted = 0;

            for (int pz = 0; pz < size; pz++)
            {
                for (int px = 0; px < size; px++)
                {
                    int idx = pz * size + px;
                    if (oceanMap.Data[idx] <= 1) continue;

                    if (covered[idx])
                    {
                        oceanMap.Data[idx] = 0;
                        painted++;
                        continue;
                    }

                    // Buffer: check if any covered pixel is within range
                    bool nearFeature = false;
                    for (int dz = -bufferPixels; dz <= bufferPixels && !nearFeature; dz++)
                    {
                        for (int dx = -bufferPixels; dx <= bufferPixels && !nearFeature; dx++)
                        {
                            int nx = px + dx, nz = pz + dz;
                            if (nx >= 0 && nx < size && nz >= 0 && nz < size && covered[nz * size + nx])
                                nearFeature = true;
                        }
                    }

                    if (nearFeature)
                    {
                        oceanMap.Data[idx] = 0;
                        painted++;
                    }
                }
            }

            if (painted > 0 && RealisticWorldsMod.Config.DebugLogging)
                sapi.Logger.Debug($"[IWRWCore] OceanMapPainter region ({regionX},{regionZ}): painted {painted} pixels as land");
        }
    }
}
