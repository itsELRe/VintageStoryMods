using System;
using System.Collections.Generic;
using System.Linq;

namespace IWantRealisticWorlds.Worldgen
{
    // Port of tools/visualiser/tectonic.js — TectonicModel.
    // Build major seeds on a centred jittered grid (margin-extended), drop minor
    // "fossil" seeds inside each plate, unify them, build one spatial index,
    // extract boundary pixels from the warped nearest-seed grid, place hotspots,
    // classify plate pairs. All randomness is stateless hashing (hash2d + FBM
    // warp) — no sequential PRNG — so nothing here depends on call order.
    //
    // NOTE: the visualiser constructor also builds `this.lines = new TectonicLines`
    // and calls `lines.assignPairTypes(...)`. TectonicLines is a separate port
    // (tectonic-lines.js); until it lands, Lines stays null and the AssignPairTypes
    // forward is deferred. PlatePairTypes is computed here regardless (Lines only
    // reads it). Everything this class produces is independent of Lines.
    public sealed class TectonicModel
    {
        // Boundary interaction codes (mirror V.BOUNDARY_* — used when consumers land).
        public const int BOUNDARY_CONVERGENT = 0;
        public const int BOUNDARY_DIVERGENT = 1;
        public const int BOUNDARY_TRANSFORM = 2;

        public sealed class PlateSeed
        {
            public double X, Z;
            public int PlateId;        // majors: own plateId; minors/unified: majorPlateId
            public bool IsMajor;
            public int Cx, Cz;         // majors only
            public int SeedId;         // unified list only
            public double VecX, VecZ;  // unified list only (motion vector)
        }

        public sealed class Hotspot
        {
            public double X, Z, Radius;
            public int PlateId;
        }

        public sealed class TectonicOptions
        {
            public long Seed;
            public int MapW, MapH;
            public double ContinentSize = 1.0;
            public double PlateCountMult = 1.0;
            public double SeedJitter = 0.7;
            public double WarpPower = 0.12;
            public double PlateSpeedMin = 0.3;
            public double PlateSpeedMax = 1.0;
            public double TransformThreshold = 0.3;
            public double OrogenWidth = 8;
            public double BasinWidth = 6;
            public double FossilWidth = 4;
            public double PlatformWidth = 25;
            public double FossilBasinWidth = 4;
            public double FossilPlatformWidth = 12;
            public double ProvinceWarpPower = 0.6;
            public double ExtendedCrustWidth = 6;
            public double WidthFloor = 0.15;
        }

        public readonly int Seed;
        public readonly int MapW, MapH;
        public readonly double ContinentSize, PlateCountMult, SeedJitter, WarpPower;
        public readonly double PlateSpeedMin, PlateSpeedMax, TransformThreshold;
        // Province width knobs (read by provinceAt / upheaval). Fossil bands are
        // intentionally narrower (older / more eroded).
        public readonly double OrogenW, BasinW, FossilW, PlatformW, FossilBasinW, FossilPlatformW;
        public readonly double ProvinceWarpPower, ExtendedCrustWidth, WidthFloor;

        public readonly double ContinentRadius, GridSpacing;
        public int PlateCount { get; private set; }
        public readonly int TargetPlateCount;

        public List<PlateSeed> MajorSeeds { get; private set; }
        public List<PlateSeed> MinorSeeds { get; private set; }
        public List<PlateSeed> AllSeeds { get; private set; }
        public (double X, double Z)[] PlateVectors { get; private set; }  // indexed by plateId
        public (double X, double Z)[] EdgePhantomVectors { get; private set; } // [W,E,N,S]

        public int[] SeedGrid { get; private set; }
        public int SeedGridStep { get; private set; }
        public int SeedGridGw { get; private set; }
        public int SeedGridGh { get; private set; }

        public byte[] ActiveBoundaryGrid { get; private set; }
        public byte[] FossilBoundaryGrid { get; private set; }
        public List<int> ActiveBoundaryPixels { get; private set; }
        public List<int> FossilBoundaryPixels { get; private set; }

