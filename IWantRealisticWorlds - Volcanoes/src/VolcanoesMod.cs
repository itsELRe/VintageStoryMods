using Vintagestory.API.Common;
using Vintagestory.API.Server;
using RealisticWorlds.Features;

namespace RealisticWorlds.Volcanoes
{
    /// <summary>
    /// Volcano addon entry point. Registers the volcano factory with core's spawning system.
    /// </summary>
    public class VolcanoesMod : ModSystem
    {
        public override double ExecuteOrder() => 0.2;
        public override bool ShouldLoad(EnumAppSide side) => side == EnumAppSide.Server;

        public override void StartServerSide(ICoreServerAPI api)
        {
            var factory = new VolcanoFactory(api);
            FeatureSpawnRegistry.Register("volcanoes", factory, defaultWeight: 5);
            api.Logger.Notification("[IWRWVolcanoes] Registered volcano factory (weight: 5)");
        }
    }
}
