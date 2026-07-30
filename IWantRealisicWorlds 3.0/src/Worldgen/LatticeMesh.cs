using System;
using System.Collections.Generic;

namespace IWantRealisticWorlds.Worldgen
{
    // Port of tools/visualiser/mesh.js — LatticeMesh, the anchor layer.
    //
    // A regular triangular lattice: points at formulaic positions from integer
    // indices (r, c) — rows spaced s·√3/2 apart, odd rows offset s/2 — so every
    // query resolves by O(1) arithmetic, no triangulation and no spatial index.
    // The points ARE the anchors: continuous field data attaches to them as
    // parallel arrays keyed by point id; they are immutable (never displaced).
    // The equilateral triangles BETWEEN the points are the faces: the categorical
    // unit (land/ocean labels live on faces), and they double as the interpolation
    // triangles (barycentric blend of the 3 corner points).
    //
    // Pure geometry/topology — no VS dependency, so it builds in the parity
    // harness as-is. rasterizeAnchorField (mesh.js) is JS-only (the visualiser's
    // whole-map bake); the mod samples per region-map pixel on demand via SampleAt.
    public sealed class LatticeMesh
    {
        // Extra point rows/cols beyond the map rim on each side.
        private const int MARGIN = 2;

        public readonly int MapW, MapH;
        public readonly double Spacing;
        public readonly double RowH;
        public readonly double X0, Z0;
        public readonly int NumCols, NumRows, NumAnchors, FacesPerStrip, NumFaces;

        // Point coordinates (mesh.js a_x / a_z). Public: field data and the parity
        // checksum read them directly, matching the JS module's exposed arrays.
        public readonly double[] AX;
        public readonly double[] AZ;

        // Flat corner triples per face (mesh.js _faceCorner): face f → [3f..3f+2].
        public readonly int[] CornerIndices;

        private readonly List<int>[] _pointFaces;   // point → incident faces (≤6)
        private readonly List<int>[] _faceEdgeNbrs;  // face → 3 edge-adjacent faces
        private int[][] _faceGrowthNbrs;             // face → edge+corner ring (≤12), lazy

        public LatticeMesh(int mapW, int mapH, double spacing)
        {
            MapW = mapW; MapH = mapH; Spacing = spacing;

            double s = spacing;
            RowH = s * Math.Sqrt(3) / 2;

            // Grid extents: cover [0, mapW]×[0, mapH] plus MARGIN points per side.
            X0 = -MARGIN * s;
            Z0 = -MARGIN * RowH;
            NumCols = (int)Math.Ceiling((double)MapW / s) + 2 * MARGIN + 1;
            NumRows = (int)Math.Ceiling((double)MapH / RowH) + 2 * MARGIN + 1;

            NumAnchors = NumRows * NumCols;
            FacesPerStrip = (NumCols - 1) * 2;      // 2 faces per (row-strip, column) quad
            NumFaces = (NumRows - 1) * FacesPerStrip;

            AX = new double[NumAnchors];
            AZ = new double[NumAnchors];
            CornerIndices = new int[NumFaces * 3];
            _pointFaces = new List<int>[NumAnchors];
            _faceEdgeNbrs = new List<int>[NumFaces];

            BuildPoints();
            BuildFaces();
            Verify();

            Log.Info($"[IWRW] [mesh] lattice {NumRows}x{NumCols} — {NumAnchors} points, {NumFaces} faces, spacing={s:F2}px");
        }

        // Auto-calibrated spacing: keeps point density in the same range the
        // previous mesh produced (≈2 anchors per Voronoi cell, 480 cells at the
        // 512² base, φ-scaled with map size, divided by continent size), so every
        // downstream constant tuned against anchor spacing stays valid. `mult` is
        // the user's lattice-spacing knob (1 = auto).
        public static double AutoSpacing(int mapW, int mapH, double continentSize, double mult)
        {
            double mapSize = Math.Max(mapW, mapH);
            double cont = continentSize == 0 ? 1.0 : continentSize;      // JS `continentSize || 1`
            double cells = WorldgenMath.Round(480 * Math.Pow(WorldgenMath.PHI, Math.Log2(mapSize / 512.0)))
                / Math.Max(0.01, cont);
            double points = Math.Max(32, cells * 2);
            double s = Math.Sqrt((double)mapW * mapH / (points * Math.Sqrt(3) / 2)); // area per point = s²·√3/2
            return s * (mult == 0 ? 1.0 : mult);                          // JS `mult || 1`
        }

