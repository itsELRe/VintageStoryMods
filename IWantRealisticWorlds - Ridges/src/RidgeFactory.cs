using System;
using System.Collections.Generic;
using Vintagestory.API.Common;
using Vintagestory.API.MathTools;
using Vintagestory.API.Server;
using RealisticWorlds;
using RealisticWorlds.Features;

namespace RealisticWorlds.Ridges
{
    /// <summary>
    /// Creates ridge features using space colonization. Direct port of HTML prototype.
    /// Config loaded from ModConfig/IWantRealisticWorlds/ridges.json.
    /// </summary>
    public class RidgeFactory : IFeatureFactory
    {
        private ICoreServerAPI sapi;
        private RidgeConfig config;

        public RidgeFactory(ICoreServerAPI api)
        {
            sapi = api;
            LoadConfig();
        }

        public IFeature CreateFeature(double worldX, double worldZ, Random rand)
            => GenerateMountain(worldX, worldZ, rand);

        public double GetMinRadius()
            => config.FalloffDistMax * Math.Sqrt(RealisticWorldsMod.Config.FootprintScaleMultiplier);

        public double GetMaxRadius()
            => (config.MaxSpreadMax + config.FalloffDistMax) * Math.Sqrt(RealisticWorldsMod.Config.FootprintScaleMultiplier);

        private static int RandRange(Random rand, int min, int max)
            => min >= max ? min : min + rand.Next(max - min + 1);

        private static double RandRangeF(Random rand, float min, float max)
            => min >= max ? min : min + rand.NextDouble() * (max - min);

        // --- Space colonization pipeline ---

        private class Node
        {
            public double X, Z;
            public int Parent;
            public double DirX, DirZ;
            public int RootIdx;
        }

        private class Attractor
        {
            public double X, Z;
            public bool Alive;
            public int Owner;
        }