        // Full-map scaffolding, read only while TectonicLines is being built
        // (_extractJunctions, _extractSegments). Nothing queries them afterwards —
        // GetPlateAt goes through the seed spatial index, not SeedGrid. On a
        // 8000x2000 map these three are 46 MB held for the whole session, so the
        // pipeline drops them once the build is finished. See
        // WorldgenPipeline.ReleaseScaffolding.
        public void ReleaseScaffolding()
        {
            SeedGrid = null;
            ActiveBoundaryGrid = null;
            FossilBoundaryGrid = null;
        }

        public List<Hotspot> Hotspots { get; private set; }
        public Dictionary<string, WorldgenMath.ClosingType> PlatePairTypes { get; private set; }

        // TectonicLines — attached after construction (mirrors the JS model ctor's
        // this.lines = new TectonicLines(this); the C# caller sets it, since the
        // model must exist first).
        public TectonicLines Lines;

        // Spatial index over allSeeds.
        private double _cellSize;
        private int _gridCols, _gridRows, _gridOff;
        private List<int>[] _grid;

        // Warp.
        private FbmNoise _warpX, _warpZ;
        private double _warpAmp;

        public TectonicModel(TectonicOptions opts)
        {
            Seed = (int)opts.Seed;
            MapW = opts.MapW; MapH = opts.MapH;
            ContinentSize = opts.ContinentSize;
            PlateCountMult = opts.PlateCountMult;
            SeedJitter = opts.SeedJitter;
            WarpPower = opts.WarpPower;
            PlateSpeedMin = opts.PlateSpeedMin;
            PlateSpeedMax = opts.PlateSpeedMax;
            TransformThreshold = opts.TransformThreshold;
            OrogenW = opts.OrogenWidth; BasinW = opts.BasinWidth; FossilW = opts.FossilWidth;
            PlatformW = opts.PlatformWidth; FossilBasinW = opts.FossilBasinWidth;
            FossilPlatformW = opts.FossilPlatformWidth;
            ProvinceWarpPower = opts.ProvinceWarpPower;
            ExtendedCrustWidth = opts.ExtendedCrustWidth;
            WidthFloor = opts.WidthFloor;

            double mapSize = Math.Max(MapW, MapH);
            double baseRadius = 80;
            ContinentRadius = baseRadius * WorldgenMath.PhiScale(mapSize) * Math.Sqrt(ContinentSize);

            int plateCount = Math.Max(2, (int)WorldgenMath.Round(
                4 * Math.Pow(WorldgenMath.PHI, Math.Log2(mapSize / 512)) * PlateCountMult));
            GridSpacing = Math.Sqrt(((double)MapW * MapH) / plateCount) * 1.5;
            GridSpacing *= Math.Sqrt(ContinentSize);
            GridSpacing = Math.Max(GridSpacing, ContinentRadius * 1.5);
            TargetPlateCount = plateCount;

            GenerateMajorSeeds();
            GenerateMinorSeeds();
            BuildUnifiedSeedList();
            GeneratePlateVectors();
            BuildSpatialIndex();

            // Warp displaces lookup coordinates so plate boundaries look organic.
            double warpFreq = 1 / (GridSpacing * 0.8);
            _warpX = new FbmNoise(Seed + 8001, warpFreq, 3, 0.6);
            _warpZ = new FbmNoise(Seed + 8002, warpFreq, 3, 0.6);
            _warpAmp = GridSpacing * WarpPower;

            ExtractBoundaryPixels();
            // Lines (tectonic-lines.js) attaches here in the next port step.
            GenerateHotspots();
            ComputePlatePairTypes();
            // Lines.AssignPairTypes(PlatePairTypes) deferred with the Lines port.

            Log.Info($"[IWRW] [tectonic] plates={PlateCount} seeds={AllSeeds.Count} " +
                $"hotspots={Hotspots.Count} mask={WorldgenMath.Checksum(ActiveBoundaryGrid):x}");
        }

