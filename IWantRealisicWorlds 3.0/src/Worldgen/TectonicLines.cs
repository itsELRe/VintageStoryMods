using System;
using System.Collections.Generic;

namespace IWantRealisticWorlds.Worldgen
{
    // Port of tools/visualiser/tectonic-lines.js — TectonicLines, the
    // "where am I relative to a tectonic line" primitive. Built from the plate
    // net's boundary masks + seed grid (from TectonicModel); owns junctions,
    // segments, polylines, joint nodes, and (in the .Query partial) collision
    // intensity, per-anchor kind hints, and the stick query provinces read.
    //
    // Split across partial files:
    //   TectonicLines.cs        — this file: geometry (junctions → segments →
    //                             polylines → nodes → snapping → T-pins) + the
    //                             polyline projection helpers.
    //   TectonicLines.Query.cs  — dynamics: assignPairTypes, computeAnchorKindHints,
    //                             computeCollisionIntensity, stick index, band
    //                             profile, kind distances.
    //
    // Deliberately NOT ported (scoped out of the base+climate path):
    //  - widthMul grid + blur (getProvinceWidthMultiplier / _computeWidthMulDirect
    //    / _buildWidthMulGrid / _boxBlur3x3): only ridges/rivers consume it →
    //    ports with the feature work.
    //  - getSegmentScalarAt / getJunctionInfluenceAt + the junction spatial index,
    //    junction.scalar, and the HV/broad noise fields that only feed them:
    //    DEAD (fed the retired upheaval band; no live consumers) → drop.
    //  - _buildSegmentContextGrids / _stampPolylineBand: JS-only per-pixel cache;
    //    the mod calls _computeSegmentContext on demand (identical at int pixels).
    //
    // PARITY NOTE: polyline x/z/t are Float32Array in JS (single precision). They
    // are stored here as float[] and promoted to double for all distance math, so
    // the truncation matches byte-for-byte.
    public sealed partial class TectonicLines
    {
        // Outward border normals for the four map sides [W, E, N, S].
        private static readonly int[][] EDGE_NORMALS = { new[] { -1, 0 }, new[] { 1, 0 }, new[] { 0, -1 }, new[] { 0, 1 } };

        public sealed class Junction
        {
            public double X, Z, BlobR;
            public string Type; // "active" | "fossil" (drives same-type BFS clustering)
        }

        public sealed class Polyline
        {
            public float[] X, Z, T;   // Float32 in JS — keep single precision
            public double Length;     // JS: plain-number cumulative length (double)
        }

        public sealed class Pin
        {
            public int Node;
            public double Arc;
            public double Val;        // set in computeCollisionIntensity
        }

        public sealed class Node
        {
            public double X, Z, Radius;
            public double CommonInt;  // set in computeCollisionIntensity
        }

        public sealed class Segment
        {
            public int Length;
            public bool IsActive;
            public bool OnPerimeter;
            public string PairKey;
            public WorldgenMath.ClosingType PairType = WorldgenMath.ClosingType.Convergent;
            public Polyline Polyline;
            public int NodeStart = -1, NodeEnd = -1;
            public List<Pin> Pins;
            // Dynamics (set in computeCollisionIntensity):
            public double Intensity;
            public int TallerSide;
            public double JStartInt, JEndInt;
            public bool JIntSet;      // JS: seg.jStartInt !== undefined guard
        }

        // Plate-net state copied from the model (same names → verbatim methods).
        private readonly int MapW, MapH, Seed;
        private readonly double GridSpacing;
        private readonly List<TectonicModel.PlateSeed> AllSeeds;
        // Not readonly: these are the TectonicModel's full-map grids, borrowed for
        // construction only and dropped by ReleaseScaffolding when the build ends.
        private int[] _seedGrid;
        private readonly int _seedGridStep, _seedGridGw, _seedGridGh;
        private byte[] _activeBoundaryGrid, _fossilBoundaryGrid;
        private readonly double _orogenW, _basinW, _platformW, _extendedCrustWidth, _widthFloor;
        private readonly double _mapScale, _jointRampLen;
        private readonly (double X, double Z)[] _plateVectors;
        private readonly (double X, double Z)[] _edgePhantomVectors;
        private readonly double _plateSpeedMax, _transformThreshold;