        private RidgeFeature GenerateMountain(double cx, double cz, Random rand)
        {
            // Resolve all parameters from config min/max ranges
            int attractorCount = RandRange(rand, config.AttractorCountMin, config.AttractorCountMax);
            double cloudW = RandRange(rand, config.CloudWidthMin, config.CloudWidthMax);
            double cloudH = RandRange(rand, config.CloudHeightMin, config.CloudHeightMax);
            double stepSize = RandRange(rand, config.StepSizeMin, config.StepSizeMax);
            double killDist = RandRange(rand, config.KillDistMin, config.KillDistMax);
            double influenceR = RandRange(rand, config.InfluenceRadiusMin, config.InfluenceRadiusMax);
            int maxIter = RandRange(rand, config.MaxIterMin, config.MaxIterMax);
            int seedCount = RandRange(rand, config.SeedCountMin, config.SeedCountMax);
            double seedMinDist = RandRange(rand, config.SeedMinDistMin, config.SeedMinDistMax);
            double seedBorder = RandRange(rand, config.SeedBorderMin, config.SeedBorderMax);
            double wobble = RandRangeF(rand, config.WobbleMin, config.WobbleMax);
            double outwardBias = RandRangeF(rand, config.OutwardBiasMin, config.OutwardBiasMax);
            double coherenceThreshold = RandRangeF(rand, config.CoherenceThresholdMin, config.CoherenceThresholdMax);
            int minBranch = RandRange(rand, config.MinBranchLenMin, config.MinBranchLenMax);
            double maxSpread = RandRange(rand, config.MaxSpreadMin, config.MaxSpreadMax);
            double peakHeightFrac = RandRangeF(rand, config.PeakHeightMin, config.PeakHeightMax);
            double localConeStr = RandRangeF(rand, config.LocalConeMin, config.LocalConeMax);
            double globalConeStr = RandRangeF(rand, config.GlobalConeMin, config.GlobalConeMax);
            int falloffDist = RandRange(rand, config.FalloffDistMin, config.FalloffDistMax);
            double ridgeWidth = RandRangeF(rand, config.RidgeWidthMin, config.RidgeWidthMax);
            double drainageBias = RandRangeF(rand, config.DrainageBiasMin, config.DrainageBiasMax);
            double logFalloff = RandRangeF(rand, config.LogFalloffMin, config.LogFalloffMax);
            int chainSmooth = RandRange(rand, config.ChainSmoothMin, config.ChainSmoothMax);
            int ridgeSmooth = RandRange(rand, config.RidgeSmoothMin, config.RidgeSmoothMax);
            int smoothPasses = RandRange(rand, config.SmoothPassesMin, config.SmoothPassesMax);
            double falloffNoise = RandRangeF(rand, config.FalloffNoiseMin, config.FalloffNoiseMax);
            double falloffNoiseScale = RandRangeF(rand, config.FalloffNoiseScaleMin, config.FalloffNoiseScaleMax);
            int falloffNoiseOct = RandRange(rand, config.FalloffNoiseOctMin, config.FalloffNoiseOctMax);
            int falloffSmooth = RandRange(rand, config.FalloffSmoothMin, config.FalloffSmoothMax);
            double plateauCut = RandRangeF(rand, config.PlateauCutMin, config.PlateauCutMax);

            double killDistSq = killDist * killDist;
            double influenceRSq = influenceR * influenceR;
            double maxSpreadSq = maxSpread * maxSpread;
            double seedMinDistSq = seedMinDist * seedMinDist;
            double separationR = stepSize * 2.5;
            double separationRSq = separationR * separationR;
            double separationStrength = 0.6;

            double boundW = Math.Max(stepSize * 3, cloudW / 2 - falloffDist * 0.6);
            double boundH = Math.Max(stepSize * 3, cloudH / 2 - falloffDist * 0.6);

            // Step 1: Place attractors in elliptical cloud
            var attractors = new List<Attractor>();
            for (int i = 0; i < attractorCount; i++)
            {
                double ax, az;
                do
                {
                    ax = rand.NextDouble() * 2 - 1;
                    az = rand.NextDouble() * 2 - 1;
                } while (ax * ax + az * az > 1);
                attractors.Add(new Attractor
                {
                    X = cx + ax * cloudW / 2,
                    Z = cz + az * cloudH / 2,
                    Alive = true,
                    Owner = 0
                });
            }

            // Step 2: Place seed nodes with min-distance enforcement
            var nodes = new List<Node>();
            double placeW = Math.Max(1, boundW - maxSpread * 0.3);
            double placeH = Math.Max(1, boundH - maxSpread * 0.3);

            for (int s = 0; s < seedCount; s++)
            {
                double sx = cx, sz = cz;
                for (int attempt = 0; attempt < 200; attempt++)
                {
                    double ax, az;
                    do
                    {
                        ax = rand.NextDouble() * 2 - 1;
                        az = rand.NextDouble() * 2 - 1;
                    } while (ax * ax + az * az > 1);
                    sx = cx + ax * placeW;
                    sz = cz + az * placeH;

                    bool ok = true;
                    for (int j = 0; j < nodes.Count; j++)
                    {
                        double dx = sx - nodes[j].X;
                        double dz = sz - nodes[j].Z;
                        if (dx * dx + dz * dz < seedMinDistSq) { ok = false; break; }
                    }
                    if (ok) break;
                }
                nodes.Add(new Node { X = sx, Z = sz, Parent = -1, DirX = 0, DirZ = 0, RootIdx = s });
            }

            // Step 2b: Assign attractors to seeds (Voronoi) or mark as border deflectors
            if (seedCount > 1)
            {
                foreach (var a in attractors)
                {
                    double d1 = double.MaxValue, d2 = double.MaxValue;
                    int s1 = -1;
                    for (int s = 0; s < seedCount; s++)
                    {
                        double dx = a.X - nodes[s].X;
                        double dz = a.Z - nodes[s].Z;
                        double d = Math.Sqrt(dx * dx + dz * dz);
                        if (d < d1) { d2 = d1; d1 = d; s1 = s; }
                        else if (d < d2) { d2 = d; }
                    }
                    a.Owner = (d2 - d1 < seedBorder) ? -1 : s1;
                }
            }

            // Step 3: Space colonization growth
            for (int iter = 0; iter < maxIter; iter++)
            {
                var influence = new Dictionary<int, (double dx, double dz, int count)>();
                bool anyAssignedAlive = false;

                for (int ai = 0; ai < attractors.Count; ai++)
                {
                    var a = attractors[ai];
                    if (!a.Alive) continue;

                    if (a.Owner == -1)
                    {
                        // Deflector: push nearest node away
                        int bestIdx = -1;
                        double bestDistSq = double.MaxValue;
                        for (int ni = 0; ni < nodes.Count; ni++)
                        {
                            if (nodes[ni] == null) continue;
                            double dx = a.X - nodes[ni].X;
                            double dz = a.Z - nodes[ni].Z;
                            double dsq = dx * dx + dz * dz;
                            if (dsq < bestDistSq) { bestDistSq = dsq; bestIdx = ni; }
                        }
                        if (bestIdx < 0 || bestDistSq > influenceRSq) continue;
                        double adx = a.X - nodes[bestIdx].X;
                        double adz = a.Z - nodes[bestIdx].Z;
                        double len = Math.Sqrt(adx * adx + adz * adz);
                        if (len < 0.001) continue;
                        if (!influence.ContainsKey(bestIdx))
                            influence[bestIdx] = (0, 0, 0);
                        var inf = influence[bestIdx];
                        influence[bestIdx] = (inf.dx - adx / len, inf.dz - adz / len, inf.count + 1);
                    }
                    else
                    {
                        // Assigned: attract nearest same-seed node
                        anyAssignedAlive = true;
                        int bestIdx = -1;
                        double bestDistSq = double.MaxValue;
                        for (int ni = 0; ni < nodes.Count; ni++)
                        {
                            if (nodes[ni] == null || nodes[ni].RootIdx != a.Owner) continue;
                            double dx = a.X - nodes[ni].X;
                            double dz = a.Z - nodes[ni].Z;
                            double dsq = dx * dx + dz * dz;
                            if (dsq < bestDistSq) { bestDistSq = dsq; bestIdx = ni; }
                        }
                        if (bestIdx < 0 || bestDistSq > influenceRSq) continue;
                        if (bestDistSq < killDistSq) { a.Alive = false; continue; }
                        double adx = a.X - nodes[bestIdx].X;
                        double adz = a.Z - nodes[bestIdx].Z;
                        double len = Math.Sqrt(adx * adx + adz * adz);
                        if (len < 0.001) continue;
                        if (!influence.ContainsKey(bestIdx))
                            influence[bestIdx] = (0, 0, 0);
                        var inf = influence[bestIdx];
                        influence[bestIdx] = (inf.dx + adx / len, inf.dz + adz / len, inf.count + 1);
                    }
                }

                if (!anyAssignedAlive) break;

                var newNodes = new List<Node>();
                foreach (var kv in influence)
                {
                    int ni = kv.Key;
                    var inf = kv.Value;
                    if (inf.count == 0 || nodes[ni] == null) continue;

                    double dx = inf.dx / inf.count;
                    double dz = inf.dz / inf.count;
                    var n = nodes[ni];
                    var root = nodes[n.RootIdx];

                    // Outward bias (away from own root)
                    double fromRX = n.X - root.X;
                    double fromRZ = n.Z - root.Z;
                    double fromRLen = Math.Sqrt(fromRX * fromRX + fromRZ * fromRZ);
                    if (fromRLen > 0.01 && outwardBias > 0)
                    {
                        dx += (fromRX / fromRLen) * outwardBias;
                        dz += (fromRZ / fromRLen) * outwardBias;
                    }

                    // Separation from nearby nodes
                    double sepX = 0, sepZ = 0;
                    for (int j = 0; j < nodes.Count; j++)
                    {
                        if (j == ni || nodes[j] == null) continue;
                        if (nodes[j].Parent == ni || n.Parent == j) continue;
                        double ddx = n.X - nodes[j].X;
                        double ddz = n.Z - nodes[j].Z;
                        double dsq = ddx * ddx + ddz * ddz;
                        if (dsq < separationRSq && dsq > 0.01)
                        {
                            double d = Math.Sqrt(dsq);
                            sepX += (ddx / d) * (1 - d / separationR);
                            sepZ += (ddz / d) * (1 - d / separationR);
                        }
                    }
                    dx += sepX * separationStrength;
                    dz += sepZ * separationStrength;

                    // Wobble
                    dx += (rand.NextDouble() * 2 - 1) * wobble;
                    dz += (rand.NextDouble() * 2 - 1) * wobble;

                    // Normalize
                    double nlen = Math.Sqrt(dx * dx + dz * dz);
                    if (nlen < 0.001) continue;
                    double ndx = dx / nlen;
                    double ndz = dz / nlen;

                    // Anti-reversal
                    if (n.Parent >= 0)
                    {
                        double inLen = Math.Sqrt(n.DirX * n.DirX + n.DirZ * n.DirZ);
                        if (inLen > 0.01)
                        {
                            if ((n.DirX / inLen) * ndx + (n.DirZ / inLen) * ndz < -0.17)
                                continue;
                        }
                    }

                    // Max spread from root
                    double toRX = n.X - root.X;
                    double toRZ = n.Z - root.Z;
                    double toRLenSq = toRX * toRX + toRZ * toRZ;
                    if (toRLenSq > maxSpreadSq) continue;

                    // Coherence
                    if (coherenceThreshold > 0 && toRLenSq > stepSize * stepSize * 9)
                    {
                        double toRLen = Math.Sqrt(toRLenSq);
                        double coherence = (toRX / toRLen) * ndx + (toRZ / toRLen) * ndz;
                        if (coherence < coherenceThreshold * 2 - 1) continue;
                    }

                    // Boundary (ellipse)
                    double nx = n.X + ndx * stepSize;
                    double nz = n.Z + ndz * stepSize;
                    double enx = (nx - cx) / boundW;
                    double enz = (nz - cz) / boundH;
                    if (enx * enx + enz * enz > 1) continue;

                    // Collision
                    bool blocked = false;
                    double halfStepSq = (stepSize * 0.5) * (stepSize * 0.5);
                    for (int j = 0; j < nodes.Count; j++)
                    {
                        if (j == ni || nodes[j] == null) continue;
                        double ddx = nx - nodes[j].X;
                        double ddz = nz - nodes[j].Z;
                        double dsq = ddx * ddx + ddz * ddz;
                        if (dsq < halfStepSq) { blocked = true; break; }
                        if (nodes[j].RootIdx != n.RootIdx && dsq < seedBorder * seedBorder)
                        { blocked = true; break; }
                    }
                    if (blocked) continue;

                    newNodes.Add(new Node
                    {
                        X = nx, Z = nz, Parent = ni,
                        DirX = ndx, DirZ = ndz, RootIdx = n.RootIdx
                    });
                }

                foreach (var nn in newNodes) nodes.Add(nn);
                if (newNodes.Count == 0 && influence.Count == 0) break;
            }

            if (nodes.Count < 2) return null;

            // Step 4a: Build children array
            var children = new List<int>[nodes.Count];
            for (int i = 0; i < nodes.Count; i++) children[i] = new List<int>();
            for (int i = 0; i < nodes.Count; i++)
            {
                if (nodes[i] != null && nodes[i].Parent >= 0)
                    children[nodes[i].Parent].Add(i);
            }

            // Step 4b: Prune short leaf chains
            if (minBranch > 0)
            {
                bool pruned = true;
                while (pruned)
                {
                    pruned = false;
                    for (int i = 0; i < nodes.Count; i++)
                    {
                        if (nodes[i] == null || children[i].Count > 0) continue;
                        int chainLen = 1, cur = i;
                        while (true)
                        {
                            int p = nodes[cur].Parent;
                            if (p < 0 || children[p].Count > 1) break;
                            chainLen++; cur = p;
                        }
                        if (chainLen < minBranch && nodes[i].Parent >= 0)
                        {
                            int p = nodes[i].Parent;
                            children[p].Remove(i);
                            nodes[i] = null;
                            pruned = true;
                        }
                    }
                }
            }

            // Step 4c: Compact (remove nulls, remap parent indices)
            var validMap = new int[nodes.Count];
            var valid = new List<Node>();
            for (int i = 0; i < nodes.Count; i++)
            {
                if (nodes[i] != null)
                {
                    validMap[i] = valid.Count;
                    valid.Add(nodes[i]);
                }
                else validMap[i] = -1;
            }
            for (int i = 0; i < valid.Count; i++)
            {
                if (valid[i].Parent >= 0)
                    valid[i].Parent = validMap[valid[i].Parent];
            }

            var childrenFinal = new List<int>[valid.Count];
            for (int i = 0; i < valid.Count; i++) childrenFinal[i] = new List<int>();
            for (int i = 0; i < valid.Count; i++)
            {
                if (valid[i].Parent >= 0)
                    childrenFinal[valid[i].Parent].Add(i);
            }

            if (valid.Count < 2) return null;

            // Step 4d: Flow counts (bottom-up child accumulation)
            var childCount = new int[valid.Count];
            for (int i = valid.Count - 1; i >= 0; i--)
            {
                childCount[i] += 1;
                if (valid[i].Parent >= 0)
                    childCount[valid[i].Parent] += childCount[i];
            }

            int maxFlow = 1;
            for (int i = 0; i < valid.Count; i++)
                if (childCount[i] > maxFlow) maxFlow = childCount[i];

            // Step 5: Node heights (flow fraction + cone blending)
            var seedRootX = new double[seedCount];
            var seedRootZ = new double[seedCount];
            var maxSeedR = new double[seedCount];
            for (int s = 0; s < seedCount; s++) maxSeedR[s] = 1;

            for (int i = 0; i < valid.Count; i++)
            {
                if (valid[i].Parent < 0)
                {
                    int s = valid[i].RootIdx;
                    if (s >= 0 && s < seedCount)
                    {
                        seedRootX[s] = valid[i].X;
                        seedRootZ[s] = valid[i].Z;
                    }
                }
            }
            for (int i = 0; i < valid.Count; i++)
            {
                int s = valid[i].RootIdx;
                if (s >= 0 && s < seedCount)
                {
                    double dx = valid[i].X - seedRootX[s];
                    double dz = valid[i].Z - seedRootZ[s];
                    double r = Math.Sqrt(dx * dx + dz * dz);
                    if (r > maxSeedR[s]) maxSeedR[s] = r;
                }
            }

            double maxNodeR = 1;
            for (int i = 0; i < valid.Count; i++)
            {
                double ndx = valid[i].X - cx;
                double ndz = valid[i].Z - cz;
                double gr = Math.Sqrt(ndx * ndx + ndz * ndz);
                if (gr > maxNodeR) maxNodeR = gr;
            }

            var nodeHeight = new double[valid.Count];
            for (int i = 0; i < valid.Count; i++)
            {
                double flowFrac = Math.Pow((double)childCount[i] / maxFlow, 0.45);

                int s = valid[i].RootIdx;
                double localRFrac = 0;
                if (s >= 0 && s < seedCount)
                {
                    double ldx = valid[i].X - seedRootX[s];
                    double ldz = valid[i].Z - seedRootZ[s];
                    localRFrac = Math.Min(1.0, Math.Sqrt(ldx * ldx + ldz * ldz) / maxSeedR[s]);
                }
                double lv = Math.Max(0, 1.0 - localRFrac * localRFrac);
                double localCone = lv * Math.Sqrt(lv) * localConeStr;

                double gcx = valid[i].X - cx;
                double gcz = valid[i].Z - cz;
                double globalRFrac = Math.Min(1.0,
                    Math.Sqrt(gcx * gcx + gcz * gcz) / maxNodeR);
                double gv = Math.Max(0, 1.0 - globalRFrac * globalRFrac);
                double globalCone = gv * Math.Sqrt(gv) * globalConeStr;

                double coneVal = Math.Max(localCone, globalCone);
                nodeHeight[i] = coneVal + flowFrac * (1.0 - coneVal);
            }

            // Step 5b: Smooth node heights
            for (int pass = 0; pass < ridgeSmooth; pass++)
            {
                var newH = new double[valid.Count];
                Array.Copy(nodeHeight, newH, valid.Count);
                for (int i = 0; i < valid.Count; i++)
                {
                    double sum = nodeHeight[i];
                    int cnt = 1;
                    int p = valid[i].Parent;
                    if (p >= 0) { sum += nodeHeight[p]; cnt++; }
                    foreach (int c in childrenFinal[i]) { sum += nodeHeight[c]; cnt++; }
                    newH[i] = sum / cnt;
                }
                Array.Copy(newH, nodeHeight, valid.Count);
            }

            // Step 6a: Extract chains
            var chains = new List<List<int>>();
            var visited = new bool[valid.Count];

            void TraceChains(int ni)
            {
                foreach (int kid in childrenFinal[ni])
                {
                    var chain = new List<int> { ni, kid };
                    visited[kid] = true;
                    int cur = kid;
                    while (childrenFinal[cur].Count == 1)
                    {
                        cur = childrenFinal[cur][0];
                        chain.Add(cur);
                        visited[cur] = true;
                    }
                    chains.Add(chain);
                    if (childrenFinal[cur].Count > 1)
                        TraceChains(cur);
                }
            }

            for (int i = 0; i < valid.Count; i++)
            {
                if (valid[i].Parent < 0 && !visited[i])
                {
                    visited[i] = true;
                    TraceChains(i);
                }
            }

            // Step 6b: Smooth chain positions (flow-weighted Laplacian)
            if (chainSmooth > 0)
            {
                var isFixed = new bool[valid.Count];
                for (int i = 0; i < valid.Count; i++)
                {
                    if (valid[i].Parent < 0 || childrenFinal[i].Count != 1)
                        isFixed[i] = true;
                }

                for (int pass = 0; pass < chainSmooth; pass++)
                {
                    var ox = new double[valid.Count];
                    var oz = new double[valid.Count];
                    for (int i = 0; i < valid.Count; i++)
                    { ox[i] = valid[i].X; oz[i] = valid[i].Z; }

                    foreach (var chain in chains)
                    {
                        for (int ci = 1; ci < chain.Count - 1; ci++)
                        {
                            int ni = chain[ci];
                            if (isFixed[ni]) continue;
                            double flowRatio = (double)childCount[ni] / maxFlow;
                            double alpha = 0.5 * (1.0 - Math.Pow(flowRatio, 0.3));
                            int pi = chain[ci - 1], qi = chain[ci + 1];
                            valid[ni].X = ox[ni] + alpha * ((ox[pi] + ox[qi]) / 2.0 - ox[ni]);
                            valid[ni].Z = oz[ni] + alpha * ((oz[pi] + oz[qi]) / 2.0 - oz[ni]);
                        }
                    }
                }
            }

            // Step 6c: Generate Catmull-Rom segments
            var segments = new List<RidgeSegment>();
            const int SUB = 4;

            foreach (var chain in chains)
            {
                if (chain.Count < 2) continue;
                int chainRoot = valid[chain[0]].RootIdx;

                var pts = new List<(double x, double z, double h)>();
                foreach (int idx in chain)
                    pts.Add((valid[idx].X, valid[idx].Z, nodeHeight[idx]));

                if (chain.Count < 3)
                {
                    for (int i = 0; i < pts.Count - 1; i++)
                    {
                        segments.Add(new RidgeSegment
                        {
                            X0 = pts[i].x, Z0 = pts[i].z, H0 = pts[i].h,
                            X1 = pts[i + 1].x, Z1 = pts[i + 1].z, H1 = pts[i + 1].h,
                            RootIdx = chainRoot
                        });
                    }
                }
                else
                {
                    var p0Ph = (x: 2 * pts[0].x - pts[1].x, z: 2 * pts[0].z - pts[1].z, h: pts[0].h);
                    int last = pts.Count - 1;
                    var pNPh = (x: 2 * pts[last].x - pts[last - 1].x,
                                z: 2 * pts[last].z - pts[last - 1].z, h: pts[last].h);

                    var allPts = new List<(double x, double z, double h)>();
                    allPts.Add(p0Ph);
                    allPts.AddRange(pts);
                    allPts.Add(pNPh);

                    for (int i = 0; i < allPts.Count - 3; i++)
                    {
                        var A = allPts[i]; var B = allPts[i + 1];
                        var C = allPts[i + 2]; var D = allPts[i + 3];

                        for (int s = 0; s < SUB; s++)
                        {
                            double t0 = (double)s / SUB;
                            double t1 = (double)(s + 1) / SUB;

                            CatmullRom(A.x, A.z, B.x, B.z, C.x, C.z, D.x, D.z, t0,
                                out double x0, out double z0);
                            CatmullRom(A.x, A.z, B.x, B.z, C.x, C.z, D.x, D.z, t1,
                                out double x1, out double z1);

                            segments.Add(new RidgeSegment
                            {
                                X0 = x0, Z0 = z0, H0 = B.h + (C.h - B.h) * t0,
                                X1 = x1, Z1 = z1, H1 = B.h + (C.h - B.h) * t1,
                                RootIdx = chainRoot
                            });
                        }
                    }
                }
            }

            if (segments.Count == 0) return null;

            // Resolve peak height from available headroom above sea level
            int worldHeight = sapi.WorldManager.MapSizeY;
            int seaLevel = (int)(worldHeight * 0.4313725490196078);
            double peakH = (worldHeight - seaLevel) * peakHeightFrac
                * RealisticWorldsMod.Config.GlobalHeightLimit;

            // Build feature
            double ridgeHalfWidth = ridgeWidth * stepSize * 0.5;

            var feature = new RidgeFeature
            {
                Segments = segments,
                SeedRootX = seedRootX,
                SeedRootZ = seedRootZ,
                MaxSeedRadius = maxSeedR,
                MaxNodeRadius = maxNodeR,
                PeakHeight = peakH,
                FalloffDist = falloffDist,
                LocalConeStr = localConeStr,
                GlobalConeStr = globalConeStr,
                RidgeHalfWidth = ridgeHalfWidth,
                DrainageBias = drainageBias,
                LogFalloff = logFalloff,
                FalloffNoiseStr = falloffNoise,
                FalloffNoiseScale = falloffNoiseScale,
                FalloffNoiseOct = falloffNoiseOct,
                SmoothPasses = smoothPasses,
                FalloffSmoothN = falloffSmooth,
                PlateauCut = plateauCut,
                FeatureCenterX = cx,
                FeatureCenterZ = cz
            };
            feature.ComputeBounds();
            return feature;
        }

