using System;
using Vintagestory.API.MathTools;

namespace IWantRealisticWorlds.Worldgen
{
    // Port of tools/visualiser/math.js — seed parity, hashing, noise, PRNG.
    // Every value here MUST be bit-identical to the JS visualiser for the same
    // seed: parity is obligatory, and any drift here cascades into a different
    // world. Verification rubric: the old project's docs/port_parity_spec.md.
    //
    // NOT ported (deliberate, documented):
    //  - seedStringToInt: the mod receives an already-resolved int seed from VS
    //    (World.Seed); it never converts a typed seed string. The JS version's
    //    empty-seed branch uses Math.random (non-deterministic — must never enter
    //    worldgen). Whether VS's own string→seed resolution matches the
    //    visualiser's dotNetStringHash is a verify-in-game item, not a port item.
    //  - boxBlurFloat32 / boxBlurUint8: these live in wind.js in v3, not math.js.
    //    They port with the wind system, to keep C# file structure mirroring v3.
    public static class WorldgenMath
    {
        // ===== Golden ratio scaling =====
        // Feature sizes (plate radius, band widths, …) grow by PHI per linear
        // doubling from the 512² base: phiScale(W) = PHI^log2(W/base).
        public const double PHI = 1.618033988749895;

        public static double PhiScale(double size, double baseSize = 512.0)
        {
            if (baseSize == 0) baseSize = 512.0;          // JS `base || 512`
            return Math.Pow(PHI, Math.Log2(size / baseSize)); // Log2, NOT Log(x,2) — last-ULP drift
        }

        // ===== JS Math.round =====
        // Rounds half toward +Infinity (NOT away-from-zero, NOT banker's): so
        // round(-2.5) = -2, round(2.5) = 3. C#'s Math.Round defaults to banker's
        // and MidpointRounding.AwayFromZero disagrees on negative halves, which
        // matters wherever the rounded value can be negative (e.g. lattice coords
        // at the negative margins). Floor(v + 0.5) reproduces JS exactly.
        public static double Round(double v) => Math.Floor(v + 0.5);

        // ===== Signed component byte encoding (wind / currents) =====
        // Vector components stored as SIGNED 0–255 bytes: 128 = 0, ±max at the ends.
        // JS: max(0, min(255, round(v/max*127) + 128)).
        public static byte EncodeSignedByte(double v, double max)
        {
            int r = (int)Round(v / max * 127) + 128;
            return (byte)(r < 0 ? 0 : (r > 255 ? 255 : r));
        }

        public static double DecodeSignedByte(int b, double max) => (b - 128) / 127.0 * max;

        // ===== VS seed parity =====
        // JS math.js reimplements .NET's legacy string hash by hand (with the
        // sign-preserving >> shift) specifically to match GameMath.DotNetStringHash
        // bit-for-bit. In C# we simply ARE that hash — delegate, never reimplement.
        public static int DotNetStringHash(string text) => GameMath.DotNetStringHash(text);

        // ===== Integer-coordinate hash: hash2d(x, y, seed) -> [0, 1) =====
        // JS source (math.js):
        //   let h = seed | 0;
        //   h = ((h ^ (x * 374761393)) + (y * 668265263) + 1274126177) | 0;
        //   h = Math.imul(h ^ (h >>> 13), 1103515245);
        //   return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
        // Trap #4 (int-vs-float): JS does the products in float64 then reduces
        // mod 2^32 once; C# wraps each op in int32. They agree because +/× are
        // ring homomorphisms mod 2^32 AND every intermediate stays < 2^53 for any
        // realistic coordinate (|y*668265263| < 2^53 up to |y| ≈ 1.3e7).
        public static double Hash2D(int x, int y, long seed)
        {
            int h = (int)seed;
            h = ((h ^ (x * 374761393)) + (y * 668265263) + 1274126177);
            h = (int)((uint)(h ^ (int)((uint)h >> 13)) * 1103515245u);
            return ((uint)(h ^ (int)((uint)h >> 16))) / 4294967296.0;
        }

