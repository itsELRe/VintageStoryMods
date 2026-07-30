using System;
using System.Collections.Generic;
using System.Linq;

namespace IWantRealisticWorlds.Worldgen
{
    // Port of tools/visualiser/ocean.js (orchestrator + queries + plate typing)
    // and continent-bfs.js (_growContinents / _closeCoast / _fillEnclosedPockets).
    //
    // Labels the lattice FACES land/ocean: plate typing → BFS continent growth →
    // deterministic coast cleanup → derived point classification + land raster.
    //
    // ORDER-CRITICAL: this uses stateful Mulberry32 PRNGs (typeRng, growth rng),
    // so the exact sequence of Next() draws must match the JS. The control flow
    // below is a faithful transcription for that reason.
    //
    // NOT ported: _addFragmentationIslands (continent-islands.js) — dormant
    // (fragmentation disabled; must be rewritten to face-labels on revival), and
    // the renderer-only seed/marker lists (viz, no downstream consumer).
    public sealed class ContinentGen
    {
        // Point classification (derived from incident face labels).
        public const byte POINT_OCEANIC = 0;   // touches only OCEAN faces
        public const byte POINT_COASTAL = 1;   // touches both — on the coast polyline
        public const byte POINT_INTERIOR = 2;  // touches only LAND faces

        public sealed class ContinentOptions
        {
            public int MapW, MapH;
            public long Seed;
            public double ContinentSize = 1.0;
            public double Landcover = 0.6;
            public double LandcoverScale = 1.0;
            public int SeedOverride = 0;
            public double SizeVar = 0.5;
            public double Fragmentation = 0;
            public double PlateBias = 1.0;
            public double SeparationBias = 1.0;
            public double EdgeBias = 1.0;
            public double GapFill = 1.0;
        }

        private sealed class Growth { public int Id; public List<int> Queue; public double Speed; }

        private readonly ContinentOptions p;
        private readonly TectonicModel tectonic;
        private readonly LatticeMesh mesh;
        public readonly double ContinentRadius, GridSpacing;
        public readonly double SpawnX, SpawnZ;

        // Plate typing outputs.
        public byte[] PlateGrid;
        public Dictionary<int, int> PlateAreas;
        public Dictionary<int, (double X, double Z)> PlateCentroids;
        public HashSet<int> EdgePlates;
        public List<int> InteriorPlates;
        public int SpawnPlateId;
        public HashSet<int> ContinentalPlates;

        // Face + derived outputs.
        public int[] FaceState;      // 0 = ocean, >0 = continent id (JS Uint16Array range)
        public byte[] PointClass;
        public byte[] LandGrid;
        public List<int> CoastPixels;
        public byte[] CoastGrid;

        // PlateGrid feeds the BFS growth and the centroid test, CoastGrid is written
        // by the coast scan and read by nothing else — both are construction-only.
        // LandGrid is NOT released: ProvinceMap.PrimitiveAt reads it, which is the
        // faceted land signal wind and climate query. See
        // WorldgenPipeline.ReleaseScaffolding.
        public void ReleaseScaffolding()
        {
            PlateGrid = null;
            CoastGrid = null;
        }

        public ContinentGen(ContinentOptions opts, TectonicModel tectonic, LatticeMesh mesh)
        {
            p = opts;
            this.tectonic = tectonic;
            this.mesh = mesh;
            ContinentRadius = tectonic.ContinentRadius;
            GridSpacing = tectonic.GridSpacing;
            SpawnX = p.MapW / 2.0;
            SpawnZ = p.MapH / 2.0;
        }

        public bool IsLandAt(double px, double pz)
        {
            if (FaceState == null) return false;
            return FaceState[mesh.FaceAt(px, pz)] > 0;
        }

        public void Calibrate()
        {
            _classifyPlates();
            _growContinents();

            int spawnFace = mesh.FaceAt(SpawnX, SpawnZ);
            if (FaceState[spawnFace] == 0) FaceState[spawnFace] = 1;

            _classifyPoints();
            _rasterizeLandGrid();
            _collectCoastPixels();

            int landFaces = 0, coastal = 0;
            for (int f = 0; f < FaceState.Length; f++) if (FaceState[f] > 0) landFaces++;
            for (int t = 0; t < PointClass.Length; t++) if (PointClass[t] == POINT_COASTAL) coastal++;
            Log.Info($"[IWRW] [continent] faces={FaceState.Length} land={landFaces} coastalPts={coastal} landMask={WorldgenMath.Checksum(LandGrid):x}");
        }

