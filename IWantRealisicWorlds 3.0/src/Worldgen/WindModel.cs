using System;

namespace IWantRealisticWorlds.Worldgen
{
    // Port of tools/visualiser/wind.js — WindModel.
    // A wind vector (direction + magnitude) from one law, evaluated per data point
    // (ComputeAnchorWinds — the primitive climate reads): latitude-band base (6-belt
    // table) → jet meander (fBm shifts effective latitude) → cyclone rotation →
    // land friction (upwind ray) → mountain shadow (upwind ray). Stored as signed
    // component bytes per anchor (128 = calm, ±WIND_MAX at the ends).
    //
    // NOT ported: the detailed rasters (rasterizeAnchorField + box blur) — JS-only
    // bake; the mod builds region wind fields in Phase 2. latColor is viz-only.
    public sealed class WindModel
    {
        // Shared with currents/climate.
        public const double WIND_MAX = 1.5;

        private const int RAY_STEPS = 8;
        private const double FRICTION_MAX_REDUCTION = 0.5;
        private const double SHADOW_MIN = 0.3;
        private const double CYCLONE_STRENGTH = 0.25;
        private const double MEANDER_DEGREES = 13.5;

        // 6-belt latitude wind anchor table (+x east, +z south), high lat → low.
        private static readonly (double Lat, double Dx, double Dz)[] _ANCHORS =
        {
            ( 90,  0,     0    ),
            ( 75, -0.38,  0.12 ),
            ( 60,  0,     0    ),
            ( 45,  0.76, -0.24 ),
            ( 30,  0,     0    ),
            ( 15, -0.67,  0.21 ),
            (  0,  0,     0    ),
            (-15, -0.67, -0.21 ),
            (-30,  0,     0    ),
            (-45,  0.76,  0.24 ),
            (-60,  0,     0    ),
            (-75, -0.38, -0.12 ),
            (-90,  0,     0    ),
        };

        public sealed class WindOptions { public int MapW, MapH; public long Seed; public double PolarEquatorDistance; }

        private readonly int mapW, mapH, seed;
        private readonly ContinentGen continent;
        private readonly TectonicModel tectonic;
        private readonly ProvinceMap provinces;
        private readonly double polarEquatorDistance;
        private readonly FbmNoise jetMeander, cycloneNoise;

        public byte[] AnchorWindDx, AnchorWindDz;

        public WindModel(WindOptions opts, ContinentGen continent, TectonicModel tectonic, ProvinceMap provinces)
        {
            mapW = opts.MapW; mapH = opts.MapH; seed = (int)opts.Seed;
            this.continent = continent; this.tectonic = tectonic; this.provinces = provinces;
            polarEquatorDistance = opts.PolarEquatorDistance > 0 ? opts.PolarEquatorDistance : mapH / 2.0;
            jetMeander = new FbmNoise(seed + 9001, 1.0 / 150, 2, 0.5);
            cycloneNoise = new FbmNoise(seed + 9002, 1.0 / 40, 3, 0.6);
        }

        // Per-anchor wind — the primitive (signed component bytes).
        public void ComputeAnchorWinds(LatticeMesh mesh)
        {
            int n = mesh.NumAnchors;
            AnchorWindDx = new byte[n];
            AnchorWindDz = new byte[n];
            for (int i = 0; i < n; i++) { AnchorWindDx[i] = 128; AnchorWindDz[i] = 128; }
            var pointClass = continent.PointClass;
            double stepSize = Math.Max(8, mesh.Spacing);
            for (int t = 0; t < n; t++)
            {
                double ax = mesh.AX[t], az = mesh.AZ[t];
                bool isLand = pointClass[t] >= ContinentGen.POINT_COASTAL;
                var (wdx, wdz) = _computeWindAt(ax, az, isLand, stepSize);
                AnchorWindDx[t] = WorldgenMath.EncodeSignedByte(wdx, WIND_MAX);
                AnchorWindDz[t] = WorldgenMath.EncodeSignedByte(wdz, WIND_MAX);
            }
            // Detailed rasters + blur skipped (JS-only bake).
        }