        private void GenerateMajorSeeds()
        {
            int mapW = MapW, mapH = MapH; double gridSpacing = GridSpacing; int seed = Seed;
            MajorSeeds = new List<PlateSeed>();
            double originX = mapW / 2.0 - gridSpacing * 0.5;
            double originZ = mapH / 2.0 - gridSpacing * 0.5;
            int pad = 1;
            int minCx = (int)Math.Floor(-originX / gridSpacing) - pad;
            int maxCx = (int)Math.Ceiling((mapW - originX) / gridSpacing) + pad;
            int minCz = (int)Math.Floor(-originZ / gridSpacing) - pad;
            int maxCz = (int)Math.Ceiling((mapH - originZ) / gridSpacing) + pad;
            double minDist = gridSpacing * 0.45;
            double minDistSq = minDist * minDist;
            double jitterAmp = 0.8 * SeedJitter; // v1 hardcodes 0.8; slider scales it

            int plateId = 0;
            for (int cz = minCz; cz <= maxCz; cz++)
            {
                for (int cx = minCx; cx <= maxCx; cx++)
                {
                    double jx = 0, jz = 0;
                    if (cx != 0 || cz != 0)
                    {
                        jx = (WorldgenMath.Hash2D(cx, cz, seed + 3333) - 0.5) * jitterAmp;
                        jz = (WorldgenMath.Hash2D(cx, cz, seed + 3334) - 0.5) * jitterAmp;
                    }
                    double sx = originX + (cx + 0.5 + jx) * gridSpacing;
                    double sz = originZ + (cz + 0.5 + jz) * gridSpacing;

                    double margin = gridSpacing * 1.5;
                    if (sx < -margin || sx > mapW + margin || sz < -margin || sz > mapH + margin) continue;

                    bool isInterior = sx >= 0 && sx <= mapW && sz >= 0 && sz <= mapH;
                    if (isInterior && (cx != 0 || cz != 0))
                    {
                        bool tooClose = false;
                        foreach (var existing in MajorSeeds)
                        {
                            double dx = sx - existing.X, dz = sz - existing.Z;
                            if (dx * dx + dz * dz < minDistSq) { tooClose = true; break; }
                        }
                        if (tooClose)
                        {
                            for (int reduce = 0; reduce < 3; reduce++)
                            {
                                jx *= 0.5; jz *= 0.5;
                                sx = originX + (cx + 0.5 + jx) * gridSpacing;
                                sz = originZ + (cz + 0.5 + jz) * gridSpacing;
                                tooClose = false;
                                foreach (var existing in MajorSeeds)
                                {
                                    double dx = sx - existing.X, dz = sz - existing.Z;
                                    if (dx * dx + dz * dz < minDistSq) { tooClose = true; break; }
                                }
                                if (!tooClose) break;
                            }
                        }
                    }

                    MajorSeeds.Add(new PlateSeed { X = sx, Z = sz, PlateId = plateId, IsMajor = true, Cx = cx, Cz = cz });
                    plateId++;
                }
            }
            PlateCount = plateId;
        }

