using System;
using Vintagestory.API.MathTools;
using RealisticWorlds.Features;

namespace RealisticWorlds.Lakes
{
    // Bowl-shaped lake with water fill.
    //
    // Geometry:
    //   innerRadius = water body extent
    //   outerRadius = terrain slope (shore ramp)
    //   waterLevel  = absolute Y of water surface
    //   floorDepth  = depth at deepest point (center) below waterLevel
    //
    // Phase 1 (GetDirectHeight):
    //   Inner zone: returns bowl-shaped lake floor (below waterLevel)
    //   Shore zone: smooth ramp between waterLevel and baseHeight
    //     waterLevel < baseHeight -> carves down (depression)
    //     waterLevel > baseHeight -> builds up (raised bowl)
    //
    // Phase 2 (GetColumnLayers):
    //   Inner zone: returns [Water, waterLevel] -- fills above floor
    //   Shore/outside: returns null -- no water placement
    public class LakeFeature : ILayeredFeature
    {
        private readonly double centerX, centerZ;
        private readonly double innerRadius;
        private readonly double outerRadius;
        private readonly int waterLevel;
        private readonly int floorDepth;
        private readonly float noiseFreq;
        private readonly float noiseStrength;

        public LakeFeature(
            double centerX, double centerZ,
            double innerRadius, double outerRadius,
            int waterLevel, int floorDepth,
            float noiseFreq, float noiseStrength)
        {
            this.centerX = centerX;
            this.centerZ = centerZ;
            this.innerRadius = innerRadius;
            this.outerRadius = outerRadius;
            this.waterLevel = waterLevel;
            this.floorDepth = floorDepth;
            this.noiseFreq = noiseFreq;
            this.noiseStrength = noiseStrength;
        }

        public HeightOutput? GetDirectHeight(double worldX, double worldZ, int baseHeight, int peakHeight)
        {
            double dist = NoisyDistance(worldX, worldZ);

            // Outside feature entirely
            if (dist > outerRadius) return null;

            int result;

            // Shore zone: smooth ramp between waterLevel and baseHeight
            if (dist > innerRadius)
            {
                double t = (dist - innerRadius) / (outerRadius - innerRadius);
                // Smoothstep: smooth transition from waterLevel (0) to baseHeight (1)
                t = t * t * (3.0 - 2.0 * t);
                result = waterLevel + (int)((baseHeight - waterLevel) * t);
            }
            else
            {
                // Inner zone: bowl-shaped lake floor
                double bowlT = dist / Math.Max(1, innerRadius); // 0 at center, 1 at edge
                double bowlFactor = bowlT * bowlT; // parabolic: deepest at center
                result = (waterLevel - floorDepth) + (int)(floorDepth * bowlFactor);
            }

            // No change needed for this column
            if (result == baseHeight) return null;

            return HeightOutput.Absolute(Math.Max(result, 1));
        }

        public ColumnLayer[] GetColumnLayers(double worldX, double worldZ, int baseHeight, int peakHeight)
        {
            double dist = NoisyDistance(worldX, worldZ);

            // Only the inner zone gets water
            if (dist > innerRadius) return null;

            // Only place water if the rock surface is below water level
            if (baseHeight >= waterLevel) return null;

            return new[] { new ColumnLayer(ColumnBlockType.Water, waterLevel) };
        }

        // Distance from point to center with noise for irregular shoreline
        private double NoisyDistance(double worldX, double worldZ)
        {
            double dx = worldX - centerX;
            double dz = worldZ - centerZ;
            double dist = Math.Sqrt(dx * dx + dz * dz);

            if (noiseStrength > 0 && dist > 0)
            {
                double noise = Hash2D(worldX * noiseFreq, worldZ * noiseFreq);
                // Noise shrinks/expands the effective radius
                dist *= 1.0 - noiseStrength * noise;
            }

            return dist;
        }

        private static double Hash2D(double x, double y)
        {
            int i = (int)Math.Floor(x);
            int j = (int)Math.Floor(y);
            double fx = x - i;
            double fy = y - j;
            double u = fx * fx * (3.0 - 2.0 * fx);
            double v = fy * fy * (3.0 - 2.0 * fy);

            double H(int ix, int iy)
            {
                int h = ix * 374761393 + iy * 668265263;
                h = (h ^ (h >> 13)) * 1274126177;
                return ((h ^ (h >> 16)) & 0xFFFFFF) / (double)0xFFFFFF * 2.0 - 1.0;
            }

            double g00 = H(i, j), g10 = H(i + 1, j), g01 = H(i, j + 1), g11 = H(i + 1, j + 1);
            double x1 = g00 * (1.0 - u) + g10 * u;
            double x2 = g01 * (1.0 - u) + g11 * u;
            return x1 * (1.0 - v) + x2 * v;
        }

        public BlockPos GetMinBounds() =>
            new BlockPos((int)(centerX - outerRadius - 10), 0, (int)(centerZ - outerRadius - 10));

        public BlockPos GetMaxBounds() =>
            new BlockPos((int)(centerX + outerRadius + 10), 256, (int)(centerZ + outerRadius + 10));
    }
}
