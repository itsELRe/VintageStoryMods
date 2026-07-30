// continent-islands.js — ContinentGen._addFragmentationIslands
// Five island types stamped onto landGrid by tectonic boundary type:
//   1. Island arcs       — sparse clusters along convergent boundaries
//   2. Shelf fragments   — broken-off pieces near continental coasts
//   3. Hotspot trails    — chains away from plate centroids
//   4. Rift islands      — sparse volcanic dots along divergent boundaries
//   5. Equatorial scatter — gap-fill near the equator
//
// Currently DORMANT: calibrate() does not invoke this method (we'll re-enable
// when the user wants to dial islands back in). The function is preserved
// here because the user explicitly asked for it to be ported "as is".
//
// REVIVAL NOTE (lattice rework, 2026-07-23): this still stamps polygon pixels
// straight into landGrid, which violates the labels-live-on-faces invariant
// (docs/continental-shape-spec.md §6). When re-enabled it must be rewritten to
// label whole faces (set faceState on the faces the island polygon covers,
// before pointClass/landGrid are derived), not paint pixels.

window.VIS = window.VIS || {};

(function (V) {

  V.ContinentGen.prototype._addFragmentationIslands = function () {
    const p = this.p;
    const frag = p.fragmentation;
    if (frag <= 0 || !this.landGrid) return;

    const mapW = p.mapW, mapH = p.mapH;
    const mapSize = Math.max(mapW, mapH);
    const r = this.continentRadius;
    const sizeScale = Math.sqrt(mapSize / 512);
    const fragRng = V.makePRNG((V.hash2d(5, 0, p.seed + 88888) * 0xFFFFFFFF) | 0);

    const stampIsland = (cx, cz, area) => {
      const polyRng = V.makePRNG((V.hash2d(Math.round(cx), Math.round(cz), p.seed + 99999) * 0xFFFFFFFF) | 0);
      const N = 3 + Math.floor(polyRng() * 3);
      const m = V.makeLandmass(polyRng, area, cx, cz, { N, levels: 3, elongation: 1.0 + polyRng() * 0.3, k: 0.3 });
      const pts = m.points;
      if (pts.length < 3) return;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [x, z] of pts) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      const x0 = Math.max(1, Math.floor(minX)), x1 = Math.min(mapW - 2, Math.ceil(maxX));
      const z0 = Math.max(1, Math.floor(minZ)), z1 = Math.min(mapH - 2, Math.ceil(maxZ));
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (V.pointInPoly(pts, x, z)) this.landGrid[z * mapW + x] = 1;
        }
      }
    };

    const isOcean = (x, z) => {
      const gx = Math.max(0, Math.min(mapW - 1, Math.round(x)));
      const gz = Math.max(0, Math.min(mapH - 1, Math.round(z)));
      return this.landGrid[gz * mapW + gx] === 0;
    };

    const plateCentroids = {};
    for (const ms of this.tectonic.majorSeeds) {
      if (!plateCentroids[ms.plateId]) plateCentroids[ms.plateId] = { sx: 0, sz: 0, n: 0 };
      plateCentroids[ms.plateId].sx += ms.x;
      plateCentroids[ms.plateId].sz += ms.z;
      plateCentroids[ms.plateId].n++;
    }
    for (const pid in plateCentroids) {
      const c = plateCentroids[pid];
      c.x = c.sx / c.n;
      c.z = c.sz / c.n;
    }

    // ===== 1. Island arcs (convergent boundaries) =====
    const step = Math.max(4, Math.floor(mapSize / 150));
    const arcSpacing = r * 0.25 * sizeScale;
    const arcOffset = r * 0.5;
    const arcIslandSize = Math.PI * Math.pow(1.5 * sizeScale, 2);
    const sortedPairKeys = Object.keys(this.tectonic.platePairTypes).sort();

    for (const key of sortedPairKeys) {
      if (this.tectonic.platePairTypes[key] !== 'convergent') continue;
      if (fragRng() > frag) continue;
      const [pidA, pidB] = key.split(',').map(Number);

      const boundaryPts = [];
      for (let z = 0; z < mapH; z += step) {
        for (let x = 0; x < mapW; x += step) {
          const pHere = this.tectonic.getPlateAtRaw(x, z);
          if (pHere !== pidA && pHere !== pidB) continue;
          const pRight = this.tectonic.getPlateAtRaw(x + step, z);
          const pDown = this.tectonic.getPlateAtRaw(x, z + step);
          if ((pRight === pidA || pRight === pidB) && pRight !== pHere)
            boundaryPts.push({ x: x + step / 2, z });
          if ((pDown === pidA || pDown === pidB) && pDown !== pHere)
            boundaryPts.push({ x, z: z + step / 2 });
        }
      }
      if (boundaryPts.length < 2) continue;

      const oceanBoundaryPts = boundaryPts.filter(pt => isOcean(pt.x, pt.z));
      if (oceanBoundaryPts.length < 3) continue;

      const sorted = [oceanBoundaryPts[0]];
      const used = new Set([0]);
      for (let si = 1; si < oceanBoundaryPts.length; si++) {
        const last = sorted[sorted.length - 1];
        let bestIdx = -1, bestDist = Infinity;
        for (let j = 0; j < oceanBoundaryPts.length; j++) {
          if (used.has(j)) continue;
          const dx = oceanBoundaryPts[j].x - last.x, dz = oceanBoundaryPts[j].z - last.z;
          const d = dx * dx + dz * dz;
          if (d < bestDist) { bestDist = d; bestIdx = j; }
        }
        if (bestIdx < 0) break;
        sorted.push(oceanBoundaryPts[bestIdx]);
        used.add(bestIdx);
      }

      let lastClusterX = -Infinity, lastClusterZ = -Infinity;
      let lastPx = -Infinity, lastPz = -Infinity;
      let inCluster = false;
      let clusterRemaining = 0;
      const clusterGap = arcSpacing * (4 + fragRng() * 6);

      for (let si = 0; si < sorted.length; si++) {
        const pt = sorted[si];
        const dx = pt.x - lastPx, dz = pt.z - lastPz;
        const distFromLast = Math.sqrt(dx * dx + dz * dz);

        if (!inCluster) {
          const dxc = pt.x - lastClusterX, dzc = pt.z - lastClusterZ;
          if (Math.sqrt(dxc * dxc + dzc * dzc) < clusterGap) continue;
          if (fragRng() > frag * 0.35) continue;
          inCluster = true;
          clusterRemaining = 3 + Math.floor(fragRng() * 5 * frag);
          lastClusterX = pt.x; lastClusterZ = pt.z;
        } else {
          if (distFromLast < arcSpacing * 0.3) continue;
        }

        const prev = sorted[Math.max(0, si - 2)];
        const next = sorted[Math.min(sorted.length - 1, si + 2)];
        let tdx = next.x - prev.x, tdz = next.z - prev.z;
        const tlen = Math.sqrt(tdx * tdx + tdz * tdz);
        if (tlen > 0.01) { tdx /= tlen; tdz /= tlen; }

        const perpX = -tdz, perpZ = tdx;
        const wobble = (fragRng() - 0.5) * 2 * arcOffset;
        const scatter = arcSpacing * 0.6;
        const offX = pt.x + perpX * wobble + (fragRng() - 0.5) * scatter;
        const offZ = pt.z + perpZ * wobble + (fragRng() - 0.5) * scatter;
        if (!isOcean(offX, offZ)) continue;

        const sizeMul = fragRng() < 0.3 ? (2.0 + fragRng() * 2.0) : (0.3 + fragRng() * 1.0);
        const area = arcIslandSize * sizeMul * frag;
        stampIsland(offX, offZ, area);
        lastPx = pt.x; lastPz = pt.z;

        clusterRemaining--;
        if (clusterRemaining <= 0) inCluster = false;
      }
    }

    // ===== 2. Shelf fragments =====
    const coastPixels = [];
    const coastSampleStep = Math.max(2, Math.floor(mapSize / 200));
    for (let z = 1; z < mapH - 1; z += coastSampleStep) {
      for (let x = 1; x < mapW - 1; x += coastSampleStep) {
        if (this.landGrid[z * mapW + x] !== 1) continue;
        if (this.landGrid[z * mapW + (x - 1)] === 0 ||
            this.landGrid[z * mapW + (x + 1)] === 0 ||
            this.landGrid[(z - 1) * mapW + x] === 0 ||
            this.landGrid[(z + 1) * mapW + x] === 0) {
          coastPixels.push({ x, z });
        }
      }
    }

    const shelfFragCount = Math.round(frag * coastPixels.length * 0.18);
    const shelfMinOff = r * 0.06;
    const shelfMaxOff = r * 0.3;
    for (let i = 0; i < shelfFragCount; i++) {
      const ci = Math.floor(fragRng() * coastPixels.length);
      const cp = coastPixels[ci];
      let ox = 0, oz = 0;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cp.x + dx, nz = cp.z + dz;
          if (nx < 0 || nx >= mapW || nz < 0 || nz >= mapH) continue;
          if (this.landGrid[nz * mapW + nx] === 0) { ox += dx; oz += dz; }
        }
      }
      const olen = Math.sqrt(ox * ox + oz * oz);
      if (olen < 0.01) continue;
      ox /= olen; oz /= olen;

      const dist = shelfMinOff + fragRng() * (shelfMaxOff - shelfMinOff);
      const ix = cp.x + ox * dist + (fragRng() - 0.5) * dist * 0.6;
      const iz = cp.z + oz * dist + (fragRng() - 0.5) * dist * 0.6;
      if (!isOcean(ix, iz)) continue;
      if (ix < 1 || ix > mapW - 2 || iz < 1 || iz > mapH - 2) continue;

      const islandR = (1 + fragRng() * 2.5) * sizeScale * frag;
      stampIsland(ix, iz, Math.PI * islandR * islandR);
    }

    // ===== 3. Hotspot trails =====
    if (this.tectonic.hotspots) {
      let trailsPlaced = 0;
      const maxTrails = Math.max(1, Math.round(frag * 2));
      for (const hs of this.tectonic.hotspots) {
        if (trailsPlaced >= maxTrails) break;
        if (fragRng() > frag * 0.4) continue;

        const centroid = plateCentroids[hs.plateId];
        let trailDx = 0, trailDz = 1;
        if (centroid) {
          trailDx = hs.x - centroid.x;
          trailDz = hs.z - centroid.z;
          const len = Math.sqrt(trailDx * trailDx + trailDz * trailDz);
          if (len > 0.01) { trailDx /= len; trailDz /= len; }
        }

        const trailLen = Math.round(3 + fragRng() * 6 * frag);
        const trailSpacing = r * (0.08 + fragRng() * 0.06) * sizeScale;
        for (let ti = 0; ti < trailLen; ti++) {
          const dist = (ti + 1) * trailSpacing;
          const wobble = (fragRng() - 0.5) * trailSpacing * 0.4;
          const ix = hs.x + trailDx * dist + (-trailDz) * wobble;
          const iz = hs.z + trailDz * dist + trailDx * wobble;
          if (!isOcean(ix, iz)) continue;
          if (ix < 1 || ix > mapW - 2 || iz < 1 || iz > mapH - 2) continue;

          const ageFactor = 1.0 - ti * 0.08;
          const islandR = (1 + fragRng() * 2.5) * sizeScale * frag * Math.max(0.3, ageFactor);
          stampIsland(ix, iz, Math.PI * islandR * islandR);
        }
        trailsPlaced++;
      }
    }

    // ===== 4. Rift islands (divergent boundaries) =====
    for (const key of sortedPairKeys) {
      if (this.tectonic.platePairTypes[key] !== 'divergent') continue;
      if (fragRng() > frag * 0.3) continue;
      const [pidA, pidB] = key.split(',').map(Number);

      const riftPts = [];
      for (let z = 0; z < mapH; z += step * 2) {
        for (let x = 0; x < mapW; x += step * 2) {
          const pHere = this.tectonic.getPlateAtRaw(x, z);
          if (pHere !== pidA && pHere !== pidB) continue;
          const pRight = this.tectonic.getPlateAtRaw(x + step, z);
          const pDown = this.tectonic.getPlateAtRaw(x, z + step);
          if ((pRight === pidA || pRight === pidB) && pRight !== pHere) riftPts.push({ x: x + step / 2, z });
          if ((pDown === pidA || pDown === pidB) && pDown !== pHere) riftPts.push({ x, z: z + step / 2 });
        }
      }

      const riftOceanPts = riftPts.filter(pt => isOcean(pt.x, pt.z));
      const riftCount = Math.min(riftOceanPts.length, 1 + Math.floor(fragRng() * 2 * frag));
      for (let ri = 0; ri < riftCount; ri++) {
        const pt = riftOceanPts[Math.floor(fragRng() * riftOceanPts.length)];
        const islandR = (1.5 + fragRng() * 3) * sizeScale * frag;
        const scatter = r * 0.3;
        stampIsland(pt.x + (fragRng() - 0.5) * scatter, pt.z + (fragRng() - 0.5) * scatter, Math.PI * islandR * islandR);
      }
    }

    // ===== 5. Equatorial scatter =====
    const equatorBand = mapH * 0.35;
    const archCount = Math.round(frag * frag * 5);
    for (let a = 0; a < archCount; a++) {
      const ax = fragRng() * mapW;
      const az = (mapH / 2) + (fragRng() - 0.5) * 2 * equatorBand;
      if (!isOcean(ax, az)) continue;
      const count = 2 + Math.floor(fragRng() * 4 * frag);
      const spread = r * (0.15 + fragRng() * 0.3);
      for (let i = 0; i < count; i++) {
        const angle = fragRng() * Math.PI * 2;
        const dist = fragRng() * spread;
        const ix = ax + Math.cos(angle) * dist;
        const iz = az + Math.sin(angle) * dist;
        const islandR = (0.8 + fragRng() * 2.5) * sizeScale * frag;
        stampIsland(ix, iz, Math.PI * islandR * islandR);
      }
    }
  };

})(window.VIS);