        private void GenerateMinorSeeds()
        {
            int mapW = MapW, mapH = MapH, seed = Seed;
            double mapSize = Math.Max(mapW, mapH);
            int centerFossils = (int)WorldgenMath.Round(4 * Math.Pow(WorldgenMath.PHI, Math.Log2(mapSize / 512)));

            // Area sampling: linear scan because spatial index isn't built yet.
            var plateAreas = new Dictionary<int, int>();
            int sampleStep = Math.Max(4, (int)Math.Floor(mapSize / 100));
            int maxArea = 0;
            for (int z = 0; z < mapH; z += sampleStep)
            {
                for (int x = 0; x < mapW; x += sampleStep)
                {
                    int idx = NearestMajorSeed(x, z);
                    if (idx >= 0)
                    {
                        int pid = MajorSeeds[idx].PlateId;
                        plateAreas.TryGetValue(pid, out int a); a++; plateAreas[pid] = a;
                        if (a > maxArea) maxArea = a;
                    }
                }
            }

            MinorSeeds = new List<PlateSeed>();
            int fossilSeed = seed + 200000;
            double minFossilDist = GridSpacing * 0.35;
            double minFossilDistSq = minFossilDist * minFossilDist;

            // JS Object.entries(plateAreas) iterates integer keys in ascending order.
            foreach (int pid in plateAreas.Keys.OrderBy(k => k))
            {
                int area = plateAreas[pid];
                double ratio = (double)area / maxArea;
                int fossilCount = (int)WorldgenMath.Round(centerFossils * ratio);
                if (fossilCount < 2) fossilCount = 0;

                var plateSeeds = MajorSeeds.Where(s => s.PlateId == pid).ToList();
                double minX = Math.Max(0, plateSeeds.Min(s => s.X) - GridSpacing * 0.5);
                double maxX = Math.Min(mapW, plateSeeds.Max(s => s.X) + GridSpacing * 0.5);
                double minZ = Math.Max(0, plateSeeds.Min(s => s.Z) - GridSpacing * 0.5);
                double maxZ = Math.Min(mapH, plateSeeds.Max(s => s.Z) + GridSpacing * 0.5);

                for (int f = 0; f < fossilCount; f++)
                {
                    double fx = WorldgenMath.Hash2D(pid * 1000 + f, 0, fossilSeed + 5555);
                    double fz = WorldgenMath.Hash2D(pid * 1000 + f, 1, fossilSeed + 6666);
                    double sx = minX + fx * (maxX - minX);
                    double sz = minZ + fz * (maxZ - minZ);

                    bool tooClose = false;
                    foreach (var ms in MajorSeeds)
                    {
                        double dx = sx - ms.X, dz = sz - ms.Z;
                        if (dx * dx + dz * dz < minFossilDistSq) { tooClose = true; break; }
                    }
                    if (tooClose) continue;
                    foreach (var fs in MinorSeeds)
                    {
                        double dx = sx - fs.X, dz = sz - fs.Z;
                        if (dx * dx + dz * dz < minFossilDistSq) { tooClose = true; break; }
                    }
                    if (tooClose) continue;

                    MinorSeeds.Add(new PlateSeed { X = sx, Z = sz, PlateId = pid, IsMajor = false });
                }
            }
        }

        private int NearestMajorSeed(double x, double z)
        {
            double bestDist = double.PositiveInfinity; int bestIdx = -1;
            for (int i = 0; i < MajorSeeds.Count; i++)
            {
                var s = MajorSeeds[i];
                double dx = x - s.X, dz = z - s.Z;
                double d = dx * dx + dz * dz;
                if (d < bestDist) { bestDist = d; bestIdx = i; }
            }
            return bestIdx;
        }

        private void BuildUnifiedSeedList()
        {
            AllSeeds = new List<PlateSeed>();
            foreach (var s in MajorSeeds)
                AllSeeds.Add(new PlateSeed { X = s.X, Z = s.Z, PlateId = s.PlateId, IsMajor = true, SeedId = AllSeeds.Count });
            foreach (var s in MinorSeeds)
                AllSeeds.Add(new PlateSeed { X = s.X, Z = s.Z, PlateId = s.PlateId, IsMajor = false, SeedId = AllSeeds.Count });
        }

        // Plate motion vectors (spec §3.1): every seed gets a seed-based drift
        // vector (uniform direction, bounded speed) as vec = [cos·speed, sin·speed].
        private void GeneratePlateVectors()
        {
            double lo = PlateSpeedMin, hi = PlateSpeedMax;
            PlateVectors = new (double, double)[PlateCount];
            int fossilCount = 0;
            foreach (var s in AllSeeds)
            {
                double angle = WorldgenMath.Hash2D(s.SeedId, 0, Seed + 51000) * Math.PI * 2;
                double speed = lo + WorldgenMath.Hash2D(s.SeedId, 1, Seed + 52000) * (hi - lo);
                s.VecX = Math.Cos(angle) * speed;
                s.VecZ = Math.Sin(angle) * speed;
                if (s.IsMajor) PlateVectors[s.PlateId] = (s.VecX, s.VecZ);
                else fossilCount++;
            }
            // Phantom plates beyond the four map borders (edge lines are REAL active
            // boundaries — "edge dice", agreed 2026-07-10). One seeded vector per
            // side [W,E,N,S], same speed distribution; phantom crust is oceanic.
            EdgePhantomVectors = new (double, double)[4];
            for (int side = 0; side < 4; side++)
            {
                double angle = WorldgenMath.Hash2D(side, 0, Seed + 53000) * Math.PI * 2;
                double speed = lo + WorldgenMath.Hash2D(side, 1, Seed + 54000) * (hi - lo);
                EdgePhantomVectors[side] = (Math.Cos(angle) * speed, Math.Sin(angle) * speed);
            }

            Log.Info($"[IWRW] [tectonic] plate vectors: {PlateCount} plates + {fossilCount} fossil seeds " +
                $"+ 4 edge phantoms, speed∈[{lo}, {hi}]");
        }

