using Vintagestory.API.MathTools;

namespace RealisticWorlds.Features
{
    // Height result from a feature. Can express absolute or relative intent.
    //
    // Absolute: "set terrain to this Y" (e.g. lake floor at Y=55, volcano peak at Y=180)
    // Relative: "add this offset to current terrain" (e.g. ridge adds +80, river cuts -20)
    //
    // The core resolves these in two phases:
    //   1. Absolute results compete (MAX wins), producing a resolved base height.
    //   2. Relative offsets apply on top of that base. Positive offsets (builders)
    //      take MAX among them, negative offsets (carvers) take MIN. Both apply
    //      additively, so a ridge (+80) and river (-20) at the same column = net +60.
    public struct HeightOutput
    {
        public int Height;
        public bool IsRelative;

        public static HeightOutput Absolute(int height)
            => new HeightOutput { Height = height, IsRelative = false };

        public static HeightOutput Relative(int offset)
            => new HeightOutput { Height = offset, IsRelative = true };
    }

    /// <summary>
    /// Contract for all terrain features. Reports height at any world position
    /// and a bounding box for spatial queries.
    /// </summary>
    public interface IFeature
    {
        /// <summary>
        /// Get terrain height at (worldX, worldZ).
        /// baseHeight = vanilla terrain at this column.
        /// peakHeight = global height cap.
        /// Returns a HeightOutput (absolute or relative), or null if outside this feature.
        /// </summary>
        HeightOutput? GetDirectHeight(double worldX, double worldZ, int baseHeight, int peakHeight);

        BlockPos GetMinBounds();
        BlockPos GetMaxBounds();
    }

    // Block types that features can place in column layers.
    // The core resolves these to actual block IDs at runtime.
    public enum ColumnBlockType
    {
        Water,
        Ice,
        Lava,
    }

    // A single layer in a column: place BlockType up to TopY.
    // Layers are ordered bottom-to-top. Phase 2 handler places them
    // after the terrain pass carves the bowl, so water fills correctly.
    public struct ColumnLayer
    {
        public ColumnBlockType BlockType;
        public int TopY;

        public ColumnLayer(ColumnBlockType type, int topY)
        {
            BlockType = type;
            TopY = topY;
        }
    }

    // Features that need non-rock blocks (water, ice, lava, etc.)
    // implement this alongside IFeature.
    //
    // Phase 1: GetDirectHeight carves/builds rock terrain.
    // Phase 2: GetColumnLayers places fluids above the rock surface.
    //
    // Existing features (ridges, volcanoes) only implement IFeature
    // and are completely unaffected by Phase 2.
    public interface ILayeredFeature : IFeature
    {
        // Returns layers to place above the rock surface, or null if
        // this column has no special layers (rock-only or outside feature).
        ColumnLayer[] GetColumnLayers(double worldX, double worldZ, int baseHeight, int peakHeight);
    }
}