        // ===== Plate typing (coarse grid + continental/oceanic sets) =====
        private void _classifyPlates()
        {
            int mapW = p.MapW, mapH = p.MapH;
            var tec = tectonic;

            PlateGrid = new byte[mapW * mapH];
            PlateAreas = new Dictionary<int, int>();
            var plateSumX = new Dictionary<int, long>();
            var plateSumZ = new Dictionary<int, long>();
            EdgePlates = new HashSet<int>();
            for (int z = 0; z < mapH; z++)
            {
                for (int x = 0; x < mapW; x++)
                {
                    int pid = tec.GetPlateAt(x, z);
                    PlateGrid[z * mapW + x] = (byte)(pid >= 0 ? pid : 255);
                    if (pid >= 0)
                    {
                        PlateAreas.TryGetValue(pid, out int a); PlateAreas[pid] = a + 1;
                        plateSumX.TryGetValue(pid, out long sx); plateSumX[pid] = sx + x;
                        plateSumZ.TryGetValue(pid, out long sz); plateSumZ[pid] = sz + z;
                        if (x == 0 || x == mapW - 1 || z == 0 || z == mapH - 1) EdgePlates.Add(pid);
                    }
                }
            }
            PlateCentroids = new Dictionary<int, (double, double)>();
            var allPlateIds = PlateAreas.Keys.OrderBy(k => k).ToList();
            foreach (int pid in allPlateIds)
                PlateCentroids[pid] = ((double)plateSumX[pid] / PlateAreas[pid], (double)plateSumZ[pid] / PlateAreas[pid]);
            InteriorPlates = allPlateIds.Where(pid => !EdgePlates.Contains(pid)).ToList();
            if (InteriorPlates.Count == 0) InteriorPlates = allPlateIds;
            SpawnPlateId = tec.GetPlateAt(SpawnX, SpawnZ);

            // Continental / oceanic typing. Edge plates lean oceanic; interior lean
            // continental. Spawn plate forced continental. ONE typeRng draw per
            // plate, in ascending plateId order.
            var typeRng = WorldgenMath.MakePRNG(WorldgenMath.ToInt32(WorldgenMath.Hash2D(0, 0, p.Seed + 55555) * 4294967295.0));
            ContinentalPlates = new HashSet<int>();
            foreach (int pid in allPlateIds)
            {
                if (EdgePlates.Contains(pid)) { if (typeRng.Next() < 0.2) ContinentalPlates.Add(pid); }
                else { if (typeRng.Next() < 0.7) ContinentalPlates.Add(pid); }
            }
            ContinentalPlates.Add(SpawnPlateId);
        }

