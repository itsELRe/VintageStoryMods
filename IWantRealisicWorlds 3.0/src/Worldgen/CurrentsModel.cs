using System;

namespace IWantRealisticWorlds.Worldgen
{
    // Port of tools/visualiser/currents.js — CurrentsModel.
    // A current vector + temperature offset from one law, per OCEANIC data point
    // (ComputeAnchorCurrents — the primitive climate reads). Land and coastal
    // points carry no current.
    //
    // Direction: take the point's wind vector → Ekman-rotate 45° (right in N, left
    // in S) → near a coast, project onto the coast tangent and drop the into-land
    // normal, so boundary currents run along the coast at full speed (hash tiebreak
    // when the wind is exactly perpendicular). Coast normal = the mean direction
    // toward the point's COASTAL lattice neighbors.
    //
    // Temp offset: walk backward along -current, average the latitude base-temp of
    // the samples, subtract the own-latitude temp. Surfaces through climate temp.
    //
    // NOT ported: the detailed rasters (rasterizeAnchorField + box blur) — JS-only
    // bake; the mod builds region fields in Phase 2. Same split as WindModel.
    public sealed class CurrentsModel
    {
        private const int RAY_STEPS = 8;

        // cos(45°) = sin(45°) = √2/2. JS uses Math.SQRT1_2; this literal rounds to
        // the same double.
        private const double ROT45 = 0.70710678118654752440084436210485;

        // Temp-offset byte scale (docs/14_vs_wind.md). tempOff is a difference of
        // two normalized [0,1] temperatures, so it lives in [-1,1] → signed byte
        // around 128. Components reuse WindModel.WIND_MAX (currents share the wind
        // component scale).
        public const double CURRENT_TEMP_MAX = 1.0;

        // Latitude → base temperature [0, 1]. Piecewise linear curve.
        // latNorm = |latDeg|/90; equator = 0, pole = 1.
        private static readonly (double X, double Y)[] TEMP_CURVE =
        {
            (0.00, 1.00),   // equator
            (0.30, 0.85),   // hot plateau end
            (0.35, 0.65),   // fast drop into temperate
            (0.65, 0.35),   // temperate plateau end
            (0.70, 0.20),   // fast drop into cold
            (1.00, 0.08),   // pole
        };

        // MapW/MapH are only consumed by the detailed raster (Phase 2) — kept on the
        // options so the call site matches the visualiser's, not stored yet.
        public sealed class CurrentsOptions { public int MapW, MapH; public long Seed; }

        private readonly int seed;
        private readonly ContinentGen continent;
        private readonly WindModel wind;

        // Primitive: signed component BYTES per point (128 = calm / no offset).
        public byte[] AnchorCurrentDx, AnchorCurrentDz, AnchorCurrentTempOff;

        // `tectonic` is taken for call-site parity with currents.js; the current law
        // reads nothing from it (JS stores it unused too — flagged for JS cleanup).
        public CurrentsModel(CurrentsOptions opts, ContinentGen continent, TectonicModel tectonic, WindModel wind)
        {
            seed = (int)opts.Seed;
            this.continent = continent; this.wind = wind;
        }

