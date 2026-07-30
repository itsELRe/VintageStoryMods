using System;
using System.Collections.Generic;

namespace IWantRealisticWorlds.Worldgen
{
    // Dynamics half of TectonicLines (see TectonicLines.cs header): pair-type
    // assignment, segment-context lookup, per-anchor kind hints, collision
    // intensity + joint values + the stick lookup grid, and the query API that
    // provinces / upheaval / climate read.
    public sealed partial class TectonicLines
    {
        // Per-anchor nearest-segment-id hints (mountain/rift × active/fossil).
        private int[] _anchorMtnActiveSeg, _anchorMtnFossilSeg, _anchorRiftActiveSeg, _anchorRiftFossilSeg;

        // Stick lookup grid (built by _buildStickIndex, after intensities exist).
        private double _stickCellSize;
        private int _stickCols, _stickRows;
        private List<int>[] _stickGrid;

        public struct SegContext { public int SegmentId; public double ArcParam; public double Dist; public int Side; }

        public struct KindDistances
        {
            public double MtnActive, MtnFossil, RiftActive, RiftFossil;
            public int MtnActiveSeg, MtnFossilSeg, RiftActiveSeg, RiftFossilSeg;
            public double MtnActiveArc, MtnFossilArc, RiftActiveArc, RiftFossilArc;
        }

        // Tag each segment with its plate-pair interaction type. Called after the
        // model's ComputePlatePairTypes. Provinces + upheaval read seg.PairType.
        public void AssignPairTypes(Dictionary<string, WorldgenMath.ClosingType> platePairTypes)
        {
            foreach (var seg in Segments)
            {
                string k = seg.PairKey;
                if (k != null && k[0] == 'A')
                {
                    seg.PairType = platePairTypes.TryGetValue(k.Substring(1), out var t) ? t : WorldgenMath.ClosingType.Convergent;
                }
                else if (k != null && k[0] == 'F')
                {
                    var p = k.Substring(1).Split(',');
                    int ia = int.Parse(p[0]), ib = int.Parse(p[1]);
                    var sa = (ia >= 0 && ia < AllSeeds.Count) ? AllSeeds[ia] : null;
                    var sb = (ib >= 0 && ib < AllSeeds.Count) ? AllSeeds[ib] : null;
                    seg.PairType = (sa != null && sb != null)
                        ? WorldgenMath.ClassifyClosing(sa.VecX, sa.VecZ, sb.VecX, sb.VecZ, sa.X, sa.Z, sb.X, sb.Z, _transformThreshold)
                        : WorldgenMath.ClosingType.Convergent;
                }
                else if (k != null && k[0] == 'E')
                {
                    int side = k[1] - '0';
                    int plateId = int.Parse(k.Substring(3));
                    var sa = (plateId >= 0 && plateId < AllSeeds.Count) ? AllSeeds[plateId] : null;
                    var n = EDGE_NORMALS[side];
                    seg.PairType = (sa != null)
                        ? WorldgenMath.ClassifyClosing(sa.VecX, sa.VecZ, _edgePhantomVectors[side].X, _edgePhantomVectors[side].Z,
                            sa.X, sa.Z, sa.X + n[0], sa.Z + n[1], _transformThreshold)
                        : WorldgenMath.ClosingType.Convergent;
                }
                else
                {
                    seg.PairType = WorldgenMath.ClosingType.Convergent;
                }
            }
        }

