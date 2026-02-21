using System;
using Vintagestory.API.MathTools;
using RealisticWorlds.Features;

namespace RealisticWorlds.Volcanoes
{
    public enum VolcanoShapeProfile
    {
        Convex,  // Classic cone: steep base, narrow top
        SCurve   // Smooth transition with pronounced neck
    }

    /// <summary>
    /// Single volcano feature. Computes per-column height using radial distance,
    /// shape profile curve, optional vent depression, and footprint irregularity noise.
    /// </summary>
    public class VolcanoFeature : IFeature
    {
        public Vec2d Center { get; set; }
        public double Radius { get; set; }
        public float HeightMultiplier { get; set; }
        public VolcanoShapeProfile ShapeProfile { get; set; } = VolcanoShapeProfile.Convex;
        public float Curvature { get; set; } = 0.5f;
        public float VentRadius { get; set; } = 0.15f;
        public float VentDepth { get; set; } = 0.3f;
        public float IrregularityFrequency { get; set; } = 0.01f;
        public float IrregularityStrength { get; set; } = 0.15f;

        public HeightOutput? GetDirectHeight(double worldX, double worldZ, int baseHeight, int peakHeight)
        {
            double dx = worldX - Center.X;
            double dz = worldZ - Center.Y;
            double baseDist = Math.Sqrt(dx * dx + dz * dz) / Radius;

            if (baseDist > 1.0) return null;

            // Irregularity: 2D noise warps the effective radius.
            // Log smoothing makes it weak near peak, strong at base.
            double noise = ValueNoise2D(worldX * IrregularityFrequency, worldZ * IrregularityFrequency);
            double smoothing = Math.Log10(1.0 + baseDist * 9.0);
            double effectiveRadius = Radius * (1.0 + noise * IrregularityStrength * smoothing);
            double dist = Math.Sqrt(dx * dx + dz * dz) / effectiveRadius;

            if (dist > 1.0) return null;

            // Shape profile: maps dist [0,1] to height factor [0=peak, 1=base]
            double heightFactor = ApplyShapeProfile(dist);

            double heightRange = peakHeight - baseHeight;
            int volcanoHeight = (int)(peakHeight - (heightFactor * heightRange));
            volcanoHeight = baseHeight + (int)((volcanoHeight - baseHeight) * HeightMultiplier);

            // Vent: smooth hermite dip at center
            if (VentRadius > 0 && dist < VentRadius)
            {
                double t = dist / VentRadius;
                double ventFactor = t * t * (3.0 - 2.0 * t);
                int ventDepthBlocks = (int)((volcanoHeight - baseHeight) * VentDepth);
                volcanoHeight -= (int)(ventDepthBlocks * (1.0 - ventFactor));
            }

            return HeightOutput.Absolute(volcanoHeight);
        }

        /// <summary>Shape curve: t=0 center, t=1 edge. Returns 0=peak, 1=base.</summary>
        private double ApplyShapeProfile(double t)
        {
            switch (ShapeProfile)
            {
                case VolcanoShapeProfile.Convex:
                    return 1.0 - Math.Pow(1.0 - t, 1.0 + Curvature);
                case VolcanoShapeProfile.SCurve:
                    if (Curvature < 0.01) return t;
                    double s = t * t * (3.0 - 2.0 * t);
                    return t + (s - t) * Curvature * 2.0;
                default:
                    return t;
            }
        }

        /// <summary>Hash-based 2D value noise, returns [-1, 1].</summary>
        private static double ValueNoise2D(double x, double y)
        {
            int i = (int)Math.Floor(x);
            int j = (int)Math.Floor(y);
            double fx = x - i, fy = y - j;

            double u = fx * fx * (3.0 - 2.0 * fx);
            double v = fy * fy * (3.0 - 2.0 * fy);

            double Hash(int ix, int iy)
            {
                int h = ix * 374761393 + iy * 668265263;
                h = (h ^ (h >> 13)) * 1274126177;
                return ((h ^ (h >> 16)) & 0xFFFFFF) / (double)0xFFFFFF * 2.0 - 1.0;
            }

            double g00 = Hash(i, j), g10 = Hash(i + 1, j);
            double g01 = Hash(i, j + 1), g11 = Hash(i + 1, j + 1);

            double x1 = g00 * (1.0 - u) + g10 * u;
            double x2 = g01 * (1.0 - u) + g11 * u;
            return x1 * (1.0 - v) + x2 * v;
        }

        public BlockPos GetMinBounds()
            => new BlockPos((int)(Center.X - Radius), 0, (int)(Center.Y - Radius));

        public BlockPos GetMaxBounds()
            => new BlockPos((int)(Center.X + Radius), 256, (int)(Center.Y + Radius));
    }
}
