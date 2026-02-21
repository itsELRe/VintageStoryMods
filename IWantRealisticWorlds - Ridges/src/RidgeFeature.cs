using System;
using System.Collections.Generic;
using Vintagestory.API.MathTools;
using RealisticWorlds.Features;

namespace RealisticWorlds.Ridges
{
    /// <summary>Catmull-Rom chain segment. H0/H1 are height fractions [0,1].</summary>
    public struct RidgeSegment
    {
        public double X0, Z0, H0;
        public double X1, Z1, H1;
        public int RootIdx;
    }

    /// <summary>
    /// Ridge mountain feature built by space colonization.
    /// Heights are precomputed on a 4-block resolution grid during ComputeBounds().
    /// GetDirectHeight does fast bilinear interpolation at runtime.
    /// </summary>
    public class RidgeFeature : IFeature
    {
        // Set by factory, converted to array in ComputeBounds
        public List<RidgeSegment> Segments;

        // Per-seed root data for local cone computation
        public double[] SeedRootX, SeedRootZ;
        public double[] MaxSeedRadius;
        public double MaxNodeRadius;

        // Terrain parameters
        public double PeakHeight;
        public double FalloffDist;
        public double LocalConeStr;
        public double GlobalConeStr;
        public double RidgeHalfWidth;
        public double DrainageBias;
        public double LogFalloff;

        // Feature center (spawn position) — noise origin
        public double FeatureCenterX, FeatureCenterZ;

        // Slope noise
        public double FalloffNoiseStr;
        public double FalloffNoiseScale;
        public int FalloffNoiseOct;

        // Smoothing
        public int SmoothPasses;
        public int FalloffSmoothN;

        // Plateau cut
        public double PlateauCut;

        // Precomputed bounds
        private BlockPos boundsMin, boundsMax;

        // Precomputed height grid (GRID_RES blocks per cell)
        private const int GRID_RES = 4;
        private float[] heightGrid;
        private int hgW, hgH;
        private double hgOriginX, hgOriginZ;

        /// <summary>
        /// Builds the precomputed height grid. Must be called after all properties are set.
        /// Frees Segments list after grid is built (no longer needed).
        /// </summary>
        public void ComputeBounds()
        {
            double pad = FalloffDist + RidgeHalfWidth;
            double minX = double.MaxValue, minZ = double.MaxValue;
            double maxX = double.MinValue, maxZ = double.MinValue;

            foreach (var s in Segments)
            {
                if (s.X0 < minX) minX = s.X0;
                if (s.X1 < minX) minX = s.X1;
                if (s.X0 > maxX) maxX = s.X0;
                if (s.X1 > maxX) maxX = s.X1;
                if (s.Z0 < minZ) minZ = s.Z0;
                if (s.Z1 < minZ) minZ = s.Z1;
                if (s.Z0 > maxZ) maxZ = s.Z0;
                if (s.Z1 > maxZ) maxZ = s.Z1;
            }

            boundsMin = new BlockPos((int)(minX - pad), 0, (int)(minZ - pad));
            boundsMax = new BlockPos((int)(maxX + pad), 256, (int)(maxZ + pad));

            var segArray = Segments.ToArray();
            int segCount = segArray.Length;

            // Precompute per-segment direction and length squared
            var segDx = new double[segCount];
            var segDz = new double[segCount];
            var segLenSq = new double[segCount];
            for (int i = 0; i < segCount; i++)
            {
                segDx[i] = segArray[i].X1 - segArray[i].X0;
                segDz[i] = segArray[i].Z1 - segArray[i].Z0;
                segLenSq[i] = segDx[i] * segDx[i] + segDz[i] * segDz[i];
            }

            double dropPerUnit = PeakHeight / FalloffDist;

            // Spatial grid for fast segment lookup during precomputation
            const int CELL_SIZE = 64;
            double sgOriginX = minX - pad;
            double sgOriginZ = minZ - pad;
            int sgW = Math.Max(1, (int)Math.Ceiling((maxX + pad - sgOriginX) / CELL_SIZE) + 1);
            int sgH = Math.Max(1, (int)Math.Ceiling((maxZ + pad - sgOriginZ) / CELL_SIZE) + 1);

            var cellLists = new List<int>[sgW * sgH];
            for (int i = 0; i < cellLists.Length; i++)
                cellLists[i] = new List<int>();

            for (int si = 0; si < segCount; si++)
            {
                var seg = segArray[si];
                double sMinX = Math.Min(seg.X0, seg.X1) - pad;
                double sMaxX = Math.Max(seg.X0, seg.X1) + pad;
                double sMinZ = Math.Min(seg.Z0, seg.Z1) - pad;
                double sMaxZ = Math.Max(seg.Z0, seg.Z1) + pad;

                int cx0 = Math.Max(0, (int)((sMinX - sgOriginX) / CELL_SIZE));
                int cx1 = Math.Min(sgW - 1, (int)((sMaxX - sgOriginX) / CELL_SIZE));
                int cz0 = Math.Max(0, (int)((sMinZ - sgOriginZ) / CELL_SIZE));
                int cz1 = Math.Min(sgH - 1, (int)((sMaxZ - sgOriginZ) / CELL_SIZE));

                for (int gx = cx0; gx <= cx1; gx++)
                    for (int gz = cz0; gz <= cz1; gz++)
                        cellLists[gx + gz * sgW].Add(si);
            }

            var sgCells = new int[cellLists.Length][];
            for (int i = 0; i < cellLists.Length; i++)
                sgCells[i] = cellLists[i].ToArray();

            // Build height grid
            hgOriginX = boundsMin.X;
            hgOriginZ = boundsMin.Z;
            hgW = (boundsMax.X - boundsMin.X) / GRID_RES + 2;
            hgH = (boundsMax.Z - boundsMin.Z) / GRID_RES + 2;
            heightGrid = new float[hgW * hgH];

            for (int gz = 0; gz < hgH; gz++)
            {
                double wz = hgOriginZ + gz * GRID_RES;
                for (int gx = 0; gx < hgW; gx++)
                {
                    double wx = hgOriginX + gx * GRID_RES;
                    heightGrid[gz * hgW + gx] = (float)ComputeRawHeightAt(
                        wx, wz, segArray, segDx, segDz, segLenSq,
                        sgCells, sgW, sgH, sgOriginX, sgOriginZ, CELL_SIZE,
                        dropPerUnit);
                }
            }

            ApplyGridPostProcessing();
            Segments = null;
        }