        // Direct segment-context compute. Spatial-index candidates in a growing
        // cell window, project onto each candidate polyline, pick the closest.
        // wantRift: null = any kind; true/false = require divergent / not-divergent.
        private SegContext? _computeSegmentContext(double x, double z, bool isActive, bool? wantRift = null)
        {
            if (_segGrid == null) return null;
            var segs = Segments;
            double cs = _segCellSize;
            int gcx = (int)Math.Floor(x / cs) + _segGridOff;
            int gcz = (int)Math.Floor(z / cs) + _segGridOff;
            int wantActive = isActive ? 1 : 0;

            double bestDist = double.PositiveInfinity;
            int bestSegId = -1; double bestT = 0; int bestSide = 0;
            var seenIds = new List<int>();

            for (int pass = 0; pass < 2; pass++)
            {
                int reach = pass == 0 ? 1 : 2;
                for (int dz = -reach; dz <= reach; dz++)
                {
                    for (int dx = -reach; dx <= reach; dx++)
                    {
                        int ci = gcz + dz, cj = gcx + dx;
                        if (ci < 0 || ci >= _segGridRows || cj < 0 || cj >= _segGridCols) continue;
                        var bucket = _segGrid[ci * _segGridCols + cj];
                        for (int k = 0; k < bucket.Count; k += 3)
                        {
                            int segId = bucket[k + 2];
                            bool already = false;
                            for (int s = 0; s < seenIds.Count; s++) if (seenIds[s] == segId) { already = true; break; }
                            if (already) continue;
                            seenIds.Add(segId);
                            var seg = segs[segId];
                            if ((seg.IsActive ? 1 : 0) != wantActive) continue;
                            if (wantRift != null && (seg.PairType == WorldgenMath.ClosingType.Divergent) != wantRift.Value) continue;
                            if (seg.Polyline == null) continue;
                            var proj = _projectOntoPolyline(x, z, seg.Polyline);
                            if (proj.Dist < bestDist)
                            {
                                bestDist = proj.Dist;
                                bestSegId = segId;
                                bestT = proj.T;
                                bestSide = proj.Side;
                            }
                        }
                    }
                }
                if (bestSegId >= 0) break;
            }

            if (bestSegId < 0) return null;
            return new SegContext { SegmentId = bestSegId, ArcParam = bestT, Dist = bestDist, Side = bestSide };
        }

        // Per-anchor nearest-segment-id cache, one per kind. Stores the mesh so the
        // distance queries below don't need every caller to thread it through.
        public void ComputeAnchorKindHints(LatticeMesh mesh)
        {
            _mesh = mesh;
            int n = mesh.NumAnchors;
            _anchorMtnActiveSeg = new int[n]; _anchorMtnFossilSeg = new int[n];
            _anchorRiftActiveSeg = new int[n]; _anchorRiftFossilSeg = new int[n];
            for (int i = 0; i < n; i++) { _anchorMtnActiveSeg[i] = -1; _anchorMtnFossilSeg[i] = -1; _anchorRiftActiveSeg[i] = -1; _anchorRiftFossilSeg[i] = -1; }

            for (int t = 0; t < n; t++)
            {
                double x = mesh.AX[t], z = mesh.AZ[t];
                var mA = _computeSegmentContext(x, z, true, false);
                var mF = _computeSegmentContext(x, z, false, false);
                var rA = _computeSegmentContext(x, z, true, true);
                var rF = _computeSegmentContext(x, z, false, true);
                _anchorMtnActiveSeg[t] = mA.HasValue ? mA.Value.SegmentId : -1;
                _anchorMtnFossilSeg[t] = mF.HasValue ? mF.Value.SegmentId : -1;
                _anchorRiftActiveSeg[t] = rA.HasValue ? rA.Value.SegmentId : -1;
                _anchorRiftFossilSeg[t] = rF.HasValue ? rF.Value.SegmentId : -1;
            }

            int cA = 0, cF = 0, crA = 0, crF = 0;
            for (int t = 0; t < n; t++)
            {
                if (_anchorMtnActiveSeg[t] >= 0) cA++;
                if (_anchorMtnFossilSeg[t] >= 0) cF++;
                if (_anchorRiftActiveSeg[t] >= 0) crA++;
                if (_anchorRiftFossilSeg[t] >= 0) crF++;
            }
            Log.Info($"[IWRW] [tectonic-lines] anchor kind hints: {n} anchors — mtnActive={cA} mtnFossil={cF} riftActive={crA} riftFossil={crF}");
        }