        // ===== BFS continent growth (continent-bfs.js) =====
        private void _growContinents()
        {
            int mapW = p.MapW, mapH = p.MapH;
            double mapArea = (double)mapW * mapH;
            double lcs = p.LandcoverScale;
            int nF = mesh.NumFaces;
            double faceArea = mesh.Spacing * mesh.Spacing * Math.Sqrt(3) / 4;

            FaceState = new int[nF];
            int[] state = FaceState;

            double targetArea = p.Landcover * mapArea;
            if (targetArea < faceArea) return;

            double gf = p.GapFill, sb = p.SeparationBias, eb = p.EdgeBias, pb = p.PlateBias;

            // Face centroids + claimable set (centroid inside the map).
            var fcx = new double[nF]; var fcz = new double[nF];
            var claimable = new byte[nF];
            int claimableCount = 0;
            for (int f = 0; f < nF; f++)
            {
                var c = mesh.FaceCentroid(f);
                fcx[f] = c.x; fcz[f] = c.z;
                if (c.x >= 0 && c.x < mapW && c.z >= 0 && c.z < mapH) { claimable[f] = 1; claimableCount++; }
            }

            double claimedArea = 0;

            // Seed count (growth units = claimable faces).
            double worldScale = Math.Max(1, Math.Sqrt(mapArea / (512.0 * 512)));
            double baseSeeds;
            if (lcs >= 4.5) baseSeeds = 1;
            else if (lcs >= 3.5) baseSeeds = 1 + (4.5 - lcs);
            else if (lcs >= 2.5) baseSeeds = 2 + (3.5 - lcs);
            else if (lcs >= 1.5) baseSeeds = 3 + (2.5 - lcs) * 3;
            else if (lcs >= 0.5) baseSeeds = 6 + (1.5 - lcs) * 9;
            else baseSeeds = 15 + (0.5 - lcs) * claimableCount * 0.3;
            int numSeeds = Math.Min(claimableCount, Math.Max(1, (int)WorldgenMath.Round(baseSeeds * worldScale)));
            if (p.SeedOverride > 0) numSeeds = Math.Min(claimableCount, Math.Max(1, p.SeedOverride));

            var rng = WorldgenMath.MakePRNG(WorldgenMath.ToInt32(WorldgenMath.Hash2D(2, 0, p.Seed + 77777) * 4294967295.0));

            // Seed selection: spawn face first, then farthest-first w/ plate bias.
            int spawnFace = mesh.FaceAt(SpawnX, SpawnZ);
            var seeds = new List<int> { spawnFace };
            var seedSet = new HashSet<int> { spawnFace };
            while (seeds.Count < numSeeds)
            {
                int bestFace = -1; double bestScore = -1;
                for (int f = 0; f < nF; f++)
                {
                    if (claimable[f] == 0 || seedSet.Contains(f)) continue;
                    double sx = fcx[f], sz = fcz[f];
                    if (p.Landcover < 0.5)
                    {
                        double margin = Math.Max(mapW, mapH) * 0.05;
                        if (sx < margin || sx > mapW - margin || sz < margin || sz > mapH - margin) continue;
                    }
                    double minDist = double.PositiveInfinity;
                    foreach (int s in seeds)
                    {
                        double dx = (sx - fcx[s]) / mapW;
                        double dz = (sz - fcz[s]) / mapH;
                        minDist = Math.Min(minDist, dx * dx + dz * dz);
                    }
                    double score = minDist;

                    int gx = Math.Max(0, Math.Min(mapW - 1, (int)WorldgenMath.Round(sx)));
                    int gz = Math.Max(0, Math.Min(mapH - 1, (int)WorldgenMath.Round(sz)));
                    int pid = PlateGrid[gz * mapW + gx];
                    if (ContinentalPlates.Contains(pid)) score *= 1.0 + 1.5 * pb;
                    else score *= Math.Max(0.1, 1.0 - 0.5 * pb);

                    if (score > bestScore) { bestScore = score; bestFace = f; }
                }
                if (bestFace < 0) break;
                seeds.Add(bestFace);
                seedSet.Add(bestFace);
            }

            // Activate seed faces (each gets a unique continent id).
            var activatedSeeds = new List<int>();
            for (int si = 0; si < seeds.Count; si++)
            {
                if (claimedArea >= targetArea) break;
                int s = seeds[si];
                state[s] = si + 1;
                claimedArea += faceArea;
                activatedSeeds.Add(s);
            }

            // Round-robin BFS growth (edge-connected). One speed draw per activated
            // seed, in order.
            double sizeVar = p.SizeVar;
            var queues = new List<Growth>();
            for (int i = 0; i < activatedSeeds.Count; i++)
            {
                int s = activatedSeeds[i];
                var q = new List<int>();
                var sortedNbrs = new List<int>(mesh.FaceEdgeNeighbors(s)); sortedNbrs.Sort();
                foreach (int n in sortedNbrs) if (claimable[n] == 1 && state[n] == 0) q.Add(n);
                double speed = 1.0 + (rng.Next() - 0.5) * 2 * sizeVar;
                queues.Add(new Growth { Id = i + 1, Queue = q, Speed = Math.Max(0.25, speed) });
            }
            var inQueue = new HashSet<int>();
            foreach (var cq in queues) foreach (int n in cq.Queue) inQueue.Add(n);

            int mapSize = Math.Max(mapW, mapH);

            while (claimedArea < targetArea)
            {
                bool anyGrew = false;
                foreach (var cq in queues)
                {
                    if (claimedArea >= targetArea) break;
                    if (cq.Queue.Count == 0) continue;

                    int facesThisTurn = Math.Max(1, (int)WorldgenMath.Round((1 + rng.Next() * 2) * cq.Speed));
                    for (int ct = 0; ct < facesThisTurn; ct++)
                    {
                        if (claimedArea >= targetArea || cq.Queue.Count == 0) break;

                        int bestIdx = -1; double bestScore = double.NegativeInfinity;
                        int samples = Math.Min(cq.Queue.Count, 8);
                        while (samples-- > 0 && cq.Queue.Count > 0)
                        {
                            int ri = (int)Math.Floor(rng.Next() * cq.Queue.Count);
                            int rc = cq.Queue[ri];

                            int edgeClaimed = 0; bool edgeForeign = false;
                            bool invalid = state[rc] != 0;
                            if (!invalid)
                            {
                                foreach (int nb in mesh.FaceEdgeNeighbors(rc))
                                {
                                    if (state[nb] > 0) { edgeClaimed++; if (state[nb] != cq.Id) edgeForeign = true; }
                                }
                                if (edgeForeign && sb >= 1.5) invalid = true;
                            }
                            if (invalid)
                            {
                                int last = cq.Queue.Count - 1;
                                cq.Queue[ri] = cq.Queue[last];
                                cq.Queue.RemoveAt(last);
                                if (bestIdx == last) bestIdx = ri;
                                continue;
                            }

                            var ring = mesh.FaceGrowthNeighbors(rc);
                            int ringClaimed = 0; bool ring1Foreign = edgeForeign, ring2Foreign = false;
                            foreach (int nb in ring)
                            {
                                if (state[nb] > 0) { ringClaimed++; if (state[nb] != cq.Id) ring1Foreign = true; }
                            }
                            if (sb > 0 && !ring1Foreign)
                            {
                                bool found = false;
                                foreach (int nb in ring)
                                {
                                    foreach (int nb2 in mesh.FaceGrowthNeighbors(nb))
                                        if (state[nb2] > 0 && state[nb2] != cq.Id) { ring2Foreign = true; found = true; break; }
                                    if (found) break;
                                }
                            }

                            double gapBonus = 0;
                            if (edgeClaimed >= 3) gapBonus = 20 * gf;
                            else if (ringClaimed >= 8) gapBonus = 4 * gf;
                            else if (edgeClaimed == 2) gapBonus = 2 * gf;
                            else if (ringClaimed >= 5) gapBonus = 1 * gf;
                            else if (gf > 1) gapBonus = (gf - 1) * 2;

                            double sepPenalty = 1.0;
                            if (sb > 0)
                            {
                                if (ring1Foreign) sepPenalty = Math.Max(0.02, 1 - sb * 0.7);
                                else if (ring2Foreign) sepPenalty = Math.Max(0.2, 1 - sb * 0.4);
                            }

                            double edgePenalty = 1.0;
                            if (eb > 0)
                            {
                                double margin = mapSize * 0.05 * eb;
                                double dist = Math.Min(Math.Min(fcx[rc], fcz[rc]), Math.Min(mapW - fcx[rc], mapH - fcz[rc]));
                                if (dist < margin)
                                {
                                    double t = Math.Max(0, dist / margin);
                                    double smooth = t * t * (3 - 2 * t);
                                    double floor = Math.Min(1, Math.Max(0.02, 0.1 / eb));
                                    edgePenalty = floor + (1 - floor) * smooth;
                                }
                            }

                            int pcx = Math.Max(0, Math.Min(mapW - 1, (int)WorldgenMath.Round(fcx[rc])));
                            int pcz = Math.Max(0, Math.Min(mapH - 1, (int)WorldgenMath.Round(fcz[rc])));
                            bool onContinental = ContinentalPlates.Contains(PlateGrid[pcz * mapW + pcx]);
                            double plateBias = onContinental ? 1.0 + 1.0 * pb : Math.Max(0.1, 1.0 - 0.35 * pb);

                            double score = (gapBonus + ringClaimed * 0.25 + rng.Next() * 1.0) * sepPenalty * edgePenalty * plateBias;
                            if (score > bestScore) { bestScore = score; bestIdx = ri; }
                        }

                        if (bestIdx < 0) continue;
                        int face = cq.Queue[bestIdx];
                        cq.Queue[bestIdx] = cq.Queue[cq.Queue.Count - 1];
                        cq.Queue.RemoveAt(cq.Queue.Count - 1);
                        if (state[face] != 0) continue;

                        state[face] = cq.Id;
                        claimedArea += faceArea;
                        anyGrew = true;

                        var faceNbrs = new List<int>(mesh.FaceEdgeNeighbors(face)); faceNbrs.Sort();
                        foreach (int n in faceNbrs)
                        {
                            if (claimable[n] == 1 && state[n] == 0 && !inQueue.Contains(n)) { cq.Queue.Add(n); inQueue.Add(n); }
                        }
                    }
                }
                if (!anyGrew) break;
            }

            // Deterministic cleanup.
            bool protectStraits = sb >= 1.5;
            int closingRounds = (int)WorldgenMath.Round(gf);
            if (closingRounds > 0) _closeCoast(closingRounds, gf, protectStraits, claimable, spawnFace);
            _fillEnclosedPockets(gf, protectStraits, claimable);
            // (renderer continent-seed markers not ported — viz only)
        }

