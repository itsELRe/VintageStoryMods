using System;
using System.Globalization;
using Vintagestory.API.Common;
using Vintagestory.API.Server;
using RealisticWorlds.Features;

namespace RealisticWorlds
{
    /// <summary>
    /// Core mod entry point. Loads config, initializes the FeatureNetwork, and wires
    /// up world generation. Runs at ExecuteOrder 0.05 so the registry is ready before
    /// addons register their feature types.
    /// </summary>
    public class RealisticWorldsMod : ModSystem
    {
        private ICoreServerAPI api;
        private string modConfigPath;
        private FeatureNetwork featureNetwork;

        public static CoreConfig Config { get; private set; }

        public override double ExecuteOrder() => 0.05;
        public override bool ShouldLoad(EnumAppSide forSide) => forSide == EnumAppSide.Server;

        public override void StartServerSide(ICoreServerAPI api)
        {
            this.api = api;

            LoadConfig();
            FeatureRegistry.Initialize(api);
            featureNetwork = new FeatureNetwork(api);

            // InitWorldGenerator fires after all addons call StartServerSide,
            // so all feature types are registered by the time we merge + initialize.
            api.Event.InitWorldGenerator(() =>
            {
                MergeRegisteredFeatures();
                featureNetwork.Initialize();
                FeatureRegistry.SetNetwork(featureNetwork);
            }, "standard");

            api.Logger.Notification("[IWRWCore] Core mod loaded");
        }

        public override void Dispose()
        {
            FeatureSpawnRegistry.Clear();
            FeatureRegistry.Clear();
            base.Dispose();
        }

        /// <summary>
        /// Loads config from ModConfig (user-editable) with fallback to bundled assets.
        /// </summary>
        private void LoadConfig()
        {
            try
            {
                modConfigPath = System.IO.Path.Combine(
                    api.GetOrCreateDataPath("ModConfig"),
                    "IWantRealisticWorlds",
                    "core.json");

                string json = null;

                if (System.IO.File.Exists(modConfigPath))
                {
                    json = System.IO.File.ReadAllText(modConfigPath);
                }
                else
                {
                    var asset = api.Assets.Get(new AssetLocation("iwrw:config/core.json"));
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
                        Config = new CoreConfig();
                        return;
                    }
                }

                if (json != null)
                {
                    // Strip // comments before parsing
                    json = System.Text.RegularExpressions.Regex.Replace(
                        json, @"//.*$", "", System.Text.RegularExpressions.RegexOptions.Multiline);

                    var j = Vintagestory.API.Datastructures.JsonObject.FromJson(json);

                    Config = new CoreConfig
                    {
                        GlobalHeightLimit = j["globalHeightLimit"].AsFloat(0.88f),
                        FootprintScaleMultiplier = j["footprintScaleMultiplier"].AsFloat(1.0f),
                        GlobalLandformDensity = j["globalLandformDensity"].AsInt(50),
                        PlateSize = j["plateSize"].AsInt(8000),
                        ZoneSize = j["zoneSize"].AsInt(512),
                        SearchRadius = j["searchRadius"].AsInt(1500),
                        DebugLogging = j["debugLogging"].AsBool(false)
                    };

                    // Parse feature weights via reflection (JsonObject doesn't expose keys directly)
                    var weightsObj = j["featureWeights"];
                    if (weightsObj != null && weightsObj.Exists)
                    {
                        var token = weightsObj.Token;
                        if (token != null)
                        {
                            var propertiesMethod = token.GetType().GetMethod("Properties");
                            if (propertiesMethod != null)
                            {
                                var properties = propertiesMethod.Invoke(token, null) as System.Collections.IEnumerable;
                                if (properties != null)
                                {
                                    foreach (var prop in properties)
                                    {
                                        var nameProp = prop.GetType().GetProperty("Name");
                                        if (nameProp != null)
                                        {
                                            string key = nameProp.GetValue(prop) as string;
                                            if (key != null)
                                                Config.FeatureWeights[key] = weightsObj[key].AsInt(1);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                else
                {
                    Config = new CoreConfig();
                }
            }
            catch (Exception ex)
            {
                api.Logger.Error($"[IWRWCore] Config error: {ex.Message}");
                Config = new CoreConfig();
            }
        }

        /// <summary>
        /// Adds newly registered feature types to config with default weights.
        /// Preserves user edits to existing entries.
        /// </summary>
        private void MergeRegisteredFeatures()
        {
            var registered = FeatureSpawnRegistry.GetAllRegistered();
            bool changed = false;

            foreach (var kvp in registered)
            {
                if (!Config.FeatureWeights.ContainsKey(kvp.Key))
                {
                    Config.FeatureWeights[kvp.Key] = kvp.Value.DefaultWeight;
                    changed = true;
                    api.Logger.Notification($"[IWRWCore] New feature type: '{kvp.Key}' (weight {kvp.Value.DefaultWeight})");
                }
            }

            if (changed) SaveConfig();
        }

        private void SaveConfig()
        {
            try
            {
                var sb = new System.Text.StringBuilder();
                sb.AppendLine("{");
                sb.AppendLine($"  \"globalHeightLimit\": {Config.GlobalHeightLimit.ToString(CultureInfo.InvariantCulture)},");
                sb.AppendLine($"  \"footprintScaleMultiplier\": {Config.FootprintScaleMultiplier.ToString(CultureInfo.InvariantCulture)},");
                sb.AppendLine($"  \"globalLandformDensity\": {Config.GlobalLandformDensity},");
                sb.AppendLine();
                sb.AppendLine("  // Plate = generation unit. Zone = one feature per zone max.");
                sb.AppendLine($"  \"plateSize\": {Config.PlateSize},");
                sb.AppendLine($"  \"zoneSize\": {Config.ZoneSize},");
                sb.AppendLine($"  \"searchRadius\": {Config.SearchRadius},");
                sb.AppendLine();
                sb.AppendLine("  // Relative spawn weights. Auto-populated when addons register.");
                sb.AppendLine("  \"featureWeights\": {");

                int count = 0;
                foreach (var kvp in Config.FeatureWeights)
                {
                    count++;
                    string comma = count < Config.FeatureWeights.Count ? "," : "";
                    sb.AppendLine($"    \"{kvp.Key}\": {kvp.Value}{comma}");
                }

                sb.AppendLine("  },");
                sb.AppendLine();
                sb.AppendLine($"  \"debugLogging\": {(Config.DebugLogging ? "true" : "false")}");
                sb.AppendLine("}");

                System.IO.File.WriteAllText(modConfigPath, sb.ToString());
            }
            catch (Exception ex)
            {
                api.Logger.Error($"[IWRWCore] Config save error: {ex.Message}");
            }
        }
    }
}