        // ===== Points =====

        private void BuildPoints()
        {
            double s = Spacing;
            for (int r = 0; r < NumRows; r++)
            {
                double off = (r & 1) != 0 ? s / 2 : 0;
                double z = Z0 + r * RowH;
                for (int c = 0; c < NumCols; c++)
                {
                    int t = r * NumCols + c;
                    // 6-decimal round — JS/C# numeric parity (JS Math.round semantics).
                    AX[t] = WorldgenMath.Round((X0 + c * s + off) * 1e6) / 1e6;
                    AZ[t] = WorldgenMath.Round(z * 1e6) / 1e6;
                }
            }
        }

        public int PointIndex(int r, int c) => r * NumCols + c;
        public int PointRow(int t) => t / NumCols;   // t ≥ 0, so truncation == JS `(t/numCols)|0`
        public int PointCol(int t) => t % NumCols;

        // The up-to-6 lattice neighbors of point t (fewer on the outer rim).
        // Push order matches mesh.js (iteration-order parity for BFS consumers).
        public List<int> NeighborsOfAnchor(int t)
        {
            int r = PointRow(t), c = PointCol(t);
            int odd = r & 1;
            var outv = new List<int>(6);
            void Push(int rr, int cc)
            {
                if (rr >= 0 && rr < NumRows && cc >= 0 && cc < NumCols)
                    outv.Add(rr * NumCols + cc);
            }
            Push(r, c - 1); Push(r, c + 1);
            // Adjacent rows: even rows pair with (c-1, c), odd with (c, c+1).
            int cA = odd != 0 ? c : c - 1;
            Push(r - 1, cA); Push(r - 1, cA + 1);
            Push(r + 1, cA); Push(r + 1, cA + 1);
            return outv;
        }

        // Nearest lattice point to (x, z): the nearest point is always a corner of
        // the containing face (its Voronoi hexagon is covered by its 6 faces).
        public int NearestAnchor(double x, double z)
        {
            int f = FaceAt(x, z);
            int s = f * 3;
            int best = CornerIndices[s];
            double bestD2 = double.PositiveInfinity;
            for (int i = 0; i < 3; i++)
            {
                int t = CornerIndices[s + i];
                double dx = AX[t] - x, dz = AZ[t] - z;
                double d2 = dx * dx + dz * dz;
                if (d2 < bestD2) { bestD2 = d2; best = t; }
            }
            return best;
        }

        // ===== Faces =====