        // Owner pick over a neighbor list: -2 = empty/below-count (JS null),
        // -1 = protected-mixed, else majority id (ties → lowest id).
        private int _ownerOf(IReadOnlyList<int> nbrs, int minCount, bool protectStraits)
        {
            int[] state = FaceState;
            int n = 0;
            var ids = new List<int>(); var counts = new List<int>();
            foreach (int nb in nbrs)
            {
                int id = state[nb];
                if (id == 0) continue;
                n++;
                int k = ids.IndexOf(id);
                if (k >= 0) counts[k]++; else { ids.Add(id); counts.Add(1); }
            }
            if (n < minCount) return -2;
            if (ids.Count > 1 && protectStraits) return -1;
            int best = 0;
            for (int k = 1; k < ids.Count; k++)
                if (counts[k] > counts[best] || (counts[k] == counts[best] && ids[k] < ids[best])) best = k;
            return ids[best];
        }

        private void _closeCoast(int rounds, double gf, bool protectStraits, byte[] claimable, int spawnFace)
        {
            int[] state = FaceState;
            int nF = state.Length;
            bool narrow = gf >= 1.5;

            for (int r = 0; r < rounds; r++)
            {
                // Phase A — fill notches (≥2 land edges).
                var fills = new List<int>();
                for (int f = 0; f < nF; f++)
                {
                    if (state[f] != 0 || claimable[f] == 0) continue;
                    int owner = _ownerOf(mesh.FaceEdgeNeighbors(f), 2, protectStraits);
                    if (owner != -2 && owner > 0) { fills.Add(f); fills.Add(owner); }
                }
                for (int i = 0; i < fills.Count; i += 2) state[fills[i]] = fills[i + 1];

                // Phase B — shave teeth (≥2 ocean edges).
                var shaves = new List<int>();
                for (int f = 0; f < nF; f++)
                {
                    if (state[f] == 0 || f == spawnFace) continue;
                    int oceanEdges = 0;
                    foreach (int nb in mesh.FaceEdgeNeighbors(f)) if (state[nb] == 0) oceanEdges++;
                    if (oceanEdges >= 2) shaves.Add(f);
                }
                foreach (int f in shaves) state[f] = 0;

                if (!narrow) continue;

                // Phase C — collapse 1-wide ocean cracks (ring ≥ 9 land).
                var crackFills = new List<int>();
                for (int f = 0; f < nF; f++)
                {
                    if (state[f] != 0 || claimable[f] == 0) continue;
                    int owner = _ownerOf(mesh.FaceGrowthNeighbors(f), 9, protectStraits);
                    if (owner != -2 && owner > 0) { crackFills.Add(f); crackFills.Add(owner); }
                }
                for (int i = 0; i < crackFills.Count; i += 2) state[crackFills[i]] = crackFills[i + 1];

                // Phase D — shave 1-wide land spits/needles (ring ≤ 3 land).
                var spitShaves = new List<int>();
                for (int f = 0; f < nF; f++)
                {
                    if (state[f] == 0 || f == spawnFace) continue;
                    int ringLand = 0;
                    foreach (int nb in mesh.FaceGrowthNeighbors(f)) if (state[nb] > 0) ringLand++;
                    if (ringLand <= 3) spitShaves.Add(f);
                }
                foreach (int f in spitShaves) state[f] = 0;
            }
        }

