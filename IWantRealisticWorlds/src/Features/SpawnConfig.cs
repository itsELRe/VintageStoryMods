using System;

namespace RealisticWorlds.Features
{
    /// <summary>
    /// Factory for creating features during zone-based spawning.
    /// Core calls CreateFeature() once per zone with a deterministic Random.
    /// Return null to skip spawning.
    /// </summary>
    public interface IFeatureFactory
    {
        IFeature CreateFeature(double worldX, double worldZ, Random rand);
        double GetMinRadius();
        double GetMaxRadius();
    }
}