        public List<Junction> Junctions;
        public List<Segment> Segments;
        public List<Node> Nodes;
        // One int per MAP PIXEL naming which segment that pixel belongs to — the
        // single largest array in the whole mod (61 MB on a 8000x2000 map, to hold
        // ids for ~52 segments). Read only by _buildSegGrid, _buildSegmentPolylines
        // and _buildSegmentContext, all construction-time; the polylines and the
        // lookup grid they produce are what queries actually use. Dropped by
        // ReleaseScaffolding.
        private int[] _segmentLabel;

        // Segment spatial index (feeds _computeSegmentContext).
        private double _segCellSize;
        private int _segGridCols, _segGridRows, _segGridOff;
        private List<int>[] _segGrid; // buckets of (x, z, segId) triples

        // Mesh + stick index attach in the .Query partial.
        private LatticeMesh _mesh;

        public TectonicLines(TectonicModel tec)
        {
            MapW = tec.MapW; MapH = tec.MapH; Seed = tec.Seed;
            GridSpacing = tec.GridSpacing;
            AllSeeds = tec.AllSeeds;
            _seedGrid = tec.SeedGrid;
            _seedGridStep = tec.SeedGridStep; _seedGridGw = tec.SeedGridGw; _seedGridGh = tec.SeedGridGh;
            _activeBoundaryGrid = tec.ActiveBoundaryGrid; _fossilBoundaryGrid = tec.FossilBoundaryGrid;
            _orogenW = tec.OrogenW; _basinW = tec.BasinW; _platformW = tec.PlatformW;
            _extendedCrustWidth = tec.ExtendedCrustWidth; _widthFloor = tec.WidthFloor;
            _mapScale = WorldgenMath.PhiScale(Math.Max(MapW, MapH));
            _jointRampLen = GridSpacing * 0.35;
            _plateVectors = tec.PlateVectors;
            _edgePhantomVectors = tec.EdgePhantomVectors;
            _plateSpeedMax = tec.PlateSpeedMax;
            _transformThreshold = tec.TransformThreshold;

            _extractJunctions();
            _extractSegments();
            _buildNodes();
            _snapPolylinesToNodes();
            _buildTPins();

            Log.Info($"[IWRW] [tectonic-lines] segments={Segments.Count} junctions={Junctions.Count}");
        }

        // Junction extraction. A junction is a point where 3+ Voronoi cells meet.
        //   3+ distinct majors → 'active'; 1 major, 3+ distinct seeds → 'fossil'.
        //   2-majors case → not a junction (see JS comment: avoids false positives).
        // Connected junction pixels (same type) cluster into one junction via BFS.
        private void _extractJunctions()
        {
            int[] grid = _seedGrid;
            int step = _seedGridStep, gw = _seedGridGw, gh = _seedGridGh;
            var allSeeds = AllSeeds;
            int total = gw * gh;

            const byte T_NONE = 0, T_ACTIVE = 1, T_FOSSIL = 2;
            var typeMask = new byte[total];

            for (int gz = 1; gz < gh - 1; gz++)
            {
                for (int gx = 1; gx < gw - 1; gx++)
                {
                    var seedSet = new HashSet<int>();
                    for (int dz = -1; dz <= 1; dz++)
                        for (int dx = -1; dx <= 1; dx++)
                        {
                            int sid = grid[(gz + dz) * gw + (gx + dx)];
                            if (sid >= 0) seedSet.Add(sid);
                        }
                    if (seedSet.Count < 3) continue;

                    var majors = new HashSet<int>();
                    foreach (int sid in seedSet) majors.Add(allSeeds[sid].PlateId);

                    if (majors.Count >= 3) typeMask[gz * gw + gx] = T_ACTIVE;
                    else if (majors.Count == 1) typeMask[gz * gw + gx] = T_FOSSIL;
                    // majors.Count == 2 → not a junction
                }
            }

            Junctions = new List<Junction>();
            var label = new int[total];
            for (int i = 0; i < total; i++) label[i] = -1;
            var stack = new List<int>();

            for (int gz = 0; gz < gh; gz++)
            {
                for (int gx = 0; gx < gw; gx++)
                {
                    int i0 = gz * gw + gx;
                    if (typeMask[i0] == T_NONE || label[i0] >= 0) continue;
                    byte myType = typeMask[i0];
                    int segId = Junctions.Count;
                    label[i0] = segId;
                    stack.Clear();
                    stack.Add(i0);
                    double sumX = 0, sumZ = 0; int count = 0;
                    var blobXs = new List<double>(); var blobZs = new List<double>();

                    while (stack.Count > 0)
                    {
                        int j = stack[stack.Count - 1]; stack.RemoveAt(stack.Count - 1);
                        int jx = j % gw;
                        int jz = (j - jx) / gw;
                        sumX += jx * step;
                        sumZ += jz * step;
                        blobXs.Add(jx * step);
                        blobZs.Add(jz * step);
                        count++;
                        if (jx > 0) { int ni = j - 1; if (typeMask[ni] == myType && label[ni] < 0) { label[ni] = segId; stack.Add(ni); } }
                        if (jx < gw - 1) { int ni = j + 1; if (typeMask[ni] == myType && label[ni] < 0) { label[ni] = segId; stack.Add(ni); } }
                        if (jz > 0) { int ni = j - gw; if (typeMask[ni] == myType && label[ni] < 0) { label[ni] = segId; stack.Add(ni); } }
                        if (jz < gh - 1) { int ni = j + gw; if (typeMask[ni] == myType && label[ni] < 0) { label[ni] = segId; stack.Add(ni); } }
                    }

                    double cx = sumX / count, cz = sumZ / count;
                    double blobR = 0;
                    for (int b = 0; b < count; b++)
                    {
                        double d = Math.Sqrt((blobXs[b] - cx) * (blobXs[b] - cx) + (blobZs[b] - cz) * (blobZs[b] - cz));
                        if (d > blobR) blobR = d;
                    }

                    Junctions.Add(new Junction
                    {
                        X = cx,
                        Z = cz,
                        BlobR = blobR,
                        Type = myType == T_ACTIVE ? "active" : "fossil",
                    });
                }
            }
            // (junction spatial index + influence dropped — dead, see header)
        }

