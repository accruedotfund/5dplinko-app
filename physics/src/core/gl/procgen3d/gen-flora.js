// core/gl/procgen3d/gen-flora.js — flora generators (STUBS, priority domain).
//
// Each registers a real signature + a recognizable PLACEHOLDER mesh so the
// pipeline (registry → SceneGraph → renderer) works end-to-end today. The real
// algorithms land in the flora phase:
//   tree     — TODO recursive branching (procgen.branch / L-system) → swept-tube
//              limbs + leaf cards; variants oak/pine/dead/giant; growth twist.
//   bush     — TODO clustered deformed spheres; round/low/thorn variants.
//   grass    — TODO single tapered blade → patch (the gl-foliage instancer already
//              renders blades; this would emit the blade MESH + LOD billboard).
//   flower   — TODO petal ring + stem + leaves (petalCount/stemLength params).
//   mushroom — TODO cap + stem + cluster; small/large/glowing.
//
// PLACEHOLDER shapes below are intentionally crude (boxes) — they exist to prove
// the contract and let demos place flora now; replace the bodies, keep the specs.

import { MeshBuilder, combine } from './mesh-builder.js';
import { register } from './registry.js';
import { rng, randRange } from '../../procgen.js';

// ── tiny 3-vec helpers (tree growth) ──────────────────────────────────────────
const TAU = Math.PI * 2;
const _sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const _add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const _scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const _len = (a) => Math.hypot(a[0], a[1], a[2]);
const _norm = (a) => { const l = _len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const _cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function _perp(dir) { const a = Math.abs(dir[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0]; const t = _norm(_cross(a, dir)); return [t, _cross(dir, t)]; }

// a tapered tube segment (ring of `sides`) from p0→p1, radius r0→r1.
function segment(mb, p0, p1, r0, r1, sides) {
  const dir = _norm(_sub(p1, p0)); const [t, b] = _perp(dir);
  const base = mb.vertexCount;
  for (let s = 0; s < sides; s++) {
    const a = (s / sides) * TAU, cx = Math.cos(a), sy = Math.sin(a);
    const ox = t[0] * cx + b[0] * sy, oy = t[1] * cx + b[1] * sy, oz = t[2] * cx + b[2] * sy;
    mb.vertex(p0[0] + ox * r0, p0[1] + oy * r0, p0[2] + oz * r0, ox, oy, oz);
    mb.vertex(p1[0] + ox * r1, p1[1] + oy * r1, p1[2] + oz * r1, ox, oy, oz);
  }
  for (let s = 0; s < sides; s++) {
    const i = base + s * 2, ni = base + ((s + 1) % sides) * 2;
    mb.tri(i, i + 1, ni); mb.tri(ni, i + 1, ni + 1);
  }
}

// low-poly leaf/needle blob (displaced octahedron) at a point.
function blob(mb, c, rad, r, squashY = 1) {
  const v = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((p) => {
    const j = 0.7 + r() * 0.6; return [p[0] * j, p[1] * j * squashY, p[2] * j];
  });
  const base = mb.vertexCount;
  for (const p of v) mb.vertex(c[0] + p[0] * rad, c[1] + p[1] * rad, c[2] + p[2] * rad, p[0], p[1], p[2]);
  for (const [a, b, cc] of [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]]) mb.tri(base + a, base + b, base + cc);
}

// SPECIES descriptors — drive branching, silhouette, foliage.
const SPECIES = {
  oak:   { sides: 5, depth: 4, trunk: 0.16, taper: 0.72, child: [2, 3], lenF: 0.74, radF: 0.62, spread: 0.85, up: 0.35, leaves: true, leafR: 1.5, needle: false },
  pine:  { sides: 5, depth: 4, trunk: 0.14, taper: 0.6, child: [3, 4], lenF: 0.66, radF: 0.55, spread: 1.15, up: -0.05, leaves: true, leafR: 0.9, needle: true },
  birch: { sides: 5, depth: 3, trunk: 0.08, taper: 0.78, child: [2, 2], lenF: 0.72, radF: 0.66, spread: 0.7, up: 0.5, leaves: true, leafR: 1.1, needle: false },
  dead:  { sides: 5, depth: 4, trunk: 0.13, taper: 0.66, child: [2, 3], lenF: 0.7, radF: 0.6, spread: 1.0, up: 0.15, leaves: false, leafR: 0, needle: false, broken: true },
  giant: { sides: 6, depth: 5, trunk: 0.4, taper: 0.76, child: [2, 3], lenF: 0.76, radF: 0.66, spread: 0.8, up: 0.3, leaves: true, leafR: 2.2, needle: false },
};

// bend a direction toward a random spread + upward bias (curvature/heliotropism).
function bendDir(dir, sp, r) {
  const [t, b] = _perp(dir);
  const a = r() * TAU, mag = sp.spread * (0.4 + r() * 0.8);
  let nd = _add(dir, _add(_scl(t, Math.cos(a) * mag), _scl(b, Math.sin(a) * mag)));
  nd = _add(nd, [0, sp.up, 0]); // pull toward light
  return _norm(nd);
}

export function generateTree(params = {}, ctx = {}) {
  const r = rng(ctx.seed ?? params.seed ?? 1);
  const sp = SPECIES[params.variant] || SPECIES.oak;
  const H = params.height ?? randRange(r, 4, 6) * (params.variant === 'giant' ? 1.6 : 1);
  const trunkR = params.trunkRadius ?? sp.trunk * (H / 5);
  const bark = new MeshBuilder(), leaf = new MeshBuilder();
  const tips = [];
  // whole-tree lean (silhouette variation): tilt the base growth direction
  const lean = (r() - 0.5) * 0.3;
  const base0 = _norm([Math.sin(lean) * (r() - 0.5), 1, Math.cos(lean) * (r() - 0.5) * 0.6 + 0.1]);

  function grow(p0, dir, len, rad, depth) {
    const curved = bendDir(dir, sp, r);
    const mid = _add(p0, _scl(_norm(_add(dir, curved)), len)); // slight curve mid-segment
    segment(bark, p0, mid, rad, rad * sp.taper, sp.sides);
    if (sp.broken && depth < sp.depth && r() < 0.18) { if (sp.leaves) {} return; } // snapped branch
    if (depth <= 0) {
      if (sp.leaves) {
        if (sp.needle) for (let k = 0; k < 3; k++) blob(leaf, _add(mid, [0, -k * len * 0.5, 0]), len * sp.leafR * (1 - k * 0.18), r, 0.5);
        else blob(leaf, mid, len * sp.leafR, r, 0.85);
      }
      tips.push(mid); return;
    }
    const [lo, hi] = sp.child;
    const n = (lo + Math.floor(r() * (hi - lo + 1)));
    for (let i = 0; i < n; i++) grow(mid, curved, len * sp.lenF * (0.8 + r() * 0.4), rad * sp.radF, depth - 1);
  }
  grow([0, 0, 0], base0, H * 0.32, trunkR, sp.depth);
  bark.shade(params.flat); leaf.shade(params.flat);

  // per-tree color jitter so no two are identical
  const jit = (c, k) => [Math.max(0, c[0] + (r() - 0.5) * k), Math.max(0, c[1] + (r() - 0.5) * k), Math.max(0, c[2] + (r() - 0.5) * k)];
  const barkCol = jit(params.barkColor || (params.variant === 'birch' ? [0.78, 0.78, 0.74] : [0.28, 0.2, 0.13]), 0.05);
  const leafCol = jit(params.leafColor || [0.18, 0.32, 0.15], 0.06);
  const parts = [{ mb: bark, color: barkCol, roughness: 0.95 }];
  if (leaf.pos.length) parts.push({ mb: leaf, color: leafCol, roughness: 0.85 });
  return combine(parts, 'tree');
}

export function generateBush(params = {}, ctx = {}) {
  void ctx; const s = params.size ?? 0.6;
  const mb = new MeshBuilder();
  mb.box([0, s * 0.6, 0], [s, s * 0.6, s]);
  mb.shade(params.flat);
  return mb.toSceneGraph({ color: params.color || [0.2, 0.36, 0.16], roughness: 0.95, name: 'bush' });
}

export function generateGrass(params = {}, ctx = {}) {
  const r = rng(ctx.seed ?? params.seed ?? 1);
  const mb = new MeshBuilder(); const h = params.height ?? randRange(r, 0.25, 0.45), blades = 4 + (r() * 4 | 0);
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * TAU + r() * 0.5, lean = 0.2 + r() * 0.35;
    segment(mb, [0, 0, 0], [Math.cos(a) * h * lean, h * (0.8 + r() * 0.4), Math.sin(a) * h * lean], 0.02, 0.004, 3);
  }
  mb.shade(params.flat);
  return mb.toSceneGraph({ color: params.color || [0.3, 0.5, 0.2], roughness: 1, doubleSided: true, name: 'grass' });
}

