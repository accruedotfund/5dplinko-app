// core/gl/procgen3d/gen-rock.js — procedural rock (FOUNDATION, minimal-real).
//
//   generate('rock', { seed, radius:1, detail:2, lumpiness:0.45, color })
//     detail     — subdivision level (0=8 tris … 3=512); higher = rounder base
//     lumpiness  — 0..1 noise displacement amount (pebble→boulder→cliff)
//     squash     — [sx,sy,sz] non-uniform scale for flatter/taller rocks
//     → SceneGraph (flat-ish faceted rock)
//
// REAL today: subdivided octahedron → spherify → 3D-noise displacement → smooth
// normals. TODO: cliff/stratified variants, erosion striations, LOD chain.

import { MeshBuilder } from './mesh-builder.js';
import { makeNoise } from './noise3d.js';
import { register } from './registry.js';
import { rng } from '../../procgen.js';

// subdivided octahedron unit sphere → {positions:[[x,y,z]…], tris:[[a,b,c]…]}
function icosphere(detail) {
  let verts = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let faces = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
  for (let d = 0; d < detail; d++) {
    const mid = new Map(), next = [];
    const midpoint = (a, b) => {
      const key = a < b ? a + '_' + b : b + '_' + a;
      if (mid.has(key)) return mid.get(key);
      const va = verts[a], vb = verts[b];
      let mx = va[0] + vb[0], my = va[1] + vb[1], mz = va[2] + vb[2];
      const l = Math.hypot(mx, my, mz) || 1; mx /= l; my /= l; mz /= l;
      const idx = verts.push([mx, my, mz]) - 1; mid.set(key, idx); return idx;
    };
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  return { verts, faces };
}

// per-style geometry knobs: squash (xyz), how angular, default lumpiness.
const ROCK_STYLES = {
  boulder: { squash: [1, 0.8, 1], angular: 0.35, lump: 0.6 },
  slab:    { squash: [1.3, 0.32, 1.1], angular: 0.3, lump: 0.45 },
  spire:   { squash: [0.7, 1.9, 0.7], angular: 0.4, lump: 0.6 },
};

export function generateRock(params = {}, ctx = {}) {
  const seed = ctx.seed ?? params.seed ?? 1;
  if ((params.style || params.formation) === 'basalt') return basaltColumns(params, seed);
  const r = params.radius ?? 1;
  const detail = Math.max(0, Math.min(4, params.detail ?? 3)); // 3 = 512 tris, enough to read craggy
  const st = ROCK_STYLES[params.style] || ROCK_STYLES.boulder;
  const n = makeNoise(seed);
  const pr = rng((seed * 2654435761) >>> 0); // per-ROCK random so each instance is distinct
  // per-rock proportions + a LARGE noise-domain offset so two seeds sample
  // different regions (the old seed*0.01 offset gave near-identical blobs).
  const lump = (params.lumpiness ?? st.lump) * (0.7 + pr() * 0.7);
  const baseSq = params.squash || st.squash;
  const sq = [baseSq[0] * (0.8 + pr() * 0.5), baseSq[1] * (0.75 + pr() * 0.6), baseSq[2] * (0.8 + pr() * 0.5)];
  const angular = params.angular ?? st.angular;
  const freq = 1.4 + pr() * 1.2;
  const ox = pr() * 200, oy = pr() * 200, oz = pr() * 200;
  const { verts, faces } = icosphere(detail);
  const mb = new MeshBuilder();
  let minY = Infinity;
  const placed = [];
  for (const v of verts) {
    // two octaves at different scales → big lumps + craggy detail
    let nz = n.sample3D(v[0] * freq + ox, v[1] * freq + oy, v[2] * freq + oz, { octaves: 4 });
    nz += 0.4 * n.raw3D(v[0] * freq * 3 + ox, v[1] * freq * 3, v[2] * freq * 3 + oz);
    nz = Math.sign(nz) * Math.pow(Math.abs(nz), 1 - angular); // sharpen → faceted, not blobby
    const d = 1 + lump * 0.55 * nz;
    const p = [v[0] * r * d * sq[0], v[1] * r * d * sq[1], v[2] * r * d * sq[2]];
    placed.push(p); if (p[1] < minY) minY = p[1];
  }
  for (const p of placed) { if (p[1] - minY < r * 0.1 * sq[1]) p[1] = minY; mb.vertex(p[0], p[1] - minY, p[2]); }
  for (const [a, b, c] of faces) mb.tri(a, b, c);
  mb.shade(params.flat);
  return mb.toSceneGraph({ color: params.color || [0.46, 0.45, 0.43], roughness: 1, name: 'rock' });
}

// basalt columns — a packed cluster of hexagonal prisms of varying height
// (Giant's-Causeway look). One mesh, seated on y=0.
function basaltColumns(params, seed) {
  const r = makeNoise(seed).raw2D; const rnd = (i) => (r(i * 1.7, seed * 0.1) * 0.5 + 0.5);
  const cols = params.columns ?? 7, cr = params.columnRadius ?? 0.22, R = params.radius ?? 1.0;
  const mb = new MeshBuilder();
  const place = [[0, 0]]; for (let i = 0; i < cols; i++) { const a = (i / cols) * Math.PI * 2; place.push([Math.cos(a) * cr * 2 * (0.7 + rnd(i)), Math.sin(a) * cr * 2 * (0.7 + rnd(i + 9))]); }
  place.slice(0, cols + 1).forEach(([cx, cz], i) => {
    const h = R * (0.6 + rnd(i + 3) * 1.6), sides = 6, base = mb.vertexCount;
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2, ox = Math.cos(a) * cr, oz = Math.sin(a) * cr;
      mb.vertex(cx + ox, 0, cz + oz, ox, 0, oz); mb.vertex(cx + ox, h, cz + oz, ox, 0, oz);
    }
    for (let s = 0; s < sides; s++) { const a = base + s * 2, b = base + ((s + 1) % sides) * 2; mb.tri(a, a + 1, b); mb.tri(b, a + 1, b + 1); }
    const topC = mb.vertex(cx, h, cz, 0, 1, 0); // cap
    for (let s = 0; s < sides; s++) mb.tri(base + s * 2 + 1, base + ((s + 1) % sides) * 2 + 1, topC);
  });
  mb.shade(params.flat);
  return mb.toSceneGraph({ color: params.color || [0.22, 0.22, 0.25], roughness: 0.95, name: 'basalt' });
}

register('rock', generateRock, { mesh: true, kind: 'rock' });
