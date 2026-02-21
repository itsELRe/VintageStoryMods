using Vintagestory.API.Common;
using Vintagestory.API.Server;
using RealisticWorlds.Features;

namespace RealisticWorlds.Lakes
{
    // Lake addon entry point.
    // Creates LakeFactory and registers it with core's FeatureSpawnRegistry.
    // Core handles zone spawning, overlap, and terrain modification.
    public class LakesMod : ModSystem
    {
        private LakeFactory factory;

        public override double ExecuteOrder() => 0.2;

        public override bool ShouldLoad(EnumAppSide side) => side == EnumAppSide.Server;

        public override void StartServerSide(ICoreServerAPI api)
        {
            factory = new LakeFactory(api);
            FeatureSpawnRegistry.Register("lakes", factory,
                defaultWeight: 5,
                placement: FeaturePlacement.Land,
                climate: null,
                skipOverlapCheck: false,
                minSameTypeDistance: 600,
                minAnyTypeDistance: 0);

            // InitSeaLevel must run during InitWorldGenerator when TerraGenConfig is ready
            api.Event.InitWorldGenerator(() =>
            {
                factory.InitSeaLevel();
            }, "standard");

            api.Logger.Notification("[IWRWLakes] Registered lake factory (weight: 5, land only, 600 same-type distance)");
        }
    }
}