        private void BuildSpatialIndex()
        {
            double cellSize = GridSpacing * 0.8;
            cellSize = Math.Max(cellSize, 20);
            _cellSize = cellSize;
            _gridCols = (int)Math.Ceiling(MapW / cellSize) + 4;
            _gridRows = (int)Math.Ceiling(MapH / cellSize) + 4;
            _gridOff = 2;
            int gridLen = _gridCols * _gridRows;
            _grid = new List<int>[gridLen];
            for (int i = 0; i < gridLen; i++) _grid[i] = new List<int>();

            for (int i = 0; i < AllSeeds.Count; i++)
            {
                var s = AllSeeds[i];
                int gcx = (int)Math.Floor(s.X / cellSize) + _gridOff;
                int gcz = (int)Math.Floor(s.Z / cellSize) + _gridOff;
                if (gcx >= 0 && gcx < _gridCols && gcz >= 0 && gcz < _gridRows)
                    _grid[gcz * _gridCols + gcx].Add(i);
            }
        }

        // Unwarped nearest-seed lookup (structural — adjacency, hotspots).
        private int NearestSeedRaw(double x, double z)
        {
            int gcx = (int)Math.Floor(x / _cellSize) + _gridOff;
            int gcz = (int)Math.Floor(z / _cellSize) + _gridOff;
            double bestDist = double.PositiveInfinity; int bestIdx = -1;
            for (int dz = -2; dz <= 2; dz++)
            {
                for (int dx = -2; dx <= 2; dx++)
                {
                    int ci = gcz + dz, cj = gcx + dx;
                    if (ci < 0 || ci >= _gridRows || cj < 0 || cj >= _gridCols) continue;
                    var bucket = _grid[ci * _gridCols + cj];
                    foreach (int si in bucket)
                    {
                        var s = AllSeeds[si];
                        double ddx = x - s.X, ddz = z - s.Z;
                        double d = ddx * ddx + ddz * ddz;
                        if (d < bestDist) { bestDist = d; bestIdx = si; }
                    }
                }
            }
            return bestIdx;
        }

        // Warped nearest-seed lookup (visual — boundaries, ownership).
        private int NearestSeed(double x, double z)
        {
            var (wx, wz) = Warp(x, z);
            int gcx = (int)Math.Floor(wx / _cellSize) + _gridOff;
            int gcz = (int)Math.Floor(wz / _cellSize) + _gridOff;
            double bestDist = double.PositiveInfinity; int bestIdx = -1;
            for (int dz = -2; dz <= 2; dz++)
            {
                for (int dx = -2; dx <= 2; dx++)
                {
                    int ci = gcz + dz, cj = gcx + dx;
                    if (ci < 0 || ci >= _gridRows || cj < 0 || cj >= _gridCols) continue;
                    var bucket = _grid[ci * _gridCols + cj];
                    foreach (int si in bucket)
                    {
                        var s = AllSeeds[si];
                        double ddx = wx - s.X, ddz = wz - s.Z;
                        double d = ddx * ddx + ddz * ddz;
                        if (d < bestDist) { bestDist = d; bestIdx = si; }
                    }
                }
            }
            return bestIdx;
        }

