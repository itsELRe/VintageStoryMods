namespace RealisticWorlds.Lakes
{
    // Configuration for lake generation.
    // Loaded from assets/iwrw-lakes/config/lakes.json
    public class LakeConfig
    {
        // Water body radius range (blocks)
        public int RadiusMin { get; set; } = 60;
        public int RadiusMax { get; set; } = 180;

        // Shore depression width as fraction of water radius
        public float ShoreFraction { get; set; } = 0.4f;

        // Lake floor depth below water surface (blocks)
        public int DepthMin { get; set; } = 6;
        public int DepthMax { get; set; } = 20;

        // Water surface offset from sea level.
        // +20 = raised bowl 20 blocks above seaLevel (Phase 1 water fills it).
        // Negative = below seaLevel (game fills water naturally).
        public int WaterLevelOffset { get; set; } = 20;

        // Shoreline irregularity
        public float NoiseFrequency { get; set; } = 0.015f;
        public float NoiseStrength { get; set; } = 0.25f;
    }
}