        // Segment extraction. A segment is a connected run of boundary pixels with
        // the same plate-pair. Each stores length + a fixed length-driven scalar.
        private void _extractSegments()
        {
            int mapW = MapW, mapH = MapH;
            var allSeeds = AllSeeds;
            int[] grid = _seedGrid;
            int step = _seedGridStep, gw = _seedGridGw, gh = _seedGridGh;
            int total = mapW * mapH;

            var pairLabel = new int[total];
            for (int i = 0; i < total; i++) pairLabel[i] = -1;
            var pairActive = new byte[total];
            var pairKeys = new Dictionary<string, int>(); // key → integer pair ID (pid = insertion index)
            var labelToKey = new List<string>();

            for (int gz = 1; gz < gh - 1; gz++)
            {
                for (int gx = 1; gx < gw - 1; gx++)
                {
                    int px = gx * step, pz = gz * step;
                    if (px >= mapW || pz >= mapH) continue;
                    int pi = pz * mapW + px;
                    bool isActive = _activeBoundaryGrid[pi] == 1;
                    bool isFossil = _fossilBoundaryGrid[pi] == 1;
                    if (!isActive && !isFossil) continue;

                    int idx = grid[gz * gw + gx];
                    if (idx < 0) continue;
                    int myPlate = allSeeds[idx].PlateId;

                    string key = null;
                    int[] ns =
                    {
                        grid[gz * gw + (gx - 1)],
                        grid[gz * gw + (gx + 1)],
                        grid[(gz - 1) * gw + gx],
                        grid[(gz + 1) * gw + gx],
                    };
                    foreach (int ni in ns)
                    {
                        if (ni < 0 || ni == idx) continue;
                        int otherPlate = allSeeds[ni].PlateId;
                        if (isActive && otherPlate != myPlate)
                        {
                            int a = Math.Min(myPlate, otherPlate), b = Math.Max(myPlate, otherPlate);
                            key = "A" + a + "," + b;
                            break;
                        }
                        if (isFossil && otherPlate == myPlate)
                        {
                            int a = Math.Min(idx, ni), b = Math.Max(idx, ni);
                            key = "F" + a + "," + b;
                            break;
                        }
                    }
                    if (key == null)
                    {
                        // Perimeter frame: register each plate's edge frontage as a
                        // REAL active pair against that side's PHANTOM plate.
                        bool onEdgeFrame = gx <= 1 || gx >= gw - 2 || gz <= 1 || gz >= gh - 2;
                        if (isActive && onEdgeFrame)
                        {
                            int side = gx <= 1 ? 0 : gx >= gw - 2 ? 1 : gz <= 1 ? 2 : 3;
                            key = "E" + side + ":" + myPlate;
                        }
                        else continue;
                    }

                    if (!pairKeys.TryGetValue(key, out int pid))
                    {
                        pid = pairKeys.Count; pairKeys[key] = pid; labelToKey.Add(key);
                    }
                    pairLabel[pi] = pid;
                    pairActive[pi] = (byte)(isActive ? 1 : 0);
                }
            }

            // Connected-components grouping. Same pair, (2r+1)-window adjacency.
            Segments = new List<Segment>();
            var segmentLabel = new int[total];
            for (int i = 0; i < total; i++) segmentLabel[i] = -1;
            var stack = new List<int>();

            for (int z = 0; z < mapH; z++)
            {
                for (int x = 0; x < mapW; x++)
                {
                    int i0 = z * mapW + x;
                    if (pairLabel[i0] == -1 || segmentLabel[i0] >= 0) continue;
                    int myPair = pairLabel[i0];
                    bool myActive = pairActive[i0] == 1;
                    int segId = Segments.Count;
                    segmentLabel[i0] = segId;
                    stack.Clear();
                    stack.Add(i0);
                    int count = 0;
                    bool onPerimeter = false;

                    while (stack.Count > 0)
                    {
                        int j = stack[stack.Count - 1]; stack.RemoveAt(stack.Count - 1);
                        int jx = j % mapW;
                        int jz = (j - jx) / mapW;
                        count++;
                        if (jx <= 1 || jx >= mapW - 2 || jz <= 1 || jz >= mapH - 2) onPerimeter = true;
                        int r = _seedGridStep;
                        for (int dz = -r; dz <= r; dz++)
                        {
                            for (int dx = -r; dx <= r; dx++)
                            {
                                if (dx == 0 && dz == 0) continue;
                                int nx = jx + dx, nz = jz + dz;
                                if (nx < 0 || nx >= mapW || nz < 0 || nz >= mapH) continue;
                                int ni = nz * mapW + nx;
                                if (pairLabel[ni] == myPair && segmentLabel[ni] < 0)
                                {
                                    segmentLabel[ni] = segId;
                                    stack.Add(ni);
                                }
                            }
                        }
                    }

                    Segments.Add(new Segment
                    {
                        Length = count,
                        IsActive = myActive,
                        OnPerimeter = onPerimeter,
                        PairKey = labelToKey[myPair],
                        PairType = WorldgenMath.ClosingType.Convergent, // real value set in AssignPairTypes
                    });
                }
            }

            _segmentLabel = segmentLabel;
            // NOTE: still needed here — _buildSegGrid / _buildSegmentPolylines /
            // _buildSegmentContext read it later in the same construction.
            _buildSegmentSpatialIndex();
            _buildSegmentPolylines();
        }

