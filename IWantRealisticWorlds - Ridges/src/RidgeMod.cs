using Vintagestory.API.Common;
using Vintagestory.API.Server;
using RealisticWorlds.Features;

namespace RealisticWorlds.Ridges
{
    /// <summary>
    /// Ridge addon entry point. Registers the ridge factory with core's spawning system.
    /// Ridges skip overlap checks (they blend naturally) and enforce 1500-block same-type spacing.
    /// </summary>
    public class RidgeMod : ModSystem
    {
        public override double ExecuteOrder() => 0.2;
        public override bool ShouldLoad(EnumAppSide side) => side == EnumAppSide.Server;

        public override void StartServerSide(ICoreServerAPI api)
        {
            var factory = new RidgeFactory(api);
            FeatureSpawnRegistry.Register("ridges", factory,
                defaultWeight: 5,
                placement: FeaturePlacement.Anywhere,
                skipOverlapCheck: true,
                minSameTypeDistance: 1500);
            api.Logger.Notification("[IWRWRidges] Registered ridge factory (weight: 5)");
        }
    }
}