        // The wind law at one position, given its land state.
        private (double dx, double dz) _computeWindAt(double cx, double cz, bool isLand, double stepSize)
        {
            double rawLat = LatitudeAt(cz);

            // Step 2: jet meander shifts effective latitude.
            double meander = jetMeander.Sample(cx, cz) * MEANDER_DEGREES;
            double effLat = rawLat + meander;
            if (effLat > 90) effLat = 90; else if (effLat < -90) effLat = -90;

            // Step 1: latitude band base — interpolate between surrounding anchors.
            int ai = _anchorIndexBelow(effLat);
            var a = _ANCHORS[ai];
            var b = _ANCHORS[ai + 1];
            double span = a.Lat - b.Lat;
            double t = span > 0 ? (a.Lat - effLat) / span : 0;
            double ts = t * t * (3 - 2 * t);
            double dx = a.Dx * (1 - ts) + b.Dx * ts;
            double dz = a.Dz * (1 - ts) + b.Dz * ts;

            // Step 3: cyclone rotation (hemisphere-correct sign).
            double cycX = cycloneNoise.Sample(cx, cz);
            double cycZ = cycloneNoise.Sample(cx + 7000, cz + 3000);
            int hemiSign = rawLat >= 0 ? 1 : -1;
            dx += cycZ * CYCLONE_STRENGTH;
            dz -= cycX * CYCLONE_STRENGTH * hemiSign;

            double magnitude = Math.Sqrt(dx * dx + dz * dz);

            // Steps 4 + 5: land-only modifiers, sharing the upwind ray.
            if (isLand && magnitude > 0.001)
            {
                double ux = dx / magnitude, uz = dz / magnitude;

                // Step 4: friction.
                int overLandCount = 0;
                for (int r = 1; r <= RAY_STEPS; r++)
                {
                    double tx = cx - ux * r * stepSize;
                    double tz = cz - uz * r * stepSize;
                    if (_isLandAt(tx, tz)) overLandCount++;
                }
                double overLandFraction = (double)overLandCount / RAY_STEPS;
                magnitude *= 1 - overLandFraction * FRICTION_MAX_REDUCTION;

                // Step 5: mountain shadow (skip if this point is itself in a range).
                int ownProv = provinces.PrimitiveAt((int)cx, (int)cz);
                bool inOrogen = ownProv == ProvinceMap.PROVINCE_OROGEN || ownProv == ProvinceMap.PROVINCE_EXTENDED_CRUST;
                if (!inOrogen)
                {
                    for (int r = 1; r <= RAY_STEPS; r++)
                    {
                        double tx = cx - ux * r * stepSize;
                        double tz = cz - uz * r * stepSize;
                        if (!_isLandAt(tx, tz)) break;
                        int upProv = provinces.PrimitiveAt((int)tx, (int)tz);
                        if (upProv == ProvinceMap.PROVINCE_OROGEN || upProv == ProvinceMap.PROVINCE_EXTENDED_CRUST)
                        {
                            double fade = (double)r / RAY_STEPS;
                            magnitude *= SHADOW_MIN + (1 - SHADOW_MIN) * fade;
                            break;
                        }
                    }
                }
            }

            if (magnitude < 0) magnitude = 0;

            double oldMag = Math.Sqrt(dx * dx + dz * dz);
            if (oldMag > 0.001) { double scale = magnitude / oldMag; dx *= scale; dz *= scale; }
            else { dx = 0; dz = 0; }

            return (dx, dz);
        }

        private bool _isLandAt(double x, double z)
        {
            int ix = (int)Math.Floor(x), iz = (int)Math.Floor(z);
            if (ix < 0 || ix >= mapW || iz < 0 || iz >= mapH) return false;
            var lg = continent?.LandGrid;
            return lg != null && lg[iz * mapW + ix] == 1;
        }

        public double LatitudeAt(double z)
        {
            double lat = (mapH / 2.0 - z) / polarEquatorDistance * 90;
            return lat > 90 ? 90 : (lat < -90 ? -90 : lat);
        }

        // Latitude with the same jet-meander warp the wind belts use (climate reads this).
        public double EffectiveLatitudeAt(double x, double z)
        {
            double raw = LatitudeAt(z);
            double meander = jetMeander.Sample(x, z) * MEANDER_DEGREES;
            double eff = raw + meander;
            if (eff > 90) eff = 90; else if (eff < -90) eff = -90;
            return eff;
        }

        private int _anchorIndexBelow(double lat)
        {
            for (int i = 0; i < _ANCHORS.Length - 1; i++)
                if (_ANCHORS[i].Lat >= lat && _ANCHORS[i + 1].Lat <= lat) return i;
            if (lat >= _ANCHORS[0].Lat) return 0;
            return _ANCHORS.Length - 2;
        }
    }
}
