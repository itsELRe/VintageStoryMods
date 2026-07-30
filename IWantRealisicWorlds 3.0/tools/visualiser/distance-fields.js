// distance-fields.js — DistanceFields (per-anchor distance data)
//
// Spec §5, construction stage 3: distance-like data, computed once at
// worldinit over the anchor graph (mesh.js), stored per anchor. Never
// searched at chunk time — chunk-time reads go through sampleFields.
//
// distToOcean: multi-source weighted Dijkstra over the lattice point
// adjacency (mesh.neighborsOfAnchor), edge cost = real Euclidean distance
// between adjacent points, COASTAL points as sources — distance 0 is now
// EXACT, since coastal points sit on the coast polyline by construction.
// Weighted (not hop-count) keeps the output in the same units
// (pixels/blocks) as before the lattice rework, so downstream consumers'
// existing tuned constants stay valid.
//
// distToTectonicLine (kind-split) is a separate, larger piece — see
// tasks/todo.md item 2b/2c — not built here yet.

window.VIS = window.VIS || {};

(function (V) {

  class DistanceFields {
    constructor(mesh, continent) {
      this.mesh = mesh;
      this.continent = continent;

      this._computeDistToOcean();
    }

    // Sources are the COASTAL points (continent.pointClass) — exactly on the
    // coast polyline, distance 0. Dijkstra with a binary min-heap (lazy
    // deletion: stale heap entries are skipped via the `d > dist[t]` check
    // rather than supporting decrease-key directly) — O((V+E) log V), safe up
    // to the largest configured map sizes (tens of thousands of points).
    _computeDistToOcean() {
      const mesh = this.mesh;
      const pointClass = this.continent.pointClass;
      const n = mesh.numAnchors;
      const ax = mesh.a_x, az = mesh.a_z;

      const dist = new Float64Array(n).fill(Infinity);
      const visited = new Uint8Array(n);

      // Binary min-heap of (distance, anchor id), as two parallel arrays.
      const heapDist = [], heapNode = [];
      const heapPush = (d, node) => {
        let i = heapDist.length;
        heapDist.push(d); heapNode.push(node);
        while (i > 0) {
          const parent = (i - 1) >> 1;
          if (heapDist[parent] <= heapDist[i]) break;
          [heapDist[parent], heapDist[i]] = [heapDist[i], heapDist[parent]];
          [heapNode[parent], heapNode[i]] = [heapNode[i], heapNode[parent]];
          i = parent;
        }
      };
      const heapPop = () => {
        const topD = heapDist[0], topNode = heapNode[0];
        const lastD = heapDist.pop(), lastNode = heapNode.pop();
        if (heapDist.length > 0) {
          heapDist[0] = lastD; heapNode[0] = lastNode;
          let i = 0;
          const len = heapDist.length;
          while (true) {
            let smallest = i;
            const l = 2 * i + 1, r = 2 * i + 2;
            if (l < len && heapDist[l] < heapDist[smallest]) smallest = l;
            if (r < len && heapDist[r] < heapDist[smallest]) smallest = r;
            if (smallest === i) break;
            [heapDist[smallest], heapDist[i]] = [heapDist[i], heapDist[smallest]];
            [heapNode[smallest], heapNode[i]] = [heapNode[i], heapNode[smallest]];
            i = smallest;
          }
        }
        return { d: topD, node: topNode };
      };

      for (let t = 0; t < n; t++) {
        if (pointClass[t] === V.POINT_COASTAL) {
          dist[t] = 0;
          heapPush(0, t);
        }
      }

      while (heapDist.length > 0) {
        const { d, node: t } = heapPop();
        if (visited[t]) continue;
        visited[t] = 1;
        if (d > dist[t]) continue; // stale entry from before a better path was found
        const neighbors = mesh.neighborsOfAnchor(t);
        for (let i = 0; i < neighbors.length; i++) {
          const t2 = neighbors[i];
          if (visited[t2]) continue;
          const dx = ax[t] - ax[t2], dz = az[t] - az[t2];
          const nd = d + Math.sqrt(dx * dx + dz * dz);
          if (nd < dist[t2]) {
            dist[t2] = nd;
            heapPush(nd, t2);
          }
        }
      }

      this.distToOcean = dist;

      let coastCount = 0, maxDist = 0, sum = 0, finiteCount = 0;
      for (let t = 0; t < n; t++) {
        if (dist[t] === 0) coastCount++;
        if (dist[t] !== Infinity) {
          finiteCount++;
          sum += dist[t];
          if (dist[t] > maxDist) maxDist = dist[t];
        }
      }
      const mean = finiteCount > 0 ? (sum / finiteCount).toFixed(2) : 'n/a';
      console.log(`[distance-fields] distToOcean: coastAnchors=${coastCount}  maxDist=${maxDist.toFixed(2)}px  meanDist=${mean}px`);
      if (finiteCount < n) {
        console.warn(`[distance-fields] ${n - finiteCount} anchors never reached by Dijkstra (disconnected from any coast anchor?)`);
      }
    }

    // Point-graph distance to the nearest coast, in pixels/blocks (shortest
    // path along lattice edges — a few percent longer than true straight-line
    // distance, since the path must follow mesh edges).
    distToOceanAt(anchorId) {
      return this.distToOcean[anchorId];
    }

    // Distance to nearest coast at an arbitrary (x, z) — reads the nearest
    // lattice point's distToOcean (O(1) lattice arithmetic).
    getDistToOceanAt(x, z) {
      return this.distToOcean[this.mesh.nearestAnchor(x, z)];
    }
  }

  V.DistanceFields = DistanceFields;
})(window.VIS);