        // ===== JS `x | 0` / ToInt32 on a non-integer double (porting helper) =====
        // Truncate toward zero, reduce mod 2^32, reinterpret as signed int32.
        // A bare (int) cast SATURATES doubles ≥ 2^31 to int.MinValue (cvttsd2si),
        // silently diverging from JS. Use wherever JS does `| 0` on a non-integer
        // double. Not a math.js export; shared porting infrastructure.
        public static int ToInt32(double x)
        {
            if (double.IsNaN(x) || double.IsInfinity(x)) return 0;
            double t = Math.Truncate(x) % 4294967296.0;
            if (t < 0) t += 4294967296.0;
            return unchecked((int)(uint)t);
        }

        // ===== Boundary interaction sign (spec §3.1) — new in v3 =====
        // Classify the boundary between two moving plates/seeds by the sign of
        // their closing rate. Facing normal points A→B; relVel = vA − vB;
        // closing = cos(relVel, normal): + converging, − diverging, |·| below
        // transformEps ⇒ mostly parallel ⇒ transform (glancing). Vector-only, so
        // it runs at plate-build time. Same convention as
        // TectonicLines.ComputeCollisionIntensity, so pairType and intensity
        // always agree on mountain-vs-rift.
        public enum ClosingType { Convergent, Divergent, Transform }

        public static ClosingType ClassifyClosing(
            double vAx, double vAz, double vBx, double vBz,
            double ax, double az, double bx, double bz, double transformEps)
        {
            double nx = bx - ax, nz = bz - az;
            double nlen = Hypot(nx, nz);
            if (nlen < 1e-9) return ClosingType.Convergent;
            nx /= nlen; nz /= nlen;
            double rvx = vAx - vBx, rvz = vAz - vBz;
            double rlen = Hypot(rvx, rvz);
            if (rlen < 1e-9) return ClosingType.Transform;
            double cos = (rvx * nx + rvz * nz) / rlen;
            if (cos > transformEps) return ClosingType.Convergent;
            if (cos < -transformEps) return ClosingType.Divergent;
            return ClosingType.Transform;
        }

        // ===== FNV-1a 32-bit checksum over an integer array — new in v3 =====
        // Integer-only, so JS and C# produce the identical checksum for identical
        // data. THIS is the concrete parity probe: same seed ⇒ a subsystem's
        // output array must checksum the same in the visualiser and the mod.
        // JS: h = 2166136261>>>0; per elem: h=(h^arr[i])>>>0; h=imul(h,16777619)>>>0.
        public static uint Checksum(ReadOnlySpan<int> arr)
        {
            uint h = 2166136261u;
            for (int i = 0; i < arr.Length; i++)
            {
                h = h ^ (uint)arr[i];
                h = unchecked(h * 16777619u);
            }
            return h;
        }

        public static uint Checksum(ReadOnlySpan<byte> arr)
        {
            uint h = 2166136261u;
            for (int i = 0; i < arr.Length; i++)
            {
                h = h ^ arr[i];
                h = unchecked(h * 16777619u);
            }
            return h;
        }

        // JS Math.hypot(a, b). .NET has no Math.Hypot; for the magnitudes here
        // (normalized directions, bounded velocities) sqrt(a²+b²) matches to
        // within double precision. RISK only if a value sits within 1 ULP of
        // ±transformEps — not reachable in practice.
        private static double Hypot(double a, double b) => Math.Sqrt(a * a + b * b);

        // ===== Mulberry32 PRNG: seed -> Next() in [0, 1) =====
        // JS makePRNG(seed) returns a closure; the C# equivalent holds the state.
        public sealed class Mulberry32
        {
            private uint state;

            public Mulberry32(long seed)
            {
                // JS: let s = ((seed ^ 0) >>> 0) || 1;
                uint s = (uint)((int)seed);
                if (s == 0) s = 1;
                state = s;
            }

            public double Next()
            {
                // JS: s = (s + 0x6D2B79F5) >>> 0;
                state = unchecked(state + 0x6D2B79F5u);
                // let t = Math.imul(s ^ (s >>> 15), 1 | s);
                uint t = unchecked((state ^ (state >> 15)) * (1u | state));
                // t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                t = unchecked(t + (t ^ (t >> 7)) * (61u | t)) ^ t;
                // return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
                return (t ^ (t >> 14)) / 4294967296.0;
            }
        }

        public static Mulberry32 MakePRNG(long seed) => new Mulberry32(seed);
    }

