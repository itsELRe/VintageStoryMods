using System;
using Vintagestory.API.Common;
using Vintagestory.API.Server;
using Vintagestory.ServerMods;
using RealisticWorlds.Features;

namespace RealisticWorlds.Lakes
{
    // Creates LakeFeature instances for core's FeatureNetwork.
    // Loads config from ModConfig/IWantRealisticWorlds/lakes.json (or asset defaults).
    // Core calls CreateFeature() per zone with a deterministic Random.
    public class LakeFactory : IFeatureFactory
    {
        private ICoreServerAPI sapi;
        private LakeConfig config;
        private int seaLevel;

        public LakeFactory(ICoreServerAPI api)
        {
            this.sapi = api;
            LoadConfig();
        }

        public void InitSeaLevel()
        {
            seaLevel = TerraGenConfig.seaLevel;
            sapi.Logger.Notification($"[IWRWLakes] seaLevel={seaLevel}");
        }

        public IFeature CreateFeature(double worldX, double worldZ, Random rand)
        {
            double innerRadius = config.RadiusMin +
                rand.NextDouble() * (config.RadiusMax - config.RadiusMin);
            double outerRadius = innerRadius * (1.0 + config.ShoreFraction);

            int depth = config.DepthMin +
                rand.Next(config.DepthMax - config.DepthMin + 1);

            int waterLevel = seaLevel + config.WaterLevelOffset;

            return new LakeFeature(
                worldX, worldZ,
                innerRadius, outerRadius,
                waterLevel, depth,
                config.NoiseFrequency, config.NoiseStrength
            );
        }

        public double GetMinRadius() => config.RadiusMin * (1.0 + config.ShoreFraction);
        public double GetMaxRadius() => config.RadiusMax * (1.0 + config.ShoreFraction) + 20;

        private void LoadConfig()
        {
            try
            {
                string modConfigPath = System.IO.Path.Combine(
                    sapi.GetOrCreateDataPath("ModConfig"),
                    "IWantRealisticWorlds",
                    "lakes.json"
                );

                string json = null;

                if (System.IO.File.Exists(modConfigPath))
                {
                    json = System.IO.File.ReadAllText(modConfigPath);
                }
                else
                {
                    // First run: copy bundled asset config to user config directory
                    var asset = sapi.Assets.Get(new AssetLocation("iwrw-lakes:config/lakes.json"));
                    if (asset != null)
                    {
                        json = asset.ToText();
                        string dir = System.IO.Path.GetDirectoryName(modConfigPath);
                        if (!System.IO.Directory.Exists(dir))
                            System.IO.Directory.CreateDirectory(dir);
                        System.IO.File.WriteAllText(modConfigPath, json);
                    }
                    else
                    {
                        config = new LakeConfig();
                        return;
                    }
                }

                if (json != null)
                {
                    json = System.Text.RegularExpressions.Regex.Replace(
                        json, @"//.*$", "", System.Text.RegularExpressions.RegexOptions.Multiline);

                    config = new LakeConfig();
                    var j = Vintagestory.API.Datastructures.JsonObject.FromJson(json);

                    config.RadiusMin = j["radiusMin"].AsInt(config.RadiusMin);
                    config.RadiusMax = j["radiusMax"].AsInt(config.RadiusMax);
                    config.ShoreFraction = j["shoreFraction"].AsFloat(config.ShoreFraction);
                    config.DepthMin = j["depthMin"].AsInt(config.DepthMin);
                    config.DepthMax = j["depthMax"].AsInt(config.DepthMax);
                    config.WaterLevelOffset = j["waterLevelOffset"].AsInt(config.WaterLevelOffset);
                    config.NoiseFrequency = j["noiseFrequency"].AsFloat(config.NoiseFrequency);
                    config.NoiseStrength = j["noiseStrength"].AsFloat(config.NoiseStrength);
                }
                else
                {
                    config = new LakeConfig();
                }
            }
            catch (Exception ex)
            {
                sapi.Logger.Error($"[IWRWLakes] Config error: {ex.Message}");
                config = new LakeConfig();
            }
        }
    }
}
