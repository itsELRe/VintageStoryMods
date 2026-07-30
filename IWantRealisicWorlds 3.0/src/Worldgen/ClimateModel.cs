using System;

namespace IWantRealisticWorlds.Worldgen
{
    // Port of tools/visualiser/climate.js — ClimateModel (per-point primitive).
    // Three byte values per data point — temperature, rainfall, geo activity —
    // computed once at world init. Land and ocean run the same algorithm with a
    // few inputs swapped or skipped.
    //
    // Temperature:
    //   1. Latitude → piecewise temp curve (hot equatorial plateau, transition,
    //      temperate plateau, transition, cold polar).
    //   2. Land only — subtract continentality (coastNorm × strength).
    //   3. Land coastal — average ocean neighbours' current temp offset, add
    //      currentInfluence × averageOffset.
    //      Ocean — add own current temp offset directly.
    //   4. × globalTemperature, clamp [0, 1], scale to byte.
    //
    // Rainfall:
    //   1. Latitude → piecewise rain curve (ITCZ wet, trades, subtropics, desert
    //      dip, westerlies, polar front, polar dry).
    //   2. Land only — coast aridity with latitude-varying decay K and minRain.
    //   3. Land orogen point — orographic boost scaled by capped elevation.
    //   4. Land — rain shadow upwind ray cast (stops at first orogen hit, fade by
    //      distance, subtract proportional penalty).
    //   5. Land coastal — for each ocean neighbour, dot wind direction with
    //      neighbour-to-this vector; if positive, add windward bonus.
    //   6. × globalPrecipitation, clamp [0, 1], scale to byte.
    //
    // Geo activity (land + ocean):
    //   1. Distance to nearest active boundary → exponential decay, scaled by that
    //      boundary's |collision intensity|.
    //   2. Hotspot proximity bump (max with step 1, no double-count).
    //   3. Clamp [0, 255], byte.
    //
    // NOT ported: the detailed rasters (rasterizeAnchorField + box blur) — JS-only
    // bake; the mod builds region fields in Phase 2. The RGB gradients are viz-only.
    public sealed class ClimateModel
    {
        public sealed class ClimateOptions
        {
            public int MapW, MapH;
            public long Seed;
            public double TropicalEnd = 0.20;
            public double TemperateEnd = 0.70;
            public double VariationStrength = 1.0;
            public double GlobalTemperature = 1.0;
            public double GlobalPrecipitation = 1.0;
            public double ContinentalityStrength = 0.23;
            public double CurrentInfluence = 0.10;
            public double OrographicBoost = 0.20;
            public double RainShadowStrength = 0.30;
            public double WindwardBonusStrength = 0.15;
            public double TempJitter = 0.04;
            public double RainJitter = 0.08;
            // C#-only (no visualiser equivalent): vanilla's Geologic Activity world
            // setting, remapped to a plain multiplier by Settings.GeoActivityMult.
            // 1 = untouched, so the default stays bit-identical to the visualiser.
            public double GeoActivityMult = 1.0;
        }

        private const int RAY_STEPS = 8;

        private readonly int mapW, mapH, seed;
        private readonly ContinentGen continent;
        private readonly TectonicModel tectonic;
        private readonly WindModel wind;
        private readonly CurrentsModel currents;
        private readonly UpheavalMap upheaval;
        private readonly ProvinceMap provinces;
        private readonly DistanceFields distanceFields;

        // Latitude band shape — slider-driven. Curves built once at construction;
        // per-point lookups read the cached arrays.
        private readonly (double X, double Y)[] tempCurve, rainCurve;

        private readonly double globalTemperature, globalPrecipitation;
        private readonly double continentalityStrength, currentInfluence;
        private readonly double orographicBoost, rainShadowStrength, windwardBonusStrength;
        private readonly double tempJitter, rainJitter, geoActivityMult;

        public byte[] AnchorTemp, AnchorRain, AnchorGeo;