        private void _buildSegmentSpatialIndex()
        {
            int mapW = MapW, mapH = MapH;
            double cellSize = Math.Max(20, GridSpacing * 0.3);
            _segCellSize = cellSize;
            _segGridCols = (int)Math.Ceiling(mapW / cellSize) + 4;
            _segGridRows = (int)Math.Ceiling(mapH / cellSize) + 4;
            _segGridOff = 2;
            int len = _segGridCols * _segGridRows;
            _segGrid = new List<int>[len];
            for (int i = 0; i < len; i++) _segGrid[i] = new List<int>();

            for (int z = 0; z < mapH; z++)
            {
                for (int x = 0; x < mapW; x++)
                {
                    int i = z * mapW + x;
                    int segId = _segmentLabel[i];
                    if (segId < 0) continue;
                    int gcx = (int)Math.Floor(x / cellSize) + _segGridOff;
                    int gcz = (int)Math.Floor(z / cellSize) + _segGridOff;
                    if (gcx >= 0 && gcx < _segGridCols && gcz >= 0 && gcz < _segGridRows)
                    {
                        var b = _segGrid[gcz * _segGridCols + gcx];
                        b.Add(x); b.Add(z); b.Add(segId);
                    }
                }
            }
        }

        // Per segment, walk its pixel cluster into an ordered polyline with a
        // cumulative arc-length parameterization. Deterministic walk (see JS).
        private void _buildSegmentPolylines()
        {
            int mapW = MapW;
            var segs = Segments;
            int[] labels = _segmentLabel;
            int n = segs.Count;

            var pixelsBySeg = new List<int>[n];
            for (int i = 0; i < n; i++) pixelsBySeg[i] = new List<int>();
            int total = labels.Length;
            for (int i = 0; i < total; i++)
            {
                int sid = labels[i];
                if (sid < 0) continue;
                int x = i % mapW;
                int z = (i - x) / mapW;
                pixelsBySeg[sid].Add(x); pixelsBySeg[sid].Add(z);
            }

            for (int sid = 0; sid < n; sid++)
            {
                var pix = pixelsBySeg[sid];
                int m = pix.Count / 2;
                if (m == 0) { segs[sid].Polyline = null; continue; }
                if (m == 1)
                {
                    segs[sid].Polyline = new Polyline
                    {
                        X = new[] { (float)pix[0] },
                        Z = new[] { (float)pix[1] },
                        T = new[] { 0f },
                        Length = 0,
                    };
                    continue;
                }
                segs[sid].Polyline = _walkSegment(pix, m, sid);
            }
        }