        // Per-point current — the primitive. Runs the current law at each OCEANIC
        // lattice point: its own wind → Ekman → coastal deflection → temp-offset
        // lineage. Land/coastal points carry no current. Reads the point wind
        // computed in WindModel.ComputeAnchorWinds.
        public void ComputeAnchorCurrents(LatticeMesh mesh)
        {
            if (mesh == null || wind == null || wind.AnchorWindDx == null) return;
            var pointClass = continent?.PointClass;
            if (pointClass == null) return;

            int n = mesh.NumAnchors;
            AnchorCurrentDx = new byte[n];
            AnchorCurrentDz = new byte[n];
            AnchorCurrentTempOff = new byte[n];
            for (int i = 0; i < n; i++)
            {
                AnchorCurrentDx[i] = 128; AnchorCurrentDz[i] = 128; AnchorCurrentTempOff[i] = 128;
            }

            byte[] wdx = wind.AnchorWindDx, wdz = wind.AnchorWindDz;   // byte-encoded
            const double WMAX = WindModel.WIND_MAX;
            // Lineage ray step ≈ one data-point spacing.
            double stepSize = Math.Max(8, mesh.Spacing);

            for (int t = 0; t < n; t++)
            {
                double ax = mesh.AX[t], az = mesh.AZ[t];
                if (pointClass[t] != ContinentGen.POINT_OCEANIC) continue;   // land/coastal — no current
                double wx = WorldgenMath.DecodeSignedByte(wdx[t], WMAX);
                double wz = WorldgenMath.DecodeSignedByte(wdz[t], WMAX);
                if (Math.Sqrt(wx * wx + wz * wz) < 0.001) continue;
                double rawLat = wind.LatitudeAt(az);

                // Ekman rotation — CW 45° north, CCW 45° south.
                bool isNorth = rawLat >= 0;
                double dx, dz;
                if (isNorth) { dx = wx * ROT45 - wz * ROT45; dz = wx * ROT45 + wz * ROT45; }
                else { dx = wx * ROT45 + wz * ROT45; dz = -wx * ROT45 + wz * ROT45; }
                double ekmanMag = Math.Sqrt(dx * dx + dz * dz);

                // Coast normal: mean direction toward COASTAL lattice neighbors (an
                // OCEANIC point can only neighbor OCEANIC or COASTAL points, so this
                // is exactly "toward the shoreline" one step out).
                var nbrs = mesh.NeighborsOfAnchor(t);
                double lnx = 0, lnz = 0; int landCount = 0;
                for (int k = 0; k < nbrs.Count; k++)
                {
                    int nb = nbrs[k];
                    if (pointClass[nb] == ContinentGen.POINT_COASTAL)
                    {
                        lnx += mesh.AX[nb] - ax; lnz += mesh.AZ[nb] - az; landCount++;
                    }
                }
                if (landCount > 0 && ekmanMag > 1e-6)
                {
                    double nLen = Math.Sqrt(lnx * lnx + lnz * lnz);
                    if (nLen == 0) nLen = 1;                       // JS `|| 1`
                    double normX = lnx / nLen, normZ = lnz / nLen;
                    double tanX = -normZ, tanZ = normX;
                    double projection = dx * tanX + dz * tanZ;
                    double sTanX, sTanZ;
                    if (Math.Abs(projection) > 1e-6)
                    {
                        double sign = projection > 0 ? 1 : -1;
                        sTanX = tanX * sign; sTanZ = tanZ * sign;
                    }
                    else
                    {
                        double h = WorldgenMath.Hash2D(t, 0, seed + 7777);
                        double sign = h >= 0.5 ? 1 : -1;
                        sTanX = tanX * sign; sTanZ = tanZ * sign;
                    }
                    dx = sTanX * ekmanMag; dz = sTanZ * ekmanMag;
                }

                AnchorCurrentDx[t] = WorldgenMath.EncodeSignedByte(dx, WMAX);
                AnchorCurrentDz[t] = WorldgenMath.EncodeSignedByte(dz, WMAX);

                // Temp offset — backward lineage trace along -current, latitude → temp.
                double magnitude = Math.Sqrt(dx * dx + dz * dz);
                if (magnitude > 0.001)
                {
                    double uz = dz / magnitude;
                    double lineageSum = 0;
                    for (int r = 1; r <= RAY_STEPS; r++)
                        lineageSum += LatToTemp(wind.LatitudeAt(az - uz * r * stepSize));
                    double off = (lineageSum / RAY_STEPS) - LatToTemp(rawLat);
                    AnchorCurrentTempOff[t] = WorldgenMath.EncodeSignedByte(off, CURRENT_TEMP_MAX);
                }
            }
            // Detailed rasters + blur skipped (JS-only bake).
        }

        public static double LatToTemp(double rawLatDeg) => PiecewiseLerp(Math.Abs(rawLatDeg) / 90, TEMP_CURVE);

        private static double PiecewiseLerp(double x, (double X, double Y)[] curve)
        {
            double n = x < 0 ? 0 : (x > 1 ? 1 : x);
            for (int i = 0; i < curve.Length - 1; i++)
            {
                var (x0, y0) = curve[i];
                var (x1, y1) = curve[i + 1];
                if (n <= x1)
                {
                    double t = (n - x0) / (x1 - x0);
                    return y0 + t * (y1 - y0);
                }
            }
            return curve[curve.Length - 1].Y;
        }
    }
}
