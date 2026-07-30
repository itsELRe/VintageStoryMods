// ocean.js — ContinentGen (orchestrator + queries + plate typing)
// The BFS growth itself lives in continent-bfs.js (loaded after this one);
// continent-islands.js (_addFragmentationIslands) is dormant.
//
// CONVENTION NOTE
// VS's final OceanMap uses 0=land, 1–255=ocean (depth). This module's
// internal `landGrid` keeps v1's working convention: 1=land, 0=ocean —
// because the BFS algorithm treats "claimed" as 1. When we eventually
// export to VS, we flip: vsOceanMap[i] = landGrid[i] === 1 ? 0 : 1.
//
// LAND/OCEAN ON FACES (docs/continental-shape-spec.md §2)
// The categorical unit is the lattice FACE: `faceState` holds one label per
// mesh face (0 = ocean, >0 = continent id). Points carry no land/ocean value;
// their derived classification (`pointClass`: OCEANIC / COASTAL / INTERIOR)
// comes from the labels of their incident faces, so a COASTAL point lies
// exactly on the primitive coast polyline by construction.
//
// The primitive coast is faceted on purpose and never visible in-game — the
// organic coastline is the emergent coast field (coast-field.js), a pure
// per-column function, not a stored/warped grid.

window.VIS = window.VIS || {};