        // Collision intensity per segment (spec §3.1). continentalPlates = the set
        // of plateIds classified continental (from the continent system). Sets
        // seg.Intensity / seg.TallerSide, then node.CommonInt / seg.jStartInt /
        // jEndInt / pin.Val, then builds the stick index.
        public void ComputeCollisionIntensity(HashSet<int> continentalPlates)
        {
            var landPlates = continentalPlates ?? new HashSet<int>();
            var seeds = AllSeeds;
            var PV = _plateVectors;

            double TypeFactor(bool landA, bool landB) => (landA && landB) ? 1.0 : (landA || landB) ? 0.85 : 0.7;

            foreach (var seg in Segments)
            {
                seg.Intensity = 0;
                seg.TallerSide = 0;
                string key = seg.PairKey;
                if (key == null) continue;
                if (key[0] == 'E')
                {
                    int side = key[1] - '0';
                    int plateId = int.Parse(key.Substring(3));
                    if (plateId < 0 || plateId >= PV.Length) continue;
                    var vA = PV[plateId];
                    var vB = _edgePhantomVectors[side];
                    var n = EDGE_NORMALS[side];
                    double rvxE = vA.X - vB.X, rvzE = vA.Z - vB.Z;
                    double relSpeedE = Math.Sqrt(rvxE * rvxE + rvzE * rvzE);
                    double headOnE = relSpeedE < 1e-9 ? 0 : (rvxE * n[0] + rvzE * n[1]) / relSpeedE;
                    double speedNormE = Math.Min(1, relSpeedE / (2 * _plateSpeedMax));
                    bool landAE = landPlates.Contains(plateId);
                    seg.Intensity = headOnE * (0.75 + 0.25 * speedNormE) * TypeFactor(landAE, false);
                    seg.TallerSide = landAE ? +1 : 0;
                    continue;
                }

                char kind = key[0];
                var parts = key.Substring(1).Split(',');
                int a = int.Parse(parts[0]), b = int.Parse(parts[1]);
                double vAx, vAz, vBx, vBz; TectonicModel.PlateSeed sa, sb; bool landA, landB;
                if (kind == 'A')
                {
                    if (a < 0 || a >= PV.Length || b < 0 || b >= PV.Length) continue;
                    vAx = PV[a].X; vAz = PV[a].Z; vBx = PV[b].X; vBz = PV[b].Z;
                    sa = (a >= 0 && a < seeds.Count) ? seeds[a] : null;
                    sb = (b >= 0 && b < seeds.Count) ? seeds[b] : null;
                    landA = landPlates.Contains(a); landB = landPlates.Contains(b);
                }
                else
                {
                    sa = (a >= 0 && a < seeds.Count) ? seeds[a] : null;
                    sb = (b >= 0 && b < seeds.Count) ? seeds[b] : null;
                    vAx = sa != null ? sa.VecX : 0; vAz = sa != null ? sa.VecZ : 0;
                    vBx = sb != null ? sb.VecX : 0; vBz = sb != null ? sb.VecZ : 0;
                    landA = landB = landPlates.Contains(sa != null ? sa.PlateId : -1);
                }
                if (sa == null || sb == null) continue;

                double nx = sb.X - sa.X, nz = sb.Z - sa.Z;
                double nlen = Math.Sqrt(nx * nx + nz * nz);
                if (nlen < 1e-9) continue;
                nx /= nlen; nz /= nlen;

                double rvx = vAx - vBx, rvz = vAz - vBz;
                double relSpeed = Math.Sqrt(rvx * rvx + rvz * rvz);
                double headOn = relSpeed < 1e-9 ? 0 : (rvx * nx + rvz * nz) / relSpeed;
                double speedNorm = Math.Min(1, relSpeed / (2 * _plateSpeedMax));
                double speedFactor = 0.75 + 0.25 * speedNorm;

                seg.Intensity = headOn * speedFactor * TypeFactor(landA, landB);
                seg.TallerSide = (landA == landB) ? 0 : (landA ? +1 : -1);
            }

            // Joint common value: each node takes MAX |intensity| across all arms.
            foreach (var n in Nodes) n.CommonInt = 0;
            foreach (var seg in Segments)
            {
                double a = Math.Abs(seg.Intensity);
                if (seg.NodeStart >= 0 && a > Nodes[seg.NodeStart].CommonInt) Nodes[seg.NodeStart].CommonInt = a;
                if (seg.NodeEnd >= 0 && a > Nodes[seg.NodeEnd].CommonInt) Nodes[seg.NodeEnd].CommonInt = a;
                if (seg.Pins != null)
                    foreach (var p in seg.Pins)
                        if (a > Nodes[p.Node].CommonInt) Nodes[p.Node].CommonInt = a;
            }

            // Arm ends + through-line pins inherit their joint's common value.
            foreach (var seg in Segments)
            {
                double own = Math.Abs(seg.Intensity);
                seg.JStartInt = seg.NodeStart >= 0 ? Nodes[seg.NodeStart].CommonInt : own;
                seg.JEndInt = seg.NodeEnd >= 0 ? Nodes[seg.NodeEnd].CommonInt : own;
                seg.JIntSet = true;
                if (seg.Pins != null) foreach (var p in seg.Pins) p.Val = Nodes[p.Node].CommonInt;
            }

            _buildStickIndex();

            int conv = 0, rift = 0, glancing = 0, total = 0;
            foreach (var seg in Segments)
            {
                if (seg.PairKey == null || seg.PairKey[0] == 'E') continue;
                total++;
                if (seg.Intensity > 0.15) conv++;
                else if (seg.Intensity < -0.15) rift++;
                else glancing++;
            }
            Log.Info($"[IWRW] [tectonic-lines] collision intensity: {total} segments — converging={conv} rifting={rift} glancing={glancing}");
        }

