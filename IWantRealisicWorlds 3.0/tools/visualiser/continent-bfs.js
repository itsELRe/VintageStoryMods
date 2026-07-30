// continent-bfs.js — ContinentGen._growContinents
// Labels the lattice FACES: picks initial seed faces (farthest-first with
// plate bias), then runs a round-robin BFS where each iteration scores up to
// 8 random candidate faces and claims the best one, then runs deterministic
// cleanup passes (coast closing + enclosed-pocket landfill).
//
//   score = (gapBonus + ringClaimed × 0.25 + rng) × sepPenalty
//                                                × edgePenalty
//                                                × plateBias
//
// Penalties multiply (act as soft vetoes); bonuses add (rank-order nudges).
//
// LATTICE-NATIVE RULES (2026-07-23 rework — the Voronoi-era rules saturated
// or misbehaved on the regular triangle lattice):
//
// • Growth is EDGE-CONNECTED: the queue admits only the 3 edge-neighbors, so
//   every claim shares a full edge with its continent — corner-touching
//   spikes (the "sawteeth") are impossible by construction. The 12-face
//   edge+vertex ring (mesh.faceGrowthNeighbors) is used for SCORING only.
// • Gap Fill reads two signals: edgeClaimed (0–3; 3 = enclosed hole → fill
//   now, 2 = notch → filling it smooths the coast) and ringClaimed (0–12,
//   thresholds calibrated to the 12-scale). After growth, cleanup passes
//   make the high end genuinely aggressive: round(gapFill) coast-closing
//   passes (fill 2-land-edge notches, shave 2-ocean-edge teeth) and an
//   enclosed-pocket landfill (single-owner pockets ≤ gapFill×8 faces).
// • Separation is GRADED by distance — sharing an edge with a foreign
//   continent is vetoed outright at separation ≥ 1.5 (guaranteeing a strait
//   of at least one ocean face), ring-1 contact is penalized hard, ring-2
//   contact mildly.
// • Edge Avoidance fades smoothly from the border (no hard margin line for
//   the coast to trace).
// • Plate Bias is symmetric: bonus on continental plates AND a penalty on
//   oceanic plates, so high values make continents follow plate outlines.
//
// All faces are equal-area (spacing²·√3/4), so the landcover quota is a
// simple face count.

window.VIS = window.VIS || {};

