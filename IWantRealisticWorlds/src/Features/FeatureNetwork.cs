using System;
using System.Collections.Generic;
using Vintagestory.API.Common;
using Vintagestory.API.Datastructures;
using Vintagestory.API.MathTools;
using Vintagestory.API.Server;
using Vintagestory.API.Util;

namespace RealisticWorlds.Features
{
    /// <summary>
    /// Centralized spawning system. Divides the world into plates, each plate into
    /// zones. One feature per zone max. Plates are lazily generated and cached.
    /// </summary>
    public class FeatureNetwork
    {
        private ICoreServerAPI sapi;
        private int worldSeed;
        private int mapSizeX;
        private int mapSizeZ;
        private int regionSize;
        private bool initialized;

        // Cached OceanMap data from MapRegions, keyed by (regionX, regionZ).
        // Populated on demand as chunks are generated.
        private Dictionary<long, IntDataMap2D> oceanMapCache = new Dictionary<long, IntDataMap2D>();

        public FeatureNetwork(ICoreServerAPI api)
        {
            sapi = api;
        }

        public void Initialize()
        {
            worldSeed = sapi.WorldManager.Seed;
            mapSizeX = sapi.WorldManager.MapSizeX;
            mapSizeZ = sapi.WorldManager.MapSizeZ;
            regionSize = sapi.WorldManager.RegionSize;
            initialized = true;
            sapi.Logger.Notification("[IWRWCore] FeatureNetwork initialized (regionSize={0})", regionSize);

            // Pre-cache OceanMap as each region is generated (GenMaps phase).
            sapi.Event.MapRegionGeneration(OnMapRegionGenerated, "standard");
        }

        private void OnMapRegionGenerated(IMapRegion mapRegion, int regionX, int regionZ, ITreeAttribute chunkGenParams)
        {
            CacheRegion(mapRegion, regionX, regionZ);
        }

        /// <summary>
        /// Cache a MapRegion's OceanMap for ocean detection during plate generation.
        /// Called by CustomGenTerra before querying features, and by the MapRegionGeneration event.
        /// </summary>
        public void CacheRegion(IMapRegion region, int regionX, int regionZ)
        {
            long key = ((long)regionX << 32) | (uint)regionZ;
            if (oceanMapCache.ContainsKey(key)) return;

            var oceanMap = region.OceanMap;
            if (oceanMap == null) return;

            oceanMapCache[key] = oceanMap;

            if (RealisticWorldsMod.Config.DebugLogging)
            {
                int pad = oceanMap.TopLeftPadding;
                int inner = oceanMap.InnerSize;
                int centerIdx = (pad + inner / 2) * oceanMap.Size + pad + inner / 2;
                sapi.Logger.Debug(
                    "[IWRWCore] OceanMap cached region ({0},{1}): Size={2} Inner={3} Pad={4} centerVal={5}",
                    regionX, regionZ, oceanMap.Size, inner, pad, oceanMap.Data[centerIdx]);
            }
        }

        /// <summary>
        /// Returns all features whose bounding box falls within searchRadius of the chunk.
        /// Lazily generates plates as needed.
        /// </summary>
        public List<IFeature> QueryFeaturesNearChunk(int chunkX, int chunkZ)
        {
            if (!initialized) return new List<IFeature>();

            int searchRadius = RealisticWorldsMod.Config.SearchRadius;
            int plateSize = RealisticWorldsMod.Config.PlateSize;

            double cx = chunkX * 32 + 16;
            double cz = chunkZ * 32 + 16;

            int minPX = (int)Math.Floor((cx - searchRadius) / plateSize);
            int maxPX = (int)Math.Floor((cx + searchRadius) / plateSize);
            int minPZ = (int)Math.Floor((cz - searchRadius) / plateSize);
            int maxPZ = (int)Math.Floor((cz + searchRadius) / plateSize);

            var nearby = new List<IFeature>();

            for (int px = minPX; px <= maxPX; px++)
            {
                for (int pz = minPZ; pz <= maxPZ; pz++)
                {
                    var plate = GetOrCreatePlate(px, pz);

                    foreach (var feature in plate)
                    {
                        var min = feature.GetMinBounds();
                        var max = feature.GetMaxBounds();

                        if (cx + searchRadius >= min.X && cx - searchRadius <= max.X &&
                            cz + searchRadius >= min.Z && cz - searchRadius <= max.Z)
                        {
                            nearby.Add(feature);
                        }
                    }
                }
            }

            return nearby;
        }

