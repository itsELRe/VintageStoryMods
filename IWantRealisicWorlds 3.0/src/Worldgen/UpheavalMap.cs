using System;

namespace IWantRealisticWorlds.Worldgen
{
    // Port of tools/visualiser/upheaval.js — UpheavalMap.
    // The land-elevation primitive: the per-anchor (height, depth) field
    // (spec §6) — two UNSIGNED 0–255 values per point, height (0 = sea level,
    // rising inland) and depth (0 = coast, deepening seaward), mutually exclusive.
    // Built from a capped coast-distance base + collision intensity (over the
    // province footprint, via ProvinceMap.TectonicBands) + coherent variance,
    // self-scaled per side to the full byte range. The byte is a proportion; the
    // column builder owns byte→altitude.
    //
    // NOT ported: the detailed-map derivation (rasterizeAnchorField + box blur) —
    // the visualiser's whole-map bake of the anchor field. The mod builds the
    // region UpheavelMap/OceanMap from these anchors in MapGenerators (Phase 2).
    // Palettes (upheavalRGB/oceanDepthRGB) are viz-only.
    public sealed class UpheavalMap
    {
        public sealed class UpheavalOptions
        {
            public int MapW, MapH;
            public long Seed;
            public int WorldHeight;   // carried for parity of the opts; unused here (byte is a proportion)
            public double LandBaseCap = 0.40;
            public double OceanBaseCap = 0.50;
            public double BaseRiseFrac = 0.35;
            public double TectWeight = 1.0;
            public double TerrainFossilWeight = 0.6;
            public double TerrainVarAmp = 0.10;
            public double TerrainVarScaleFrac = 0.12;
            // Coastal shelf (sea side, per pixel — see DepthByteAt).
            public double ShelfReach = 1.0;
            public double ShelfDepth = 0.25;
        }

        private readonly UpheavalOptions p;
        private readonly TectonicModel tectonic;
        private readonly ContinentGen continent;
        private readonly DistanceFields distanceFields;
        private readonly int Seed;

        private readonly double landBaseCap, oceanBaseCap, baseRise, tectWeight, terrainFossilWeight, varAmp;
        private readonly double shelfReach, shelfDepth;
        private readonly CoastField coastField;
        private readonly FbmNoise _varFbm;

        // The primitive outputs.
        public byte[] AnchorHeight;
        public byte[] AnchorDepth;
        public byte[] AnchorIsLand;
        public double MaxHeightRaw, MaxDepthRaw;

        public UpheavalMap(UpheavalOptions opts, TectonicModel tectonic, ContinentGen continent,
            DistanceFields distanceFields, CoastField coastField = null)
        {
            p = opts;
            this.tectonic = tectonic;
            this.continent = continent;
            this.distanceFields = distanceFields;
            this.coastField = coastField;
            Seed = (int)opts.Seed;

            double mapSize = Math.Max(p.MapW, p.MapH);
            landBaseCap = opts.LandBaseCap;
            oceanBaseCap = opts.OceanBaseCap;
            baseRise = mapSize * opts.BaseRiseFrac;
            tectWeight = opts.TectWeight;
            terrainFossilWeight = opts.TerrainFossilWeight;
            varAmp = opts.TerrainVarAmp;
            _varFbm = new FbmNoise(Seed + 61000, 1 / (mapSize * opts.TerrainVarScaleFrac), 3, 0.5);
            shelfReach = opts.ShelfReach;
            shelfDepth = opts.ShelfDepth;
        }

        // ===== Ocean depth at a pixel — the map-facing query =====
        // The anchor field alone cannot see water narrower than the lattice spacing:
        // a one-face inlet contains no oceanic point, so every anchor around it reads
        // "land" and its depth interpolates to 0 — water that generates as dry
        // ground. The shelf term is evaluated HERE, per pixel, from the warped
        // coastline, which is defined everywhere, so depth can never be absent.
        //
        // The shelf is a FLOOR and the lattice bathymetry occupies the range ABOVE
        // it, so trenches, rifts and basins keep their full relief at any shelf
        // setting. (Combining them with max() made the two compete, and raising the
        // shelf progressively erased the lattice.)
        public int DepthByteAt(LatticeMesh mesh, double x, double z)
        {
            // PARITY: the visualiser rasterises the anchor field into a Uint8Array
            // FIRST, so the shelf combines with an already-rounded byte. Rounding
            // here, before the combine, is what keeps the two identical.
            double lattice = Clamp255(WorldgenMath.Round(mesh.SampleScalar(x, z, AnchorDepth)));
            if (coastField == null || shelfDepth <= 0) return (int)lattice;

            double sdw = coastField.SignedDistWarpedAt(x, z);
            if (sdw >= 0) return (int)lattice;   // land — untouched

            // Beyond the coast band the exact distance is unknown, so hold it AT the
            // band: the shelf stops ramping rather than jumping to full depth, which
            // is what would draw a ring.
            double band = coastField.Band;
            double reach = Math.Max(0.5, shelfReach * band);
            double d = double.IsNegativeInfinity(sdw) ? band : -sdw;
            double shelf = shelfDepth * 255 * Math.Min(1, d / reach);

            return Clamp255(WorldgenMath.Round(shelf + lattice * (255 - shelf) / 255));
        }