(function (V) {

  V.ContinentGen.prototype._growContinents = function () {
    const p = this.p;
    const mesh = this.mesh;
    const mapW = p.mapW, mapH = p.mapH;
    const mapArea = mapW * mapH;
    const lcs = p.landcoverScale;
    const nF = mesh.numFaces;
    const faceArea = mesh.spacing * mesh.spacing * Math.sqrt(3) / 4;

    this.faceState = new Uint16Array(nF);
    const state = this.faceState;

    const targetArea = p.landcover * mapArea;
    if (targetArea < faceArea) return;

    const gf = p.gapFill ?? 1.0;
    const sb = p.separationBias ?? 1.0;
    const eb = p.edgeBias ?? 1.0;
    const pb = p.plateBias ?? 1.0;

    // Face centroids (scoring positions) + the claimable set: only faces
    // whose centroid lies inside the map can become land — margin faces stay
    // ocean, so the coast always closes at the rim.
    const fcx = new Float64Array(nF), fcz = new Float64Array(nF);
    const claimable = new Uint8Array(nF);
    let claimableCount = 0;
    for (let f = 0; f < nF; f++) {
      const c = mesh.faceCentroid(f);
      fcx[f] = c.x; fcz[f] = c.z;
      if (c.x >= 0 && c.x < mapW && c.z >= 0 && c.z < mapH) {
        claimable[f] = 1;
        claimableCount++;
      }
    }

    let claimedArea = 0;

    // --- Seed count (growth units = claimable faces) ---
    const worldScale = Math.max(1, Math.sqrt(mapArea / (512 * 512)));
    let baseSeeds;
    if (lcs >= 4.5) baseSeeds = 1;
    else if (lcs >= 3.5) baseSeeds = 1 + (4.5 - lcs);
    else if (lcs >= 2.5) baseSeeds = 2 + (3.5 - lcs);
    else if (lcs >= 1.5) baseSeeds = 3 + (2.5 - lcs) * 3;
    else if (lcs >= 0.5) baseSeeds = 6 + (1.5 - lcs) * 9;
    else baseSeeds = 15 + (0.5 - lcs) * claimableCount * 0.3;
    let numSeeds = Math.min(claimableCount, Math.max(1, Math.round(baseSeeds * worldScale)));

    // User override: if seedOverride > 0, ignore the LCS-derived count.
    if (p.seedOverride && p.seedOverride > 0) {
      numSeeds = Math.min(claimableCount, Math.max(1, p.seedOverride | 0));
    }

    const rng = V.makePRNG((V.hash2d(2, 0, p.seed + 77777) * 0xFFFFFFFF) | 0);

    // --- Seed selection: spawn face first, then farthest-first w/ plate bias ---
    const spawnFace = mesh.faceAt(this.spawnX, this.spawnZ);

    const seeds = [spawnFace];
    const seedSet = new Set(seeds);
    while (seeds.length < numSeeds) {
      let bestFace = -1, bestScore = -1;
      for (let f = 0; f < nF; f++) {
        if (!claimable[f] || seedSet.has(f)) continue;
        const sx = fcx[f], sz = fcz[f];
        if (p.landcover < 0.5) {
          const margin = Math.max(mapW, mapH) * 0.05;
          if (sx < margin || sx > mapW - margin || sz < margin || sz > mapH - margin) continue;
        }
        let minDist = Infinity;
        for (const s of seeds) {
          const dx = (sx - fcx[s]) / mapW;
          const dz = (sz - fcz[s]) / mapH;
          minDist = Math.min(minDist, dx * dx + dz * dz);
        }
        let score = minDist;

        const gx = Math.max(0, Math.min(mapW - 1, Math.round(sx)));
        const gz = Math.max(0, Math.min(mapH - 1, Math.round(sz)));
        const pid = this.plateGrid[gz * mapW + gx];
        // Plate bias acts uniformly across LCS (no tecPreference gate).
        // Continental plates get a clean bonus, oceanic plates a clean
        // penalty floored at 0.1 so the BFS can still fall back when
        // forced by the landcover quota.
        if (this.continentalPlates.has(pid)) {
          score *= 1.0 + 1.5 * pb;
        } else {
          score *= Math.max(0.1, 1.0 - 0.5 * pb);
        }

        if (score > bestScore) { bestScore = score; bestFace = f; }
      }
      if (bestFace < 0) break;
      seeds.push(bestFace);
      seedSet.add(bestFace);
    }

    // --- Activate seed faces (each gets a unique continent ID) ---
    const activatedSeeds = [];
    for (let si = 0; si < seeds.length; si++) {
      if (claimedArea >= targetArea) break;
      const s = seeds[si];
      state[s] = si + 1;
      claimedArea += faceArea;
      activatedSeeds.push(s);
    }

    // --- Round-robin BFS growth (edge-connected) ---
    // Speed spread is ±100% of sizeVar: on the equal-area lattice the
    // per-continent speed is the ONLY size-variety source (Voronoi cells
    // used to add variety through their unequal areas), so the spread is
    // wider than the Voronoi-era ±50% to compensate.
    const sizeVar = p.sizeVar || 0;
    const queues = activatedSeeds.map((s, i) => {
      const q = [];
      const sortedNbrs = [...mesh.faceEdgeNeighbors(s)].sort((a, b) => a - b);
      for (const n of sortedNbrs) {
        if (claimable[n] && state[n] === 0) q.push(n);
      }
      const speed = 1.0 + (rng() - 0.5) * 2 * sizeVar;
      return { id: i + 1, queue: q, speed: Math.max(0.25, speed) };
    });
    const inQueue = new Set();
    for (const cq of queues) for (const n of cq.queue) inQueue.add(n);

    const mapSize = Math.max(mapW, mapH);

    while (claimedArea < targetArea) {
      let anyGrew = false;
      for (const cq of queues) {
        if (claimedArea >= targetArea) break;
        if (cq.queue.length === 0) continue;

        const facesThisTurn = Math.max(1, Math.round((1 + rng() * 2) * cq.speed));
        for (let ct = 0; ct < facesThisTurn; ct++) {
          if (claimedArea >= targetArea || cq.queue.length === 0) break;

          // Pick best candidate from the queue, sampling up to 8 random
          // entries. Invalid entries — claimed meanwhile, or hard-vetoed by
          // separation — are swap-popped on sight: faces only ever GAIN
          // claimed neighbors during growth, so both conditions are
          // permanent and removal both is safe and guarantees progress.
          let bestIdx = -1, bestScore = -Infinity;
          let samples = Math.min(cq.queue.length, 8);
          while (samples-- > 0 && cq.queue.length > 0) {
            const ri = Math.floor(rng() * cq.queue.length);
            const rc = cq.queue[ri];

            // Edge signal (0–3): claimed edge-neighbors + foreign contact.
            let edgeClaimed = 0, edgeForeign = false;
            let invalid = state[rc] !== 0;
            if (!invalid) {
              for (const nb of mesh.faceEdgeNeighbors(rc)) {
                if (state[nb] > 0) {
                  edgeClaimed++;
                  if (state[nb] !== cq.id) edgeForeign = true;
                }
              }
              // Hard separation veto: at high separation a face may never
              // share an edge with a foreign continent — guarantees a
              // strait of at least one ocean face between landmasses.
              if (edgeForeign && sb >= 1.5) invalid = true;
            }
            if (invalid) {
              const last = cq.queue.length - 1;
              cq.queue[ri] = cq.queue[last];
              cq.queue.pop();
              if (bestIdx === last) bestIdx = ri;   // best element was moved
              continue;
            }

            // Ring signal (0–12): surroundedness + foreign presence in the
            // 1-ring; 2-ring foreign checked only when the 1-ring is clean.
            const ring = mesh.faceGrowthNeighbors(rc);
            let ringClaimed = 0, ring1Foreign = edgeForeign, ring2Foreign = false;
            for (const nb of ring) {
              if (state[nb] > 0) {
                ringClaimed++;
                if (state[nb] !== cq.id) ring1Foreign = true;
              }
            }
            if (sb > 0 && !ring1Foreign) {
              outer:
              for (const nb of ring) {
                for (const nb2 of mesh.faceGrowthNeighbors(nb)) {
                  if (state[nb2] > 0 && state[nb2] !== cq.id) { ring2Foreign = true; break outer; }
                }
              }
            }

            // Gap bonus ladder: enclosed hole > deep pocket > notch > mild.
            // The notch reward is deliberately MILD (comparable to the rng
            // term, not dominating it): strong notch-filling during growth
            // collapses every blob into a maximally-compact hexagon — the
            // 1-face jaggies are the cleanup passes' job, while growth keeps
            // its multi-face irregularity (the organic character).
            let gapBonus = 0;
            if (edgeClaimed >= 3) gapBonus = 20 * gf;
            else if (ringClaimed >= 8) gapBonus = 4 * gf;
            else if (edgeClaimed === 2) gapBonus = 2 * gf;
            else if (ringClaimed >= 5) gapBonus = 1 * gf;
            else if (gf > 1) gapBonus = (gf - 1) * 2;

            // Separation: graded by contact distance.
            let sepPenalty = 1.0;
            if (sb > 0) {
              if (ring1Foreign)      sepPenalty = Math.max(0.02, 1 - sb * 0.7);
              else if (ring2Foreign) sepPenalty = Math.max(0.2,  1 - sb * 0.4);
            }

            // Edge avoidance: smooth falloff from the border — no hard
            // margin line for the coast to trace.
            let edgePenalty = 1.0;
            if (eb > 0) {
              const margin = mapSize * 0.05 * eb;
              const dist = Math.min(fcx[rc], fcz[rc], mapW - fcx[rc], mapH - fcz[rc]);
              if (dist < margin) {
                const t = Math.max(0, dist / margin);
                const smooth = t * t * (3 - 2 * t);
                const floor = Math.min(1, Math.max(0.02, 0.1 / eb));
                edgePenalty = floor + (1 - floor) * smooth;
              }
            }

            // Plate bias: bonus on continental plates, penalty on oceanic —
            // high values make continents follow plate outlines.
            const pcx = Math.max(0, Math.min(mapW - 1, Math.round(fcx[rc])));
            const pcz = Math.max(0, Math.min(mapH - 1, Math.round(fcz[rc])));
            const onContinental = this.continentalPlates.has(this.plateGrid[pcz * mapW + pcx]);
            const plateBias = onContinental
              ? 1.0 + 1.0 * pb
              : Math.max(0.1, 1.0 - 0.35 * pb);

            const score = (gapBonus + ringClaimed * 0.25 + rng() * 1.0) * sepPenalty * edgePenalty * plateBias;
            if (score > bestScore) { bestScore = score; bestIdx = ri; }
          }

          if (bestIdx < 0) continue;   // sampled only invalid entries (now removed)
          const face = cq.queue[bestIdx];
          cq.queue[bestIdx] = cq.queue[cq.queue.length - 1];
          cq.queue.pop();
          if (state[face] !== 0) continue;

          state[face] = cq.id;
          claimedArea += faceArea;
          anyGrew = true;

          const faceNbrs = [...mesh.faceEdgeNeighbors(face)].sort((a, b) => a - b);
          for (const n of faceNbrs) {
            if (claimable[n] && state[n] === 0 && !inQueue.has(n)) {
              cq.queue.push(n);
              inQueue.add(n);
            }
          }
        }
      }
      if (!anyGrew) break;
    }

    // --- Deterministic cleanup (the aggressive half of Gap Fill) ---
    // Straits between continents are protected from filling only when the
    // separation rule actually guarantees them (sb ≥ 1.5, the growth-time
    // hard veto). Below that, continents may touch — merged landmasses keep
    // internal id-boundaries, and protecting cracks along them would defeat
    // the cleanup for no visual gain.
    const protectStraits = sb >= 1.5;
    const closingRounds = Math.round(gf);
    if (closingRounds > 0) this._closeCoast(closingRounds, gf, protectStraits, claimable, spawnFace);
    this._fillEnclosedPockets(gf, protectStraits, claimable);

    // Continent seed positions (for renderer markers).
    this._continentSeeds = seeds.map(s => ({ x: fcx[s], z: fcz[s] }));
  };

  // Coast closing: alternating morphological passes. Each round FILLS ocean
  // notches (claimable ocean faces with ≥2 land edge-neighbors) and then
  // SHAVES land teeth (land faces with ≥2 ocean edge-neighbors — always
  // dead-end spikes: a triangle with 2 ocean edges has exactly 1 land edge,
  // so shaving can never disconnect a landmass). At gapFill ≥ 1.5 two
  // ring-based NARROWNESS phases join each round, catching what the edge
  // phases structurally can't: a straight 1-face-wide ocean channel's faces
  // each touch only ONE land edge (never a notch), and a 1-face-wide land
  // spit's faces each touch only one ocean edge (never a tooth). The
  // 12-face ring diagnoses both: ocean face with ≥9 land in its ring =
  // inside a crack → fill; land face with ≤3 land in its ring = on a
  // spit/needle → shave. Normal coast faces sit at ~5–7 and are untouched.
  // When `protectStraits` (separation ≥ 1.5) a fill touching TWO continents
  // is skipped — never bridges a guaranteed strait; otherwise mixed fills
  // take the majority owner (deterministic: ties → lowest id). Each phase
  // is computed set-first so a pass can't cascade through itself. The spawn
  // face is never shaved. Fills and shaves roughly balance, so land cover
  // stays ≈ the quota.
  V.ContinentGen.prototype._closeCoast = function (rounds, gf, protectStraits, claimable, spawnFace) {
    const mesh = this.mesh;
    const state = this.faceState;
    const nF = state.length;
    const narrow = gf >= 1.5;

    // Owner pick over a neighbor list: null if empty, -1 if protected-mixed,
    // else the majority id (ties → lowest id).
    const ownerOf = (nbrs, minCount) => {
      let n = 0;
      const ids = [], counts = [];
      for (const nb of nbrs) {
        const id = state[nb];
        if (id === 0) continue;
        n++;
        const k = ids.indexOf(id);
        if (k >= 0) counts[k]++; else { ids.push(id); counts.push(1); }
      }
      if (n < minCount) return null;
      if (ids.length > 1 && protectStraits) return -1;
      let best = 0;
      for (let k = 1; k < ids.length; k++) {
        if (counts[k] > counts[best] || (counts[k] === counts[best] && ids[k] < ids[best])) best = k;
      }
      return ids[best];
    };

    for (let r = 0; r < rounds; r++) {
      // Phase A — fill notches (≥2 land edges).
      const fills = [];
      for (let f = 0; f < nF; f++) {
        if (state[f] !== 0 || !claimable[f]) continue;
        const owner = ownerOf(mesh.faceEdgeNeighbors(f), 2);
        if (owner !== null && owner > 0) fills.push(f, owner);
      }
      for (let i = 0; i < fills.length; i += 2) state[fills[i]] = fills[i + 1];

      // Phase B — shave teeth (≥2 ocean edges).
      const shaves = [];
      for (let f = 0; f < nF; f++) {
        if (state[f] === 0 || f === spawnFace) continue;
        let oceanEdges = 0;
        for (const nb of mesh.faceEdgeNeighbors(f)) {
          if (state[nb] === 0) oceanEdges++;
        }
        if (oceanEdges >= 2) shaves.push(f);
      }
      for (const f of shaves) state[f] = 0;

      if (!narrow) continue;

      // Phase C — collapse 1-wide ocean cracks (ring ≥ 9 land).
      const crackFills = [];
      for (let f = 0; f < nF; f++) {
        if (state[f] !== 0 || !claimable[f]) continue;
        const owner = ownerOf(mesh.faceGrowthNeighbors(f), 9);
        if (owner !== null && owner > 0) crackFills.push(f, owner);
      }
      for (let i = 0; i < crackFills.length; i += 2) state[crackFills[i]] = crackFills[i + 1];

      // Phase D — shave 1-wide land spits/needles (ring ≤ 3 land).
      const spitShaves = [];
      for (let f = 0; f < nF; f++) {
        if (state[f] === 0 || f === spawnFace) continue;
        let ringLand = 0;
        for (const nb of mesh.faceGrowthNeighbors(f)) {
          if (state[nb] > 0) ringLand++;
        }
        if (ringLand <= 3) spitShaves.push(f);
      }
      for (const f of spitShaves) state[f] = 0;
    }
  };

  // Enclosed-pocket landfill: flood the ocean inward from the margin faces
  // (never claimable, always ocean, ringing the map). Ocean faces the flood
  // can't reach are enclosed pockets; pockets of ≤ gapFill×8 faces get
  // landfilled with the majority shore owner. When `protectStraits`
  // (separation ≥ 1.5) mixed-shore pockets are left alone — they are the
  // guaranteed gaps between continents, and separation owns those.
  V.ContinentGen.prototype._fillEnclosedPockets = function (gf, protectStraits, claimable) {
    const maxPocket = Math.round((gf ?? 0) * 8);
    if (maxPocket < 1) return;
    const mesh = this.mesh;
    const state = this.faceState;
    const nF = state.length;

    const reached = new Uint8Array(nF);
    const stack = [];
    for (let f = 0; f < nF; f++) {
      if (!claimable[f]) { reached[f] = 1; stack.push(f); }
    }
    while (stack.length > 0) {
      const f = stack.pop();
      for (const nb of mesh.faceEdgeNeighbors(f)) {
        if (!reached[nb] && state[nb] === 0) { reached[nb] = 1; stack.push(nb); }
      }
    }

    const seen = new Uint8Array(nF);
    let filled = 0, pockets = 0;
    for (let f = 0; f < nF; f++) {
      if (state[f] !== 0 || reached[f] || seen[f]) continue;
      // Collect this enclosed component + its shore ownership (majority
      // owner; deterministic ties → lowest id).
      const faces = [f];
      seen[f] = 1;
      const ids = [], counts = [];
      for (let head = 0; head < faces.length; head++) {
        for (const nb of mesh.faceEdgeNeighbors(faces[head])) {
          if (state[nb] === 0) {
            if (!seen[nb] && !reached[nb]) { seen[nb] = 1; faces.push(nb); }
          } else {
            const k = ids.indexOf(state[nb]);
            if (k >= 0) counts[k]++; else { ids.push(state[nb]); counts.push(1); }
          }
        }
      }
      const mixed = ids.length > 1;
      if (faces.length <= maxPocket && ids.length > 0 && !(mixed && protectStraits)) {
        let best = 0;
        for (let k = 1; k < ids.length; k++) {
          if (counts[k] > counts[best] || (counts[k] === counts[best] && ids[k] < ids[best])) best = k;
        }
        for (const pf of faces) state[pf] = ids[best];
        filled += faces.length;
        pockets++;
      }
    }
    if (pockets > 0) {
      console.log(`[continent] pocket landfill: ${pockets} pockets, ${filled} faces (limit ${maxPocket} faces/pocket)`);
    }
  };

})(window.VIS);
