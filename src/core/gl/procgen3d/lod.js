// core/gl/procgen3d/lod.js — level-of-detail generation.
//
// Two strategies:
//   1. PARAMETRIC LOD (real today) — regenerate the asset at lower detail params.
//      Most generators expose a detail knob (terrain.resolution, rock.detail,
//      tree branchDepth). lodChain() halves them per level → cheap, exact, no
//      mesh decimation needed. This is the recommended path for procedural assets.
//   2. MESH DECIMATION (stub) — collapse an existing SceneGraph's triangles for
//      assets you can't regenerate. TODO: quadric edge-collapse.
//
//   const chain = lodChain('rock', { seed:1, detail:3 }, { levels:4 });
//   // → [{level:0, params:{detail:3}}, {level:1, detail:2}, …]  (call generate() per use)

import { generate, meta } from './registry.js';

const DETAIL_KEYS = ['detail', 'resolution', 'branchDepth', 'density', 'subdiv'];

// produce LOD descriptors by scaling the generator's detail param down per level.
export function lodChain(name, params = {}, opts = {}) {
  const levels = opts.levels ?? 4;
  const key = DETAIL_KEYS.find((k) => params[k] != null) || (meta(name)?.detailKey);
  const out = [];
  for (let l = 0; l < levels; l++) {
    const p = { ...params };
    if (key && p[key] != null) p[key] = Math.max(1, Math.round(p[key] / (2 ** l)));
    out.push({ level: l, generator: name, params: p });
  }
  return out;
}

// realize a chain into SceneGraphs (LOD0 = highest detail).
export function buildLOD(name, params = {}, opts = {}) {
  return lodChain(name, params, opts).map((d) => ({ level: d.level, sceneGraph: generate(d.generator, d.params), params: d.params }));
}

// STUB: in-place mesh decimation for non-regenerable SceneGraphs.
// TODO: quadric error metric edge-collapse. For now returns the input unchanged
// (LOD via lodChain/buildLOD is the working path).
export function decimate(sceneGraph, ratio = 0.5) { void ratio; return sceneGraph; }
