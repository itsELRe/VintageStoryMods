namespace RealisticWorlds.Ridges
{
    /// <summary>
    /// Ridge generation config. Loaded from ModConfig/IWantRealisticWorlds/ridges.json.
    /// All parameters match the HTML prototype (tools/noise_mountains.html) 1:1.
    /// Each parameter has Min/Max variants — set min = max for a fixed value.
    /// </summary>
    public class RidgeConfig
    {
        // Attractors
        public int AttractorCountMin { get; set; } = 500;
        public int AttractorCountMax { get; set; } = 500;
        public int CloudWidthMin { get; set; } = 1000;
        public int CloudWidthMax { get; set; } = 1000;
        public int CloudHeightMin { get; set; } = 1000;
        public int CloudHeightMax { get; set; } = 1000;

        // Seeds
        public int SeedCountMin { get; set; } = 5;
        public int SeedCountMax { get; set; } = 5;
        public int SeedMinDistMin { get; set; } = 300;
        public int SeedMinDistMax { get; set; } = 300;
        public int SeedBorderMin { get; set; } = 100;
        public int SeedBorderMax { get; set; } = 100;
        public int MaxSpreadMin { get; set; } = 300;
        public int MaxSpreadMax { get; set; } = 300;

        // Growth
        public int StepSizeMin { get; set; } = 40;
        public int StepSizeMax { get; set; } = 40;
        public int KillDistMin { get; set; } = 25;
        public int KillDistMax { get; set; } = 25;
        public int InfluenceRadiusMin { get; set; } = 150;
        public int InfluenceRadiusMax { get; set; } = 150;
        public int MaxIterMin { get; set; } = 250;
        public int MaxIterMax { get; set; } = 250;
        public float WobbleMin { get; set; } = 0.36f;
        public float WobbleMax { get; set; } = 0.36f;
        public float OutwardBiasMin { get; set; } = 0.95f;
        public float OutwardBiasMax { get; set; } = 0.95f;
        public float CoherenceThresholdMin { get; set; } = 0.65f;
        public float CoherenceThresholdMax { get; set; } = 0.65f;

        // Shaping
        public int MinBranchLenMin { get; set; } = 3;
        public int MinBranchLenMax { get; set; } = 3;
        public int ChainSmoothMin { get; set; } = 3;
        public int ChainSmoothMax { get; set; } = 3;
        public int RidgeSmoothMin { get; set; } = 3;
        public int RidgeSmoothMax { get; set; } = 3;

        // Height (peakHeight as fraction of world height, e.g. 0.47 = 47%)
        public float PeakHeightMin { get; set; } = 0.47f;
        public float PeakHeightMax { get; set; } = 0.47f;
        public float LocalConeMin { get; set; } = 0.75f;
        public float LocalConeMax { get; set; } = 0.75f;
        public float GlobalConeMin { get; set; } = 0.15f;
        public float GlobalConeMax { get; set; } = 0.15f;

        // Terrain
        public int FalloffDistMin { get; set; } = 125;
        public int FalloffDistMax { get; set; } = 125;
        public float RidgeWidthMin { get; set; } = 0.80f;
        public float RidgeWidthMax { get; set; } = 0.80f;
        public float DrainageBiasMin { get; set; } = 0.50f;
        public float DrainageBiasMax { get; set; } = 0.50f;
        public int SmoothPassesMin { get; set; } = 5;
        public int SmoothPassesMax { get; set; } = 5;

        // Noise (logFalloff: 0 = linear slope, 0.5 = gentle base, 1+ = very gentle)
        public float LogFalloffMin { get; set; } = 0.20f;
        public float LogFalloffMax { get; set; } = 0.20f;
        public float FalloffNoiseMin { get; set; } = 0.26f;
        public float FalloffNoiseMax { get; set; } = 0.26f;
        public float FalloffNoiseScaleMin { get; set; } = 60f;
        public float FalloffNoiseScaleMax { get; set; } = 60f;
        public int FalloffNoiseOctMin { get; set; } = 3;
        public int FalloffNoiseOctMax { get; set; } = 3;
        public int FalloffSmoothMin { get; set; } = 5;
        public int FalloffSmoothMax { get; set; } = 5;
        public float PlateauCutMin { get; set; } = 0.00f;
        public float PlateauCutMax { get; set; } = 0.00f;
    }
}