        private List<IFeature> GetOrCreatePlate(int plateX, int plateZ)
        {
            string cacheKey = $"iwrw_plate_{plateX}_{plateZ}";
            return ObjectCacheUtil.GetOrCreate(sapi, cacheKey, () => GeneratePlate(plateX, plateZ));
        }

        // Spawned feature center + type name, used for distance checks within a plate.
        private struct SpawnedInfo
        {
            public double X, Z;
            public string TypeName;
        }

        /// <summary>
        /// Generates all features for one plate. Each zone rolls density, picks a
        /// weighted type, checks placement/climate/overlap/distance, then calls the factory.
        /// </summary>
        private List<IFeature> GeneratePlate(int plateX, int plateZ)
        {
            var config = RealisticWorldsMod.Config;
            var features = new List<IFeature>();
            var weights = config.FeatureWeights;
            if (weights.Count == 0) return features;

            int plateSize = config.PlateSize;
            int zoneSize = config.ZoneSize;
            int zonesPerPlate = plateSize / zoneSize;
            bool debug = config.DebugLogging;

            var rand = new LCGRandom(worldSeed);
            rand.InitPositionSeed(plateX, plateZ);

            // Track spawned positions for distance checks
            var spawnedPositions = new List<SpawnedInfo>();

            int spawned = 0, skippedOverlap = 0, skippedClimate = 0;
            int skippedPlacement = 0, skippedDistance = 0;

            for (int zx = 0; zx < zonesPerPlate; zx++)
            {
                for (int zz = 0; zz < zonesPerPlate; zz++)
                {
                    // Density roll — skip this zone?
                    if (rand.NextInt(100) >= config.GlobalLandformDensity)
                        continue;

                    string typeName = WeightedPick(rand, weights);
                    if (typeName == null) continue;

                    var reg = FeatureSpawnRegistry.GetRegistration(typeName);
                    if (reg == null || reg.Factory == null) continue;

                    // Zone center in world coords
                    double worldX = (plateX * plateSize) + (zx * zoneSize) + (zoneSize / 2.0);
                    double worldZ = (plateZ * plateSize) + (zz * zoneSize) + (zoneSize / 2.0);

                    // Placement check: land vs ocean
                    if (reg.Placement != FeaturePlacement.Anywhere)
                    {
                        bool isOcean = IsOcean(worldX, worldZ);
                        if (reg.Placement == FeaturePlacement.Land && isOcean)
                        {
                            skippedPlacement++;
                            continue;
                        }
                        if (reg.Placement == FeaturePlacement.Ocean && !isOcean)
                        {
                            skippedPlacement++;
                            continue;
                        }
                    }

                    // Climate filter
                    var (temp, rain) = EstimateClimate(worldZ, rand);
                    if (!reg.Climate.Accepts(temp, rain))
                    {
                        skippedClimate++;
                        continue;
                    }

                    // Jitter within zone
                    worldX += rand.NextInt(zoneSize) - (zoneSize / 2);
                    worldZ += rand.NextInt(zoneSize) - (zoneSize / 2);
                    int featureSeed = rand.NextInt(int.MaxValue);

                    // Distance checks (same-type and any-type)
                    if (reg.MinSameTypeDistance > 0 || reg.MinAnyTypeDistance > 0)
                    {
                        if (CheckDistanceViolation(worldX, worldZ, typeName, reg, spawnedPositions))
                        {
                            skippedDistance++;
                            continue;
                        }
                    }

                    var feature = reg.Factory.CreateFeature(worldX, worldZ, new Random(featureSeed));
                    if (feature == null) continue;

                    // Overlap check (skippable for composites that blend naturally)
                    if (!reg.SkipOverlapCheck && CheckOverlap(feature, features))
                    {
                        skippedOverlap++;
                        continue;
                    }

                    features.Add(feature);
                    spawnedPositions.Add(new SpawnedInfo { X = worldX, Z = worldZ, TypeName = typeName });
                    spawned++;
                }
            }

            if (debug)
                sapi.Logger.Debug($"[IWRWCore] Plate ({plateX},{plateZ}): {spawned} features ({skippedOverlap} overlap, {skippedClimate} climate, {skippedPlacement} placement, {skippedDistance} distance)");

            return features;
        }