        public ClimateModel(ClimateOptions opts, ContinentGen continent, TectonicModel tectonic,
            WindModel wind, CurrentsModel currents, UpheavalMap upheaval, ProvinceMap provinces,
            DistanceFields distanceFields)
        {
            mapW = opts.MapW; mapH = opts.MapH; seed = (int)opts.Seed;
            this.continent = continent; this.tectonic = tectonic; this.wind = wind;
            this.currents = currents; this.upheaval = upheaval; this.provinces = provinces;
            this.distanceFields = distanceFields;

            tempCurve = MakeTempCurve(opts.TropicalEnd, opts.TemperateEnd);
            rainCurve = MakeRainCurve(opts.TropicalEnd, opts.TemperateEnd);

            globalTemperature = opts.GlobalTemperature;
            globalPrecipitation = opts.GlobalPrecipitation;
            continentalityStrength = opts.ContinentalityStrength;
            currentInfluence = opts.CurrentInfluence;
            orographicBoost = opts.OrographicBoost;
            rainShadowStrength = opts.RainShadowStrength;
            windwardBonusStrength = opts.WindwardBonusStrength;
            // Per-point character: a deterministic hash on (pointId, seed) gives a
            // small ± offset on the curve value, so adjacent points at the same
            // effective latitude pick up slightly different bytes.
            tempJitter = opts.TempJitter * opts.VariationStrength;
            rainJitter = opts.RainJitter * opts.VariationStrength;
            geoActivityMult = opts.GeoActivityMult;
        }

        // Curve generators. `tropicalEnd` is the latNorm where the hot/wet
        // equatorial plateau ends; `temperateEnd` is where the temperate plateau
        // ends and polar dryness/cold begins. Shape stays constant; breakpoints
        // rescale with these two.
        private static (double X, double Y)[] MakeTempCurve(double tropicalEnd, double temperateEnd) =>
            new[]
            {
                (0.0,                 1.00),
                (tropicalEnd,         0.85),   // hot plateau end
                (tropicalEnd + 0.05,  0.65),   // fast drop into temperate
                (temperateEnd,        0.35),   // temperate plateau end
                (temperateEnd + 0.05, 0.20),   // fast drop into cold
                (1.0,                 0.08),
            };

        private static (double X, double Y)[] MakeRainCurve(double tropicalEnd, double temperateEnd)
        {
            double span = Math.Max(0.02, temperateEnd - tropicalEnd);
            return new[]
            {
                (0.0,                                     1.00),   // ITCZ
                (tropicalEnd * 0.4,                       0.85),   // trade winds
                (tropicalEnd,                             0.50),   // subtropics start
                (tropicalEnd + span * 0.25,               0.40),   // desert dip
                (tropicalEnd + span * 0.30,               0.55),   // recovery to westerlies
                (tropicalEnd + span * 0.65,               0.70),   // temperate peak
                (temperateEnd,                            0.50),   // polar front
                (temperateEnd + (1 - temperateEnd) * 0.6, 0.25),   // subarctic
                (1.0,                                     0.05),   // polar desert
            };
        }

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

        private double LatToTemp(double lat) => PiecewiseLerp(Math.Abs(lat) / 90, tempCurve);
        private double LatToRain(double lat) => PiecewiseLerp(Math.Abs(lat) / 90, rainCurve);