export function generateFlower(params = {}, ctx = {}) {
  const r = rng(ctx.seed ?? params.seed ?? 1);
  const stemL = params.stemLength ?? randRange(r, 0.22, 0.4);
  const stem = new MeshBuilder(), bloom = new MeshBuilder();
  segment(stem, [0, 0, 0], [(r() - 0.5) * 0.06, stemL, (r() - 0.5) * 0.06], 0.012, 0.008, 4);
  // petal fan: flat triangles radiating from the bloom center
  const petals = params.petalCount ?? (5 + (r() * 3 | 0)), pr = 0.07, y = stemL;
  const c = bloom.vertex(0, y, 0, 0, 1, 0);
  for (let i = 0; i < petals; i++) {
    const a0 = (i / petals) * TAU, a1 = ((i + 0.5) / petals) * TAU;
    const o = bloom.vertex(Math.cos(a0) * pr, y + 0.01, Math.sin(a0) * pr, 0, 1, 0);
    const t = bloom.vertex(Math.cos(a1) * pr * 1.5, y + 0.03, Math.sin(a1) * pr * 1.5, 0, 1, 0);
    bloom.tri(c, o, t);
  }
  stem.shade(params.flat); bloom.shade(params.flat);
  return combine([
    { mb: stem, color: [0.32, 0.5, 0.22], roughness: 0.9 },
    { mb: bloom, color: params.color || [0.92, 0.5, 0.62], roughness: 0.6, doubleSided: true,
      emissive: params.glowing ? (params.color || [0.5, 0.3, 0.4]) : [0, 0, 0] },
  ], 'flower');
}