        // Precompute the warped nearest-seed for every pixel, then walk the grid
        // checking all 4 neighbours per cell. The map perimeter is force-stamped
        // active so the picture has a frame.
        private void ExtractBoundaryPixels()
        {
            int mapW = MapW, mapH = MapH;
            double mapSize = Math.Max(mapW, mapH);
            int step = mapSize > 1024 ? 2 : 1;
            int gw = (int)Math.Ceiling((double)mapW / step), gh = (int)Math.Ceiling((double)mapH / step);
            int[] grid = new int[gw * gh];

            for (int gz = 0; gz < gh; gz++)
                for (int gx = 0; gx < gw; gx++)
                    grid[gz * gw + gx] = NearestSeed(gx * step, gz * step);

            SeedGrid = grid;
            SeedGridStep = step;
            SeedGridGw = gw;
            SeedGridGh = gh;

            ActiveBoundaryPixels = new List<int>();
            FossilBoundaryPixels = new List<int>();
            ActiveBoundaryGrid = new byte[mapW * mapH];
            FossilBoundaryGrid = new byte[mapW * mapH];

            void SetActive(int px, int pz)
            {
                ActiveBoundaryPixels.Add(px); ActiveBoundaryPixels.Add(pz);
                if (px >= 0 && px < mapW && pz >= 0 && pz < mapH) ActiveBoundaryGrid[pz * mapW + px] = 1;
            }
            void SetFossil(int px, int pz)
            {
                FossilBoundaryPixels.Add(px); FossilBoundaryPixels.Add(pz);
                if (px >= 0 && px < mapW && pz >= 0 && pz < mapH) FossilBoundaryGrid[pz * mapW + px] = 1;
            }

            for (int gz = 1; gz < gh - 1; gz++)
            {
                for (int gx = 1; gx < gw - 1; gx++)
                {
                    int idx = grid[gz * gw + gx];
                    if (idx < 0) continue;
                    var seed = AllSeeds[idx];
                    bool isActive = false;
                    int myPlate = seed.PlateId;
                    int[] neighbors =
                    {
                        grid[gz * gw + (gx - 1)],
                        grid[gz * gw + (gx + 1)],
                        grid[(gz - 1) * gw + gx],
                        grid[(gz + 1) * gw + gx],
                    };
                    // Lower-side-only detection + junction skip (2+ distinct
                    // differing lower neighbours ⇒ don't mark).
                    int firstNi = -1;
                    bool multipleDistinct = false;
                    foreach (int ni in neighbors)
                    {
                        if (ni < 0 || ni == idx) continue;
                        if (idx < ni)
                        {
                            if (firstNi == -1) firstNi = ni;
                            else if (firstNi != ni) multipleDistinct = true;
                            if (AllSeeds[ni].PlateId != myPlate) isActive = true;
                        }
                    }
                    if (firstNi != -1 && !multipleDistinct)
                    {
                        int px = gx * step, pz = gz * step;
                        if (isActive) SetActive(px, pz);
                        else SetFossil(px, pz);
                    }
                }
            }

            // Perimeter force-stamped STRAIGHT at the literal border (not warped).
            int edgeThreshold = step * 2;
            for (int gz = 0; gz < gh; gz++)
            {
                for (int gx = 0; gx < gw; gx++)
                {
                    int px = gx * step, pz = gz * step;
                    if (px < edgeThreshold || px > mapW - 1 - edgeThreshold ||
                        pz < edgeThreshold || pz > mapH - 1 - edgeThreshold)
                        SetActive(px, pz);
                }
            }
        }

        // Hotspots are DISABLED in v3 (mesh.js's generator returns early). The full
        // generation body is not ported until re-enabled — the output is an empty
        // list, so parity holds. Every consumer reads this list, so empty removes
        // hotspots everywhere (red dots, extended-crust province, geo bumps).
        private void GenerateHotspots()
        {
            Hotspots = new List<Hotspot>();
        }

        private void ComputePlatePairTypes()
        {
            PlatePairTypes = new Dictionary<string, WorldgenMath.ClosingType>();
            var adjacentPairs = new HashSet<string>();
            int mapW = MapW, mapH = MapH;
            int step = Math.Max(2, (int)Math.Floor((double)Math.Min(mapW, mapH) / 300));

            for (int z = 0; z < mapH - step; z += step)
            {
                for (int x = 0; x < mapW - step; x += step)
                {
                    int idxA = NearestSeedRaw(x, z);
                    if (idxA < 0) continue;
                    var seedA = AllSeeds[idxA];
                    int idxR = NearestSeedRaw(x + step, z);
                    if (idxR >= 0 && idxR != idxA)
                    {
                        var seedR = AllSeeds[idxR];
                        if (seedA.PlateId != seedR.PlateId)
                            adjacentPairs.Add(Math.Min(seedA.PlateId, seedR.PlateId) + "," + Math.Max(seedA.PlateId, seedR.PlateId));
                    }
                    int idxB = NearestSeedRaw(x, z + step);
                    if (idxB >= 0 && idxB != idxA)
                    {
                        var seedB = AllSeeds[idxB];
                        if (seedA.PlateId != seedB.PlateId)
                            adjacentPairs.Add(Math.Min(seedA.PlateId, seedB.PlateId) + "," + Math.Max(seedA.PlateId, seedB.PlateId));
                    }
                }
            }

            foreach (string key in adjacentPairs)
            {
                var parts = key.Split(',');
                int pidA = int.Parse(parts[0]), pidB = int.Parse(parts[1]);
                var sa = MajorSeeds[pidA]; var sb = MajorSeeds[pidB];
                PlatePairTypes[key] = WorldgenMath.ClassifyClosing(
                    PlateVectors[pidA].X, PlateVectors[pidA].Z,
                    PlateVectors[pidB].X, PlateVectors[pidB].Z,
                    sa.X, sa.Z, sb.X, sb.Z, TransformThreshold);
            }
        }