        // ===== Per-point climate (the primitive) =====
        // The law evaluated at each data point, reading per-point inputs — latitude,
        // distToOcean, the per-point wind/currents, anchorHeight. Neighbour-based
        // bits read neighbour points; only COASTAL points have OCEANIC neighbours,
        // so the maritime effects land exactly on the shoreline points.
        public void ComputeAnchorClimate(LatticeMesh mesh)
        {
            if (mesh == null) return;
            int n = mesh.NumAnchors;
            AnchorTemp = new byte[n];
            AnchorRain = new byte[n];
            AnchorGeo = new byte[n];
            var isLandArr = upheaval?.AnchorIsLand;
            // Ray step ≈ one data-point spacing.
            double stepSize = Math.Max(8, mesh.Spacing);

            // Pass 1: coast distance per anchor + max over land (normalisation).
            var coastDist = new float[n];
            double maxCoast = 1;
            for (int t = 0; t < n; t++)
            {
                double d = distanceFields != null ? distanceFields.GetDistToOceanAt(mesh.AX[t], mesh.AZ[t]) : 0;
                if (double.IsNaN(d) || double.IsInfinity(d)) d = 0;
                coastDist[t] = (float)d;
                bool isLandT = isLandArr != null ? isLandArr[t] == 1 : true;
                if (isLandT && d > maxCoast) maxCoast = d;
            }

            // Pass 2: per-anchor temp / rain / geo.
            for (int t = 0; t < n; t++)
            {
                double ax = mesh.AX[t], az = mesh.AZ[t];
                bool isLand = isLandArr != null ? isLandArr[t] == 1 : true;
                double coastNorm = isLand ? Math.Min(1, coastDist[t] / maxCoast) : 0;
                double lat = wind.EffectiveLatitudeAt(ax, az);
                AnchorTemp[t] = AnchorTempByte(mesh, t, isLand, coastNorm, lat);
                AnchorRain[t] = AnchorRainByte(mesh, t, ax, az, isLand, coastNorm, lat, stepSize);
                AnchorGeo[t] = AnchorGeoByte(ax, az);
            }
            // Detailed rasters + blur skipped (JS-only bake).
        }

        private byte AnchorTempByte(LatticeMesh mesh, int t, bool isLand, double coastNorm, double lat)
        {
            double temp = LatToTemp(lat);
            var off = currents?.AnchorCurrentTempOff;
            var isLandArr = upheaval?.AnchorIsLand;
            if (isLand)
            {
                temp -= coastNorm * continentalityStrength;
                // Coastal current nudge — average ocean neighbour anchors' temp offset.
                if (off != null && isLandArr != null)
                {
                    double sum = 0; int count = 0;
                    foreach (int nt in mesh.NeighborsOfAnchor(t))
                    {
                        if (isLandArr[nt] == 1) continue;   // want ocean neighbours
                        sum += WorldgenMath.DecodeSignedByte(off[nt], CurrentsModel.CURRENT_TEMP_MAX); count++;
                    }
                    if (count > 0) temp += currentInfluence * (sum / count);
                }
            }
            else if (off != null)
            {
                // Ocean — own offset.
                temp += currentInfluence * WorldgenMath.DecodeSignedByte(off[t], CurrentsModel.CURRENT_TEMP_MAX);
            }
            double h = WorldgenMath.Hash2D(t, 0, seed + 8881);
            temp += (h - 0.5) * tempJitter;
            temp *= globalTemperature;
            double c = temp < 0 ? 0 : (temp > 1 ? 1 : temp);
            return (byte)WorldgenMath.Round(c * 255);
        }

