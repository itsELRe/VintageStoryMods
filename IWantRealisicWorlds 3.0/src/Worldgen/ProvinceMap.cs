using System;
using System.Collections.Generic;

namespace IWantRealisticWorlds.Worldgen
{
    // Port of tools/visualiser/provinces.js — ProvinceMap + provinceAt.
    // Per-position geologic province via the popsicle-stick union model: every
    // tectonic line is a capsule with a trapezoid width profile; classification
    // is a priority UNION over ALL nearby sticks (never nearest-only). Strata
    // paint top→bottom (active mtn > active rift > fossil mtn > fossil rift);
    // within a stratum, core > ring2 > ring3. Returns a VS GeologicProvinceMap
    // byte (0–5).
    //
    // Requires TectonicLines collision intensity + stick index to be built
    // (ComputeCollisionIntensity) before querying.
    //
    // NOT ported: tectonicBands (dead — the retired upheaval shim, no consumers);
    // _buildEnclosedGrid / enclosedGrid (lakes/landforms/renderer only → defers
    // with features); PROVINCE_RGB / PROVINCE_NAMES (viz / landform naming).
    public sealed class ProvinceMap
    {
        // VS province byte values.
        public const int PROVINCE_SHIELD = 0;
        public const int PROVINCE_PLATFORM = 1;
        public const int PROVINCE_OROGEN = 2;
        public const int PROVINCE_BASIN = 3;
        public const int PROVINCE_LARGE_IGNEOUS = 4;
        public const int PROVINCE_EXTENDED_CRUST = 5;

        public sealed class ProvinceOptions { public int MapW, MapH; }

        private readonly ProvinceOptions p;
        private readonly TectonicModel tectonic;
        private readonly ContinentGen continent;
        private readonly CoastField coastField;


        public ProvinceMap(ProvinceOptions opts, TectonicModel tectonic, ContinentGen continent, CoastField coastField)
        {
            p = opts;
            this.tectonic = tectonic;
            this.continent = continent;
            this.coastField = coastField;
        }

        // Two maps: primitive (faceted landGrid) + detailed (coast-field mask).
        // Same stick-union query; only the land/ocean signal differs. (The mod
        // reads coastField.IsLandAt directly instead of the JS-only landMask
        // raster — equal by construction.)
        // NO whole-world rasters. The visualiser bakes two full-map province images
        // because it draws them; the mod only ever needs single lookups — ~24k of
        // them for wind/climate, and 196 per region when painting the province map.
        // Baking them cost 2.56M pixels x2 spatial queries at world init (23 of the
        // 30 seconds on a 1600px world) to answer a few thousand questions.
        //
        // These two methods ARE the former rasters, evaluated on demand at the same
        // integer pixel the array would have been indexed by — so the values are
        // identical, not merely equivalent.

        // The primitive signal (faceted landGrid) — what wind and climate read.
        public int PrimitiveAt(int x, int z)
        {
            var lg = continent.LandGrid;
            int i = Clamp(z, p.MapH) * p.MapW + Clamp(x, p.MapW);
            return ProvinceAt(tectonic, Clamp(x, p.MapW), Clamp(z, p.MapH), lg[i] == 1);
        }

        // The detailed signal (emergent coastline) — what the region map exports.
        public int DetailedAt(int x, int z)
        {
            int cx = Clamp(x, p.MapW), cz = Clamp(z, p.MapH);
            return ProvinceAt(tectonic, cx, cz, coastField.IsLandAt(cx, cz));
        }

        private static int Clamp(int v, int n) => v < 0 ? 0 : (v >= n ? n - 1 : v);

        private struct Claim
        {
            public double D, Sig;
            public bool IsActive, IsRift;
            public double OrogenW, BasinW, PlatW, ExtW;
        }

        // All band claims at (x, z): one entry per nearby stick whose stack could
        // reach the point. Widths follow the stick's trapezoid profile at the
        // projected arc position; age is NOT in the widths, only in the layering.
        private static List<Claim> StickClaimsAt(TectonicModel tec, double x, double z)
        {
            var L = tec.Lines;
            double mapScale = WorldgenMath.PhiScale(Math.Max(tec.MapW, tec.MapH));
            var claims = new List<Claim>();
            foreach (int segId in L.SticksNear(x, z))
            {
                var seg = L.Segments[segId];
                if (seg.Polyline == null) continue;
                var proj = L.ProjectOntoSegment(segId, x, z);
                double m = L.BandProfileAt(segId, proj.T);
                claims.Add(new Claim
                {
                    D = proj.Dist,
                    Sig = seg.Intensity,
                    IsActive = seg.IsActive,
                    IsRift = seg.PairType == WorldgenMath.ClosingType.Divergent,
                    OrogenW = tec.OrogenW * mapScale * m,
                    BasinW = tec.BasinW * mapScale * m,
                    PlatW = tec.PlatformW * mapScale * m,
                    ExtW = tec.ExtendedCrustWidth * mapScale * m,
                });
            }
            return claims;
        }

