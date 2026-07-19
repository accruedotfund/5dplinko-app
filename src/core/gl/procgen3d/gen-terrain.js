// core/gl/procgen3d/gen-terrain.js — heightfield terrain (FOUNDATION, minimal-real).
//
//   generate('terrain', { seed, size:64, resolution:48, layers:{...}, color })
//     size       — world meters (square, centered on origin)
//     resolution — grid cells per side (verts = res+1)
//     layers     — { base:{scale,amp}, mountain:{scale,amp,ridged}, detail:{scale,amp} }
//     → SceneGraph (smooth-normalled grid)
//
// REAL today: base + ridged mountain + detail noise layers → a grid mesh.
// TODO (later phases): hydraulic/thermal erosion, river carving, lake/ocean
// masks, per-chunk generation (gen-chunks.js), slope/height material blending.
// Exposes `heightAt(params)` so ecosystem/placement can sample the same field.

import { MeshBuilder } from './mesh-builder.js';
import { makeNoise } from './noise3d.js';
import { register } from './registry.js';
import { heightFn as sharedHeightFn } from '../heightfield.js';

// returns a deterministic height(x,z) sampler for the given params (shared by
// the mesh builder AND ecosystem scatter so props sit ON the surface).
// UNIFIED: if `hills`/`hillScale` are given, delegate to the SHARED core/gl/heightfield.js
// field — the SAME one gl-animegrass uses — so a gl-procgen terrain and a gl-animegrass
// with matching params produce IDENTICAL surfaces (props/collision/visual all agree). The
// `layers` mode (base/ridged-mountain/detail) stays the default for back-compat.
export function heightField(params = {}) {
  if (params.hillScale != null || params.hills != null) return sharedHeightFn(params);
  const n = makeNoise(params.seed ?? 1);
  const L = params.layers || {};
  const base = L.base || { scale: 0.02, amp: 4 };
  const mtn = L.mountain || { scale: 0.012, amp: 8, ridged: true };
  const det = L.detail || { scale: 0.12, amp: 0.4 };
  return (x, z) => {
    let h = n.sample2D(x * base.scale, z * base.scale) * base.amp;
    if (mtn.amp) {
      const m = mtn.ridged ? n.ridged2D(x * mtn.scale, z * mtn.scale) : n.sample2D(x * mtn.scale, z * mtn.scale);
      h += m * mtn.amp;
    }
    if (det.amp) h += n.sample2D(x * det.scale, z * det.scale) * det.amp;
    return h;
  };
}

export function generateTerrain(params = {}, ctx = {}) {
  const size = params.size ?? 64;
  const res = Math.max(2, params.resolution ?? 48);
  const h = heightField({ ...params, seed: ctx.seed ?? params.seed });
  const mb = new MeshBuilder();
  const half = size / 2, step = size / res;
  // vertices
  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      const x = -half + i * step, z = -half + j * step;
      mb.vertex(x, h(x, z), z, 0, 1, 0, i / res, j / res);
    }
  }
  // quads (two tris) — index into the (res+1)² grid
  const W = res + 1;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
      mb.tri(a, c, b); mb.tri(b, c, d);
    }
  }
  mb.shade(params.flat);
  return mb.toSceneGraph({ color: params.color || [0.34, 0.46, 0.26], roughness: 0.95, name: 'terrain' });
}

register('terrain', generateTerrain, { mesh: true, kind: 'terrain' });
