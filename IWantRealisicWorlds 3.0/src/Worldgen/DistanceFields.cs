using System;
using System.Collections.Generic;

namespace IWantRealisticWorlds.Worldgen
{
    // Port of tools/visualiser/distance-fields.js — DistanceFields.
    // distToOcean: multi-source weighted Dijkstra over the lattice point
    // adjacency, edge cost = Euclidean distance between adjacent points, COASTAL
    // points as sources (distance 0, exact on the coast polyline). Weighted (not
    // hop-count) so downstream tuned constants keep their pixel/block units.
    //
    // PARITY: the binary min-heap is replicated exactly (same comparisons, same
    // sift order) so the processing order — and thus the exact path-sum doubles —
    // matches the visualiser bit-for-bit.
    public sealed class DistanceFields
    {
        private readonly LatticeMesh mesh;
        private readonly ContinentGen continent;

        public double[] DistToOcean;

        public DistanceFields(LatticeMesh mesh, ContinentGen continent)
        {
            this.mesh = mesh;
            this.continent = continent;
            _computeDistToOcean();
        }

        private void _computeDistToOcean()
        {
            var pointClass = continent.PointClass;
            int n = mesh.NumAnchors;
            double[] ax = mesh.AX, az = mesh.AZ;

            var dist = new double[n];
            for (int i = 0; i < n; i++) dist[i] = double.PositiveInfinity;
            var visited = new byte[n];

            // Binary min-heap of (distance, anchor id), two parallel lists.
            var heapDist = new List<double>();
            var heapNode = new List<int>();
            void HeapPush(double d, int node)
            {
                int i = heapDist.Count;
                heapDist.Add(d); heapNode.Add(node);
                while (i > 0)
                {
                    int parent = (i - 1) >> 1;
                    if (heapDist[parent] <= heapDist[i]) break;
                    (heapDist[parent], heapDist[i]) = (heapDist[i], heapDist[parent]);
                    (heapNode[parent], heapNode[i]) = (heapNode[i], heapNode[parent]);
                    i = parent;
                }
            }
            (double d, int node) HeapPop()
            {
                double topD = heapDist[0]; int topNode = heapNode[0];
                double lastD = heapDist[heapDist.Count - 1]; heapDist.RemoveAt(heapDist.Count - 1);
                int lastNode = heapNode[heapNode.Count - 1]; heapNode.RemoveAt(heapNode.Count - 1);
                if (heapDist.Count > 0)
                {
                    heapDist[0] = lastD; heapNode[0] = lastNode;
                    int i = 0; int len = heapDist.Count;
                    while (true)
                    {
                        int smallest = i;
                        int l = 2 * i + 1, r = 2 * i + 2;
                        if (l < len && heapDist[l] < heapDist[smallest]) smallest = l;
                        if (r < len && heapDist[r] < heapDist[smallest]) smallest = r;
                        if (smallest == i) break;
                        (heapDist[smallest], heapDist[i]) = (heapDist[i], heapDist[smallest]);
                        (heapNode[smallest], heapNode[i]) = (heapNode[i], heapNode[smallest]);
                        i = smallest;
                    }
                }
                return (topD, topNode);
            }

            for (int t = 0; t < n; t++)
            {
                if (pointClass[t] == ContinentGen.POINT_COASTAL)
                {
                    dist[t] = 0;
                    HeapPush(0, t);
                }
            }

            while (heapDist.Count > 0)
            {
                var (d, t) = HeapPop();
                if (visited[t] != 0) continue;
                visited[t] = 1;
                if (d > dist[t]) continue; // stale entry
                var neighbors = mesh.NeighborsOfAnchor(t);
                for (int i = 0; i < neighbors.Count; i++)
                {
                    int t2 = neighbors[i];
                    if (visited[t2] != 0) continue;
                    double dx = ax[t] - ax[t2], dz = az[t] - az[t2];
                    double nd = d + Math.Sqrt(dx * dx + dz * dz);
                    if (nd < dist[t2])
                    {
                        dist[t2] = nd;
                        HeapPush(nd, t2);
                    }
                }
            }

            DistToOcean = dist;

            int coastCount = 0, finiteCount = 0; double maxDist = 0, sum = 0;
            for (int t = 0; t < n; t++)
            {
                if (dist[t] == 0) coastCount++;
                if (!double.IsPositiveInfinity(dist[t]))
                {
                    finiteCount++;
                    sum += dist[t];
                    if (dist[t] > maxDist) maxDist = dist[t];
                }
            }
            string mean = finiteCount > 0 ? (sum / finiteCount).ToString("F2") : "n/a";
            Log.Info($"[IWRW] [distance-fields] distToOcean: coastAnchors={coastCount}  maxDist={maxDist:F2}px  meanDist={mean}px");
            if (finiteCount < n)
                Log.Warn($"[IWRW] [distance-fields] {n - finiteCount} anchors never reached by Dijkstra (disconnected from any coast anchor?)");
        }

        public double DistToOceanAt(int anchorId) => DistToOcean[anchorId];

        public double GetDistToOceanAt(double x, double z) => DistToOcean[mesh.NearestAnchor(x, z)];
    }
}