        /// <summary>
        /// Check if a candidate position violates same-type or any-type distance constraints.
        /// </summary>
        private bool CheckDistanceViolation(double worldX, double worldZ, string typeName,
            FeatureRegistration reg, List<SpawnedInfo> spawnedPositions)
        {
            double sameDistSq = reg.MinSameTypeDistance * reg.MinSameTypeDistance;
            double anyDistSq = reg.MinAnyTypeDistance * reg.MinAnyTypeDistance;

            foreach (var sp in spawnedPositions)
            {
                double dx = worldX - sp.X;
                double dz = worldZ - sp.Z;
                double distSq = dx * dx + dz * dz;

                if (reg.MinSameTypeDistance > 0 && sp.TypeName == typeName && distSq < sameDistSq)
                    return true;

                if (reg.MinAnyTypeDistance > 0 && distSq < anyDistSq)
                    return true;
            }

            return false;
        }

        /// <summary>
        /// Read actual OceanMap value at a world position.
        /// Returns true if the position is ocean.
        /// Falls back to edge-distance estimate if region not cached yet.
        /// </summary>
        private bool IsOcean(double worldX, double worldZ)
        {
            if (regionSize <= 0) return false;

            int regionX = (int)Math.Floor(worldX / regionSize);
            int regionZ = (int)Math.Floor(worldZ / regionSize);
            long key = ((long)regionX << 32) | (uint)regionZ;

            if (!oceanMapCache.TryGetValue(key, out var oceanMap))
                return FallbackIsOcean(worldX, worldZ);

            int inner = oceanMap.InnerSize;
            if (inner <= 0) return false;

            double localX = (worldX - regionX * regionSize) / regionSize;
            double localZ = (worldZ - regionZ * regionSize) / regionSize;
            int mapX = oceanMap.TopLeftPadding + (int)(localX * inner);
            int mapZ = oceanMap.TopLeftPadding + (int)(localZ * inner);

            mapX = Math.Max(0, Math.Min(mapX, oceanMap.Size - 1));
            mapZ = Math.Max(0, Math.Min(mapZ, oceanMap.Size - 1));

            int value = oceanMap.Data[mapZ * oceanMap.Size + mapX];

            // VS OceanMap: 0 = land, 255 = deep ocean. Threshold at 127.
            return value > 127;
        }

        // Simple fallback: positions far from map center are likely ocean
        private bool FallbackIsOcean(double worldX, double worldZ)
        {
            double halfX = mapSizeX / 2.0;
            double halfZ = mapSizeZ / 2.0;
            if (halfX <= 0 || halfZ <= 0) return false;

            double dx = Math.Abs(worldX - halfX) / halfX;
            double dz = Math.Abs(worldZ - halfZ) / halfZ;
            return Math.Max(dx, dz) > 0.85;
        }

        /// <summary>
        /// Rough climate estimate from latitude + noise. Used for spawn filtering only.
        /// </summary>
        private (int temp, int rain) EstimateClimate(double worldZ, LCGRandom rand)
        {
            double halfMap = mapSizeZ / 2.0;
            double lat = halfMap > 0 ? Math.Abs(worldZ - halfMap) / halfMap : 0.5;
            int temp = Math.Max(0, Math.Min(255, (int)((1.0 - lat) * 255)));
            int rain = Math.Max(0, Math.Min(255, 100 + rand.NextInt(100)));
            return (temp, rain);
        }

        private string WeightedPick(LCGRandom rand, Dictionary<string, int> weights)
        {
            int total = 0;
            foreach (var w in weights.Values) total += w;
            if (total == 0) return null;

            int roll = rand.NextInt(total);
            int cum = 0;
            foreach (var kvp in weights)
            {
                cum += kvp.Value;
                if (roll < cum) return kvp.Key;
            }
            return null;
        }

        private bool CheckOverlap(IFeature candidate, List<IFeature> existing)
        {
            var cMin = candidate.GetMinBounds();
            var cMax = candidate.GetMaxBounds();

            foreach (var other in existing)
            {
                var oMin = other.GetMinBounds();
                var oMax = other.GetMaxBounds();
                if (cMin.X <= oMax.X && cMax.X >= oMin.X &&
                    cMin.Z <= oMax.Z && cMax.Z >= oMin.Z)
                    return true;
            }
            return false;
        }
    }
}
