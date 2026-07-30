// math.js — seed parity, hashing, noise, PRNG
// Everything attaches to window.VIS so other modules can read it.

window.VIS = window.VIS || {};

(function (V) {

  // ===== VS seed parity =====
  // dotNetStringHash MUST match GameMath.DotNetStringHash bit-for-bit. This is
  // the only piece of v1 we carry over verbatim — any divergence here means
  // every seeded world drifts away from VS.
  function dotNetStringHash(text) {
    const codes = [];
    for (let i = 0; i < text.length; i++) codes.push(text.charCodeAt(i));
    const ints = [];
    for (let i = 0; i < codes.length; i += 2) {
      const lo = codes[i];
      const hi = (i + 1 < codes.length) ? codes[i + 1] : 0;
      ints.push((lo | (hi << 16)) | 0);
    }
    let hash1 = ((5381 << 16) + 5381) | 0;
    let hash2 = hash1;
    let idx = 0, len = text.length;
    // NOTE: >> (arithmetic / sign-preserving), NOT >>>. VS's GameMath.DotNetStringHash
    // (and .NET's legacy string hash it mirrors) shift a *signed* int, so once hashN
    // goes negative the top bits must sign-extend. Using >>> here zero-fills and the
    // hash drifts from the game for any word seed. Game is the fixed truth; match it.
    while (len > 2) {
      hash1 = (((hash1 << 5) + hash1 + (hash1 >> 27)) ^ ints[idx]) | 0;
      hash2 = (((hash2 << 5) + hash2 + (hash2 >> 27)) ^ ints[idx + 1]) | 0;
      idx += 2; len -= 4;
    }
    if (len > 0) hash1 = (((hash1 << 5) + hash1 + (hash1 >> 27)) ^ ints[idx]) | 0;
    return (hash1 + Math.imul(hash2, 1566083941)) | 0;
  }

  function seedStringToInt(seedStr) {
    if (!seedStr || seedStr.length === 0) return Math.floor(Math.random() * 2147483647);
    const parsed = parseInt(seedStr, 10);
    if (!isNaN(parsed) && parsed.toString() === seedStr && parsed >= -2147483648 && parsed <= 2147483647) return parsed;
    return dotNetStringHash(seedStr);
  }

  // ===== Mulberry32 PRNG: seed -> () -> [0, 1) =====
  function makePRNG(seed) {
    let s = ((seed ^ 0) >>> 0) || 1;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ===== Integer-coordinate hash: hash2d(x, y, seed) -> [0, 1) =====
  function hash2d(x, y, seed) {
    let h = seed | 0;
    h = ((h ^ (x * 374761393)) + (y * 668265263) + 1274126177) | 0;
    h = Math.imul(h ^ (h >>> 13), 1103515245);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // ===== 2D Simplex noise: seed -> (x, y) -> [-1, 1] =====
  const SimplexNoise = (() => {
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const G2 = (3 - Math.sqrt(3)) / 6;
    const grad = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];

    function create(seed) {
      const perm = new Uint8Array(512), p = new Uint8Array(256);
      for (let i = 0; i < 256; i++) p[i] = i;
      let s = seed | 0;
      for (let i = 255; i > 0; i--) {
        s = (s * 1664525 + 1013904223) | 0;
        const j = ((s >>> 0) % (i + 1));
        [p[i], p[j]] = [p[j], p[i]];
      }
      for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

      return function (x, y) {
        const sk = (x + y) * F2;
        const i = Math.floor(x + sk), j = Math.floor(y + sk);
        const t = (i + j) * G2;
        const x0 = x - (i - t), y0 = y - (j - t);
        const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
        const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
        const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
        const ii = i & 255, jj = j & 255;
        let n0 = 0, n1 = 0, n2 = 0;
        let t0 = 0.5 - x0 * x0 - y0 * y0;
        if (t0 > 0) { t0 *= t0; const g = grad[perm[ii + perm[jj]] & 7]; n0 = t0 * t0 * (g[0] * x0 + g[1] * y0); }
        let t1 = 0.5 - x1 * x1 - y1 * y1;
        if (t1 > 0) { t1 *= t1; const g = grad[perm[ii + i1 + perm[jj + j1]] & 7]; n1 = t1 * t1 * (g[0] * x1 + g[1] * y1); }
        let t2 = 0.5 - x2 * x2 - y2 * y2;
        if (t2 > 0) { t2 *= t2; const g = grad[perm[ii + 1 + perm[jj + 1]] & 7]; n2 = t2 * t2 * (g[0] * x2 + g[1] * y2); }
        return 70 * (n0 + n1 + n2);
      };
    }
    return { create };
  })();

  // ===== Fractal Brownian motion (multi-octave simplex) =====
  function createFBM(seed, baseFreq, octaves, persistence) {
    const layers = [];
    let amp = 1, freq = baseFreq;
    for (let i = 0; i < octaves; i++) {
      layers.push({ fn: SimplexNoise.create(seed + i * 31337), freq, amp });
      freq *= 2; amp *= persistence;
    }
    let totAmp = 0;
    for (const l of layers) totAmp += l.amp;
    return (x, y) => {
      let v = 0;
      for (const l of layers) v += l.fn(x * l.freq, y * l.freq) * l.amp;
      return v / totAmp;
    };
  }

  // ===== Golden ratio scaling =====
  // Feature sizes (plate radius, band widths, etc.) grow by PHI per linear
  // doubling from the 512² base. phiScale(W) = PHI^log2(W/base).
  const PHI = 1.618033988749895;
  function phiScale(size, base) {
    return Math.pow(PHI, Math.log2(size / (base || 512)));
  }

  // ===== Boundary interaction sign (spec §3.1) =====
  // Classify the boundary between two moving plates/seeds by the sign of their
  // closing rate: the facing normal points A→B, relVel = vA − vB, and
  // closing = relVel·normal (+ = converging). |cos(relVel, normal)| below
  // transformEps means motion is mostly parallel to the line ⇒ transform
  // (glancing). Vector-only (no land/ocean), so it can run at plate-build time.
  // Same sign convention as TectonicLines.computeCollisionIntensity, so a
  // boundary's pairType and its intensity always agree on mountain-vs-rift.
  function classifyClosing(vA, vB, ax, az, bx, bz, transformEps) {
    let nx = bx - ax, nz = bz - az;
    const nlen = Math.hypot(nx, nz);
    if (nlen < 1e-9) return 'convergent';
    nx /= nlen; nz /= nlen;
    const rvx = vA[0] - vB[0], rvz = vA[1] - vB[1];
    const rlen = Math.hypot(rvx, rvz);
    if (rlen < 1e-9) return 'transform';
    const cos = (rvx * nx + rvz * nz) / rlen;
    if (cos >  transformEps) return 'convergent';
    if (cos < -transformEps) return 'divergent';
    return 'transform';
  }

  // FNV-1a 32-bit checksum over an integer array (byte / int16 values).
  // Integer-only so it ports to C# identically — used by the porting-mirror
  // logs to confirm a subsystem's output matches between the visualiser and the
  // game for the same seed (same checksum = the port is bit-faithful).
  function checksum(arr) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < arr.length; i++) {
      h = (h ^ arr[i]) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  V.dotNetStringHash = dotNetStringHash;
  V.seedStringToInt = seedStringToInt;
  V.makePRNG = makePRNG;
  V.hash2d = hash2d;
  V.SimplexNoise = SimplexNoise;
  V.createFBM = createFBM;
  V.PHI = PHI;
  V.phiScale = phiScale;
  V.classifyClosing = classifyClosing;
  V.checksum = checksum;

})(window.VIS);