        /// <summary>Raw height from segment geometry. Noise/smoothing applied separately.</summary>
        private double ComputeRawHeightAt(
            double worldX, double worldZ,
            RidgeSegment[] segArray, double[] segDx, double[] segDz, double[] segLenSq,
            int[][] sgCells, int sgW, int sgH, double sgOriginX, double sgOriginZ, int cellSize,
            double dropPerUnit)
        {
            int cx = (int)((worldX - sgOriginX) / cellSize);
            int cz = (int)((worldZ - sgOriginZ) / cellSize);
            if (cx < 0 || cx >= sgW || cz < 0 || cz >= sgH) return 0;

            int[] cellSegs = sgCells[cx + cz * sgW];
            if (cellSegs.Length == 0) return 0;

            double bestH = 0;

            // Global cone (feature-center-relative)
            double globalCone = 0;
            if (GlobalConeStr > 0 && MaxNodeRadius > 1.0)
            {
                double gcx = worldX - FeatureCenterX;
                double gcz = worldZ - FeatureCenterZ;
                double gDist = Math.Sqrt(gcx * gcx + gcz * gcz);
                double grFrac = Math.Min(1.0, gDist / MaxNodeRadius);
                double gv = Math.Max(0, 1.0 - grFrac * grFrac);
                globalCone = gv * Math.Sqrt(gv) * GlobalConeStr;
            }

            // Per-seed local cone cache
            double cachedLocalCone = 0;
            int cachedRootIdx = -1;

            for (int ci = 0; ci < cellSegs.Length; ci++)
            {
                int si = cellSegs[ci];
                var seg = segArray[si];
                double dxS = segDx[si];
                double dzS = segDz[si];
                double lenSq = segLenSq[si];

                // Project point onto segment
                double t = 0;
                if (lenSq > 0.001)
                {
                    t = ((worldX - seg.X0) * dxS + (worldZ - seg.Z0) * dzS) / lenSq;
                    if (t < 0) t = 0;
                    else if (t > 1) t = 1;
                }

                double cpx = seg.X0 + dxS * t;
                double cpz = seg.Z0 + dzS * t;
                double dx = worldX - cpx;
                double dz = worldZ - cpz;
                double distSq = dx * dx + dz * dz;

                double hFrac = seg.H0 + (seg.H1 - seg.H0) * t;
                double halfW = RidgeHalfWidth * (0.3 + 0.7 * (1.0 - hFrac));
                double maxReach = FalloffDist + halfW;
                if (distSq > maxReach * maxReach) continue;

                double dist = Math.Sqrt(distSq);
                double effDist = dist > halfW ? dist - halfW : 0;
                double drop = effDist * dropPerUnit;

                // Local cone (cached per rootIdx)
                double localCone = 0;
                if (LocalConeStr > 0 && SeedRootX != null)
                {
                    int ri = seg.RootIdx;
                    if (ri == cachedRootIdx)
                    {
                        localCone = cachedLocalCone;
                    }
                    else if (ri >= 0 && ri < SeedRootX.Length && MaxSeedRadius[ri] > 1.0)
                    {
                        double rdx = worldX - SeedRootX[ri];
                        double rdz = worldZ - SeedRootZ[ri];
                        double lrFrac = Math.Sqrt(rdx * rdx + rdz * rdz) / MaxSeedRadius[ri];
                        if (lrFrac > 1.0) lrFrac = 1.0;
                        double lv = 1.0 - lrFrac * lrFrac;
                        localCone = lv * Math.Sqrt(lv) * LocalConeStr;
                        cachedLocalCone = localCone;
                        cachedRootIdx = ri;
                    }
                }
                double coneVal = Math.Max(localCone, globalCone);

                // Cone reduces drop at higher elevations
                if (coneVal > 0)
                {
                    double hAtPoint = hFrac * PeakHeight - drop;
                    double heightFrac = hAtPoint > 0 ? Math.Sqrt(hAtPoint / PeakHeight) : 0;
                    drop *= (1.0 - coneVal * 0.6 * heightFrac);
                }

                // Drainage bias steepens off-spine slopes
                if (DrainageBias > 0)
                {
                    drop += DrainageBias * (effDist > 0 ? dropPerUnit : 0) * (1.0 - coneVal);
                }

                double h = hFrac * PeakHeight - drop;

                // LogFalloff: power curve that preserves footprint
                if (h > 0 && LogFalloff > 0)
                {
                    double maxH = hFrac * PeakHeight;
                    if (maxH > 0)
                    {
                        double frac = h / maxH;
                        h = maxH * Math.Pow(frac, 1.0 + LogFalloff);
                    }
                }

                if (h > bestH) bestH = h;
            }

            return bestH > 0 ? bestH : 0;
        }