        private static void CatmullRom(double p0x, double p0z, double p1x, double p1z,
            double p2x, double p2z, double p3x, double p3z, double t,
            out double rx, out double rz)
        {
            double t2 = t * t, t3 = t2 * t;
            rx = 0.5 * ((2 * p1x) + (-p0x + p2x) * t +
                (2 * p0x - 5 * p1x + 4 * p2x - p3x) * t2 +
                (-p0x + 3 * p1x - 3 * p2x + p3x) * t3);
            rz = 0.5 * ((2 * p1z) + (-p0z + p2z) * t +
                (2 * p0z - 5 * p1z + 4 * p2z - p3z) * t2 +
                (-p0z + 3 * p1z - 3 * p2z + p3z) * t3);
        }

        // --- Config loading ---

        private void LoadConfig()
        {
            try
            {
                string modConfigPath = System.IO.Path.Combine(
                    sapi.GetOrCreateDataPath("ModConfig"),
                    "IWantRealisticWorlds",
                    "ridges.json");

                string json = null;

                if (System.IO.File.Exists(modConfigPath))
                {
                    json = System.IO.File.ReadAllText(modConfigPath);
                }
                else
                {
                    var asset = sapi.Assets.Get(new AssetLocation("iwrw-ridges:config/ridges.json"));
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
                        config = new RidgeConfig();
                        return;
                    }
                }

                if (json != null)
                {
                    json = System.Text.RegularExpressions.Regex.Replace(
                        json, @"//.*$", "", System.Text.RegularExpressions.RegexOptions.Multiline);

                    config = new RidgeConfig();
                    var j = Vintagestory.API.Datastructures.JsonObject.FromJson(json);

                    config.AttractorCountMin = j["attractorCountMin"].AsInt(config.AttractorCountMin);
                    config.AttractorCountMax = j["attractorCountMax"].AsInt(config.AttractorCountMax);
                    config.CloudWidthMin = j["cloudWidthMin"].AsInt(config.CloudWidthMin);
                    config.CloudWidthMax = j["cloudWidthMax"].AsInt(config.CloudWidthMax);
                    config.CloudHeightMin = j["cloudHeightMin"].AsInt(config.CloudHeightMin);
                    config.CloudHeightMax = j["cloudHeightMax"].AsInt(config.CloudHeightMax);
                    config.StepSizeMin = j["stepSizeMin"].AsInt(config.StepSizeMin);
                    config.StepSizeMax = j["stepSizeMax"].AsInt(config.StepSizeMax);
                    config.KillDistMin = j["killDistMin"].AsInt(config.KillDistMin);
                    config.KillDistMax = j["killDistMax"].AsInt(config.KillDistMax);
                    config.InfluenceRadiusMin = j["influenceRadiusMin"].AsInt(config.InfluenceRadiusMin);
                    config.InfluenceRadiusMax = j["influenceRadiusMax"].AsInt(config.InfluenceRadiusMax);
                    config.MaxIterMin = j["maxIterMin"].AsInt(config.MaxIterMin);
                    config.MaxIterMax = j["maxIterMax"].AsInt(config.MaxIterMax);
                    config.SeedCountMin = j["seedCountMin"].AsInt(config.SeedCountMin);
                    config.SeedCountMax = j["seedCountMax"].AsInt(config.SeedCountMax);
                    config.SeedMinDistMin = j["seedMinDistMin"].AsInt(config.SeedMinDistMin);
                    config.SeedMinDistMax = j["seedMinDistMax"].AsInt(config.SeedMinDistMax);
                    config.SeedBorderMin = j["seedBorderMin"].AsInt(config.SeedBorderMin);
                    config.SeedBorderMax = j["seedBorderMax"].AsInt(config.SeedBorderMax);
                    config.WobbleMin = j["wobbleMin"].AsFloat(config.WobbleMin);
                    config.WobbleMax = j["wobbleMax"].AsFloat(config.WobbleMax);
                    config.OutwardBiasMin = j["outwardBiasMin"].AsFloat(config.OutwardBiasMin);
                    config.OutwardBiasMax = j["outwardBiasMax"].AsFloat(config.OutwardBiasMax);
                    config.CoherenceThresholdMin = j["coherenceThresholdMin"].AsFloat(config.CoherenceThresholdMin);
                    config.CoherenceThresholdMax = j["coherenceThresholdMax"].AsFloat(config.CoherenceThresholdMax);
                    config.MinBranchLenMin = j["minBranchLenMin"].AsInt(config.MinBranchLenMin);
                    config.MinBranchLenMax = j["minBranchLenMax"].AsInt(config.MinBranchLenMax);
                    config.MaxSpreadMin = j["maxSpreadMin"].AsInt(config.MaxSpreadMin);
                    config.MaxSpreadMax = j["maxSpreadMax"].AsInt(config.MaxSpreadMax);
                    config.PeakHeightMin = j["peakHeightMin"].AsFloat(config.PeakHeightMin);
                    config.PeakHeightMax = j["peakHeightMax"].AsFloat(config.PeakHeightMax);
                    config.LocalConeMin = j["localConeMin"].AsFloat(config.LocalConeMin);
                    config.LocalConeMax = j["localConeMax"].AsFloat(config.LocalConeMax);
                    config.GlobalConeMin = j["globalConeMin"].AsFloat(config.GlobalConeMin);
                    config.GlobalConeMax = j["globalConeMax"].AsFloat(config.GlobalConeMax);
                    config.FalloffDistMin = j["falloffDistMin"].AsInt(config.FalloffDistMin);
                    config.FalloffDistMax = j["falloffDistMax"].AsInt(config.FalloffDistMax);
                    config.RidgeWidthMin = j["ridgeWidthMin"].AsFloat(config.RidgeWidthMin);
                    config.RidgeWidthMax = j["ridgeWidthMax"].AsFloat(config.RidgeWidthMax);
                    config.DrainageBiasMin = j["drainageBiasMin"].AsFloat(config.DrainageBiasMin);
                    config.DrainageBiasMax = j["drainageBiasMax"].AsFloat(config.DrainageBiasMax);
                    config.LogFalloffMin = j["logFalloffMin"].AsFloat(config.LogFalloffMin);
                    config.LogFalloffMax = j["logFalloffMax"].AsFloat(config.LogFalloffMax);
                    config.ChainSmoothMin = j["chainSmoothMin"].AsInt(config.ChainSmoothMin);
                    config.ChainSmoothMax = j["chainSmoothMax"].AsInt(config.ChainSmoothMax);
                    config.RidgeSmoothMin = j["ridgeSmoothMin"].AsInt(config.RidgeSmoothMin);
                    config.RidgeSmoothMax = j["ridgeSmoothMax"].AsInt(config.RidgeSmoothMax);
                    config.SmoothPassesMin = j["smoothPassesMin"].AsInt(config.SmoothPassesMin);
                    config.SmoothPassesMax = j["smoothPassesMax"].AsInt(config.SmoothPassesMax);
                    config.FalloffNoiseMin = j["falloffNoiseMin"].AsFloat(config.FalloffNoiseMin);
                    config.FalloffNoiseMax = j["falloffNoiseMax"].AsFloat(config.FalloffNoiseMax);
                    config.FalloffNoiseScaleMin = j["falloffNoiseScaleMin"].AsFloat(config.FalloffNoiseScaleMin);
                    config.FalloffNoiseScaleMax = j["falloffNoiseScaleMax"].AsFloat(config.FalloffNoiseScaleMax);
                    config.FalloffNoiseOctMin = j["falloffNoiseOctMin"].AsInt(config.FalloffNoiseOctMin);
                    config.FalloffNoiseOctMax = j["falloffNoiseOctMax"].AsInt(config.FalloffNoiseOctMax);
                    config.FalloffSmoothMin = j["falloffSmoothMin"].AsInt(config.FalloffSmoothMin);
                    config.FalloffSmoothMax = j["falloffSmoothMax"].AsInt(config.FalloffSmoothMax);
                    config.PlateauCutMin = j["plateauCutMin"].AsFloat(config.PlateauCutMin);
                    config.PlateauCutMax = j["plateauCutMax"].AsFloat(config.PlateauCutMax);
                }
                else
                {
                    config = new RidgeConfig();
                }
            }
            catch (Exception ex)
            {
                sapi.Logger.Error($"[IWRWRidges] Config error: {ex.Message}");
                config = new RidgeConfig();
            }
        }
    }
}