        private (double, double) Warp(double x, double z)
        {
            return (WorldgenMath.Round((x + _warpX.Sample(x, z) * _warpAmp) * 1e6) / 1e6,
                    WorldgenMath.Round((z + _warpZ.Sample(x, z) * _warpAmp) * 1e6) / 1e6);
        }

        // ===== Public API =====
        public int GetNearestSeed(double x, double z) => NearestSeed(x, z);
        public int GetPlateAt(double x, double z) { int i = NearestSeed(x, z); return i < 0 ? -1 : AllSeeds[i].PlateId; }
        public int GetPlateAtRaw(double x, double z) { int i = NearestSeedRaw(x, z); return i < 0 ? -1 : AllSeeds[i].PlateId; }
        public (double X, double Z) GetPlateVector(int plateId)
            => (plateId >= 0 && plateId < PlateVectors.Length) ? PlateVectors[plateId] : (0, 0);

        public (bool inHotspot, double dist, Hotspot hotspot) GetHotspotInfo(double x, double z)
        {
            foreach (var h in Hotspots)
            {
                double dx = x - h.X, dz = z - h.Z;
                double d = Math.Sqrt(dx * dx + dz * dz);
                if (d < h.Radius) return (true, d, h);
            }
            return (false, double.PositiveInfinity, null);
        }

        public double GetDistToActiveBoundary(double x, double z)
        {
            var seeds = AllSeeds;
            if (seeds.Count < 2) return double.PositiveInfinity;
            var (wx, wz) = Warp(x, z);
            double cs = _cellSize;
            int gcx = (int)Math.Floor(wx / cs) + _gridOff;
            int gcz = (int)Math.Floor(wz / cs) + _gridOff;
            double best1Dsq = double.PositiveInfinity, best2Dsq = double.PositiveInfinity; int best1Plate = -1;
            for (int dz = -2; dz <= 2; dz++)
            {
                for (int dx = -2; dx <= 2; dx++)
                {
                    int ncx = gcx + dx, ncz = gcz + dz;
                    if (ncx < 0 || ncx >= _gridCols || ncz < 0 || ncz >= _gridRows) continue;
                    var cell = _grid[ncz * _gridCols + ncx];
                    for (int i = 0; i < cell.Count; i++)
                    {
                        var s = seeds[cell[i]];
                        double ddx = wx - s.X, ddz = wz - s.Z;
                        double dsq = ddx * ddx + ddz * ddz;
                        if (dsq < best1Dsq)
                        {
                            if (best1Plate >= 0 && best1Plate != s.PlateId) best2Dsq = best1Dsq;
                            best1Dsq = dsq; best1Plate = s.PlateId;
                        }
                        else if (dsq < best2Dsq && s.PlateId != best1Plate)
                        {
                            best2Dsq = dsq;
                        }
                    }
                }
            }
            double voronoiDist = double.PositiveInfinity;
            if (best2Dsq < double.PositiveInfinity && best1Plate >= 0)
                voronoiDist = (Math.Sqrt(best2Dsq) - Math.Sqrt(best1Dsq)) / 2;
            double edgeDist = Math.Min(Math.Min(x, z), Math.Min(MapW - 1 - x, MapH - 1 - z));
            return Math.Min(voronoiDist, edgeDist);
        }

