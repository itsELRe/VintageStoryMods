using System.Collections.Generic;

namespace RealisticWorlds
{
    /// <summary>Core mod configuration. Loaded from ModConfig/IWantRealisticWorlds/core.json.</summary>
    public class CoreConfig
    {
        /// <summary>Height cap as fraction of world height. 0.88 = Y225 in a 256-high world.</summary>
        public float GlobalHeightLimit { get; set; } = 0.88f;

        /// <summary>Scales feature footprint area (not radius). 2.0 = 200% area = ~1.41x wider.</summary>
        public float FootprintScaleMultiplier { get; set; } = 1.0f;

        /// <summary>% of zones that spawn a feature. 50 = half of all zones.</summary>
        public int GlobalLandformDensity { get; set; } = 50;

        /// <summary>Relative spawn weights per feature type. Auto-populated by addons.</summary>
        public Dictionary<string, int> FeatureWeights { get; set; } = new Dictionary<string, int>();

        /// <summary>Generation unit size in blocks.</summary>
        public int PlateSize { get; set; } = 8000;

        /// <summary>One feature per zone max, in blocks.</summary>
        public int ZoneSize { get; set; } = 512;

        /// <summary>How far to search for features during chunk gen. Must cover max feature extent.</summary>
        public int SearchRadius { get; set; } = 1500;

        public bool DebugLogging { get; set; } = false;
    }
}