export function generateMushroom(params = {}, ctx = {}) {
  const r = rng(ctx.seed ?? params.seed ?? 1);
  const h = params.height ?? randRange(r, 0.22, 0.4);
  const capR = params.capRadius ?? h * 0.55;
  const stem = new MeshBuilder(), cap = new MeshBuilder();
  // tapered, slightly-curved stem
  const lean = [(r() - 0.5) * 0.15, h, (r() - 0.5) * 0.15];
  segment(stem, [0, 0, 0], lean, h * 0.16, h * 0.11, 7);
  // gills: a flat fan disc tucked under the cap (same pale material as the stem)
  const gillY = h * 0.96, base = stem.vertexCount, sides = 10;
  const gc = stem.vertex(lean[0], gillY + capR * 0.12, lean[2], 0, -1, 0);
  for (let s = 0; s < sides; s++) { const a = (s / sides) * TAU; stem.vertex(lean[0] + Math.cos(a) * capR * 0.82, gillY, lean[2] + Math.sin(a) * capR * 0.82, 0, -1, 0); }
  for (let s = 0; s < sides; s++) stem.tri(gc, base + 1 + s, base + 1 + (s + 1) % sides);
  // domed cap (squashed displaced blob)
  blob(cap, [lean[0], gillY + capR * 0.15, lean[2]], capR, r, 0.55);
  stem.shade(params.flat); cap.shade(params.flat);
  const glow = params.glowing;
  return combine([
    { mb: stem, color: params.stemColor || [0.86, 0.82, 0.72], roughness: 0.85 },
    { mb: cap, color: params.color || (glow ? [0.3, 0.6, 0.7] : [0.62, 0.2, 0.18]), roughness: 0.7,
      emissive: glow ? (params.glowColor || [0.15, 0.5, 0.65]) : [0, 0, 0] },
  ], 'mushroom');
}