    // ===== 2D Simplex noise — port of SimplexNoise.create in math.js =====
    // seed -> (x, y) -> [-1, 1]. Permutation table from the same LCG
    // (1664525 / 1013904223), same gradient table, same 70× output scaling.
    public sealed class SimplexNoise2D
    {
        private static readonly double F2 = 0.5 * (Math.Sqrt(3) - 1);
        private static readonly double G2 = (3 - Math.Sqrt(3)) / 6;
        private static readonly int[][] grad = {
            new[]{ 1, 1}, new[]{-1, 1}, new[]{ 1,-1}, new[]{-1,-1},
            new[]{ 1, 0}, new[]{-1, 0}, new[]{ 0, 1}, new[]{ 0,-1}
        };

        private readonly byte[] perm;

        public SimplexNoise2D(int seed)
        {
            perm = new byte[512];
            byte[] p = new byte[256];
            for (int i = 0; i < 256; i++) p[i] = (byte)i;

            // JS: let s = seed | 0;
            //     for (let i = 255; i > 0; i--) {
            //       s = (s * 1664525 + 1013904223) | 0;
            //       const j = ((s >>> 0) % (i + 1));
            //       [p[i], p[j]] = [p[j], p[i]];
            //     }
            int s = seed;
            for (int i = 255; i > 0; i--)
            {
                s = unchecked(s * 1664525 + 1013904223);
                int j = (int)(((uint)s) % (uint)(i + 1));
                byte tmp = p[i]; p[i] = p[j]; p[j] = tmp;
            }
            for (int i = 0; i < 512; i++) perm[i] = p[i & 255];
        }

        public double Noise(double x, double y)
        {
            double sk = (x + y) * F2;
            int i = (int)Math.Floor(x + sk);
            int j = (int)Math.Floor(y + sk);
            double t = (i + j) * G2;
            double x0 = x - (i - t), y0 = y - (j - t);
            int i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
            double x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
            double x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
            int ii = i & 255, jj = j & 255;

            double n0 = 0, n1 = 0, n2 = 0;
            double t0 = 0.5 - x0 * x0 - y0 * y0;
            if (t0 > 0) { t0 *= t0; var g = grad[perm[ii + perm[jj]] & 7]; n0 = t0 * t0 * (g[0] * x0 + g[1] * y0); }
            double t1 = 0.5 - x1 * x1 - y1 * y1;
            if (t1 > 0) { t1 *= t1; var g = grad[perm[ii + i1 + perm[jj + j1]] & 7]; n1 = t1 * t1 * (g[0] * x1 + g[1] * y1); }
            double t2 = 0.5 - x2 * x2 - y2 * y2;
            if (t2 > 0) { t2 *= t2; var g = grad[perm[ii + 1 + perm[jj + 1]] & 7]; n2 = t2 * t2 * (g[0] * x2 + g[1] * y2); }
            return 70 * (n0 + n1 + n2);
        }
    }

    // ===== Fractal Brownian motion (multi-octave simplex) — port of createFBM =====
    // Each octave offset by i × 31337 to de-correlate; output normalized by the
    // total amplitude so it fits roughly in [-1, +1]. Octaves summed in order.
    public sealed class FbmNoise
    {
        private readonly SimplexNoise2D[] layers;
        private readonly double[] freqs;
        private readonly double[] amps;
        private readonly double totalAmp;

        public FbmNoise(int seed, double baseFreq, int octaves, double persistence)
        {
            layers = new SimplexNoise2D[octaves];
            freqs = new double[octaves];
            amps = new double[octaves];
            double amp = 1, freq = baseFreq;
            double totAmp = 0;
            for (int i = 0; i < octaves; i++)
            {
                layers[i] = new SimplexNoise2D(seed + i * 31337);
                freqs[i] = freq;
                amps[i] = amp;
                totAmp += amp;
                freq *= 2;
                amp *= persistence;
            }
            totalAmp = totAmp;
        }

        public double Sample(double x, double y)
        {
            double v = 0;
            for (int i = 0; i < layers.Length; i++)
                v += layers[i].Noise(x * freqs[i], y * freqs[i]) * amps[i];
            return v / totalAmp;
        }
    }
}
