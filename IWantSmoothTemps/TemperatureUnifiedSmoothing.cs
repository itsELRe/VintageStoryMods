using System;
using Vintagestory.API.Client;
using Vintagestory.API.Common;
using Vintagestory.API.Datastructures;
using Vintagestory.API.MathTools;
using Vintagestory.API.Server;

namespace TemperatureUnifiedSmoothing
{
    public class ModConfig
    {
        // Feature toggles
        public bool EnableHorizontalSmoothing { get; set; } = true;
        public string EnableHorizontalSmoothingDescription { get; set; } = "Enable box blur smoothing of climate map during worldgen.";

        public bool EnableVerticalSmoothing { get; set; } = true;
        public string EnableVerticalSmoothingDescription { get; set; } = "Enable sigmoid curve for elevation temperature changes.";

        // Horizontal smoothing
        public int SmoothingPasses { get; set; } = 1;
        public string SmoothingPassesDescription { get; set; } = "How many times to apply the blur. More passes = smoother. 1-3 recommended.";

        // Vertical sigmoid
        public double SigmoidAmplitude { get; set; } = 12.0;
        public string SigmoidAmplitudeDescription { get; set; } = "Max temperature penalty at extreme heights in degrees C. Vanilla drops ~28C over 180 blocks. Examples: 12 = gentle (peaks 12C colder), 28 = vanilla-like, 35 = harsh arctic peaks.";

        public double SigmoidSteepness { get; set; } = 0.025;
        public string SigmoidSteepnessDescription { get; set; } = "How sharply temperature drops at mid-elevations (per raw block). Examples: 0.01 = very gentle curve, 0.025 = moderate (default), 0.05 = steep drop on small hills.";

        public double SigmoidInflection { get; set; } = 80.0;
        public string SigmoidInflectionDescription { get; set; } = "Blocks above sea level where cooling rate is steepest (inflection point). Examples: 40 = cooling kicks in early, 80 = mid-range (default), 120 = only tall mountains get steep cooling.";

        // Climate-aware
        public bool UseClimateAwareElevation { get; set; } = false;
        public string UseClimateAwareElevationDescription { get; set; } = "If true, hot biomes cool less on mountains (tropical peaks stay warmer), cold biomes cool more.";

        public double ClimateWeightFactor { get; set; } = 0.01;
        public string ClimateWeightFactorDescription { get; set; } = "Strength of climate-aware effect. Examples: 0.01 = subtle (20C base gets 15% less cooling), 0.03 = moderate, 0.05 = strong effect.";

        // Debug
        public bool EnableDebugLogging { get; set; } = false;
        public string EnableDebugLoggingDescription { get; set; } = "Log a sample temperature transformation every 5 seconds to help diagnose issues. Prints initial vs final temperature.";
    }

    public class TemperatureUnifiedSmoothingMod : ModSystem
    {
        private ICoreServerAPI sapi;
        private ICoreClientAPI capi;
        private ModConfig serverConfig;
        private ModConfig clientConfig;

        // Vanilla elevation penalty: 1 / (1.5 * 4.25) ≈ 0.157 °C per block above sea level
        private const float VanillaPenaltyPerBlock = 1f / (1.5f * 4.25f);

        // Throttle debug logging to one message per interval
        private long nextDebugLogTime;

        public override void StartServerSide(ICoreServerAPI api)
        {
            sapi = api;
            serverConfig = LoadConfigServer();

            if (serverConfig.EnableHorizontalSmoothing)
            {
                api.Event.MapRegionGeneration(OnMapRegionGenerated, "iwantsmoothtemperature");
            }

            if (serverConfig.EnableVerticalSmoothing)
            {
                api.Event.OnGetClimate += OnGetClimateServer;
            }

            sapi.Logger.Notification("[TempSmooth] Server initialized");
            sapi.Logger.Notification($"[TempSmooth] Horizontal smoothing: {(serverConfig.EnableHorizontalSmoothing ? "ON" : "OFF")}");
            sapi.Logger.Notification($"[TempSmooth] Vertical smoothing: {(serverConfig.EnableVerticalSmoothing ? "ON" : "OFF")}");

            if (serverConfig.EnableVerticalSmoothing)
            {
                sapi.Logger.Notification($"[TempSmooth] Sigmoid: amplitude={serverConfig.SigmoidAmplitude}, steepness={serverConfig.SigmoidSteepness}, inflection={serverConfig.SigmoidInflection}");
            }
            if (serverConfig.EnableHorizontalSmoothing)
            {
                sapi.Logger.Notification($"[TempSmooth] Horizontal: passes={serverConfig.SmoothingPasses}");
            }
            if (serverConfig.UseClimateAwareElevation)
            {
                sapi.Logger.Notification($"[TempSmooth] Climate-aware elevation: weight={serverConfig.ClimateWeightFactor}");
            }
            if (serverConfig.EnableDebugLogging)
            {
                sapi.Logger.Notification("[TempSmooth] Debug logging is ON (one sample every 5s)");
            }
        }

        public override void StartClientSide(ICoreClientAPI api)
        {
            capi = api;
            clientConfig = LoadConfigClient();

            if (clientConfig.EnableVerticalSmoothing)
            {
                api.Event.OnGetClimate += OnGetClimateClient;
            }

            capi.Logger.Notification("[TempSmooth] Client initialized");
        }

