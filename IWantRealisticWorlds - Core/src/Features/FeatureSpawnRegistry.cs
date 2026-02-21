using System.Collections.Generic;

namespace RealisticWorlds.Features
{
    public enum FeaturePlacement { Land, Ocean, Anywhere }

    /// <summary>
    /// Climate range for spawn filtering (0-255 matching VS climate map range).
    /// Default range (0-255) = no restriction.
    /// </summary>
    public class ClimateRange
    {
        public int MinTemp = 0, MaxTemp = 255;
        public int MinRain = 0, MaxRain = 255;

        public bool Accepts(int temperature, int rainfall)
            => temperature >= MinTemp && temperature <= MaxTemp
            && rainfall >= MinRain && rainfall <= MaxRain;
    }

    /// <summary>Metadata for a registered feature type.</summary>
    public class FeatureRegistration
    {
        public string Name;
        public IFeatureFactory Factory;
        public int DefaultWeight;
        public FeaturePlacement Placement;
        public ClimateRange Climate = new ClimateRange();
        /// <summary>Skip bounding-box overlap check (for composites that blend naturally).</summary>
        public bool SkipOverlapCheck;
        /// <summary>Min center-to-center distance between same-type features (0 = no check).</summary>
        public double MinSameTypeDistance;
        /// <summary>Min distance from any other feature type (0 = only bounding box overlap check).</summary>
        public double MinAnyTypeDistance;
    }

    /// <summary>
    /// Central registry for feature types. Addons register here during StartServerSide.
    /// Core reads this during plate generation to pick feature types.
    /// </summary>
    public static class FeatureSpawnRegistry
    {
        private static Dictionary<string, FeatureRegistration> registered
            = new Dictionary<string, FeatureRegistration>();

        public static void Register(
            string name,
            IFeatureFactory factory,
            int defaultWeight,
            FeaturePlacement placement = FeaturePlacement.Land,
            ClimateRange climate = null,
            bool skipOverlapCheck = false,
            double minSameTypeDistance = 0,
            double minAnyTypeDistance = 0)
        {
            if (registered.ContainsKey(name)) return;

            registered[name] = new FeatureRegistration
            {
                Name = name,
                Factory = factory,
                DefaultWeight = defaultWeight,
                Placement = placement,
                Climate = climate ?? new ClimateRange(),
                SkipOverlapCheck = skipOverlapCheck,
                MinSameTypeDistance = minSameTypeDistance,
                MinAnyTypeDistance = minAnyTypeDistance
            };
        }

        public static Dictionary<string, FeatureRegistration> GetAllRegistered()
            => new Dictionary<string, FeatureRegistration>(registered);

        public static FeatureRegistration GetRegistration(string name)
            => registered.TryGetValue(name, out var reg) ? reg : null;

        public static void Clear() => registered.Clear();
    }
}