        private byte AnchorRainByte(LatticeMesh mesh, int t, double ax, double az,
            bool isLand, double coastNorm, double lat, double stepSize)
        {
            double rain = LatToRain(lat);
            double latDeg = Math.Abs(lat);
            var landGrid = continent?.LandGrid;
            var isLandArr = upheaval?.AnchorIsLand;

            // Province at a position, from the primitive (faceted) land signal —
            // evaluated on demand at the same integer pixel the old raster indexed.
            int ProvAt(double px, double pz)
                => provinces.PrimitiveAt(WorldgenMath.ToInt32(px), WorldgenMath.ToInt32(pz));

            if (isLand)
            {
                double decayK = latDeg < 15 ? 0.5 : (latDeg < 35 ? 2.5 : 1.2);
                double minRain = latDeg < 15 ? 0.6 : (latDeg < 35 ? 0.45 : 0.55);
                rain *= minRain + (1 - minRain) / (1 + coastNorm * decayK);

                // Orographic — province at the anchor, scaled by anchor height.
                int prov = ProvAt(ax, az);
                if (prov == ProvinceMap.PROVINCE_OROGEN || prov == ProvinceMap.PROVINCE_EXTENDED_CRUST)
                {
                    double elev = upheaval?.AnchorHeight != null ? upheaval.AnchorHeight[t] / 255.0 : 0;
                    rain += orographicBoost * Math.Min(0.7, elev);
                }

                // Rain shadow — upwind ray (this anchor's wind), stop at first orogen.
                byte[] wdx = wind.AnchorWindDx, wdz = wind.AnchorWindDz;   // byte-encoded
                double wx = wdx != null ? WorldgenMath.DecodeSignedByte(wdx[t], WindModel.WIND_MAX) : 0;
                double wz = wdz != null ? WorldgenMath.DecodeSignedByte(wdz[t], WindModel.WIND_MAX) : 0;
                double wmag = Math.Sqrt(wx * wx + wz * wz);
                if (wmag > 0.001)
                {
                    double ux = wx / wmag, uz = wz / wmag;
                    for (int s = 1; s <= RAY_STEPS; s++)
                    {
                        double tx = ax - ux * s * stepSize, tz = az - uz * s * stepSize;
                        if (tx < 0 || tx >= mapW || tz < 0 || tz >= mapH) break;
                        if (landGrid != null && landGrid[WorldgenMath.ToInt32(tz) * mapW + WorldgenMath.ToInt32(tx)] != 1) break;
                        int up = ProvAt(tx, tz);
                        if (up == ProvinceMap.PROVINCE_OROGEN || up == ProvinceMap.PROVINCE_EXTENDED_CRUST)
                        {
                            rain -= rainShadowStrength * (1 - (double)s / RAY_STEPS);
                            break;
                        }
                    }
                    // Windward bonus — wind onshore from ocean neighbour anchors.
                    if (isLandArr != null)
                    {
                        foreach (int nt in mesh.NeighborsOfAnchor(t))
                        {
                            if (isLandArr[nt] == 1) continue;   // ocean neighbours only
                            double dxn = ax - mesh.AX[nt], dzn = az - mesh.AZ[nt];
                            double len = Math.Sqrt(dxn * dxn + dzn * dzn);
                            if (len == 0) len = 1;              // JS `|| 1`
                            double align = (wx * dxn + wz * dzn) / len;
                            if (align > 0) rain += windwardBonusStrength * align * wmag;
                        }
                    }
                }
            }

            double h = WorldgenMath.Hash2D(t, 0, seed + 8882);
            rain += (h - 0.5) * rainJitter;
            rain *= globalPrecipitation;
            double c = rain < 0 ? 0 : (rain > 1 ? 1 : rain);
            return (byte)WorldgenMath.Round(c * 255);
        }

        private byte AnchorGeoByte(double ax, double az)
        {
            // Distance to nearest active boundary × that boundary's |intensity|:
            // stronger collision → more geologic activity; transforms (≈0) stay calm.
            var L = tectonic.Lines;
            var kd = L.GetKindDistancesAt(ax, az);
            double dActive = Math.Min(kd.MtnActive, kd.RiftActive);
            double geo = 0;
            if (!double.IsNaN(dActive) && !double.IsInfinity(dActive))
            {
                int segId = kd.MtnActive <= kd.RiftActive ? kd.MtnActiveSeg : kd.RiftActiveSeg;
                var seg = (segId >= 0 && L.Segments != null) ? L.Segments[segId] : null;
                double iv = seg != null ? seg.Intensity : 0;
                if (double.IsNaN(iv)) iv = 0;               // JS `seg.intensity || 0`
                double intensity = Math.Abs(iv);
                double mapScale = Math.Sqrt(Math.Max(mapW, mapH) / 512.0);
                geo = intensity * 255 * Math.Exp(-dActive / (20 * mapScale));
            }
            var hs = tectonic.GetHotspotInfo(ax, az);
            if (hs.inHotspot) geo = Math.Max(geo, 255 * (1 - hs.dist / hs.hotspot.Radius));
            geo *= geoActivityMult;                      // vanilla knob; 1 = no change
            double r = WorldgenMath.Round(geo);          // JS rounds, then clamps
            return (byte)(r < 0 ? 0 : (r > 255 ? 255 : r));
        }
    }
}