(function (V) {

  // Point classification values (derived from incident face labels).
  V.POINT_OCEANIC  = 0;  // touches only OCEAN faces
  V.POINT_COASTAL  = 1;  // touches both — sits exactly on the coast polyline
  V.POINT_INTERIOR = 2;  // touches only LAND faces

  class ContinentGen {
    constructor(opts, tectonic, mesh) {
      this.p = { ...opts };
      this.tectonic = tectonic;
      this.mesh = mesh;
      this.continentRadius = tectonic.continentRadius;
      this.gridSpacing = tectonic.gridSpacing;

      this.spawnX = this.p.mapW / 2;
      this.spawnZ = this.p.mapH / 2;

      this.seeds = [];
    }

    // ===== Queries =====

    isLandAt(px, pz) {
      if (!this.faceState) return false;
      return this.faceState[this.mesh.faceAt(px, pz)] > 0;
    }

    // ===== Plate typing (coarse grid + continental/oceanic sets) =====
    // Used for plate-bias conditioning during BFS seed selection + growth.
    _classifyPlates() {
      const p = this.p;
      const tec = this.tectonic;
      const mapW = p.mapW, mapH = p.mapH;

      this.plateGrid = new Uint8Array(mapW * mapH);
      const plateAreas = {};
      const plateSumX = {}, plateSumZ = {};
      this._edgePlates = new Set();
      for (let z = 0; z < mapH; z++) {
        for (let x = 0; x < mapW; x++) {
          const pid = tec.getPlateAt(x, z);
          this.plateGrid[z * mapW + x] = pid >= 0 ? pid : 255;
          if (pid >= 0) {
            plateAreas[pid] = (plateAreas[pid] || 0) + 1;
            plateSumX[pid] = (plateSumX[pid] || 0) + x;
            plateSumZ[pid] = (plateSumZ[pid] || 0) + z;
            if (x === 0 || x === mapW - 1 || z === 0 || z === mapH - 1)
              this._edgePlates.add(pid);
          }
        }
      }
      this.plateAreas = plateAreas;
      this.plateCentroids = {};
      const allPlateIds = Object.keys(plateAreas).map(Number).sort((a, b) => a - b);
      for (const pid of allPlateIds) {
        this.plateCentroids[pid] = {
          x: plateSumX[pid] / plateAreas[pid],
          z: plateSumZ[pid] / plateAreas[pid],
        };
      }
      this.interiorPlates = allPlateIds.filter(pid => !this._edgePlates.has(pid));
      if (this.interiorPlates.length === 0) this.interiorPlates = allPlateIds;
      this.spawnPlateId = tec.getPlateAt(this.spawnX, this.spawnZ);

      // Continental / oceanic typing. Edge plates lean oceanic; interior
      // plates lean continental. Spawn plate is forced continental.
      const typeRng = V.makePRNG((V.hash2d(0, 0, p.seed + 55555) * 0xFFFFFFFF) | 0);
      this.continentalPlates = new Set();
      for (const pid of allPlateIds) {
        if (this._edgePlates.has(pid)) {
          if (typeRng() < 0.2) this.continentalPlates.add(pid);
        } else {
          if (typeRng() < 0.7) this.continentalPlates.add(pid);
        }
      }
      this.continentalPlates.add(this.spawnPlateId);
    }

    // ===== Derived views of the face labels =====

    // pointClass: OCEANIC / COASTAL / INTERIOR per lattice point, from the
    // labels of its incident faces. Margin faces (outside the map) are never
    // claimed, so the rim classifies OCEANIC and the coast closes at the edge.
    _classifyPoints() {
      const mesh = this.mesh;
      const n = mesh.numAnchors;
      this.pointClass = new Uint8Array(n);
      for (let t = 0; t < n; t++) {
        const faces = mesh.facesAtPoint(t);
        let hasLand = false, hasOcean = false;
        for (let i = 0; i < faces.length; i++) {
          if (this.faceState[faces[i]] > 0) hasLand = true; else hasOcean = true;
        }
        this.pointClass[t] = hasLand
          ? (hasOcean ? V.POINT_COASTAL : V.POINT_INTERIOR)
          : V.POINT_OCEANIC;
      }
    }

    // Per-pixel land raster of the face labels (the Primitive view; the
    // Detailed view is the coast field's mask).
    _rasterizeLandGrid() {
      const { mapW, mapH } = this.p;
      this.landGrid = new Uint8Array(mapW * mapH);
      for (let z = 0; z < mapH; z++) {
        const row = z * mapW;
        for (let x = 0; x < mapW; x++) {
          if (this.faceState[this.mesh.faceAt(x, z)] > 0) this.landGrid[row + x] = 1;
        }
      }
    }

    _collectCoastPixels() {
      const { mapW, mapH } = this.p;
      this.coastPixels = [];
      this.coastGrid = new Uint8Array(mapW * mapH);
      for (let z = 0; z < mapH; z++) {
        for (let x = 0; x < mapW; x++) {
          const i = z * mapW + x;
          if (this.landGrid[i] !== 1) continue;
          if ((x > 0        && this.landGrid[z * mapW + (x - 1)] === 0) ||
              (x < mapW - 1 && this.landGrid[z * mapW + (x + 1)] === 0) ||
              (z > 0        && this.landGrid[(z - 1) * mapW + x] === 0) ||
              (z < mapH - 1 && this.landGrid[(z + 1) * mapW + x] === 0)) {
            this.coastPixels.push(x, z);
            this.coastGrid[i] = 1;
          }
        }
      }
    }

    // ===== Main entry =====
    calibrate() {
      this._classifyPlates();
      this._growContinents();   // continent-bfs.js — labels the faces

      // Guarantee the spawn face is land.
      const spawnFace = this.mesh.faceAt(this.spawnX, this.spawnZ);
      if (this.faceState[spawnFace] === 0) this.faceState[spawnFace] = 1;

      // Fragmentation islands not invoked yet (continent-islands.js, dormant).

      this._classifyPoints();
      this._rasterizeLandGrid();
      this._collectCoastPixels();

      // Continent/plate seed list for renderer markers.
      this.seeds = [];
      for (const ms of this.tectonic.majorSeeds) {
        const isLand = this.continentalPlates.has(ms.plateId);
        this.seeds.push({
          x: ms.x, z: ms.z, cx: ms.cx, cz: ms.cz,
          isLand, isSpawn: ms.plateId === this.spawnPlateId && ms.cx === 0 && ms.cz === 0,
          plateId: isLand ? ms.plateId : -1,
        });
      }

      // Porting mirror — copy to the C# debug logs.
      let landFaces = 0, coastal = 0;
      for (let f = 0; f < this.faceState.length; f++) if (this.faceState[f] > 0) landFaces++;
      for (let t = 0; t < this.pointClass.length; t++) if (this.pointClass[t] === V.POINT_COASTAL) coastal++;
      console.log(`[continent] faces=${this.faceState.length} land=${landFaces} coastalPts=${coastal} landMask=${V.checksum(this.landGrid).toString(16)}`);
    }
  }

  V.ContinentGen = ContinentGen;

})(window.VIS);