        /// <summary>Post-processing: falloff noise, slope smoothing, plateau cut, grid smoothing.</summary>
        private void ApplyGridPostProcessing()
        {
            // Falloff noise (feature-center-relative for HTML parity)
            if (FalloffNoiseStr > 0)
            {
                for (int gz = 0; gz < hgH; gz++)
                {
                    double wz = hgOriginZ + gz * GRID_RES - FeatureCenterZ;
                    for (int gx = 0; gx < hgW; gx++)
                    {
                        int idx = gz * hgW + gx;
                        double h = heightGrid[idx];
                        if (h <= 0) continue;
                        double ridgeFrac = h / PeakHeight;
                        double noiseWeight = Math.Pow(1.0 - ridgeFrac, 0.7);
                        double edgeTaper = Math.Min(1.0, h / (PeakHeight * 0.05));
                        double wx = hgOriginX + gx * GRID_RES - FeatureCenterX;
                        double n = FractalNoise2D(wx, wz, FalloffNoiseOct, FalloffNoiseScale);
                        heightGrid[idx] = (float)Math.Max(0, h + n * noiseWeight * edgeTaper * FalloffNoiseStr * PeakHeight);
                    }
                }
            }

            // Falloff zone smoothing (slope-selective 3x3 kernel)
            if (FalloffSmoothN > 0)
            {
                var tmp = new float[hgW * hgH];
                for (int pass = 0; pass < FalloffSmoothN; pass++)
                {
                    for (int gz = 0; gz < hgH; gz++)
                    {
                        for (int gx = 0; gx < hgW; gx++)
                        {
                            int idx = gz * hgW + gx;
                            double h = heightGrid[idx];
                            double sw = Math.Pow(1.0 - Math.Min(1.0, h / PeakHeight), 0.5);
                            double sum = 0;
                            int cnt = 0;
                            for (int dz = -1; dz <= 1; dz++)
                            {
                                int zz = gz + dz;
                                if (zz < 0 || zz >= hgH) continue;
                                for (int dx = -1; dx <= 1; dx++)
                                {
                                    int xx = gx + dx;
                                    if (xx < 0 || xx >= hgW) continue;
                                    sum += heightGrid[zz * hgW + xx];
                                    cnt++;
                                }
                            }
                            tmp[idx] = (float)(h + (sum / cnt - h) * sw);
                        }
                    }
                    Array.Copy(tmp, heightGrid, heightGrid.Length);
                }
            }

            // Plateau cut
            if (PlateauCut > 0)
            {
                double cutHeight = PeakHeight * (1.0 - PlateauCut);
                double noiseAmp = PlateauCut * PeakHeight * 0.15;
                double ridgeFollowAmp = PlateauCut * PeakHeight * 0.25;
                double cutRange = PeakHeight - cutHeight;
                double rangeX = (double)(hgW * GRID_RES);
                double rangeZ = (double)(hgH * GRID_RES);
                double plateauScale = Math.Max(16.0, (rangeX + rangeZ) / 2.0 / 40.0);

                for (int gz = 0; gz < hgH; gz++)
                {
                    double wz = hgOriginZ + gz * GRID_RES - FeatureCenterZ;
                    for (int gx = 0; gx < hgW; gx++)
                    {
                        int idx = gz * hgW + gx;
                        double h = heightGrid[idx];
                        if (h <= cutHeight) continue;
                        double ridgeFrac = Math.Min(1.0, (h - cutHeight) / cutRange);
                        double wx = hgOriginX + gx * GRID_RES - FeatureCenterX;
                        double pn = PlateauNoise(wx / plateauScale, wz / plateauScale);
                        heightGrid[idx] = (float)(cutHeight + pn * noiseAmp + ridgeFrac * ridgeFollowAmp);
                    }
                }
            }

            // Final grid smoothing (box blur)
            if (SmoothPasses > 0)
            {
                var tmp = new float[hgW * hgH];
                for (int pass = 0; pass < SmoothPasses; pass++)
                {
                    for (int gz = 0; gz < hgH; gz++)
                    {
                        for (int gx = 0; gx < hgW; gx++)
                        {
                            double sum = 0;
                            int cnt = 0;
                            for (int dz = -1; dz <= 1; dz++)
                            {
                                int zz = gz + dz;
                                if (zz < 0 || zz >= hgH) continue;
                                for (int dx = -1; dx <= 1; dx++)
                                {
                                    int xx = gx + dx;
                                    if (xx < 0 || xx >= hgW) continue;
                                    sum += heightGrid[zz * hgW + xx];
                                    cnt++;
                                }
                            }
                            tmp[gz * hgW + gx] = (float)(sum / cnt);
                        }
                    }
                    Array.Copy(tmp, heightGrid, heightGrid.Length);
                }
            }
        }