        private void _fillEnclosedPockets(double gf, bool protectStraits, byte[] claimable)
        {
            int maxPocket = (int)WorldgenMath.Round(gf * 8);
            if (maxPocket < 1) return;
            int[] state = FaceState;
            int nF = state.Length;

            var reached = new byte[nF];
            var stack = new List<int>();
            for (int f = 0; f < nF; f++) if (claimable[f] == 0) { reached[f] = 1; stack.Add(f); }
            while (stack.Count > 0)
            {
                int f = stack[stack.Count - 1]; stack.RemoveAt(stack.Count - 1);
                foreach (int nb in mesh.FaceEdgeNeighbors(f))
                    if (reached[nb] == 0 && state[nb] == 0) { reached[nb] = 1; stack.Add(nb); }
            }

            var seen = new byte[nF];
            int filled = 0, pockets = 0;
            for (int f = 0; f < nF; f++)
            {
                if (state[f] != 0 || reached[f] == 1 || seen[f] == 1) continue;
                var faces = new List<int> { f };
                seen[f] = 1;
                var ids = new List<int>(); var counts = new List<int>();
                for (int head = 0; head < faces.Count; head++)
                {
                    foreach (int nb in mesh.FaceEdgeNeighbors(faces[head]))
                    {
                        if (state[nb] == 0)
                        {
                            if (seen[nb] == 0 && reached[nb] == 0) { seen[nb] = 1; faces.Add(nb); }
                        }
                        else
                        {
                            int k = ids.IndexOf(state[nb]);
                            if (k >= 0) counts[k]++; else { ids.Add(state[nb]); counts.Add(1); }
                        }
                    }
                }
                bool mixed = ids.Count > 1;
                if (faces.Count <= maxPocket && ids.Count > 0 && !(mixed && protectStraits))
                {
                    int best = 0;
                    for (int k = 1; k < ids.Count; k++)
                        if (counts[k] > counts[best] || (counts[k] == counts[best] && ids[k] < ids[best])) best = k;
                    foreach (int pf in faces) state[pf] = ids[best];
                    filled += faces.Count;
                    pockets++;
                }
            }
            if (pockets > 0)
                Log.Info($"[IWRW] [continent] pocket landfill: {pockets} pockets, {filled} faces (limit {maxPocket} faces/pocket)");
        }

