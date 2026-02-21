using System.Collections.Generic;
using Vintagestory.API.Common;
using Vintagestory.API.Server;

namespace RealisticWorlds.Features
{
    /// <summary>
    /// Stable API facade over FeatureNetwork for spatial queries.
    /// All consumers (CustomGenTerra, OceanMapPainter) call through here.
    /// </summary>
    public static class FeatureRegistry
    {
        private static ICoreServerAPI sapi;
        private static FeatureNetwork network;
        private static bool initialized;

        public static void Initialize(ICoreServerAPI api)
        {
            sapi = api;
            initialized = true;
            sapi.Logger.Notification("[IWRWCore] FeatureRegistry initialized");
        }

        public static void SetNetwork(FeatureNetwork net) => network = net;

        public static List<IFeature> QueryFeaturesNearChunk(int chunkX, int chunkZ)
        {
            if (!initialized || network == null) return new List<IFeature>();
            return network.QueryFeaturesNearChunk(chunkX, chunkZ);
        }

        /// <summary>
        /// Cache a MapRegion's OceanMap for ocean detection.
        /// Called by CustomGenTerra before feature queries.
        /// </summary>
        public static void CacheRegion(IMapRegion region, int regionX, int regionZ)
        {
            if (network != null)
                network.CacheRegion(region, regionX, regionZ);
        }

        public static void Clear() => network = null;
    }
}
