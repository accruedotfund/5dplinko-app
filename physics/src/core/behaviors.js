// core/behaviors.js — a registry of named BEHAVIORS (Construct-style). A component
// that owns imperative machinery (physics, camera, an effect, a controller) registers
// an action surface here under an id; manifest EVENT SHEETS (core/rules.js) then DRIVE
// it declaratively via the `act` action — `{ act: ['player.impulse', [0,-200]] }`.
//
// This is the boundary done right: the behavior keeps the raw world/raycast/rAF code;
// the event sheet stays pure data and only CALLS the behavior's exposed actions (or sets
// its variables, which are just setter actions or store keys). Mirrors Construct exactly:
// the sheet never does physics math — it calls "Physics: Apply impulse".
//
//   // in a component factory:
//   const off = ctx.behaviors.register('player', {
//     actions: {
//       impulse:  ([x, y]) => body.applyImpulse(x, y),
//       setSpeed: (v) => { body.maxSpeed = v; },      // "modify a behavior variable"
//       dash:     () => { /* … */ },
//     },
//   });
//   return { el, destroy() { off(); } };
//
//   // in the manifest:
//   events: [ { on: 'jump', do: [ { act: ['player.impulse', [0, -200]] } ] } ]
//
// Surface: { actions: { name(...args){} } }. `ctx.behaviors.get(id)` returns it.
// Registering the same id replaces (last writer wins); the returned fn unregisters.

// Wrap ANY component instance into a behavior surface so the event sheet can drive it
// with no per-component wiring. registry.create auto-registers every instance that has a
// manifest `id` through this — so `{ act: ['<id>.<methodPath>', …args] }` resolves to the
// component's own API. The method path may be DOTTED to reach nested sub-APIs:
//   'fogTo'              → first container with a fn `fogTo` (instance.api/instance/el/
//                          el.api/el.world/el.camera/el.controller), or el.__fogTo
//   'camera.tweenTo'     → finds the `camera` object in a container, then its `tweenTo`
//   'world.camera.set'   → walks el.world.camera.set (explicit deep path)
// (Most components hang their imperative API on `el` as `el.world`/`el.camera`/`el.__fire`;
// gl-scene's camera lives at `el.world.camera`, reachable as `<id>.camera.<m>`.)
export function instanceSurface(instance) {
  // a lazy component (lazyComponent in boot.js) returns a host whose real instance
  // appears on `.inner` only AFTER its async import — resolve against it once present,
  // so `act` reaches the real el.world/el.camera API and not the empty lazy host.
  const real = () => instance.inner || instance;
  const elOf = () => real().el;
  const containers = () => { const i = real(), el = i.el; return [i.api, i, el, el && el.api, el && el.world, el && el.camera, el && el.controller].filter(Boolean); };
  // find the first container that has a (non-null) property `name`
  const findProp = (name) => {
    for (const c of containers()) { const v = c[name]; if (v != null) return { owner: c, val: v }; }
    const el = elOf();
    if (el && typeof el['__' + name] === 'function') return { owner: el, val: el['__' + name] }; // el.__fire, el.__learn, …
    return null;
  };
  // resolve a (possibly dotted) method path → a bound function, or null
  const resolve = (path) => {
    if (typeof path !== 'string' || !path || path === 'el' || path === 'destroy') return null;
    const segs = path.split('.');
    const method = segs.pop();
    if (segs.length === 0) {
      const hit = findProp(method);
      return hit && typeof hit.val === 'function' ? hit.val.bind(hit.owner) : null;
    }
    const root = findProp(segs[0]); // first segment names an object in a container
    if (!root) return null;
    let base = root.val;
    for (let k = 1; k < segs.length && base != null; k++) base = base[segs[k]];
    const fn = base && base[method];
    return typeof fn === 'function' ? fn.bind(base) : null;
  };
  return { instance, resolve, actions: new Proxy({}, { get: (_, m) => resolve(m), has: () => true }) };
}

// Auto-register a component instance so event sheets can `act` on it. Registers under
// BOTH `<type>:<id>` (always unambiguous — survives id collisions like psx-forest's two
// `id:'main'` components) AND the bare `<id>` (first-wins convenience). Returns an
// unregister fn (called on the instance's destroy). Used by registry.create.
export function registerInstance(behaviors, spec, instance) {
  if (!spec || spec.id == null || !behaviors) return () => {};
  const surface = instanceSurface(instance);
  const offs = [behaviors.register(`${spec.type}:${spec.id}`, surface)];
  if (!behaviors.has(spec.id)) offs.push(behaviors.register(spec.id, surface));
  return () => offs.forEach((o) => o && o());
}

export function createBehaviors() {
  const map = new Map();
  return {
    register(id, surface) {
      if (!id) { console.warn('[behaviors] register needs an id'); return () => {}; }
      map.set(id, surface || {});
      return () => { if (map.get(id) === surface) map.delete(id); };
    },
    get(id) { return map.get(id); },
    has(id) { return map.has(id); },
    list() { return [...map.keys()]; },
    // call an action: invoke('player.impulse', [args]) or a DOTTED path
    // invoke('gl-scene:main.camera.tweenTo', [...]). The id is everything before the
    // FIRST '.', the rest is the (possibly nested) method path.
    invoke(ref, args = []) {
      const s = String(ref);
      const dot = s.indexOf('.');
      if (dot < 0) { console.warn('[behaviors] act needs "id.method"', ref); return undefined; }
      const id = s.slice(0, dot), path = s.slice(dot + 1);
      const bh = map.get(id);
      if (!bh) { console.warn('[behaviors] no behavior', id); return undefined; }
      // auto-surfaces expose resolve() (handles dotted paths); explicit {actions} surfaces
      // use a flat action name.
      const fn = typeof bh.resolve === 'function' ? bh.resolve(path) : (bh.actions && bh.actions[path]);
      if (typeof fn !== 'function') { console.warn('[behaviors] no action', ref); return undefined; }
      return fn(...args);
    },
  };
}