        // Width multiplier of a stick at normalized arc t ∈ [0, 1]. Pinned to the
        // shared joint value at each tied end and every T-pin; ramps in real distance.
        public double BandProfileAt(int segId, double tNorm)
        {
            var seg = Segments[segId];
            double own = Math.Abs(seg.Intensity);
            double a = own;
            var poly = seg.Polyline;
            if (poly != null && poly.Length > 0 && seg.JIntSet)
            {
                double ramp = _jointRampLen;
                double ds = tNorm * poly.Length;
                double wsum = 0, vsum = 0;
                void Pull(double dist, double val) { double w = Math.Max(0, 1 - dist / ramp); wsum += w; vsum += w * val; }
                Pull(ds, seg.JStartInt);
                Pull(poly.Length - ds, seg.JEndInt);
                if (seg.Pins != null) foreach (var p in seg.Pins) Pull(Math.Abs(ds - p.Arc), p.Val);
                if (wsum > 1) { vsum /= wsum; wsum = 1; }
                a = (1 - wsum) * own + vsum;
            }
            return _widthFloor + (1 - _widthFloor) * Math.Min(1, a);
        }

        // Stick lookup grid: which segments' band stacks could reach a pixel.
        private void _buildStickIndex()
        {
            double maxStackBase = Math.Max(
                _orogenW + _basinW + _platformW,
                _extendedCrustWidth + _basinW + _platformW);
            double cell = Math.Max(24, maxStackBase * _mapScale + 4);
            _stickCellSize = cell;
            _stickCols = (int)Math.Ceiling(MapW / cell) + 2;
            _stickRows = (int)Math.Ceiling(MapH / cell) + 2;
            var grid = new List<int>[_stickCols * _stickRows];
            for (int i = 0; i < grid.Length; i++) grid[i] = new List<int>();
            void Insert(double px, double pz, int sid)
            {
                int cx = (int)Math.Floor(px / cell), cz = (int)Math.Floor(pz / cell);
                if (cx < 0 || cx >= _stickCols || cz < 0 || cz >= _stickRows) return;
                var bucket = grid[cz * _stickCols + cx];
                if (!bucket.Contains(sid)) bucket.Add(sid);
            }
            for (int sid = 0; sid < Segments.Count; sid++)
            {
                var poly = Segments[sid].Polyline;
                if (poly == null) continue;
                double px = poly.X[0], pz = poly.Z[0];
                Insert(px, pz, sid);
                for (int v = 1; v < poly.X.Length; v++)
                {
                    double qx = poly.X[v], qz = poly.Z[v];
                    double elen = Math.Sqrt((qx - px) * (qx - px) + (qz - pz) * (qz - pz));
                    int steps = Math.Max(1, (int)Math.Ceiling(elen / (cell * 0.5)));
                    for (int s = 1; s <= steps; s++)
                        Insert(px + (qx - px) * s / steps, pz + (qz - pz) * s / steps, sid);
                    px = qx; pz = qz;
                }
            }
            _stickGrid = grid;
        }

