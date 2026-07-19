// core/gl/procgen3d/registry.js — central generator registry + serialization.
//
// Every generator registers under a name and is a PURE function of
// (params, ctx) → result (a SceneGraph for mesh generators, or data for
// placement/biome generators). Because they're pure + seeded, any result is
// fully described by { generator, seed, params } and can be regenerated later —
// that's the serialization contract.
//
//   register('rock', generateRock, { mesh: true });
//   const sg   = generate('rock', { seed: 42, radius: 1.2 });   // SceneGraph
//   const desc = describe('rock', { seed: 42, radius: 1.2 });   // { generator, seed, params }
//   const same = regenerate(desc);                              // identical result

const REGISTRY = new Map(); // name → { fn, meta }

export function register(name, fn, meta = {}) {
  if (typeof fn !== 'function') throw new Error(`procgen3d.register("${name}"): fn must be a function`);
  REGISTRY.set(name, { fn, meta });
  return fn;
}
export function has(name) { return REGISTRY.has(name); }
export function get(name) { return REGISTRY.get(name)?.fn || null; }
export function list() { return [...REGISTRY.keys()].sort(); }
export function meta(name) { return REGISTRY.get(name)?.meta || null; }

// run a generator by name. `params.seed` (default 1) is the determinism anchor.
export function generate(name, params = {}) {
  const entry = REGISTRY.get(name);
  if (!entry) throw new Error(`procgen3d: unknown generator "${name}" (have: ${list().join(', ')})`);
  const seed = params.seed ?? 1;
  return entry.fn(params, { seed, name });
}

// serialization: a result → its regenerable descriptor, and back.
export function describe(name, params = {}) {
  return { generator: name, seed: params.seed ?? 1, params: { ...params } };
}
export function regenerate(desc) {
  if (!desc || !desc.generator) throw new Error('regenerate(desc): need { generator, params }');
  return generate(desc.generator, { seed: desc.seed, ...(desc.params || {}) });
}
// round-trippable JSON (params must be JSON-safe — keep generator params plain data).
export function serialize(name, params = {}) { return JSON.stringify(describe(name, params)); }
export function deserialize(json) { return regenerate(typeof json === 'string' ? JSON.parse(json) : json); }
