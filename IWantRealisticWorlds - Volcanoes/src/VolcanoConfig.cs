using System.Collections.Generic;

namespace RealisticWorlds.Volcanoes
{
    /// <summary>
    /// Volcano generation config. Loaded from ModConfig/IWantRealisticWorlds/volcanoes.json.
    /// </summary>
    public class VolcanoConfig
    {
        // Dimensions
        public int RadiusMin { get; set; } = 240;
        public int RadiusMax { get; set; } = 270;
        public float HeightMultiplierMin { get; set; } = 0.7f;
        public float HeightMultiplierMax { get; set; } = 1.0f;

        // Shape profile weights (convex = classic cone, scurve = smooth neck)
        public Dictionary<string, int> ShapeProfileWeights { get; set; } = new Dictionary<string, int>
        {
            { "convex", 70 },
            { "scurve", 30 }
        };

        // Vent (crater) at peak
        public bool VentsEnabled { get; set; } = true;
        public float VentRadiusMin { get; set; } = 0.10f;
        public float VentRadiusMax { get; set; } = 0.15f;
        public float VentDepthMin { get; set; } = 0.05f;
        public float VentDepthMax { get; set; } = 0.13f;

        // Footprint irregularity (non-circular base via 2D noise)
        public bool IrregularityEnabled { get; set; } = true;
        public float IrregularityStrengthMin { get; set; } = 0.10f;
        public float IrregularityStrengthMax { get; set; } = 0.20f;
    }
}