        // One stratum = one (age, kind) group. core > ring2 > ring3. Returns a
        // province byte, or -1 if this stratum claims nothing here.
        private static int StratumFromClaims(List<Claim> claims, bool wantActive, bool wantRift, bool isLand)
        {
            bool core = false, ring2 = false, ring3 = false;
            foreach (var c in claims)
            {
                if (c.IsActive != wantActive || c.IsRift != wantRift) continue;
                double coreW = wantRift ? c.ExtW : c.OrogenW;
                if (c.D < coreW) core = true;
                else if (c.D < coreW + c.BasinW) ring2 = true;
                else if (c.D < coreW + c.BasinW + c.PlatW) ring3 = true;
            }
            if (core) return wantRift ? PROVINCE_EXTENDED_CRUST : PROVINCE_OROGEN;
            if (ring2) return wantRift ? (isLand ? PROVINCE_SHIELD : PROVINCE_LARGE_IGNEOUS) : PROVINCE_BASIN;
            if (ring3) return PROVINCE_PLATFORM;
            return -1;
        }

        // provinceAt — direct per-position function. Hotspots override (extended
        // crust). Strata top→bottom; interior = continental shield / oceanic
        // large igneous. Returns the VS GeologicProvinceMap byte (0–5).
        public static int ProvinceAt(TectonicModel tec, double x, double z, bool isLand)
        {
            var hs = tec.GetHotspotInfo(x, z);
            if (hs.inHotspot) return PROVINCE_EXTENDED_CRUST;

            var claims = StickClaimsAt(tec, x, z);

            int pr = StratumFromClaims(claims, true, false, isLand);
            if (pr >= 0) return pr;
            pr = StratumFromClaims(claims, true, true, isLand);
            if (pr >= 0) return pr;
            pr = StratumFromClaims(claims, false, false, isLand);
            if (pr >= 0) return pr;
            pr = StratumFromClaims(claims, false, true, isLand);
            if (pr >= 0) return pr;

            return isLand ? PROVINCE_SHIELD : PROVINCE_LARGE_IGNEOUS;
        }

        // One nearest-claim slot per kind, for UpheavalMap's height law.
        public struct Band { public double D, Sig, OrogenW, BasinW, PlatW, ExtW; }
        public struct Bands { public Band MtnA, MtnF, RiftA, RiftF; }

        // tectonicBands — nearest claim per kind (mountain/rift × active/fossil),
        // same footprint the provinces use so height fills the province belt.
        // Kinds with no stick in reach report D = Infinity + floor widths (the
        // height falloff reads that as zero contribution).
        public static Bands TectonicBands(TectonicModel tec, double x, double z)
        {
            double mapScale = WorldgenMath.PhiScale(Math.Max(tec.MapW, tec.MapH));
            double mFloor = tec.WidthFloor;
            Band Empty() => new Band
            {
                D = double.PositiveInfinity, Sig = 0,
                OrogenW = tec.OrogenW * mapScale * mFloor,
                BasinW = tec.BasinW * mapScale * mFloor,
                PlatW = tec.PlatformW * mapScale * mFloor,
                ExtW = tec.ExtendedCrustWidth * mapScale * mFloor,
            };
            var outv = new Bands { MtnA = Empty(), MtnF = Empty(), RiftA = Empty(), RiftF = Empty() };
            foreach (var c in StickClaimsAt(tec, x, z))
            {
                var band = new Band { D = c.D, Sig = c.Sig, OrogenW = c.OrogenW, BasinW = c.BasinW, PlatW = c.PlatW, ExtW = c.ExtW };
                if (c.IsRift)
                {
                    if (c.IsActive) { if (c.D < outv.RiftA.D) outv.RiftA = band; }
                    else { if (c.D < outv.RiftF.D) outv.RiftF = band; }
                }
                else
                {
                    if (c.IsActive) { if (c.D < outv.MtnA.D) outv.MtnA = band; }
                    else { if (c.D < outv.MtnF.D) outv.MtnF = band; }
                }
            }
            return outv;
        }
    }
}
