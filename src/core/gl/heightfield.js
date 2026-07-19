// core/gl/heightfield.js — SHARED value-noise fbm height field. A reusable primitive
// (NOT baked into any one component) so any gl pass gets MATCHING rolling terrain across
// three places that must agree or props float/sink:
//   • the VISUAL  — include HGT_GLSL in a vertex/fragment shader, call hgt(worldXZ)
//   • COLLISION   — buildCollisionMesh(spec, heightFn(spec)) → a BVH-able grid
//   • PROPS/query — heightFn(spec)(x, z) to place things ON the surface
//
// Shader contract: a pass using HGT_GLSL must declare `uniform float u_hills, u_hillScale;`
// (hgt() returns the height already scaled by u_hills; add your own u_level outside).
// The JS `heightFn` is an EXACT mirror of HGT_GLSL — keep them in lockstep if edited.
//
//   spec fields: { hills: amplitude, hillScale: frequency, level: base Y }

export const HGT_GLSL = `
float h21(vec2 p){ p=fract(p*vec2(123.34,345.45)); p+=dot(p,p+34.345); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
float hgt(vec2 w){
  vec2 p = w * u_hillScale;
  float h = vnoise(p) * 0.6 + vnoise(p * 2.3 + 5.2) * 0.28 + vnoise(p * 4.7 + 11.1) * 0.12;
  return (h - 0.5) * 2.0 * u_hills;
}`;

// ── JS mirror of HGT_GLSL ────────────────────────────────────────────────────
const _fr = (v) => v - Math.floor(v);
function _h21(x, y) { let px = _fr(x * 123.34), py = _fr(y * 345.45); const dt = px * (px + 34.345) + py * (py + 34.345); px += dt; py += dt; return _fr(px * py); }
function _vn(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y); let fx = x - ix, fy = y - iy; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = _h21(ix, iy), b = _h21(ix + 1, iy), c = _h21(ix, iy + 1), d = _h21(ix + 1, iy + 1);
  const ab = a + (b - a) * fx, cd = c + (d - c) * fx; return ab + (cd - ab) * fy;
}

// height(x, z) sampler for a spec — for collision + prop placement
export function heightFn(spec = {}) {
  const hills = spec.hills ?? 1.8, scale = spec.hillScale ?? 0.025, level = spec.level ?? 0;
  return (x, z) => {
    const px = x * scale, pz = z * scale;
    const h = _vn(px, pz) * 0.6 + _vn(px * 2.3 + 5.2, pz * 2.3 + 5.2) * 0.28 + _vn(px * 4.7 + 11.1, pz * 4.7 + 11.1) * 0.12;
    return level + (h - 0.5) * 2 * hills;
  };
}

// ── PNG / grayscale IMAGE heightmap ──────────────────────────────────────────
// An alternative to the procedural noise field: drive height from a decoded image
// (white = high, black = low). Returns a sampler with the SAME (x,z)=>y signature
// as heightFn, so it drops straight into buildCollisionMesh (collision), prop
// placement, AND a CPU-baked visual mesh — the three must agree (see the L1267
// landmine: never bake the visual on the GPU while colliding on the CPU).
//
//   const hm = await loadHeightmap('assets/terrain/valley.png');
//   const h  = imageHeightFn(hm, { area:[-64,-64,64,64], hills: 12, level: 0 });
//   const mesh = buildCollisionMesh({ area:[-64,-64,64,64] }, h, 96); // BVH-able
//
// Decode an image URL to raw RGBA pixels. Needs same-origin / CORS for getImageData.
export function loadHeightmap(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const { data } = g.getImageData(0, 0, c.width, c.height);
      resolve({ data, width: c.width, height: c.height });
    };
    img.onerror = () => reject(new Error(`heightmap load failed: ${url}`));
    img.src = url;
  });
}

// (x,z)=>y sampler over a decoded heightmap `hm` ({data,width,height}). Bilinear,
// edge-clamped. spec: { area:[x0,z0,x1,z1] (world rect the image spans), hills
// (amplitude, luminance 0..1 → 0..hills), level (base Y), channel (0=R default,
// grayscale so any), signed (true → center to (h-0.5)*2*hills like the noise field) }.
export function imageHeightFn(hm, spec = {}) {
  const { data, width: W, height: H } = hm;
  const [x0, z0, x1, z1] = spec.area;
  const hills = spec.hills ?? 1.8, level = spec.level ?? 0;
  const ch = spec.channel ?? 0, signed = !!spec.signed;
  const dx = (x1 - x0) || 1, dz = (z1 - z0) || 1;
  const lum = (px, py) => data[(py * W + px) * 4 + ch] / 255;
  return (x, z) => {
    let u = (x - x0) / dx * (W - 1);
    let v = (z - z0) / dz * (H - 1);
    u = u < 0 ? 0 : u > W - 1 ? W - 1 : u;
    v = v < 0 ? 0 : v > H - 1 ? H - 1 : v;
    const ix = Math.floor(u), iy = Math.floor(v), fx = u - ix, fy = v - iy;
    const ix1 = ix + 1 < W ? ix + 1 : ix, iy1 = iy + 1 < H ? iy + 1 : iy;
    const a = lum(ix, iy), b = lum(ix1, iy), c = lum(ix, iy1), d = lum(ix1, iy1);
    const ab = a + (b - a) * fx, cd = c + (d - c) * fx;
    const h = ab + (cd - ab) * fy;                 // 0..1
    return level + (signed ? (h - 0.5) * 2 : h) * hills;
  };
}

// a coarse collidable grid mesh sampling the field over `area` → {positions, indices, world}
export function buildCollisionMesh(spec, heightAt, res = 48) {
  const [x0, z0, x1, z1] = spec.area, N = res;
  const positions = new Float32Array((N + 1) * (N + 1) * 3); let o = 0;
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const x = x0 + (x1 - x0) * (i / N), z = z0 + (z1 - z0) * (j / N);
    positions[o++] = x; positions[o++] = heightAt(x, z); positions[o++] = z;
  }
  const indices = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * (N + 1) + i, b = a + 1, c = a + (N + 1), d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { positions, indices: new Uint32Array(indices), world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
}