        public double GetDistToFossilBoundary(double x, double z)
        {
            var seeds = AllSeeds;
            if (seeds.Count < 2) return double.PositiveInfinity;
            var (wx, wz) = Warp(x, z);
            double cs = _cellSize;
            int gcx = (int)Math.Floor(wx / cs) + _gridOff;
            int gcz = (int)Math.Floor(wz / cs) + _gridOff;
            double best1Dsq = double.PositiveInfinity, best2Dsq = double.PositiveInfinity;
            int best1Idx = -1, best1Plate = -1;
            for (int dz = -2; dz <= 2; dz++)
            {
                for (int dx = -2; dx <= 2; dx++)
                {
                    int ncx = gcx + dx, ncz = gcz + dz;
                    if (ncx < 0 || ncx >= _gridCols || ncz < 0 || ncz >= _gridRows) continue;
                    var cell = _grid[ncz * _gridCols + ncx];
                    for (int i = 0; i < cell.Count; i++)
                    {
                        int si = cell[i];
                        var s = seeds[si];
                        double ddx = wx - s.X, ddz = wz - s.Z;
                        double dsq = ddx * ddx + ddz * ddz;
                        if (dsq < best1Dsq)
                        {
                            if (best1Idx >= 0 && best1Plate == s.PlateId && best1Dsq < best2Dsq) best2Dsq = best1Dsq;
                            best1Dsq = dsq; best1Idx = si; best1Plate = s.PlateId;
                        }
                        else if (s.PlateId == best1Plate && si != best1Idx && dsq < best2Dsq)
                        {
                            best2Dsq = dsq;
                        }
                    }
                }
            }
            if (best2Dsq >= double.PositiveInfinity || best1Idx < 0) return double.PositiveInfinity;
            return (Math.Sqrt(best2Dsq) - Math.Sqrt(best1Dsq)) / 2;
        }

        public WorldgenMath.ClosingType GetPlateRelationship(double x, double z)
        {
            var seeds = AllSeeds;
            if (seeds.Count < 2) return WorldgenMath.ClosingType.Convergent;
            double edgeDist = Math.Min(Math.Min(x, z), Math.Min(MapW - 1 - x, MapH - 1 - z));
            var (wx, wz) = Warp(x, z);
            double cs = _cellSize;
            int gcx = (int)Math.Floor(wx / cs) + _gridOff;
            int gcz = (int)Math.Floor(wz / cs) + _gridOff;
            int myPlate = -1, otherPlate = -1;
            double myDsq = double.PositiveInfinity, otherDsq = double.PositiveInfinity;
            for (int dz = -2; dz <= 2; dz++)
            {
                for (int dx = -2; dx <= 2; dx++)
                {
                    int ncx = gcx + dx, ncz = gcz + dz;
                    if (ncx < 0 || ncx >= _gridCols || ncz < 0 || ncz >= _gridRows) continue;
                    var cell = _grid[ncz * _gridCols + ncx];
                    for (int i = 0; i < cell.Count; i++)
                    {
                        var s = seeds[cell[i]];
                        double ddx = wx - s.X, ddz = wz - s.Z;
                        double dsq = ddx * ddx + ddz * ddz;
                        if (dsq < myDsq)
                        {
                            if (myPlate >= 0 && myPlate != s.PlateId && myDsq < otherDsq)
                            {
                                otherPlate = myPlate; otherDsq = myDsq;
                            }
                            myDsq = dsq; myPlate = s.PlateId;
                        }
                        else if (s.PlateId != myPlate && dsq < otherDsq)
                        {
                            otherPlate = s.PlateId; otherDsq = dsq;
                        }
                    }
                }
            }
            if (edgeDist < Math.Sqrt(otherDsq)) return WorldgenMath.ClosingType.Convergent;
            if (otherPlate < 0 || myPlate < 0) return WorldgenMath.ClosingType.Convergent;
            string key = Math.Min(myPlate, otherPlate) + "," + Math.Max(myPlate, otherPlate);
            return PlatePairTypes.TryGetValue(key, out var t) ? t : WorldgenMath.ClosingType.Convergent;
        }
    }
}
