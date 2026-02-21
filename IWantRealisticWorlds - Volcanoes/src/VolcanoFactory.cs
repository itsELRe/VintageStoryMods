using System;
using Vintagestory.API.Common;
using Vintagestory.API.MathTools;
using Vintagestory.API.Server;
using RealisticWorlds;
using RealisticWorlds.Features;

namespace RealisticWorlds.Volcanoes
{
    /// <summary>
    /// Creates VolcanoFeature instances for core's zone-based spawning.
    /// Config loaded from ModConfig/IWantRealisticWorlds/volcanoes.json.
    /// </summary>
    public class VolcanoFactory : IFeatureFactory
    {
        private ICoreServerAPI sapi;
        private VolcanoConfig config;

        public VolcanoFactory(ICoreServerAPI api)
        {
            sapi = api;
            LoadConfig();
        }

        public IFeature CreateFeature(double worldX, double worldZ, Random rand)
        {
            // FootprintScaleMultiplier scales area, not radius: 2x area = radius * sqrt(2)
            double radius = (config.RadiusMin + rand.Next(config.RadiusMax - config.RadiusMin))
                * Math.Sqrt(RealisticWorldsMod.Config.FootprintScaleMultiplier);

            float heightMult = config.HeightMultiplierMin
                + (float)rand.NextDouble() * (config.HeightMultiplierMax - config.HeightMultiplierMin);

            float ventRadius = 0f, ventDepth = 0f;
            if (config.VentsEnabled)
            {
                ventRadius = config.VentRadiusMin + (float)rand.NextDouble() * (config.VentRadiusMax - config.VentRadiusMin);
                ventDepth = config.VentDepthMin + (float)rand.NextDouble() * (config.VentDepthMax - config.VentDepthMin);
            }

            float irregStrength = config.IrregularityEnabled
                ? config.IrregularityStrengthMin + (float)rand.NextDouble() * (config.IrregularityStrengthMax - config.IrregularityStrengthMin)
                : 0f;

            return new VolcanoFeature
            {
                Center = new Vec2d(worldX, worldZ),
                Radius = radius,
                HeightMultiplier = heightMult,
                ShapeProfile = SelectWeightedProfile(rand),
                Curvature = 1.0f + (float)rand.NextDouble() * 1.5f,
                VentRadius = ventRadius,
                VentDepth = ventDepth,
                IrregularityFrequency = 0.008f + (float)rand.NextDouble() * 0.006f,
                IrregularityStrength = irregStrength
            };
        }

        public double GetMinRadius() => config.RadiusMin * Math.Sqrt(RealisticWorldsMod.Config.FootprintScaleMultiplier);
        public double GetMaxRadius() => config.RadiusMax * Math.Sqrt(RealisticWorldsMod.Config.FootprintScaleMultiplier);

        private VolcanoShapeProfile SelectWeightedProfile(Random rand)
        {
            int total = 0;
            foreach (var w in config.ShapeProfileWeights.Values) total += w;
            if (total == 0) return VolcanoShapeProfile.Convex;

            int roll = rand.Next(total);
            int cum = 0;
            foreach (var entry in config.ShapeProfileWeights)
            {
                cum += entry.Value;
                if (roll < cum)
                {
                    return entry.Key.ToLower() switch
                    {
                        "convex" => VolcanoShapeProfile.Convex,
                        "scurve" => VolcanoShapeProfile.SCurve,
                        _ => VolcanoShapeProfile.Convex
                    };
                }
            }
            return VolcanoShapeProfile.Convex;
        }

        private void LoadConfig()
        {
            try
            {
                string modConfigPath = System.IO.Path.Combine(
                    sapi.GetOrCreateDataPath("ModConfig"),
                    "IWantRealisticWorlds",
                    "volcanoes.json");

                string json = null;

                if (System.IO.File.Exists(modConfigPath))
                {
                    json = System.IO.File.ReadAllText(modConfigPath);
                }
                else
                {
                    var asset = sapi.Assets.Get(new AssetLocation("iwrw-volcanoes:config/volcanoes.json"));
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
                        config = new VolcanoConfig();
                        return;
                    }
                }

                if (json != null)
                {
                    json = System.Text.RegularExpressions.Regex.Replace(
                        json, @"//.*$", "", System.Text.RegularExpressions.RegexOptions.Multiline);

                    config = new VolcanoConfig();
                    var j = Vintagestory.API.Datastructures.JsonObject.FromJson(json);

                    config.RadiusMin = j["radiusMin"].AsInt(config.RadiusMin);
                    config.RadiusMax = j["radiusMax"].AsInt(config.RadiusMax);
                    config.HeightMultiplierMin = j["heightMultiplierMin"].AsFloat(config.HeightMultiplierMin);
                    config.HeightMultiplierMax = j["heightMultiplierMax"].AsFloat(config.HeightMultiplierMax);
                    config.VentsEnabled = j["ventsEnabled"].AsBool(config.VentsEnabled);
                    config.VentRadiusMin = j["ventRadiusMin"].AsFloat(config.VentRadiusMin);
                    config.VentRadiusMax = j["ventRadiusMax"].AsFloat(config.VentRadiusMax);
                    config.VentDepthMin = j["ventDepthMin"].AsFloat(config.VentDepthMin);
                    config.VentDepthMax = j["ventDepthMax"].AsFloat(config.VentDepthMax);
                    config.IrregularityEnabled = j["irregularityEnabled"].AsBool(config.IrregularityEnabled);
                    config.IrregularityStrengthMin = j["irregularityStrengthMin"].AsFloat(config.IrregularityStrengthMin);
                    config.IrregularityStrengthMax = j["irregularityStrengthMax"].AsFloat(config.IrregularityStrengthMax);

                    var weightsObj = j["shapeProfileWeights"];
                    if (weightsObj != null && weightsObj.Exists)
                    {
                        var tempWeights = new System.Collections.Generic.Dictionary<string, int>();
                        if (weightsObj.KeyExists("convex"))
                            tempWeights["convex"] = weightsObj["convex"].AsInt(70);
                        if (weightsObj.KeyExists("scurve"))
                            tempWeights["scurve"] = weightsObj["scurve"].AsInt(30);
                        if (tempWeights.Count > 0)
                            config.ShapeProfileWeights = tempWeights;
                    }
                }
                else
                {
                    config = new VolcanoConfig();
                }
            }
            catch (Exception ex)
            {
                sapi.Logger.Error($"[IWRWVolcanoes] Config error: {ex.Message}");
                config = new VolcanoConfig();
            }
        }
    }
}