        // --- Runtime: bilinear interpolation from precomputed grid ---

        public HeightOutput? GetDirectHeight(double worldX, double worldZ, int baseHeight, int peakHeight)
        {
            double gx = (worldX - hgOriginX) / GRID_RES;
            double gz = (worldZ - hgOriginZ) / GRID_RES;
            int ix = (int)gx;
            int iz = (int)gz;

            if (ix < 0 || ix >= hgW - 1 || iz < 0 || iz >= hgH - 1) return null;

            double fx = gx - ix;
            double fz = gz - iz;
            int idx = iz * hgW + ix;

            double h00 = heightGrid[idx];
            double h10 = heightGrid[idx + 1];
            double h01 = heightGrid[idx + hgW];
            double h11 = heightGrid[idx + hgW + 1];

            double bestH = h00 * (1 - fx) * (1 - fz)
                         + h10 * fx * (1 - fz)
                         + h01 * (1 - fx) * fz
                         + h11 * fx * fz;

            if (bestH <= 0) return null;
            if (baseHeight >= peakHeight) return null;

            int result = baseHeight + (int)bestH;
            if (result > peakHeight) result = peakHeight;
            return HeightOutput.Absolute(result);
        }

        public BlockPos GetMinBounds() => boundsMin;
        public BlockPos GetMaxBounds() => boundsMax;

        // --- Noise utilities (matching HTML prototype exactly) ---

        private static double ValueNoise2D(double x, double y)
        {
            int ix = (int)Math.Floor(x);
            int iy = (int)Math.Floor(y);
            double fx = x - ix;
            double fy = y - iy;

            double u = fx * fx * (3.0 - 2.0 * fx);
            double v = fy * fy * (3.0 - 2.0 * fy);

            double g00 = HashInt(ix, iy);
            double g10 = HashInt(ix + 1, iy);
            double g01 = HashInt(ix, iy + 1);
            double g11 = HashInt(ix + 1, iy + 1);

            double x1 = g00 * (1.0 - u) + g10 * u;
            double x2 = g01 * (1.0 - u) + g11 * u;
            return x1 * (1.0 - v) + x2 * v;
        }

        private static double HashInt(int x, int y)
        {
            int h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
            h = ((h ^ (h >> 13)) * 1274126177) & 0x7fffffff;
            return h / (double)0x7fffffff;
        }

        private static double PlateauNoise(double gx, double gz) => ValueNoise2D(gx, gz);

        private static double FractalNoise2D(double x, double z, int octaves, double scale)
        {
            double sum = 0, amp = 1, s = scale, totalAmp = 0;
            for (int o = 0; o < octaves; o++)
            {
                double val = ValueNoise2D((x + o * 1337) / s, (z + o * 2971) / s);
                sum += amp * (val * 2.0 - 1.0);
                totalAmp += amp;
                amp *= 0.5;
                s *= 0.5;
            }
            return sum / totalAmp;
        }
    }
}
