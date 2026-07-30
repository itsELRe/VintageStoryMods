using Vintagestory.API.Common;
using Vintagestory.API.Server;

namespace IWantRealisticWorlds
{
    // Mod entry point. Server-side only — worldgen runs on the server.
    //
    // Deliberately does nothing but announce itself: the real work lives in
    // MapGenerators (ExecuteOrder 0.12 — builds the primitives at world init and
    // paints the region maps) and ColumnBuilder (0.05 — writes every land column),
    // each its own ModSystem so the load order is explicit rather than implied.
    public class ModEntry : ModSystem
    {
        public override bool ShouldLoad(EnumAppSide forSide) => forSide == EnumAppSide.Server;

        public override void StartServerSide(ICoreServerAPI api)
        {
            api.Logger.Notification("[IWRW] I Want Realistic Worlds loaded.");
        }
    }
}
