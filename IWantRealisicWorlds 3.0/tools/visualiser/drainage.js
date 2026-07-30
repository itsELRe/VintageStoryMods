// drainage.js — Drainage direction graph (primitive)
//
// The downhill web on the data points: for each LAND anchor, a connection to
// EVERY strictly-lower neighbour (multi-downhill — every point a river could
// descend to, not just the steepest). A pure reader of the per-anchor height
// field: it consumes `upheaval.anchorHeight` + `anchorIsLand` over the mesh
// adjacency and computes once, at world init. Nothing writes back into it.
//
// Ocean anchors are never a SOURCE (we don't emit connections out of them);
// coastal land→ocean links ARE kept (an ocean anchor's height 0 is lower), so
// the web visibly drains to the coast. "Lower" is strictly lower — equal bytes
// make no connection, and a point with no lower neighbour is a pit (parked;
// the water-fill / lake step comes later).
//
// Connections are stored as three parallel flat arrays (compact, port-friendly):
//   from[i] -> to[i], with drop[i] = anchorHeight[from] - anchorHeight[to].
// Current consumer: the Drainage Graph debug marker (renderer._drawDrainage).
// Later consumers (the rivers/valleys rework) read the same web — accumulation,
// channel extraction, etc. build on top of these connections.

window.VIS = window.VIS || {};

(function (V) {

  class DrainageGraph {
    constructor(mesh, upheaval) {
      this.mesh = mesh;
      this.from = [];   // source anchor index (always land)
      this.to = [];     // downstream anchor index (lower; may be ocean)
      this.drop = [];   // byte height difference from → to (> 0)
      this._build(mesh, upheaval);
      console.log(`[drainage] ${this.from.length} downhill connections over ${mesh ? mesh.numAnchors : 0} anchors`);
    }

    _build(mesh, upheaval) {
      if (!mesh || !upheaval || !upheaval.anchorHeight || !upheaval.anchorIsLand) return;
      const h = upheaval.anchorHeight;
      const isLand = upheaval.anchorIsLand;
      const n = mesh.numAnchors;
      for (let t = 0; t < n; t++) {
        if (isLand[t] !== 1) continue;   // ocean is never a source
        const ht = h[t];
        const nbrs = mesh.neighborsOfAnchor(t);
        for (let k = 0; k < nbrs.length; k++) {
          const m = nbrs[k];
          const hm = h[m];
          if (hm >= ht) continue;        // strictly lower only (high → low)
          this.from.push(t);
          this.to.push(m);
          this.drop.push(ht - hm);
        }
      }
    }

    get connectionCount() { return this.from.length; }
  }

  V.DrainageGraph = DrainageGraph;

})(window.VIS);