        private static int Clamp255(double v) => v < 0 ? 0 : (v > 255 ? 255 : (int)v);

        // Raw base-terrain magnitude at a pixel (spec §6), pre-self-scale.
        private double _rawTerrainAt(double x, double z, bool isLand)
        {
            double dCoastRaw = distanceFields.GetDistToOceanAt(x, z);
            double dCoast = (double.IsPositiveInfinity(dCoastRaw) || double.IsNaN(dCoastRaw)) ? baseRise : dCoastRaw;
            double baseCap = isLand ? landBaseCap : oceanBaseCap;
            double baseTerm = baseCap * Math.Min(1, dCoast / baseRise);

            // Tectonic term over the same footprint the provinces use, so height
            // fills the province belt. Sign raises (convergent) / lowers (divergent);
            // fossils discounted here (age lives in height, not in width/category).
            var b = ProvinceMap.TectonicBands(tectonic, x, z);
            var mtn = b.MtnA.D <= b.MtnF.D ? b.MtnA : b.MtnF;
            var rift = b.RiftA.D <= b.RiftF.D ? b.RiftA : b.RiftF;
            double mtnAge = b.MtnF.D < b.MtnA.D ? terrainFossilWeight : 1;
            double riftAge = b.RiftF.D < b.RiftA.D ? terrainFossilWeight : 1;
            double mtnReach = mtn.OrogenW + mtn.BasinW + mtn.PlatW;
            double riftReach = rift.ExtW + rift.BasinW + rift.PlatW;

            static double Smooth(double d, double reach)
            {
                if (reach <= 0 || d >= reach) return 0;
                double t = d / reach;
                return 1 - t * t * (3 - 2 * t); // smoothstep: 1 at the line → 0 at the belt edge
            }
            double tect = mtn.Sig * mtnAge * Smooth(mtn.D, mtnReach)
                        + rift.Sig * riftAge * Smooth(rift.D, riftReach);

            double variance = varAmp * _varFbm.Sample(x, z);
            return Math.Max(0, baseTerm + tect * tectWeight + variance);
        }

        // Base-terrain primitive per anchor: each carries (height, depth).
        // Self-scales each side to 255. Call after mesh + collision intensity.
        // NOTE (parity): rawH/rawD are Float32 in JS; maxH/maxD track the DOUBLE
        // raw. So the scale factor uses the double max, but the scaled value reads
        // the float32-truncated raw — replicated exactly with float[] + double.
        public void ComputePointTerrain(LatticeMesh mesh)
        {
            int n = mesh.NumAnchors;
            AnchorHeight = new byte[n];
            AnchorDepth = new byte[n];
            AnchorIsLand = new byte[n];
            var rawH = new float[n];
            var rawD = new float[n];
            double maxH = 1e-6, maxD = 1e-6;
            var pointClass = continent.PointClass;
            for (int t = 0; t < n; t++)
            {
                double x = mesh.AX[t], z = mesh.AZ[t];
                bool isLand = pointClass[t] >= ContinentGen.POINT_COASTAL;
                AnchorIsLand[t] = (byte)(isLand ? 1 : 0);
                double raw = _rawTerrainAt(x, z, isLand);
                if (isLand) { rawH[t] = (float)raw; if (raw > maxH) maxH = raw; }
                else { rawD[t] = (float)raw; if (raw > maxD) maxD = raw; }
            }
            double sh = 255 / maxH, sd = 255 / maxD;
            for (int t = 0; t < n; t++)
            {
                AnchorHeight[t] = rawH[t] > 0 ? (byte)Math.Min(255, (int)WorldgenMath.Round((double)rawH[t] * sh)) : (byte)0;
                // 0 is RESERVED for land. Every water point gets at least 1, so a
                // shallow inland sea — whose raw depth rounds to nothing against the
                // world's deepest trench — still reads as water rather than dry ground.
                AnchorDepth[t] = AnchorIsLand[t] == 1
                    ? (byte)0
                    : (byte)Math.Max(1, Math.Min(255, (int)WorldgenMath.Round((double)rawD[t] * sd)));
            }
            MaxHeightRaw = maxH; MaxDepthRaw = maxD;

            // Detailed rasters + blur skipped (JS-only bake; the mod builds region
            // maps from these anchors in MapGenerators).

            Log.Info($"[IWRW] [upheaval] point terrain: {n} points — maxHeightRaw={maxH:F3} maxDepthRaw={maxD:F3}");
        }
    }
}