        // Strip r (between point rows r and r+1), column c, k ∈ {0,1}; the diagonal
        // orientation alternates with row parity:
        //   even r: k=0 → (r,c)(r,c+1)(r+1,c)    k=1 → (r,c+1)(r+1,c+1)(r+1,c)
        //   odd  r: k=0 → (r,c)(r+1,c)(r+1,c+1)  k=1 → (r,c)(r,c+1)(r+1,c+1)
        private void BuildFaces()
        {
            int nF = NumFaces;
            for (int r = 0; r < NumRows - 1; r++)
            {
                int odd = r & 1;
                for (int c = 0; c < NumCols - 1; c++)
                {
                    int baseF = (r * (NumCols - 1) + c) * 2;
                    int A = PointIndex(r, c), B = PointIndex(r, c + 1);
                    int C = PointIndex(r + 1, c), D = PointIndex(r + 1, c + 1);
                    int i = baseF * 3;
                    if (odd == 0)
                    {
                        CornerIndices[i++] = A; CornerIndices[i++] = B; CornerIndices[i++] = C;
                        CornerIndices[i++] = B; CornerIndices[i++] = D; CornerIndices[i++] = C;
                    }
                    else
                    {
                        CornerIndices[i++] = A; CornerIndices[i++] = C; CornerIndices[i++] = D;
                        CornerIndices[i++] = A; CornerIndices[i++] = B; CornerIndices[i++] = D;
                    }
                }
            }

            // Point → incident faces (≤6), for point classification + BFS adjacency.
            for (int t = 0; t < NumAnchors; t++) _pointFaces[t] = new List<int>();
            for (int f = 0; f < nF; f++)
            {
                _pointFaces[CornerIndices[3 * f]].Add(f);
                _pointFaces[CornerIndices[3 * f + 1]].Add(f);
                _pointFaces[CornerIndices[3 * f + 2]].Add(f);
            }

            // Face → 3 edge-adjacent faces, via a shared-edge map (generic build —
            // no parity case analysis to get wrong).
            var edgeMap = new Dictionary<long, int>();
            for (int f = 0; f < nF; f++) _faceEdgeNbrs[f] = new List<int>();
            for (int f = 0; f < nF; f++)
            {
                for (int e = 0; e < 3; e++)
                {
                    int p = CornerIndices[3 * f + e];
                    int q = CornerIndices[3 * f + (e + 1) % 3];
                    long key = p < q ? (long)p * NumAnchors + q : (long)q * NumAnchors + p;
                    if (edgeMap.TryGetValue(key, out int other))
                    {
                        _faceEdgeNbrs[f].Add(other);
                        _faceEdgeNbrs[other].Add(f);
                    }
                    else
                    {
                        edgeMap[key] = f;
                    }
                }
            }
        }

        public int[] FaceCorners(int f)
        {
            int s = f * 3;
            return new[] { CornerIndices[s], CornerIndices[s + 1], CornerIndices[s + 2] };
        }

        public (double x, double z) FaceCentroid(int f)
        {
            int s = f * 3;
            int i0 = CornerIndices[s], i1 = CornerIndices[s + 1], i2 = CornerIndices[s + 2];
            return ((AX[i0] + AX[i1] + AX[i2]) / 3, (AZ[i0] + AZ[i1] + AZ[i2]) / 3);
        }

        public List<int> FacesAtPoint(int t) => _pointFaces[t];

        // The 3 faces sharing an edge with f.
        public List<int> FaceEdgeNeighbors(int f) => _faceEdgeNbrs[f];

        // All faces sharing an edge OR a corner with f (12 for an interior face) —
        // the BFS growth adjacency. Precomputed lazily (the BFS scoring hits it hard).
        public int[] FaceGrowthNeighbors(int f)
        {
            if (_faceGrowthNbrs == null)
            {
                _faceGrowthNbrs = new int[NumFaces][];
                for (int g = 0; g < NumFaces; g++)
                {
                    var outv = new List<int>();
                    int s = g * 3;
                    for (int i = 0; i < 3; i++)
                    {
                        var inc = _pointFaces[CornerIndices[s + i]];
                        for (int m = 0; m < inc.Count; m++)
                        {
                            int h = inc[m];
                            if (h != g && !outv.Contains(h)) outv.Add(h);
                        }
                    }
                    _faceGrowthNbrs[g] = outv.ToArray();
                }
            }
            return _faceGrowthNbrs[f];
        }

        // O(1) exact containing face for (x, z), by strip + skewed-column
        // arithmetic (clamped to the lattice, so out-of-range queries snap to the
        // rim face).
        public int FaceAt(double x, double z)
        {
            int r = (int)Math.Floor((z - Z0) / RowH);
            if (r < 0) r = 0; else if (r > NumRows - 2) r = NumRows - 2;
            double zf = Math.Min(1, Math.Max(0, (z - Z0 - r * RowH) / RowH));
            double u = (x - X0) / Spacing;
            int c, k;
            if ((r & 1) == 0)
            {
                double v = u - 0.5 * zf;
                c = (int)Math.Floor(v);
                if (c < 0) c = 0; else if (c > NumCols - 2) c = NumCols - 2;
                k = (v - c) <= (1 - zf) ? 0 : 1;
            }
            else
            {
                double v = u - 0.5 + 0.5 * zf;
                c = (int)Math.Floor(v);
                if (c < 0) c = 0; else if (c > NumCols - 2) c = NumCols - 2;
                k = (v - c) <= zf ? 0 : 1;
            }
            return (r * (NumCols - 1) + c) * 2 + k;
        }