        // Greedy walk from a deterministic endpoint; keep the longest connected run.
        private Polyline _walkSegment(List<int> pix, int m, int segId)
        {
            int mapW = MapW, mapH = MapH;
            int[] labels = _segmentLabel;
            int r = _seedGridStep;
            double gapSq = r * r * 2 + r;

            var visited = new byte[m];
            int NeighbourCount(int i)
            {
                int x = pix[2 * i], z = pix[2 * i + 1];
                int cnt = 0;
                for (int dz = -r; dz <= r; dz++)
                    for (int dx = -r; dx <= r; dx++)
                    {
                        if (dx == 0 && dz == 0) continue;
                        int nx = x + dx, nz = z + dz;
                        if (nx < 0 || nx >= mapW || nz < 0 || nz >= mapH) continue;
                        if (labels[nz * mapW + nx] == segId) cnt++;
                    }
                return cnt;
            }

            List<int> order = null;
            while (true)
            {
                int start = -1; double startNb = double.PositiveInfinity;
                for (int i = 0; i < m; i++)
                {
                    if (visited[i] != 0) continue;
                    int c = NeighbourCount(i);
                    if (c < startNb) { startNb = c; start = i; if (c <= 1) break; }
                }
                if (start < 0) break;

                var run = new List<int> { start };
                visited[start] = 1;
                int cur = start;
                while (true)
                {
                    int cx = pix[2 * cur], cz = pix[2 * cur + 1];
                    int bestJ = -1; double bestD2 = double.PositiveInfinity;
                    for (int j = 0; j < m; j++)
                    {
                        if (visited[j] != 0) continue;
                        double dx = pix[2 * j] - cx, dz = pix[2 * j + 1] - cz;
                        double d2 = dx * dx + dz * dz;
                        if (d2 < bestD2) { bestD2 = d2; bestJ = j; }
                    }
                    if (bestJ < 0 || bestD2 > gapSq) break;
                    visited[bestJ] = 1;
                    run.Add(bestJ);
                    cur = bestJ;
                }
                if (order == null || run.Count > order.Count) order = run;
            }

            int k = order.Count;
            // Dbg, not Warn: a segment splitting into runs is a band-quality note
            // for us, not something a player can act on or should see flagged.
            if (k < m * 0.5)
                Log.Dbg($"[IWRW] [walkSegment] seg {segId}: longest run {k}/{m}px — multiple large runs, band may still cut.");
            var xArr = new float[k];
            var zArr = new float[k];
            var tArr = new float[k];
            xArr[0] = pix[2 * order[0]];
            zArr[0] = pix[2 * order[0] + 1];
            tArr[0] = 0;
            double cumLen = 0;
            for (int i = 1; i < k; i++)
            {
                xArr[i] = pix[2 * order[i]];
                zArr[i] = pix[2 * order[i] + 1];
                double dx = xArr[i] - xArr[i - 1], dz = zArr[i] - zArr[i - 1];
                cumLen += Math.Sqrt(dx * dx + dz * dz);
                tArr[i] = (float)cumLen;
            }
            return new Polyline { X = xArr, Z = zArr, T = tArr, Length = cumLen };
        }