        // All segments whose band stack could reach (x, z). Union query.
        public List<int> SticksNear(double x, double z)
        {
            var outv = new List<int>();
            if (_stickGrid == null) return outv;
            double cell = _stickCellSize;
            int cx = (int)Math.Floor(x / cell), cz = (int)Math.Floor(z / cell);
            for (int dz = -1; dz <= 1; dz++)
            {
                for (int dx = -1; dx <= 1; dx++)
                {
                    int nx = cx + dx, nz = cz + dz;
                    if (nx < 0 || nx >= _stickCols || nz < 0 || nz >= _stickRows) continue;
                    var bucket = _stickGrid[nz * _stickCols + nx];
                    foreach (int k in bucket) if (!outv.Contains(k)) outv.Add(k);
                }
            }
            return outv;
        }

        // Public exact projection onto one segment's polyline (end caps included).
        public Proj ProjectOntoSegment(int segId, double x, double z)
        {
            var poly = Segments[segId].Polyline;
            if (poly == null) return new Proj { Dist = double.PositiveInfinity, T = 0, Side = 0 };
            return _projectOntoPolyline(x, z, poly);
        }

        // Exact kind-split distances at (x, z): candidates from the nearest anchor's
        // cached hints + its graph neighbours' hints; distance is always exact.
        public KindDistances GetKindDistancesAt(double x, double z)
        {
            var mesh = _mesh;
            int anchor = mesh.NearestAnchor(x, z);

            var mtnActiveIds = new List<int>(); var mtnFossilIds = new List<int>();
            var riftActiveIds = new List<int>(); var riftFossilIds = new List<int>();
            void AddId(List<int> lst, int v) { if (v >= 0 && !lst.Contains(v)) lst.Add(v); }
            void AddHints(int t)
            {
                AddId(mtnActiveIds, _anchorMtnActiveSeg[t]);
                AddId(mtnFossilIds, _anchorMtnFossilSeg[t]);
                AddId(riftActiveIds, _anchorRiftActiveSeg[t]);
                AddId(riftFossilIds, _anchorRiftFossilSeg[t]);
            }
            AddHints(anchor);
            foreach (int t2 in mesh.NeighborsOfAnchor(anchor)) AddHints(t2);

            (double dist, int seg, double arc) NearestOf(List<int> segIds)
            {
                double best = double.PositiveInfinity; int bestSeg = -1; double bestArc = 0;
                foreach (int segId in segIds)
                {
                    var seg = Segments[segId];
                    if (seg.Polyline == null) continue;
                    var proj = _projectOntoPolyline(x, z, seg.Polyline);
                    if (proj.Dist < best) { best = proj.Dist; bestSeg = segId; bestArc = proj.T; }
                }
                return (best, bestSeg, bestArc);
            }

            var (mtnActive, mtnActiveSeg, mtnActiveArc) = NearestOf(mtnActiveIds);
            var (mtnFossil, mtnFossilSeg, mtnFossilArc) = NearestOf(mtnFossilIds);
            var (riftActive, riftActiveSeg, riftActiveArc) = NearestOf(riftActiveIds);
            var (riftFossil, riftFossilSeg, riftFossilArc) = NearestOf(riftFossilIds);
            return new KindDistances
            {
                MtnActive = mtnActive, MtnFossil = mtnFossil, RiftActive = riftActive, RiftFossil = riftFossil,
                MtnActiveSeg = mtnActiveSeg, MtnFossilSeg = mtnFossilSeg, RiftActiveSeg = riftActiveSeg, RiftFossilSeg = riftFossilSeg,
                MtnActiveArc = mtnActiveArc, MtnFossilArc = mtnFossilArc, RiftActiveArc = riftActiveArc, RiftFossilArc = riftFossilArc,
            };
        }