        private ModConfig LoadConfigServer()
        {
            ModConfig cfg;
            try
            {
                cfg = sapi.LoadModConfig<ModConfig>("IWantSmoothTemperature.json");
                if (cfg == null)
                {
                    cfg = new ModConfig();
                    sapi.Logger.Notification("[TempSmooth] Created default config file");
                }
                // Re-save to persist any new fields added in updates
                sapi.StoreModConfig(cfg, "IWantSmoothTemperature.json");
            }
            catch (Exception ex)
            {
                sapi.Logger.Warning($"[TempSmooth] Failed to load config, using defaults: {ex.Message}");
                cfg = new ModConfig();
            }
            return cfg;
        }

        private ModConfig LoadConfigClient()
        {
            ModConfig cfg;
            try
            {
                cfg = capi.LoadModConfig<ModConfig>("IWantSmoothTemperature.json");
                if (cfg == null)
                {
                    cfg = new ModConfig();
                }
            }
            catch (Exception ex)
            {
                capi.Logger.Warning($"[TempSmooth] Failed to load config on client, using defaults: {ex.Message}");
                cfg = new ModConfig();
            }
            return cfg;
        }

        // ==================== VERTICAL SMOOTHING ====================

        private void OnGetClimateServer(ref ClimateCondition climate, BlockPos pos, EnumGetClimateMode mode, double totalDays)
        {
            ApplyVerticalSmoothing(ref climate, pos, sapi.World.SeaLevel, serverConfig, mode, sapi.Logger);
        }

        private void OnGetClimateClient(ref ClimateCondition climate, BlockPos pos, EnumGetClimateMode mode, double totalDays)
        {
            ApplyVerticalSmoothing(ref climate, pos, capi.World.SeaLevel, clientConfig, mode, capi.Logger);
        }

        private void ApplyVerticalSmoothing(ref ClimateCondition climate, BlockPos pos, int seaLevel, ModConfig config, EnumGetClimateMode mode, ILogger logger)
        {
            if (climate == null || pos == null || config == null) return;

            int distToSealevel = pos.Y - seaLevel;

            // Only apply sigmoid cooling above sea level
            if (distToSealevel <= 0) return;

            float originalTemp = climate.Temperature;

            // Reverse vanilla's linear elevation penalty
            float vanillaPenalty = distToSealevel * VanillaPenaltyPerBlock;
            climate.Temperature += vanillaPenalty;

            // Apply sigmoid penalty
            double a = config.SigmoidAmplitude;
            double b = config.SigmoidSteepness;
            double c = config.SigmoidInflection;

            double offset = a / (1.0 + Math.Exp(b * c));
            double sigmoidPenalty = a / (1.0 + Math.Exp(-b * (distToSealevel - c))) - offset;

            if (config.UseClimateAwareElevation)
            {
                double climateModifier = 1.0 - (climate.Temperature - 5) * config.ClimateWeightFactor;
                climateModifier = Math.Max(0.5, Math.Min(1.5, climateModifier));
                sigmoidPenalty *= climateModifier;
            }

            climate.Temperature -= (float)Math.Max(0, sigmoidPenalty);

            if (config.EnableDebugLogging)
            {
                long now = Environment.TickCount64;
                if (now >= nextDebugLogTime)
                {
                    nextDebugLogTime = now + 5000;
                    logger.Debug($"[TempSmooth] pos=({pos.X},{pos.Y},{pos.Z}) height={distToSealevel} Initial temperature {originalTemp:F2} transformed into {climate.Temperature:F2}");
                }
            }
        }

        // ==================== HORIZONTAL SMOOTHING ====================

        private void OnMapRegionGenerated(IMapRegion mapRegion, int regionX, int regionZ, ITreeAttribute chunkGenParams)
        {
            if (serverConfig.SmoothingPasses <= 0) return;

            IntDataMap2D climateMap = mapRegion.ClimateMap;
            if (climateMap == null) return;

            // Radius capped to map padding so the kernel never reads out-of-bounds
            int radius = Math.Min(2, climateMap.TopLeftPadding);

            for (int pass = 0; pass < serverConfig.SmoothingPasses; pass++)
            {
                SmoothClimateMap(climateMap, radius);
            }
        }

        private void SmoothClimateMap(IntDataMap2D map, int radius)
        {
            int size = map.Size;
            int pad = map.TopLeftPadding;
            int[] original = new int[map.Data.Length];
            Array.Copy(map.Data, original, map.Data.Length);

            // Only write to core pixels; read from padding for the blur kernel
            for (int z = pad; z < size - pad; z++)
            {
                for (int x = pad; x < size - pad; x++)
                {
                    long sum = 0;
                    int count = 0;

                    for (int dz = -radius; dz <= radius; dz++)
                    {
                        for (int dx = -radius; dx <= radius; dx++)
                        {
                            int nx = x + dx;
                            int nz = z + dz;

                            if (nx >= 0 && nx < size && nz >= 0 && nz < size)
                            {
                                sum += original[nz * size + nx];
                                count++;
                            }
                        }
                    }

                    map.Data[z * size + x] = (int)(sum / count);
                }
            }
        }

        public override void Dispose()
        {
            if (sapi != null && serverConfig != null && serverConfig.EnableVerticalSmoothing)
            {
                sapi.Event.OnGetClimate -= OnGetClimateServer;
            }
            if (capi != null && clientConfig != null && clientConfig.EnableVerticalSmoothing)
            {
                capi.Event.OnGetClimate -= OnGetClimateClient;
            }
            base.Dispose();
        }
    }
}