        // ===== Derived views of the face labels =====
        private void _classifyPoints()
        {
            int n = mesh.NumAnchors;
            PointClass = new byte[n];
            for (int t = 0; t < n; t++)
            {
                var faces = mesh.FacesAtPoint(t);
                bool hasLand = false, hasOcean = false;
                for (int i = 0; i < faces.Count; i++)
                {
                    if (FaceState[faces[i]] > 0) hasLand = true; else hasOcean = true;
                }
                PointClass[t] = hasLand ? (hasOcean ? POINT_COASTAL : POINT_INTERIOR) : POINT_OCEANIC;
            }
        }

        private void _rasterizeLandGrid()
        {
            int mapW = p.MapW, mapH = p.MapH;
            LandGrid = new byte[mapW * mapH];
            for (int z = 0; z < mapH; z++)
            {
                int row = z * mapW;
                for (int x = 0; x < mapW; x++)
                    if (FaceState[mesh.FaceAt(x, z)] > 0) LandGrid[row + x] = 1;
            }
        }

        private void _collectCoastPixels()
        {
            int mapW = p.MapW, mapH = p.MapH;
            CoastPixels = new List<int>();
            CoastGrid = new byte[mapW * mapH];
            for (int z = 0; z < mapH; z++)
            {
                for (int x = 0; x < mapW; x++)
                {
                    int i = z * mapW + x;
                    if (LandGrid[i] != 1) continue;
                    if ((x > 0 && LandGrid[z * mapW + (x - 1)] == 0) ||
                        (x < mapW - 1 && LandGrid[z * mapW + (x + 1)] == 0) ||
                        (z > 0 && LandGrid[(z - 1) * mapW + x] == 0) ||
                        (z < mapH - 1 && LandGrid[(z + 1) * mapW + x] == 0))
                    {
                        CoastPixels.Add(x); CoastPixels.Add(z);
                        CoastGrid[i] = 1;
                    }
                }
            }
        }
    }
}
