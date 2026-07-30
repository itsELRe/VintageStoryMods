// geometry.js — polygon helpers
// Port of v1's geometry.js (subset). Used by ocean.js for fragmentation
// island stamping. Polygon operations: generation, scaling, displacement,
// point-in-polygon test.

window.VIS = window.VIS || {};

(function (V) {

  function polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) * 0.5;
  }

  function scalePoly(pts, targetArea) {
    const area = polyArea(pts);
    if (area < 1e-30) return pts;
    const s = Math.sqrt(targetArea / area);
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    return pts.map(([x, y]) => [cx + (x - cx) * s, cy + (y - cy) * s]);
  }

  function movePoly(pts, tx, ty) {
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    return pts.map(([x, y]) => [x - cx + tx, y - cy + ty]);
  }

  // Generate a base polygon with N points around a unit circle, with bays.
  function makeBasePoly(rng, N, elongation, angle) {
    const cosA = Math.cos(angle), sinA = Math.sin(angle);
    const numBays = 2 + (rng() * Math.max(0, Math.floor(N * 0.38) - 1) | 0);
    const baySet = new Set();
    while (baySet.size < numBays) baySet.add((rng() * N) | 0);
    const pts = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + (rng() - 0.5) * (Math.PI / N) * 0.65;
      const r = baySet.has(i) ? 0.12 + rng() * 0.26 : 0.60 + rng() * 0.40;
      const lx = r * elongation * Math.cos(a);
      const ly = r * Math.sin(a);
      const vx = lx * cosA - ly * sinA, vy = lx * sinA + ly * cosA;
      pts.push([Math.round(vx * 1e6) / 1e6, Math.round(vy * 1e6) / 1e6]);
    }
    const cx = pts.reduce((s, p) => s + p[0], 0) / N;
    const cy = pts.reduce((s, p) => s + p[1], 0) / N;
    pts.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    return pts;
  }

  // Recursively displace edge midpoints to add fractal coastline detail.
  // 6-decimal rounding per level keeps JS/C# numerics in lockstep.
  function displace(pts, rng, levels, k) {
    for (let lv = 0; lv < levels; lv++) {
      const n = pts.length, result = [];
      for (let i = 0; i < n; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % n];
        result.push([x1, y1]);
        const mx = (x1 + x2) * 0.5, my = (y1 + y2) * 0.5;
        const ex = x2 - x1, ey = y2 - y1;
        const len = Math.sqrt(ex * ex + ey * ey);
        if (len < 1e-10) { result.push([mx, my]); continue; }
        const nx = -ey / len, ny = ex / len;
        const d = (rng() - 0.5) * len * k;
        result.push([mx + nx * d, my + ny * d]);
      }
      pts = result.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);
    }
    return pts;
  }

  function makeLandmass(rng, targetArea, cx, cy, opts = {}) {
    const N = opts.N ?? 6 + (rng() * 3 | 0);
    const elongation = opts.elongation ?? (1.4 + rng() * 1.2);
    const angle = rng() * Math.PI;
    const levels = opts.levels ?? 6;
    const k = opts.k ?? (0.46 + rng() * 0.14);
    const base = makeBasePoly(rng, N, elongation, angle);
    const disp = displace(base, rng, levels, k);
    const sized = scalePoly(disp, targetArea);
    return {
      points: movePoly(sized, cx, cy),
      base: movePoly(scalePoly(base, targetArea), cx, cy),
    };
  }

  function pointInPoly(pts, px, py) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const yi = pts[i][1], yj = pts[j][1];
      if ((yi > py) !== (yj > py) && px < (pts[j][0] - pts[i][0]) * (py - yi) / (yj - yi) + pts[i][0]) inside = !inside;
    }
    return inside;
  }

  V.polyArea = polyArea;
  V.scalePoly = scalePoly;
  V.movePoly = movePoly;
  V.makeBasePoly = makeBasePoly;
  V.displace = displace;
  V.makeLandmass = makeLandmass;
  V.pointInPoly = pointInPoly;

})(window.VIS);