        // ===== Joint nodes (type-less) =====
        // Every line meeting at a joint shares the SAME joint value. Junction blobs
        // (extracted per type) merge across type when overlapping; endpoint clusters
        // add nodes for meetings with no blob (edge corners, border hits, mixed).
        private void _buildNodes()
        {
            double slack = _seedGridStep * 8;

            // Union-find over `count` items; closeFn(i,j) merges.
            Dictionary<int, List<int>> MergeGroups(int count, Func<int, int, bool> closeFn)
            {
                var parent = new int[count];
                for (int i = 0; i < count; i++) parent[i] = i;
                int Find(int i) { while (parent[i] != i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
                for (int i = 0; i < count; i++)
                    for (int j = i + 1; j < count; j++)
                        if (closeFn(i, j)) parent[Find(i)] = Find(j);
                var groups = new Dictionary<int, List<int>>();
                for (int i = 0; i < count; i++)
                {
                    int rt = Find(i);
                    if (!groups.TryGetValue(rt, out var lst)) { lst = new List<int>(); groups[rt] = lst; }
                    lst.Add(i);
                }
                return groups;
            }

            // 1. Junction blobs, merged across type when they overlap.
            Nodes = new List<Node>();
            var jxs = Junctions;
            var jGroups = MergeGroups(jxs.Count, (i, j) =>
            {
                var a = jxs[i]; var b = jxs[j];
                return Math.Sqrt((a.X - b.X) * (a.X - b.X) + (a.Z - b.Z) * (a.Z - b.Z)) <= a.BlobR + b.BlobR + slack;
            });
            foreach (var members in jGroups.Values)
            {
                double sx = 0, sz = 0;
                foreach (int i in members) { sx += jxs[i].X; sz += jxs[i].Z; }
                double x = sx / members.Count, z = sz / members.Count;
                double radius = 0;
                foreach (int i in members)
                    radius = Math.Max(radius, Math.Sqrt((jxs[i].X - x) * (jxs[i].X - x) + (jxs[i].Z - z) * (jxs[i].Z - z)) + jxs[i].BlobR);
                Nodes.Add(new Node { X = x, Z = z, Radius = radius });
            }
            int blobNodes = Nodes.Count;

            // 2. Endpoint clusters: polyline ends not covered by any blob node.
            var loose = new List<(double X, double Z)>();
            foreach (var seg in Segments)
            {
                var poly = seg.Polyline;
                if (poly == null || poly.X.Length < 2) continue;
                int L = poly.X.Length - 1;
                var ends = new[] { ((double)poly.X[0], (double)poly.Z[0]), ((double)poly.X[L], (double)poly.Z[L]) };
                foreach (var (ex, ez) in ends)
                {
                    bool covered = false;
                    foreach (var n in Nodes)
                    {
                        if (Math.Sqrt((n.X - ex) * (n.X - ex) + (n.Z - ez) * (n.Z - ez)) <= n.Radius + slack) { covered = true; break; }
                    }
                    if (!covered) loose.Add((ex, ez));
                }
            }
            var eGroups = MergeGroups(loose.Count, (i, j) =>
                Math.Sqrt((loose[i].X - loose[j].X) * (loose[i].X - loose[j].X) + (loose[i].Z - loose[j].Z) * (loose[i].Z - loose[j].Z)) <= slack);
            foreach (var members in eGroups.Values)
            {
                if (members.Count < 2) continue;
                double sx = 0, sz = 0;
                foreach (int i in members) { sx += loose[i].X; sz += loose[i].Z; }
                double x = sx / members.Count, z = sz / members.Count;
                double radius = 0;
                foreach (int i in members)
                    radius = Math.Max(radius, Math.Sqrt((loose[i].X - x) * (loose[i].X - x) + (loose[i].Z - z) * (loose[i].Z - z)));
                Nodes.Add(new Node { X = x, Z = z, Radius = radius });
            }

            Log.Info($"[IWRW] [tectonic-lines] joint nodes: {Nodes.Count} ({blobNodes} merged junction blobs + {Nodes.Count - blobNodes} endpoint clusters)");
        }

        // Snap each arm's endpoints to the node it terminates against.
        private void _snapPolylinesToNodes()
        {
            double slack = _seedGridStep * 8;
            var nodes = Nodes;
            int snapped = 0, free = 0;

            int NearestNode(double px, double pz)
            {
                int best = -1; double bestD = double.PositiveInfinity;
                for (int n = 0; n < nodes.Count; n++)
                {
                    double d = Math.Sqrt((nodes[n].X - px) * (nodes[n].X - px) + (nodes[n].Z - pz) * (nodes[n].Z - pz));
                    if (d < bestD) { bestD = d; best = n; }
                }
                return (best >= 0 && bestD <= nodes[best].Radius + slack) ? best : -1;
            }

            foreach (var seg in Segments)
            {
                seg.NodeStart = -1;
                seg.NodeEnd = -1;
                var poly = seg.Polyline;
                if (poly == null || poly.X.Length < 2) continue;

                int L = poly.X.Length - 1;
                int ns = NearestNode(poly.X[0], poly.Z[0]);
                int ne = NearestNode(poly.X[L], poly.Z[L]);
                if (ns >= 0) snapped++; else free++;
                if (ne >= 0) snapped++; else free++;
                if (ns >= 0) _snapEndToNode(seg, 0, ns);
                if (ne >= 0) _snapEndToNode(seg, 1, ne);
            }

            Log.Info($"[IWRW] [tectonic-lines] polyline ends snapped to nodes: {snapped} snapped, {free} free");
        }

        // Tie one polyline end to a node: add the node as the final vertex and
        // rebuild the cumulative arc lengths (prepend shifts existing pins).
        private void _snapEndToNode(Segment seg, int end, int nodeId)
        {
            var node = Nodes[nodeId];
            var poly = seg.Polyline;
            var xs = new List<double>(); var zs = new List<double>();
            for (int i = 0; i < poly.X.Length; i++) { xs.Add(poly.X[i]); zs.Add(poly.Z[i]); }
            double prependLen = 0;
            if (end == 0)
            {
                seg.NodeStart = nodeId;
                double d = Math.Sqrt((xs[0] - node.X) * (xs[0] - node.X) + (zs[0] - node.Z) * (zs[0] - node.Z));
                if (d > 1e-3) { prependLen = d; xs.Insert(0, node.X); zs.Insert(0, node.Z); }
            }
            else
            {
                seg.NodeEnd = nodeId;
                if (Math.Sqrt((xs[xs.Count - 1] - node.X) * (xs[xs.Count - 1] - node.X) + (zs[zs.Count - 1] - node.Z) * (zs[zs.Count - 1] - node.Z)) > 1e-3)
                { xs.Add(node.X); zs.Add(node.Z); }
            }
            int k = xs.Count;
            var xArr = new float[k]; var zArr = new float[k]; var tArr = new float[k];
            for (int i = 0; i < k; i++) { xArr[i] = (float)xs[i]; zArr[i] = (float)zs[i]; }
            double cum = 0;
            for (int i = 1; i < k; i++)
            {
                double dx = xArr[i] - xArr[i - 1], dz = zArr[i] - zArr[i - 1];
                cum += Math.Sqrt(dx * dx + dz * dz);
                tArr[i] = (float)cum;
            }
            seg.Polyline = new Polyline { X = xArr, Z = zArr, T = tArr, Length = cum };
            if (prependLen > 0 && seg.Pins != null)
                foreach (var p in seg.Pins) p.Arc += prependLen;
        }

        // T-joints: a polyline end still free after node snapping is tied to the
        // nearest OTHER segment's polyline, with a node AT the contact point and a
        // width pin on the through-line.
        private void _buildTPins()
        {
            double slack = _seedGridStep * 8;
            var segs = Segments;
            int tJoints = 0;
            for (int sid = 0; sid < segs.Count; sid++)
            {
                var seg = segs[sid];
                foreach (int end in new[] { 0, 1 })
                {
                    var poly = seg.Polyline; // re-read: snapping replaces the object
                    if (poly == null || poly.X.Length < 2) continue;
                    if ((end == 0 ? seg.NodeStart : seg.NodeEnd) >= 0) continue;
                    int L = poly.X.Length - 1;
                    double ex = end == 0 ? poly.X[0] : poly.X[L];
                    double ez = end == 0 ? poly.Z[0] : poly.Z[L];

                    int best = -1; Proj bestProj = default;
                    for (int os = 0; os < segs.Count; os++)
                    {
                        if (os == sid) continue;
                        var op = segs[os].Polyline;
                        if (op == null || op.X.Length < 2) continue;
                        var proj = _projectOntoPolyline(ex, ez, op);
                        if (proj.Dist <= slack && (best < 0 || proj.Dist < bestProj.Dist)) { best = os; bestProj = proj; }
                    }
                    if (best < 0) continue;

                    var through = segs[best];
                    var pos = _polylinePosition(through.Polyline, bestProj.T);
                    int nodeId = -1;
                    for (int n = 0; n < Nodes.Count; n++)
                    {
                        if (Math.Sqrt((Nodes[n].X - pos.X) * (Nodes[n].X - pos.X) + (Nodes[n].Z - pos.Z) * (Nodes[n].Z - pos.Z)) <= Nodes[n].Radius + slack) { nodeId = n; break; }
                    }
                    if (nodeId < 0)
                    {
                        nodeId = Nodes.Count;
                        Nodes.Add(new Node { X = pos.X, Z = pos.Z, Radius = 0 });
                    }
                    _snapEndToNode(seg, end, nodeId);
                    if (through.Pins == null) through.Pins = new List<Pin>();
                    bool has = false;
                    foreach (var p in through.Pins) if (p.Node == nodeId) { has = true; break; }
                    if (!has) through.Pins.Add(new Pin { Node = nodeId, Arc = bestProj.T * through.Polyline.Length });
                    tJoints++;
                }
            }
            Log.Info($"[IWRW] [tectonic-lines] T-joints: {tJoints} line-into-line connections");
        }

        // ===== Polyline projection helpers =====

        public struct Proj { public double Dist; public double T; public int Side; }

        // Closest point on a polyline. Euclidean perpendicular distance, normalized
        // arcParam, and side (sign of edge × offset). Float32 verts → double math.
        private Proj _projectOntoPolyline(double x, double z, Polyline poly)
        {
            float[] xs = poly.X, zs = poly.Z, ts = poly.T;
            int m = xs.Length;
            if (m == 0) return new Proj { Dist = double.PositiveInfinity, T = 0, Side = 0 };
            if (m == 1)
            {
                double dx0 = x - xs[0], dz0 = z - zs[0];
                return new Proj { Dist = Math.Sqrt(dx0 * dx0 + dz0 * dz0), T = 0, Side = 0 };
            }

            double bestD2 = double.PositiveInfinity, bestArc = 0; int bestSide = 0;
            for (int k = 0; k < m - 1; k++)
            {
                double ax = xs[k], az = zs[k];
                double ex = xs[k + 1] - ax, ez = zs[k + 1] - az;
                double lenSq = ex * ex + ez * ez;
                if (lenSq < 1e-9) continue;
                double dxa = x - ax, dza = z - az;
                double s = (dxa * ex + dza * ez) / lenSq;
                if (s < 0) s = 0; else if (s > 1) s = 1;
                double px = ax + s * ex, pz = az + s * ez;
                double ddx = x - px, ddz = z - pz;
                double d2 = ddx * ddx + ddz * ddz;
                if (d2 < bestD2)
                {
                    bestD2 = d2;
                    bestArc = ts[k] + s * (ts[k + 1] - ts[k]);
                    bestSide = (ex * ddz - ez * ddx) >= 0 ? 1 : -1;
                }
            }

            return new Proj
            {
                Dist = Math.Sqrt(bestD2),
                T = poly.Length > 0 ? bestArc / poly.Length : 0,
                Side = bestSide,
            };
        }

        // (x, z) at a given arcParam ∈ [0, 1] along a polyline. Binary search over
        // cumulative arc-lengths, then linear interpolation.
        private (double X, double Z) _polylinePosition(Polyline poly, double arcParam)
        {
            float[] xs = poly.X, zs = poly.Z, ts = poly.T;
            int m = xs.Length;
            if (m == 1) return (xs[0], zs[0]);
            double target = arcParam * poly.Length;
            int lo = 0, hi = m - 1;
            while (lo < hi - 1)
            {
                int mid = (lo + hi) >> 1;
                if (ts[mid] <= target) lo = mid;
                else hi = mid;
            }
            double seg = ts[hi] - ts[lo];
            double s = seg > 0 ? (target - ts[lo]) / seg : 0;
            return (xs[lo] + s * (xs[hi] - xs[lo]), zs[lo] + s * (zs[hi] - zs[lo]));
        }
    }
}
