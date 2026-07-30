using System;
using System.Collections.Generic;

namespace IWantRealisticWorlds.Worldgen
{
    // Port of tools/visualiser/coast-field.js — CoastField, the emergent
    // organic coastline (docs/continental-shape-spec.md §4, no mouth pinning):
    //
    //   land(p) = sd(p) + n(p)·A  >  0
    //
    // sd(p) = signed distance to the nearest primitive coast segment (+ inside a
    // LAND face, − inside an OCEAN face); n(p) = seeded FBM in ≈[−1,1]; A =
    // amplitude. The coastline is the zero-crossing, evaluated per column — pure
    // function of (x, z, seed). The primitive's faceted geometry never shows.
    //
    // NOT ported: _buildRasters (landMask / coastMask) — the visualiser's whole-
    // map bake of isLandAt. The mod evaluates isLandAt per column; the full raster
    // over the map equals landMask by construction (outside the band, isLandAt
    // returns exactly the face label = landGrid).
    public sealed class CoastField
    {
        public sealed class CoastOptions
        {
            public int MapW, MapH;
            public long Seed;
            public double CoastAmplitude = 0.45;
            public double CoastCoarseBlend = 0;
        }

        // Hard bound from the interior-point distance proof (√3/2·s).
        private static readonly double AMPLITUDE_HARD_BOUND = Math.Sqrt(3) / 2;

        private readonly int MapW, MapH, Seed;
        private readonly LatticeMesh mesh;
        private readonly ContinentGen continent;
        public readonly double Spacing;
        public readonly double Amplitude;   // px
        public readonly double Band;        // evaluation radius R
        private readonly double _coarseBlend;
        private readonly FbmNoise _fine, _coarse;

        public double[] CoastSegments;      // flat x1,z1,x2,z2 per segment
        public int NumSegments;
        private double _binSize;
        private int _binCols, _binRows;
        private List<int>[] _bins;

        public CoastField(CoastOptions opts, LatticeMesh mesh, ContinentGen continent)
        {
            MapW = opts.MapW; MapH = opts.MapH; Seed = (int)opts.Seed;
            this.mesh = mesh; this.continent = continent;

            double s = mesh.Spacing;
            Spacing = s;

            double amp = opts.CoastAmplitude;
            if (amp >= AMPLITUDE_HARD_BOUND)
            {
                Log.Warn($"[IWRW] [coast-field] amplitude {amp}·s ≥ hard bound {AMPLITUDE_HARD_BOUND:F3}·s — clamping");
                amp = AMPLITUDE_HARD_BOUND - 0.01;
            }
            Amplitude = amp * s;
            Band = Amplitude + 0.1 * s;

            _coarseBlend = opts.CoastCoarseBlend;
            _fine = new FbmNoise(Seed + 71001, 1 / (1.0 * s), 4, 0.5);
            _coarse = new FbmNoise(Seed + 71002, 1 / (3.5 * s), 2, 0.5);

            _buildCoastSegments();
            // _buildRasters skipped (JS-only bake).
            _verify();

            Log.Info($"[IWRW] [coast-field] segments={NumSegments} A={Amplitude:F2}px band={Band:F2}px");
        }

        // A coast segment is a lattice edge shared by exactly one LAND and one
        // OCEAN face — the two corners the incident faces have in common.
        private void _buildCoastSegments()
        {
            var state = continent.FaceState;
            var segs = new List<double>();

            for (int f = 0; f < mesh.NumFaces; f++)
            {
                bool landF = state[f] > 0;
                var nbrs = mesh.FaceEdgeNeighbors(f);
                for (int i = 0; i < nbrs.Count; i++)
                {
                    int g = nbrs[i];
                    if (g < f) continue;
                    if ((state[g] > 0) == landF) continue;
                    var a = mesh.FaceCorners(f);
                    var b = mesh.FaceCorners(g);
                    int p = -1, q = -1;
                    foreach (int c in a)
                        if (c == b[0] || c == b[1] || c == b[2]) { if (p < 0) p = c; else q = c; }
                    segs.Add(mesh.AX[p]); segs.Add(mesh.AZ[p]); segs.Add(mesh.AX[q]); segs.Add(mesh.AZ[q]);
                }
            }
            CoastSegments = segs.ToArray();
            NumSegments = segs.Count / 4;

            double binSize = Spacing;
            _binSize = binSize;
            _binCols = (int)Math.Ceiling(MapW / binSize) + 2;
            _binRows = (int)Math.Ceiling(MapH / binSize) + 2;
            _bins = new List<int>[_binCols * _binRows];
            int BinOf(double x, double z)
            {
                int bx = Math.Max(0, Math.Min(_binCols - 1, (int)Math.Floor(x / binSize) + 1));
                int bz = Math.Max(0, Math.Min(_binRows - 1, (int)Math.Floor(z / binSize) + 1));
                return bz * _binCols + bx;
            }
            for (int i = 0; i < NumSegments; i++)
            {
                double x1 = CoastSegments[4 * i], z1 = CoastSegments[4 * i + 1];
                double x2 = CoastSegments[4 * i + 2], z2 = CoastSegments[4 * i + 3];
                int b1 = BinOf(x1, z1), b2 = BinOf(x2, z2);
                int bxA = Math.Min(b1 % _binCols, b2 % _binCols);
                int bxB = Math.Max(b1 % _binCols, b2 % _binCols);
                int bzA = Math.Min(b1 / _binCols, b2 / _binCols);
                int bzB = Math.Max(b1 / _binCols, b2 / _binCols);
                for (int bz = bzA; bz <= bzB; bz++)
                {
                    for (int bx = bxA; bx <= bxB; bx++)
                    {
                        int b = bz * _binCols + bx;
                        if (_bins[b] == null) _bins[b] = new List<int>();
                        _bins[b].Add(i);
                    }
                }
            }
        }

