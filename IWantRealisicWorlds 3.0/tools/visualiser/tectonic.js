// tectonic.js — TectonicModel
// Port of v1 logic. Build major seeds on a centred jittered grid (with margin
// extension), drop minor "fossil" seeds inside each plate, unify them, build
// one spatial index, extract boundary pixels by precomputing the warped
// nearest-seed grid and walking 4-neighbours, then place hotspots and
// classify plate pairs.

window.VIS = window.VIS || {};

(function (V) {

  V.BOUNDARY_CONVERGENT = 0;
  V.BOUNDARY_DIVERGENT = 1;
  V.BOUNDARY_TRANSFORM = 2;
  V.PROVINCE_SHIELD = 0;
  V.PROVINCE_PLATFORM = 1;
  V.PROVINCE_OROGEN = 2;
  V.PROVINCE_BASIN = 3;
  V.PROVINCE_LARGE_IGNEOUS = 4;
  V.PROVINCE_EXTENDED_CRUST = 5;

  const PHI = 1.618033988749895;

  class TectonicModel {
    constructor(opts) {
      this.seed = opts.seed | 0;
      this.mapW = opts.mapW;
      this.mapH = opts.mapH;
      this.continentSize = opts.continentSize ?? 1.0;
      this.plateCountMult = opts.plateCountMult ?? 1.0;
      this.seedJitter = opts.seedJitter ?? 0.7;
      this.warpPower = opts.warpPower ?? 0.12;

      // Plate motion vectors (spec §3.1). Raw drift-speed spread across plates.
      // A moderate/wide range is fine: the effect on height is gentled
      // (sublinear) downstream in the collision-intensity code, so the spread
      // reads as contrast between ranges, not as runaway peak height.
      this.plateSpeedMin = opts.plateSpeedMin ?? 0.3;
      this.plateSpeedMax = opts.plateSpeedMax ?? 1.0;
      // Boundary interaction type (convergent/divergent/transform) now comes
      // from the plate-motion sign, not a hash. |cos(relative motion, boundary
      // normal)| below this ⇒ transform (glancing). Bigger ⇒ more transforms.
      this.transformThreshold = opts.transformThreshold ?? 0.3;

      // Province width knobs (see provinceAt). Pixel widths before scaling.
      // Fossil basin and platform are intentionally narrower than the active
      // counterparts — fossils are older / more eroded, so their associated
      // band stack is smaller. Provinces and upheaval BOTH read these so the
      // two maps stay in lockstep.
      this.orogenW            = opts.orogenWidth        ?? 8;
      this.basinW             = opts.basinWidth         ?? 6;
      this.fossilW            = opts.fossilWidth        ?? 4;
      this.platformW          = opts.platformWidth      ?? 25;
      this.fossilBasinW       = opts.fossilBasinWidth    ?? 4;
      this.fossilPlatformW    = opts.fossilPlatformWidth ?? 12;

      // Province width warp: smooth scalar field that scales ALL province
      // band widths together at each pixel. Sampled at the closest point on
      // a tectonic line (not at the pixel) so both sides of the spine breathe
      // together — bands stretch and squish along the line's length, the line
      // itself never moves. Floored at 0.5 so no band ever vanishes.
      // See TectonicLines.getProvinceWidthMultiplier (tectonic-lines.js) for the slider→amplitude mapping.
      this.provinceWarpPower = opts.provinceWarpPower ?? 0.6;
      // Width of the extended-crust band on divergent active boundaries, in
      // raw base pixels (multiplied by mapScale × activity at use site, like
      // orogenW / basinW / etc.). FLAT — does NOT pick up the province warp
      // widthMul, so the band is the same width along the whole rift. 0 =
      // no band. Read by provinceAt.
      this.extendedCrustWidth = opts.extendedCrustWidth ?? 6;

      // Band widths now respond to collision INTENSITY (not the old random warp):
      // width = baseWidth × (widthFloor + (1−widthFloor)·|intensity|). widthFloor
      // keeps a thin band even at ~zero intensity so nothing vanishes; full
      // intensity gives the slider's full width. Same scaling feeds the upheaval
      // falloff reach (V.tectonicBands), so category and height stay in sync.
      this.widthFloor = opts.widthFloor ?? 0.15;

      const mapSize = Math.max(this.mapW, this.mapH);
      const baseRadius = 80;
      this.continentRadius = baseRadius * V.phiScale(mapSize) * Math.sqrt(this.continentSize);

      const plateCount = Math.max(2, Math.round(4 * Math.pow(PHI, Math.log2(mapSize / 512)) * this.plateCountMult));
      this.gridSpacing = Math.sqrt((this.mapW * this.mapH) / plateCount) * 1.5;
      this.gridSpacing *= Math.sqrt(this.continentSize);
      this.gridSpacing = Math.max(this.gridSpacing, this.continentRadius * 1.5);
      this.targetPlateCount = plateCount;

      this._generateMajorSeeds();
      this._generateMinorSeeds();
      this._buildUnifiedSeedList();
      this._generatePlateVectors();
      this._buildSpatialIndex();

      // Warp displaces lookup coordinates so plate boundaries look organic
      // instead of straight Voronoi lines. Frequency tied to grid spacing.
      const warpFreq = 1 / (this.gridSpacing * 0.8);
      this._warpX = V.createFBM(this.seed + 8001, warpFreq, 3, 0.6);
      this._warpZ = V.createFBM(this.seed + 8002, warpFreq, 3, 0.6);
      this._warpAmp = this.gridSpacing * this.warpPower;

      this._extractBoundaryPixels();
      // Segment-context primitive (junctions, segments, polylines, distance
      // fields, width-warp) — its own subsystem (tectonic-lines.js), built from
      // the boundary masks + seed grid above. Consumers read tectonic.lines.*.
      this.lines = new V.TectonicLines(this);
      this._generateHotspots();
      this._computePlatePairTypes();
      this.lines.assignPairTypes(this.platePairTypes);

      // Porting mirror — copy to the C# debug logs.
      console.log(`[tectonic] plates=${this.plateCount} seeds=${this.allSeeds.length} hotspots=${this.hotspots.length} mask=${V.checksum(this.activeBoundaryGrid).toString(16)}`);
    }

    _generateMajorSeeds() {
      const { mapW, mapH, gridSpacing, seed } = this;
      this.majorSeeds = [];
      const originX = mapW / 2 - gridSpacing * 0.5;
      const originZ = mapH / 2 - gridSpacing * 0.5;
      const pad = 1;
      const minCx = Math.floor(-originX / gridSpacing) - pad;
      const maxCx = Math.ceil((mapW - originX) / gridSpacing) + pad;
      const minCz = Math.floor(-originZ / gridSpacing) - pad;
      const maxCz = Math.ceil((mapH - originZ) / gridSpacing) + pad;
      const minDist = gridSpacing * 0.45;
      const minDistSq = minDist * minDist;
      const jitterAmp = 0.8 * this.seedJitter; // v1 hardcodes 0.8; we let the slider scale it

      let plateId = 0;
      for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          let jx = 0, jz = 0;
          if (cx !== 0 || cz !== 0) {
            jx = (V.hash2d(cx, cz, seed + 3333) - 0.5) * jitterAmp;
            jz = (V.hash2d(cx, cz, seed + 3334) - 0.5) * jitterAmp;
          }
          let sx = originX + (cx + 0.5 + jx) * gridSpacing;
          let sz = originZ + (cz + 0.5 + jz) * gridSpacing;

          const margin = gridSpacing * 1.5;
          if (sx < -margin || sx > mapW + margin || sz < -margin || sz > mapH + margin) continue;

          const isInterior = sx >= 0 && sx <= mapW && sz >= 0 && sz <= mapH;
          if (isInterior && (cx !== 0 || cz !== 0)) {
            let tooClose = false;
            for (const existing of this.majorSeeds) {
              const dx = sx - existing.x, dz = sz - existing.z;
              if (dx * dx + dz * dz < minDistSq) { tooClose = true; break; }
            }
            if (tooClose) {
              for (let reduce = 0; reduce < 3; reduce++) {
                jx *= 0.5; jz *= 0.5;
                sx = originX + (cx + 0.5 + jx) * gridSpacing;
                sz = originZ + (cz + 0.5 + jz) * gridSpacing;
                tooClose = false;
                for (const existing of this.majorSeeds) {
                  const dx = sx - existing.x, dz = sz - existing.z;
                  if (dx * dx + dz * dz < minDistSq) { tooClose = true; break; }
                }
                if (!tooClose) break;
              }
            }
          }

          this.majorSeeds.push({ x: sx, z: sz, plateId, isMajor: true, cx, cz });
          plateId++;
        }
      }
      this.plateCount = plateId;
    }

    _generateMinorSeeds() {
      const { mapW, mapH, seed } = this;
      const mapSize = Math.max(mapW, mapH);
      const centerFossils = Math.round(4 * Math.pow(PHI, Math.log2(mapSize / 512)));

      // Area sampling: linear scan because spatial index isn't built yet.
      const plateAreas = {};
      const sampleStep = Math.max(4, Math.floor(mapSize / 100));
      let maxArea = 0;
      for (let z = 0; z < mapH; z += sampleStep) {
        for (let x = 0; x < mapW; x += sampleStep) {
          const idx = this._nearestMajorSeed(x, z);
          if (idx >= 0) {
            const pid = this.majorSeeds[idx].plateId;
            plateAreas[pid] = (plateAreas[pid] || 0) + 1;
            if (plateAreas[pid] > maxArea) maxArea = plateAreas[pid];
          }
        }
      }

      this.minorSeeds = [];
      const fossilSeed = seed + 200000;
      const minFossilDist = this.gridSpacing * 0.35;
      const minFossilDistSq = minFossilDist * minFossilDist;

      for (const [pidStr, area] of Object.entries(plateAreas)) {
        const pid = parseInt(pidStr);
        const ratio = area / maxArea;
        let fossilCount = Math.round(centerFossils * ratio);
        if (fossilCount < 2) fossilCount = 0;

        const plateSeeds = this.majorSeeds.filter(s => s.plateId === pid);
        const minX = Math.max(0, Math.min(...plateSeeds.map(s => s.x)) - this.gridSpacing * 0.5);
        const maxX = Math.min(mapW, Math.max(...plateSeeds.map(s => s.x)) + this.gridSpacing * 0.5);
        const minZ = Math.max(0, Math.min(...plateSeeds.map(s => s.z)) - this.gridSpacing * 0.5);
        const maxZ = Math.min(mapH, Math.max(...plateSeeds.map(s => s.z)) + this.gridSpacing * 0.5);

        for (let f = 0; f < fossilCount; f++) {
          const fx = V.hash2d(pid * 1000 + f, 0, fossilSeed + 5555);
          const fz = V.hash2d(pid * 1000 + f, 1, fossilSeed + 6666);
          const sx = minX + fx * (maxX - minX);
          const sz = minZ + fz * (maxZ - minZ);

          let tooClose = false;
          for (const ms of this.majorSeeds) {
            const dx = sx - ms.x, dz = sz - ms.z;
            if (dx * dx + dz * dz < minFossilDistSq) { tooClose = true; break; }
          }
          if (tooClose) continue;
          for (const fs of this.minorSeeds) {
            const dx = sx - fs.x, dz = sz - fs.z;
            if (dx * dx + dz * dz < minFossilDistSq) { tooClose = true; break; }
          }
          if (tooClose) continue;

          this.minorSeeds.push({ x: sx, z: sz, majorPlateId: pid, isMajor: false });
        }
      }
    }

    _nearestMajorSeed(x, z) {
      let bestDist = Infinity, bestIdx = -1;
      for (let i = 0; i < this.majorSeeds.length; i++) {
        const s = this.majorSeeds[i];
        const dx = x - s.x, dz = z - s.z;
        const d = dx * dx + dz * dz;
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      return bestIdx;
    }

    _buildUnifiedSeedList() {
      this.allSeeds = [];
      for (const s of this.majorSeeds) {
        this.allSeeds.push({ x: s.x, z: s.z, majorPlateId: s.plateId, isMajor: true, seedId: this.allSeeds.length });
      }
      for (const s of this.minorSeeds) {
        this.allSeeds.push({ x: s.x, z: s.z, majorPlateId: s.majorPlateId, isMajor: false, seedId: this.allSeeds.length });
      }
    }

    // Plate motion vectors (spec §3.1). Each major seed IS a plate (1:1 with
    // plateId); each minor/fossil seed is an independent micro-plate. So every
    // seed gets its own seed-based drift vector: a uniform-random direction and
    // a bounded speed, stored as vec=[vx,vz] (speed folded into the magnitude so
    // relative motion is a plain vector subtraction downstream). Leaf data —
    // read only by the collision-intensity code; never feeds back into seed
    // placement, warp, land/ocean, or continent shape.
    _generatePlateVectors() {
      const { plateSpeedMin, plateSpeedMax } = this;
      this.plateVectors = new Array(this.plateCount); // indexed by plateId, for active boundaries
      let fossilCount = 0;
      for (const s of this.allSeeds) {
        const angle = V.hash2d(s.seedId, 0, this.seed + 51000) * Math.PI * 2;
        const speed = plateSpeedMin + V.hash2d(s.seedId, 1, this.seed + 52000) * (plateSpeedMax - plateSpeedMin);
        s.vec = [Math.cos(angle) * speed, Math.sin(angle) * speed];
        if (s.isMajor) this.plateVectors[s.majorPlateId] = s.vec;
        else fossilCount++;
      }
      // Phantom plates beyond the four map borders (edge lines are REAL
      // active boundaries — "imagine there's a plate on the other side",
      // agreed 2026-07-10). One seeded vector per side [W, E, N, S], same
      // speed distribution as real plates; edge segments run the same
      // collision math against these (tectonic-lines.js), so an edge
      // stretch can come out convergent, divergent, or glancing per world
      // (edge dice). Phantom crust is treated as oceanic (the void beyond).
      this.edgePhantomVectors = [];
      for (let side = 0; side < 4; side++) {
        const angle = V.hash2d(side, 0, this.seed + 53000) * Math.PI * 2;
        const speed = plateSpeedMin + V.hash2d(side, 1, this.seed + 54000) * (plateSpeedMax - plateSpeedMin);
        this.edgePhantomVectors.push([Math.cos(angle) * speed, Math.sin(angle) * speed]);
      }

      // Porting mirror — copy to the C# debug logs.
      console.log(`[tectonic] plate vectors: ${this.plateCount} plates + ${fossilCount} fossil seeds + 4 edge phantoms, speed∈[${plateSpeedMin}, ${plateSpeedMax}]`);
    }

    _buildSpatialIndex() {
      let cellSize = this.gridSpacing * 0.8;
      cellSize = Math.max(cellSize, 20);
      this._cellSize = cellSize;
      this._gridCols = Math.ceil(this.mapW / cellSize) + 4;
      this._gridRows = Math.ceil(this.mapH / cellSize) + 4;
      this._gridOff = 2;
      const gridLen = this._gridCols * this._gridRows;
      this._grid = new Array(gridLen);
      for (let i = 0; i < gridLen; i++) this._grid[i] = [];

      for (let i = 0; i < this.allSeeds.length; i++) {
        const s = this.allSeeds[i];
        const gcx = Math.floor(s.x / cellSize) + this._gridOff;
        const gcz = Math.floor(s.z / cellSize) + this._gridOff;
        if (gcx >= 0 && gcx < this._gridCols && gcz >= 0 && gcz < this._gridRows) {
          this._grid[gcz * this._gridCols + gcx].push(i);
        }
      }
    }

    // Unwarped nearest-seed lookup (structural — for adjacency, hotspots).
    _nearestSeedRaw(x, z) {
      const gcx = Math.floor(x / this._cellSize) + this._gridOff;
      const gcz = Math.floor(z / this._cellSize) + this._gridOff;
      let bestDist = Infinity, bestIdx = -1;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ci = gcz + dz, cj = gcx + dx;
          if (ci < 0 || ci >= this._gridRows || cj < 0 || cj >= this._gridCols) continue;
          const bucket = this._grid[ci * this._gridCols + cj];
          for (const si of bucket) {
            const s = this.allSeeds[si];
            const ddx = x - s.x, ddz = z - s.z;
            const d = ddx * ddx + ddz * ddz;
            if (d < bestDist) { bestDist = d; bestIdx = si; }
          }
        }
      }
      return bestIdx;
    }

    // Warped nearest-seed lookup (visual — for boundaries, ownership queries).
    _nearestSeed(x, z) {
      const [wx, wz] = this._warp(x, z);
      const gcx = Math.floor(wx / this._cellSize) + this._gridOff;
      const gcz = Math.floor(wz / this._cellSize) + this._gridOff;
      let bestDist = Infinity, bestIdx = -1;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ci = gcz + dz, cj = gcx + dx;
          if (ci < 0 || ci >= this._gridRows || cj < 0 || cj >= this._gridCols) continue;
          const bucket = this._grid[ci * this._gridCols + cj];
          for (const si of bucket) {
            const s = this.allSeeds[si];
            const ddx = wx - s.x, ddz = wz - s.z;
            const d = ddx * ddx + ddz * ddz;
            if (d < bestDist) { bestDist = d; bestIdx = si; }
          }
        }
      }
      return bestIdx;
    }

    // Precompute the warped nearest-seed for every pixel, then walk the grid
    // and check all 4 neighbours per cell. Diagonal boundaries are caught
    // because both axes are inspected. The map perimeter is force-stamped
    // active so the picture has a frame.
    _extractBoundaryPixels() {
      const { mapW, mapH } = this;
      const mapSize = Math.max(mapW, mapH);
      const step = mapSize > 1024 ? 2 : 1;
      const gw = Math.ceil(mapW / step), gh = Math.ceil(mapH / step);
      const grid = new Int32Array(gw * gh);

      for (let gz = 0; gz < gh; gz++) {
        for (let gx = 0; gx < gw; gx++) {
          grid[gz * gw + gx] = this._nearestSeed(gx * step, gz * step);
        }
      }

      // Saved for junction + segment extraction. Worldinit-only data.
      this._seedGrid = grid;
      this._seedGridStep = step;
      this._seedGridGw = gw;
      this._seedGridGh = gh;

      this.activeBoundaryPixels = [];
      this.fossilBoundaryPixels = [];
      // Per-pixel masks for unified per-screen-pixel rendering. Avoids the
      // fractional-zoom alpha banding that the previous fillRect approach hit.
      this.activeBoundaryGrid = new Uint8Array(mapW * mapH);
      this.fossilBoundaryGrid = new Uint8Array(mapW * mapH);

      const setActive = (px, pz) => {
        this.activeBoundaryPixels.push(px, pz);
        if (px >= 0 && px < mapW && pz >= 0 && pz < mapH) {
          this.activeBoundaryGrid[pz * mapW + px] = 1;
        }
      };
      const setFossil = (px, pz) => {
        this.fossilBoundaryPixels.push(px, pz);
        if (px >= 0 && px < mapW && pz >= 0 && pz < mapH) {
          this.fossilBoundaryGrid[pz * mapW + px] = 1;
        }
      };

      for (let gz = 1; gz < gh - 1; gz++) {
        for (let gx = 1; gx < gw - 1; gx++) {
          const idx = grid[gz * gw + gx];
          if (idx < 0) continue;
          const seed = this.allSeeds[idx];
          let isActive = false;
          const myPlate = seed.majorPlateId;
          const neighbors = [
            grid[gz * gw + (gx - 1)],
            grid[gz * gw + (gx + 1)],
            grid[(gz - 1) * gw + gx],
            grid[(gz + 1) * gw + gx],
          ];
          // Lower-side-only detection: this pixel is marked as a boundary
          // only if its seed has a smaller index than the differing neighbour's.
          // Boundaries become 1 px wide instead of 2.
          //
          // Junction skip: if the pixel has 2+ DISTINCT differing neighbours
          // (i.e., sits at the convergence of multiple boundary lines), don't
          // mark it. This drops junction pixels from the mask entirely, so the
          // boundary-overlay renderer doesn't paint a dark cluster there, and
          // TectonicLines' segment/junction extraction reads cleanly separated
          // lines instead of ones glued together at every meeting point.
          let firstNi = -1;
          let multipleDistinct = false;
          for (const ni of neighbors) {
            if (ni < 0 || ni === idx) continue;
            if (idx < ni) {
              if (firstNi === -1) firstNi = ni;
              else if (firstNi !== ni) multipleDistinct = true;
              if (this.allSeeds[ni].majorPlateId !== myPlate) isActive = true;
            }
          }
          if (firstNi !== -1 && !multipleDistinct) {
            const px = gx * step, pz = gz * step;
            if (isActive) setActive(px, pz);
            else setFossil(px, pz);
          }
        }
      }

      // Perimeter is force-stamped STRAIGHT at the literal border (deliberately
      // not warped): the edge line must stay pinned to the map boundary — it
      // can't displace outside the map (the small-map-mostly-land case wants a
      // mountain belt hugging the edge). Width variation along it still comes
      // from the Province Warp (widthMul breathes the orogen band width per
      // pixel), so the edge reads organic without the line itself moving.
      const edgeThreshold = step * 2;
      for (let gz = 0; gz < gh; gz++) {
        for (let gx = 0; gx < gw; gx++) {
          const px = gx * step, pz = gz * step;
          if (px < edgeThreshold || px > mapW - 1 - edgeThreshold || pz < edgeThreshold || pz > mapH - 1 - edgeThreshold) {
            setActive(px, pz);
          }
        }
      }
    }

    _generateHotspots() {
      const { mapW, mapH, seed } = this;
      this.hotspots = [];
      // Hotspots disabled for now. Kept fully wired so re-enabling is a one-line
      // revert (delete this return): every consumer reads this list, so an empty
      // list removes them everywhere — red dots, extended-crust province, geo bumps.
      return;
      const mapSize = Math.max(mapW, mapH);
      const edgeMargin = mapSize * 0.03;
      const plateIds = [...new Set(this.majorSeeds.map(s => s.plateId))];

      const plateAreas = {};
      const sampleStep = Math.max(4, Math.floor(mapSize / 100));
      let totalSamples = 0;
      for (let z = 0; z < mapH; z += sampleStep) {
        for (let x = 0; x < mapW; x += sampleStep) {
          totalSamples++;
          const idx = this._nearestSeedRaw(x, z);
          if (idx >= 0) {
            const pid = this.allSeeds[idx].majorPlateId;
            plateAreas[pid] = (plateAreas[pid] || 0) + 1;
          }
        }
      }

      for (const pid of plateIds) {
        const areaFrac = (plateAreas[pid] || 0) / totalSamples;
        const maxHotspots = areaFrac < 0.05 ? (V.hash2d(pid, 0, seed + 90000) < 0.5 ? 0 : 1) : 2;
        const plateSeeds = this.majorSeeds.filter(s => s.plateId === pid);
        const plateCx = plateSeeds.reduce((s, p) => s + p.x, 0) / plateSeeds.length;
        const plateCz = plateSeeds.reduce((s, p) => s + p.z, 0) / plateSeeds.length;

        // Reject candidates that aren't inside the parent plate or that sit
        // too close to an active boundary (the ones that broke the lines in
        // v1). Bumped attempt budget so small plates still find a valid spot.
        const minBoundaryDist = this.continentRadius * 0.2;
        for (let h = 0; h < maxHotspots; h++) {
          let bestPos = null, bestMinDist = -1;
          for (let attempt = 0; attempt < 25; attempt++) {
            const hx = V.hash2d(pid * 100 + h, attempt, seed + 77777);
            const hz = V.hash2d(pid * 100 + h, attempt + 50, seed + 88888);
            const cx = Math.max(0, Math.min(mapW - 1, plateCx * 0.3 + (edgeMargin + hx * (mapW - 2 * edgeMargin)) * 0.7));
            const cz = Math.max(0, Math.min(mapH - 1, plateCz * 0.3 + (edgeMargin + hz * (mapH - 2 * edgeMargin)) * 0.7));

            // Must be inside the parent plate.
            const idxAt = this._nearestSeedRaw(cx, cz);
            if (idxAt < 0 || this.allSeeds[idxAt].majorPlateId !== pid) continue;
            // Must be away from any active boundary.
            if (this.getDistToActiveBoundary(cx, cz) < minBoundaryDist) continue;

            let nearest = Infinity;
            for (const hs of this.hotspots) {
              const dx = cx - hs.x, dz = cz - hs.z;
              nearest = Math.min(nearest, Math.sqrt(dx * dx + dz * dz));
            }
            if (nearest > bestMinDist) { bestMinDist = nearest; bestPos = { x: cx, z: cz }; }
          }
          if (bestPos) {
            const radiusHash = V.hash2d(pid, h * 37 + 4, seed + 7780);
            const radius = this.continentRadius * (0.06 + radiusHash * 0.08);
            this.hotspots.push({
              x: bestPos.x, z: bestPos.z,
              radius,
              plateId: pid,
            });
          }
        }
      }
    }

    _computePlatePairTypes() {
      this.platePairTypes = {};
      const adjacentPairs = new Set();
      const { mapW, mapH } = this;
      const step = Math.max(2, Math.floor(Math.min(mapW, mapH) / 300));

      for (let z = 0; z < mapH - step; z += step) {
        for (let x = 0; x < mapW - step; x += step) {
          const idxA = this._nearestSeedRaw(x, z);
          if (idxA < 0) continue;
          const seedA = this.allSeeds[idxA];
          const idxR = this._nearestSeedRaw(x + step, z);
          if (idxR >= 0 && idxR !== idxA) {
            const seedR = this.allSeeds[idxR];
            if (seedA.majorPlateId !== seedR.majorPlateId) {
              adjacentPairs.add(Math.min(seedA.majorPlateId, seedR.majorPlateId) + ',' + Math.max(seedA.majorPlateId, seedR.majorPlateId));
            }
          }
          const idxB = this._nearestSeedRaw(x, z + step);
          if (idxB >= 0 && idxB !== idxA) {
            const seedB = this.allSeeds[idxB];
            if (seedA.majorPlateId !== seedB.majorPlateId) {
              adjacentPairs.add(Math.min(seedA.majorPlateId, seedB.majorPlateId) + ',' + Math.max(seedA.majorPlateId, seedB.majorPlateId));
            }
          }
        }
      }

      for (const key of adjacentPairs) {
        const [pidA, pidB] = key.split(',').map(Number);
        // Vector-derived (spec §3.1): the two plates' relative motion projected
        // onto the boundary they share (facing = between their seed centres).
        // Replaces the old deterministic hash — proportions are now emergent.
        const sa = this.majorSeeds[pidA], sb = this.majorSeeds[pidB];
        this.platePairTypes[key] = V.classifyClosing(
          this.plateVectors[pidA], this.plateVectors[pidB],
          sa.x, sa.z, sb.x, sb.z, this.transformThreshold);
      }
    }

    _warp(x, z) {
      return [
        Math.round((x + this._warpX(x, z) * this._warpAmp) * 1e6) / 1e6,
        Math.round((z + this._warpZ(x, z) * this._warpAmp) * 1e6) / 1e6,
      ];
    }

    // ===== Public API =====
    getNearestSeed(x, z) { return this._nearestSeed(x, z); }
    getPlateAt(x, z) { const i = this._nearestSeed(x, z); return i < 0 ? -1 : this.allSeeds[i].majorPlateId; }
    getPlateAtRaw(x, z) { const i = this._nearestSeedRaw(x, z); return i < 0 ? -1 : this.allSeeds[i].majorPlateId; }
    getPlateVector(plateId) { return this.plateVectors[plateId] || [0, 0]; } // major plate drift (spec §3.1)

    getHotspotInfo(x, z) {
      for (const h of this.hotspots) {
        const dx = x - h.x, dz = z - h.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < h.radius) return { inHotspot: true, dist: d, hotspot: h };
      }
      return { inHotspot: false, dist: Infinity, hotspot: null };
    }

    getDistToActiveBoundary(x, z) {
      const seeds = this.allSeeds;
      if (seeds.length < 2) return Infinity;
      const [wx, wz] = this._warp(x, z);
      const cs = this._cellSize;
      const gcx = Math.floor(wx / cs) + this._gridOff;
      const gcz = Math.floor(wz / cs) + this._gridOff;
      let best1Dsq = Infinity, best1Plate = -1, best2Dsq = Infinity;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ncx = gcx + dx, ncz = gcz + dz;
          if (ncx < 0 || ncx >= this._gridCols || ncz < 0 || ncz >= this._gridRows) continue;
          const cell = this._grid[ncz * this._gridCols + ncx];
          for (let i = 0; i < cell.length; i++) {
            const s = seeds[cell[i]];
            const ddx = wx - s.x, ddz = wz - s.z;
            const dsq = ddx * ddx + ddz * ddz;
            if (dsq < best1Dsq) {
              if (best1Plate >= 0 && best1Plate !== s.majorPlateId) best2Dsq = best1Dsq;
              best1Dsq = dsq; best1Plate = s.majorPlateId;
            } else if (dsq < best2Dsq && s.majorPlateId !== best1Plate) {
              best2Dsq = dsq;
            }
          }
        }
      }
      let voronoiDist = Infinity;
      if (best2Dsq < Infinity && best1Plate >= 0) voronoiDist = (Math.sqrt(best2Dsq) - Math.sqrt(best1Dsq)) / 2;
      const edgeDist = Math.min(x, z, this.mapW - 1 - x, this.mapH - 1 - z);
      return Math.min(voronoiDist, edgeDist);
    }

    getDistToFossilBoundary(x, z) {
      const seeds = this.allSeeds;
      if (seeds.length < 2) return Infinity;
      const [wx, wz] = this._warp(x, z);
      const cs = this._cellSize;
      const gcx = Math.floor(wx / cs) + this._gridOff;
      const gcz = Math.floor(wz / cs) + this._gridOff;
      let best1Dsq = Infinity, best1Idx = -1, best1Plate = -1, best2Dsq = Infinity;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ncx = gcx + dx, ncz = gcz + dz;
          if (ncx < 0 || ncx >= this._gridCols || ncz < 0 || ncz >= this._gridRows) continue;
          const cell = this._grid[ncz * this._gridCols + ncx];
          for (let i = 0; i < cell.length; i++) {
            const si = cell[i];
            const s = seeds[si];
            const ddx = wx - s.x, ddz = wz - s.z;
            const dsq = ddx * ddx + ddz * ddz;
            if (dsq < best1Dsq) {
              if (best1Idx >= 0 && best1Plate === s.majorPlateId && best1Dsq < best2Dsq) best2Dsq = best1Dsq;
              best1Dsq = dsq; best1Idx = si; best1Plate = s.majorPlateId;
            } else if (s.majorPlateId === best1Plate && si !== best1Idx && dsq < best2Dsq) {
              best2Dsq = dsq;
            }
          }
        }
      }
      if (best2Dsq >= Infinity || best1Idx < 0) return Infinity;
      return (Math.sqrt(best2Dsq) - Math.sqrt(best1Dsq)) / 2;
    }

    // The province-classification rule lives in provinces.js as
    // V.provinceAt(tectonic, x, z, isLand). TectonicModel still owns the
    // inputs it reads (hotspots, width-mul, plate relationship); the exact
    // per-kind boundary distance itself comes from tectonic.lines.getKindDistancesAt.

    getPlateRelationship(x, z) {
      const seeds = this.allSeeds;
      if (seeds.length < 2) return 'convergent';
      const edgeDist = Math.min(x, z, this.mapW - 1 - x, this.mapH - 1 - z);
      const [wx, wz] = this._warp(x, z);
      const cs = this._cellSize;
      const gcx = Math.floor(wx / cs) + this._gridOff;
      const gcz = Math.floor(wz / cs) + this._gridOff;
      let myPlate = -1, myDsq = Infinity, otherPlate = -1, otherDsq = Infinity;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ncx = gcx + dx, ncz = gcz + dz;
          if (ncx < 0 || ncx >= this._gridCols || ncz < 0 || ncz >= this._gridRows) continue;
          const cell = this._grid[ncz * this._gridCols + ncx];
          for (let i = 0; i < cell.length; i++) {
            const s = seeds[cell[i]];
            const ddx = wx - s.x, ddz = wz - s.z;
            const dsq = ddx * ddx + ddz * ddz;
            if (dsq < myDsq) {
              if (myPlate >= 0 && myPlate !== s.majorPlateId && myDsq < otherDsq) {
                otherPlate = myPlate; otherDsq = myDsq;
              }
              myDsq = dsq; myPlate = s.majorPlateId;
            } else if (s.majorPlateId !== myPlate && dsq < otherDsq) {
              otherPlate = s.majorPlateId; otherDsq = dsq;
            }
          }
        }
      }
      if (edgeDist < Math.sqrt(otherDsq)) return 'convergent';
      if (otherPlate < 0 || myPlate < 0) return 'convergent';
      const key = Math.min(myPlate, otherPlate) + ',' + Math.max(myPlate, otherPlate);
      return this.platePairTypes[key] || 'convergent';
    }

  }

  V.TectonicModel = TectonicModel;

})(window.VIS);
