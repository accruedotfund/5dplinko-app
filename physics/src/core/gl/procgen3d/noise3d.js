// core/gl/procgen3d/noise3d.js — 3D noise for the procgen3d layer.
//
// core/procgen.js already has simplex2D / valueNoise2D / fbm / worley2D /
// domainWarp (all 2D). This adds the 3D piece the spec needs (caves, 3D domain
// warp, volumetric masks) and bundles seeded helpers behind one factory:
//
//   const n = makeNoise(12345);
//   n.sample2D(x, z)              // fBM simplex, ~[-1,1]   (terrain height)
//   n.sample3D(x, y, z)          // fBM simplex 3D         (caves / density)
//   n.ridged2D(x, z)             // ridged (mountains/cliffs)
//   n.warped2D(x, z, amount)     // domain-warped (rivers, alien terrain)
//   n.cell2D(x, z)               // worley F1 (rock clusters, biome regions)
//   n.raw3D(x, y, z)             // single-octave simplex 3D in [-1,1]
//
// All deterministic from the seed; octaves/lacunarity/gain are per-call opts.

import { rng, simplex2D, valueNoise2D, fbm, worley2D, domainWarp } from '../../procgen.js';

// ── classic 3D simplex (Gustavson), permutation seeded from the rng ───────────
const GRAD3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];
function buildSimplex3D(r) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t; }
  const perm = new Uint8Array(512), permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; permMod12[i] = perm[i] % 12; }
  const F3 = 1 / 3, G3 = 1 / 6;
  return function (x, y, z) {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0;
    const corner = (cx, cy, cz, gi) => {
      let tt = 0.6 - cx * cx - cy * cy - cz * cz;
      if (tt < 0) return 0;
      const g = GRAD3[gi]; tt *= tt;
      return tt * tt * (g[0] * cx + g[1] * cy + g[2] * cz);
    };
    n += corner(x0, y0, z0, permMod12[ii + perm[jj + perm[kk]]]);
    n += corner(x1, y1, z1, permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]]);
    n += corner(x2, y2, z2, permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]]);
    n += corner(x3, y3, z3, permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]]);
    return 32 * n; // ~[-1,1]
  };
}

// fBM wrapper for a 3-arg noise (sibling of procgen.fbm which is 2-arg).
function fbm3(noise, opts = {}) {
  const oct = opts.octaves ?? 4, lac = opts.lacunarity ?? 2, gain = opts.gain ?? 0.5;
  const freq = opts.frequency ?? 1;
  return (x, y, z) => {
    let f = freq, a = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) { sum += a * noise(x * f, y * f, z * f); norm += a; a *= gain; f *= lac; }
    return sum / (norm || 1);
  };
}

export function makeNoise(seed = 1) {
  const s2 = simplex2D(rng(seed));
  const v2 = valueNoise2D(rng(seed + 7));
  const s3 = buildSimplex3D(rng(seed + 13));
  const warpN = simplex2D(rng(seed + 101));
  const cell = worley2D({ rng: rng(seed + 211), cellSize: 1 });
  const fbm2 = fbm(s2, { octaves: 4, lacunarity: 2, gain: 0.5 });
  const fbm3d = fbm3(s3, { octaves: 4, lacunarity: 2, gain: 0.5 });
  return {
    raw2D: s2, raw3D: s3, value2D: v2,
    sample2D: (x, z, o) => (o ? fbm(s2, o)(x, z) : fbm2(x, z)),
    sample3D: (x, y, z, o) => (o ? fbm3(s3, o)(x, y, z) : fbm3d(x, y, z)),
    ridged2D: (x, z, o) => { const f = fbm(s2, o || { octaves: 4 }); return 1 - Math.abs(f(x, z)); },
    warped2D: (x, z, amount = 0.5) => {
      const wx = x + amount * warpN(x * 0.5 + 1.3, z * 0.5);
      const wz = z + amount * warpN(x * 0.5, z * 0.5 + 5.7);
      return fbm2(wx, wz);
    },
    cell2D: (x, z) => cell(x, z),
    domainWarp,
  };
}