        // ===== Field interpolation (spec §7 sampleFields) =====

        public readonly struct SampleWeights
        {
            public readonly int I0, I1, I2;
            public readonly double W0, W1, W2;
            public SampleWeights(int i0, int i1, int i2, double w0, double w1, double w2)
            { I0 = i0; I1 = i1; I2 = i2; W0 = w0; W1 = w1; W2 = w2; }
        }

        // Containing face's corners + barycentric weights at (x, z).
        public SampleWeights SampleAt(double x, double z)
        {
            int f = FaceAt(x, z);
            int s = f * 3;
            int i0 = CornerIndices[s], i1 = CornerIndices[s + 1], i2 = CornerIndices[s + 2];
            double Ax = AX[i0], Az = AZ[i0], Bx = AX[i1], Bz = AZ[i1], Cx = AX[i2], Cz = AZ[i2];
            double d = (Bz - Cz) * (Ax - Cx) + (Cx - Bx) * (Az - Cz);
            double invD = 1 / d; // equilateral faces — never degenerate
            double w0 = ((Bz - Cz) * (x - Cx) + (Cx - Bx) * (z - Cz)) * invD;
            double w1 = ((Cz - Az) * (x - Cx) + (Ax - Cx) * (z - Cz)) * invD;
            return new SampleWeights(i0, i1, i2, w0, w1, 1 - w0 - w1);
        }

        // Interpolate a per-point vector field (parallel dx/dz arrays) at (x, z).
        public (double dx, double dz) SampleVec(double x, double z, double[] arrDx, double[] arrDz)
        {
            var s = SampleAt(x, z);
            return (s.W0 * arrDx[s.I0] + s.W1 * arrDx[s.I1] + s.W2 * arrDx[s.I2],
                    s.W0 * arrDz[s.I0] + s.W1 * arrDz[s.I1] + s.W2 * arrDz[s.I2]);
        }

        // Interpolate a per-point scalar field at (x, z).
        public double SampleScalar(double x, double z, double[] arr)
        {
            var s = SampleAt(x, z);
            return s.W0 * arr[s.I0] + s.W1 * arr[s.I1] + s.W2 * arr[s.I2];
        }

        // Same, for the byte-valued primitives (height, depth, climate, ...) the
        // region maps are built from.
        public double SampleScalar(double x, double z, byte[] arr)
        {
            var s = SampleAt(x, z);
            return s.W0 * arr[s.I0] + s.W1 * arr[s.I1] + s.W2 * arr[s.I2];
        }

        // Dev sanity check (port of mesh.js _verify): every sampled face
        // equilateral with side = spacing, and faceAt round-trips its centroid.
        // Logs only; no effect on output.
        private void Verify()
        {
            double s = Spacing;
            double maxErr = 0; int locErrs = 0;
            int step = Math.Max(1, NumFaces / 500); // sample ~500 faces
            for (int f = 0; f < NumFaces; f += step)
            {
                int i0 = CornerIndices[3 * f], i1 = CornerIndices[3 * f + 1], i2 = CornerIndices[3 * f + 2];
                double Side(int a, int b)
                {
                    double dx = AX[a] - AX[b], dz = AZ[a] - AZ[b];
                    return Math.Sqrt(dx * dx + dz * dz);
                }
                maxErr = Math.Max(maxErr, Math.Max(Math.Abs(Side(i0, i1) - s),
                    Math.Max(Math.Abs(Side(i1, i2) - s), Math.Abs(Side(i2, i0) - s))));
                var cc = FaceCentroid(f);
                if (FaceAt(cc.x, cc.z) != f) locErrs++;
            }
            if (maxErr > s * 1e-4)
                Log.Warn($"[IWRW] [mesh] face side-length error {maxErr:F6}px — lattice construction is wrong");
            if (locErrs > 0)
                Log.Warn($"[IWRW] [mesh] faceAt failed on {locErrs} sampled face centroids — location arithmetic is wrong");
        }
    }
}