        // Plain (kind-agnostic) boundary distance — min(mountain, rift) of same age.
        public (double active, double fossil) GetBoundaryDistancesAt(double x, double z)
        {
            var kd = GetKindDistancesAt(x, z);
            return (Math.Min(kd.MtnActive, kd.RiftActive), Math.Min(kd.MtnFossil, kd.RiftFossil));
        }

        // Ongoing health check: samples a 4×4 grid and logs resolved distance
        // ranges. (Debug; the JS todo flagged gating behind show_debug.)
        // Drop the full-map construction scaffolding. Everything queries the
        // polylines, nodes, pins and the segment lookup grid built FROM these — the
        // pixel grids themselves are never read again. Called by
        // WorldgenPipeline.ReleaseScaffolding, never during Build, so the parity
        // harness can still checksum them.
        public void ReleaseScaffolding()
        {
            _segmentLabel = null;
            _seedGrid = null;
            _activeBoundaryGrid = null;
            _fossilBoundaryGrid = null;
        }

        public void LogDistanceFieldsSample()
        {
            int mapW = MapW, mapH = MapH;
            int cols = 4, rows = 4;
            double minKind = double.PositiveInfinity, maxKind = 0; int kindSamples = 0;
            double minBoundary = double.PositiveInfinity, maxBoundary = 0; int boundarySamples = 0;
            bool[] anyFiniteKind = new bool[4]; // mtnActive, mtnFossil, riftActive, riftFossil

            for (int gz = 0; gz < rows; gz++)
            {
                for (int gx = 0; gx < cols; gx++)
                {
                    int x = (int)Math.Floor((gx + 0.5) / cols * mapW);
                    int z = (int)Math.Floor((gz + 0.5) / rows * mapH);

                    var kd = GetKindDistancesAt(x, z);
                    double[] kvals = { kd.MtnActive, kd.MtnFossil, kd.RiftActive, kd.RiftFossil };
                    for (int i = 0; i < 4; i++)
                    {
                        if (double.IsPositiveInfinity(kvals[i])) continue;
                        anyFiniteKind[i] = true; kindSamples++;
                        if (kvals[i] < minKind) minKind = kvals[i];
                        if (kvals[i] > maxKind) maxKind = kvals[i];
                    }

                    var bd = GetBoundaryDistancesAt(x, z);
                    double[] bvals = { bd.active, bd.fossil };
                    for (int i = 0; i < 2; i++)
                    {
                        if (double.IsPositiveInfinity(bvals[i])) continue;
                        boundarySamples++;
                        if (bvals[i] < minBoundary) minBoundary = bvals[i];
                        if (bvals[i] > maxBoundary) maxBoundary = bvals[i];
                    }
                }
            }

            Log.Info($"[IWRW] [tectonic-lines] distance fields sample ({cols * rows} points): " +
                $"kind-split range=[{minKind:F1}, {maxKind:F1}]px ({kindSamples} finite)  " +
                $"boundary range=[{minBoundary:F1}, {maxBoundary:F1}]px ({boundarySamples} finite)");
            string[] names = { "mtnActive", "mtnFossil", "riftActive", "riftFossil" };
            for (int i = 0; i < 4; i++)
                if (!anyFiniteKind[i])
                    Log.Info($"[IWRW] [tectonic-lines] note: no {names[i]} segment reachable from any sampled point");
        }
    }
}