        private double _distToCoast(double x, double z)
        {
            double binSize = _binSize;
            int K = (int)Math.Ceiling(Band / binSize) + 1;
            int bx = (int)Math.Floor(x / binSize) + 1;
            int bz = (int)Math.Floor(z / binSize) + 1;
            double best = double.PositiveInfinity;
            for (int dz = -K; dz <= K; dz++)
            {
                int rz = bz + dz;
                if (rz < 0 || rz >= _binRows) continue;
                for (int dx = -K; dx <= K; dx++)
                {
                    int rx = bx + dx;
                    if (rx < 0 || rx >= _binCols) continue;
                    var bin = _bins[rz * _binCols + rx];
                    if (bin == null) continue;
                    for (int m = 0; m < bin.Count; m++)
                    {
                        int i = bin[m] * 4;
                        double d = _pointSegDist(x, z, CoastSegments[i], CoastSegments[i + 1], CoastSegments[i + 2], CoastSegments[i + 3]);
                        if (d < best) best = d;
                    }
                }
            }
            return best;
        }

        private double _pointSegDist(double px, double pz, double x1, double z1, double x2, double z2)
        {
            double dx = x2 - x1, dz = z2 - z1;
            double len2 = dx * dx + dz * dz;
            double t = len2 > 0 ? ((px - x1) * dx + (pz - z1) * dz) / len2 : 0;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            double ex = x1 + t * dx - px, ez = z1 + t * dz - pz;
            return Math.Sqrt(ex * ex + ez * ez);
        }

        private double _noise(double x, double z)
        {
            double w = _coarseBlend;
            if (w <= 0) return _fine.Sample(x, z);
            return _coarse.Sample(x, z) * w + _fine.Sample(x, z) * (1 - w);
        }

        // Per-column land/ocean — the game-facing query.
        public bool IsLandAt(double x, double z)
        {
            bool faceLand = continent.FaceState[mesh.FaceAt(x, z)] > 0;
            double d = _distToCoast(x, z);
            if (d > Band) return faceLand;
            double sd = faceLand ? d : -d;
            return sd + _noise(x, z) * Amplitude > 0;
        }

        // Signed distance to the WARPED coastline — the one IsLandAt actually draws,
        // so its zero contour IS the shoreline and its sign always agrees with
        // IsLandAt. + = land side, - = water side. ±Infinity beyond the band, where
        // the noise can no longer flip the sign and the face label is the answer.
        // This is what gives depth to water narrower than the lattice: it is defined
        // at every pixel, so nothing depends on an anchor happening to fall inside.
        public double SignedDistWarpedAt(double x, double z)
        {
            bool faceLand = continent.FaceState[mesh.FaceAt(x, z)] > 0;
            double d = _distToCoast(x, z);
            if (d > Band) return faceLand ? double.PositiveInfinity : double.NegativeInfinity;
            return (faceLand ? d : -d) + _noise(x, z) * Amplitude;
        }

        // Signed distance (debug; + = land side).
        public double SignedDistAt(double x, double z)
        {
            bool faceLand = continent.FaceState[mesh.FaceAt(x, z)] > 0;
            double d = _distToCoast(x, z);
            return faceLand ? d : -d;
        }

        // Dev check (spec §6 invariant 7): no INTERIOR point may evaluate ocean,
        // no OCEANIC point land — guaranteed by the amplitude bound.
        private void _verify()
        {
            var pc = continent.PointClass;
            int flipped = 0;
            int step = Math.Max(1, mesh.NumAnchors / 2000);
            for (int t = 0; t < mesh.NumAnchors; t += step)
            {
                double x = mesh.AX[t], z = mesh.AZ[t];
                if (x < 0 || x >= MapW || z < 0 || z >= MapH) continue;
                if (pc[t] == ContinentGen.POINT_INTERIOR && !IsLandAt(x, z)) flipped++;
                if (pc[t] == ContinentGen.POINT_OCEANIC && IsLandAt(x, z)) flipped++;
            }
            if (flipped > 0)
                Log.Warn($"[IWRW] [coast-field] {flipped} sampled interior/oceanic points flipped by the field — amplitude bound violated?");
        }
    }
}