// ── understory / forest-floor layers (no empty floor) ────────────────────────
// moss: flat green patch (a few squashed blobs hugging the ground).
export function generateMoss(params = {}, ctx = {}) {
  const r = rng(ctx.seed ?? params.seed ?? 1); const mb = new MeshBuilder(); const R = params.radius ?? 0.5;
  for (let i = 0; i < 3 + (r() * 3 | 0); i++) blob(mb, [(r() - 0.5) * R, 0.03, (r() - 0.5) * R], R * (0.4 + r() * 0.4), r, 0.12);
  mb.shade(params.flat);
  return mb.toSceneGraph({ color: params.color || [0.12, 0.22, 0.1], roughness: 1, name: 'moss' });
}
// fern: a fan of a few tapered blades from a common base.
export function generateFern(params = {}, ctx = {}) {
  const r = rng(ctx.seed ?? params.seed ?? 1); const mb = new MeshBuilder(); const blades = 4 + (r() * 4 | 0); const H = params.height ?? 0.5;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * TAU + r() * 0.4, lean = 0.5 + r() * 0.4;
    const tip = [Math.cos(a) * H * lean, H * (0.7 + r() * 0.4), Math.sin(a) * H * lean];
    segment(mb, [0, 0, 0], tip, 0.03, 0.005, 4);
  }
  mb.shade(params.flat);
  return mb.toSceneGraph({ color: params.color || [0.14, 0.3, 0.12], roughness: 0.9, doubleSided: true, name: 'fern' });
}
// fallen log: a mossy horizontal tapered tube (deadwood — environmental story).
export function generateLog(params = {}, ctx = {}) {
  const r = rng(ctx.seed ?? params.seed ?? 1); const L = params.length ?? randRange(r, 1.5, 3), rad = params.radius ?? 0.18;
  const bark = new MeshBuilder(), mossMB = new MeshBuilder();
  segment(bark, [-L, rad, 0], [L, rad, (r() - 0.5) * 0.3], rad, rad * 0.8, 7);
  for (let i = 0; i < 5; i++) blob(mossMB, [-L + r() * 2 * L, rad * 1.7, (r() - 0.5) * rad], rad * 0.6, r, 0.3); // moss on top
  bark.shade(params.flat); mossMB.shade(params.flat);
  return combine([{ mb: bark, color: [0.24, 0.17, 0.12], roughness: 1 }, { mb: mossMB, color: [0.12, 0.24, 0.1], roughness: 1 }], 'log');
}

register('tree', generateTree, { mesh: true, kind: 'flora' });
register('moss', generateMoss, { mesh: true, kind: 'understory' });
register('fern', generateFern, { mesh: true, kind: 'understory' });
register('log', generateLog, { mesh: true, kind: 'understory' });
register('bush', generateBush, { mesh: true, kind: 'flora', stub: true });
register('grass', generateGrass, { mesh: true, kind: 'flora', stub: true });
register('flower', generateFlower, { mesh: true, kind: 'flora', stub: true });
register('mushroom', generateMushroom, { mesh: true, kind: 'flora', stub: true });
