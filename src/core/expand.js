// core/expand.js — manifest-native iteration. A spec with `repeat`/`over`
// expands into N concrete specs at boot, so "8 crates at random x" is DATA,
// not a .map() in the manifest. Pure + seeded → same world every load, and
// manifests stay serializable (tooling like pf-edit can patch them).
//
//   { type:'gl-model', repeat: 8, seed: 7,
//     id: 'crate-{i}',                       // "{i}" / "{item}" string tokens
//     src: 'assets/kit/Box_A.gltf',          // literals stay literal (pf-build)
//     position: [{ $rand: [-10, 10] }, 0, { $step: [-4, -2] }] }
//
//   { type:'gl-light', kind:'point', over: [[-16,-16],[16,-16],[16,16]],
//     pos: ['$item.0', 4.6, '$item.1'] }
//
// ── `over` can be a literal array OR a GENERATOR object ──────────────────────
//   over: { $range: [start, end, step=1] }   → numbers start..end (inclusive)
//   over: { $grid: { cols, rows, x0?=0, y0?=0, dx?=1, dy?=1, center?=false } }
//                                            → items { col, row, x, y }  (or [cols,rows] shorthand)
//   over: { $ring: { count, radius, cx?=0, cy?=0, start?=0, arc?=2π } }
//                                            → items { i, angle, x, y }
//
// ── Value tokens (deep, anywhere in the spec) ───────────────────────────────
//   '$i'  '$i1'           → index (0-based) / 1-based index
//   '$n'                  → total count in this expansion
//   '$item' / '$item.x'   → the `over` element (or a path into it; numeric = array index)
//   '…{i}… {i1} {n} {item.x}…' → string interpolation
//   { $step: [start, step] }        → start + i·step
//   { $lerp: [from, to] }           → from→to across the repeat (i/(n-1)); numbers OR arrays
//   { $seq:  [a, b, c] }            → arr[i % len]  (deterministic alternation by index)
//   { $rand: [min, max] }           → seeded uniform float
//   { $randInt: [min, max] }        → seeded integer (inclusive)
//   { $pick: [a, b, c] }            → seeded choice
//
//   { $pickWeighted: [[a, 3], [b, 1]] } → seeded weighted choice ([value, weight] pairs)
//
// ── Template reuse + conditional include (need `env = { defs, flags }`) ─────
//   extends: 'defName'   → clone manifest.defs[defName] then override with this
//                          spec's other keys (deep clone; functions kept by ref).
//                          UNIVERSAL — works for ANY type (vs `use`, which is the
//                          symbol/clip playhead clone). A def may itself `extends`.
//   include: 'groupName' → SPLICE a defs entry that is an ARRAY of specs into the
//                          list (reusable multi-component fragments). Optional
//                          `merge:{…}` deep-patches each member; `when`/`unless`
//                          gate the whole fragment.
//   merge: {…}           → deep-patch the resolved spec (override nested def fields
//                          without replacing the whole object).
//   when:  cond          → include this spec only if cond is truthy
//   unless: cond         → include only if cond is FALSY
//     cond = boolean | number | 'flagName' | '!flagName' (looked up in env.flags).
//     STATIC (boot-time, per template) — for runtime gating use `gate`/`hidden`.
//
// `seed` (optional) makes the random draws reproducible per expanded spec;
// omitted → seeded from the spec's index so layouts are still stable.
// Expansion recurses into nested spec arrays (children/components/overlays/…),
// so gl-scene children, panels, etc. can all repeat.

import { evalExpr } from './expr.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;
const path = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function substitute(value, scope) {
  if (typeof value === 'string') {
    // ── runtime operand tokens (used by core/rules.js when scope carries resolvers;
    //    inert during normal expand, which never sets scope.dyn) ──
    if (scope.dyn) {
      if (value === '$payload') return scope.payload;
      if (value === '$wallet') return scope.wallet;
      if (value.startsWith('$state.')) return scope.state(value.slice(7));
      if (value.startsWith('$config.')) return path(scope.config, value.slice(8));
      if (value.startsWith('$payload.')) return path(scope.payload, value.slice(9));
      if (value.startsWith('$wallet.')) return path(scope.wallet, value.slice(8));
    }
    if (value === '$i') return scope.i;
    if (value === '$i1') return scope.i + 1;
    if (value === '$n') return scope.count;
    if (value === '$item') return scope.item;
    if (value.startsWith('$item.')) return path(scope.item, value.slice(6));
    if (value.includes('{') && 'i' in scope) {
      return value.replace(/\{(i1|i|n|item(?:\.[\w.]+)?)\}/g, (_, tok) => {
        if (tok === 'i') return scope.i;
        if (tok === 'i1') return scope.i + 1;
        if (tok === 'n') return scope.count;
        if (tok === 'item') return String(scope.item);
        return String(path(scope.item, tok.slice(5)));
      });
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, scope));
  if (value && typeof value === 'object') {
    // {$expr:'…'} — the compiled expression language (core/expr.js). At runtime
    // (rules scope, dyn) identifiers read locals/payload/state/…; during STATIC
    // expansion the repeat counters are exposed as locals (i / i1 / n / item).
    if (typeof value.$expr === 'string') {
      return evalExpr(value.$expr, scope.dyn ? scope
        : { locals: { i: scope.i, i1: (scope.i ?? 0) + 1, n: scope.count, item: scope.item, index: scope.i, loopindex: scope.i } });
    }
    if (Array.isArray(value.$step)) return value.$step[0] + scope.i * value.$step[1];
    if (Array.isArray(value.$lerp)) {
      const [a, b] = value.$lerp;
      const t = scope.count > 1 ? scope.i / (scope.count - 1) : 0;
      const mix = (x, y) => x + (y - x) * t;
      return (Array.isArray(a) && Array.isArray(b)) ? a.map((x, k) => mix(x, b[k])) : mix(a, b);
    }
    if (Array.isArray(value.$seq)) { const L = value.$seq.length; return value.$seq[((scope.i % L) + L) % L]; }
    if (Array.isArray(value.$rand)) return value.$rand[0] + scope.rng() * (value.$rand[1] - value.$rand[0]);
    if (Array.isArray(value.$randInt)) return value.$randInt[0] + Math.floor(scope.rng() * (value.$randInt[1] - value.$randInt[0] + 1));
    if (Array.isArray(value.$pick)) return value.$pick[Math.floor(scope.rng() * value.$pick.length)];
    if (Array.isArray(value.$pickWeighted)) {
      const pairs = value.$pickWeighted, total = pairs.reduce((s, p) => s + (p[1] || 0), 0) || 1;
      let r = scope.rng() * total;
      for (const [v, w] of pairs) { r -= (w || 0); if (r <= 0) return substitute(v, scope); }
      return substitute(pairs[pairs.length - 1][0], scope);
    }
    // ── arithmetic / transform pipeline — operands are substituted first, so
    //    they compose with $i/$step/each other: { $round: { $mul: ['$i', 1.5] } }
    const A = (v) => substitute(v, scope);
    if ('$round' in value) return Math.round(A(value.$round));
    if ('$floor' in value) return Math.floor(A(value.$floor));
    if ('$ceil' in value) return Math.ceil(A(value.$ceil));
    if ('$abs' in value) return Math.abs(A(value.$abs));
    if ('$neg' in value) return -A(value.$neg);
    if (Array.isArray(value.$clamp)) { const [v, lo, hi] = value.$clamp.map(A); return Math.min(hi, Math.max(lo, v)); }
    if (Array.isArray(value.$add)) return value.$add.map(A).reduce((s, x) => s + x, 0);
    if (Array.isArray(value.$sub)) { const a = value.$sub.map(A); return a.reduce((s, x, i) => (i ? s - x : x)); }
    if (Array.isArray(value.$mul)) return value.$mul.map(A).reduce((s, x) => s * x, 1);
    if (Array.isArray(value.$div)) { const [a, b] = value.$div.map(A); return a / b; }
    if (Array.isArray(value.$mod)) { const [a, b] = value.$mod.map(A); return ((a % b) + b) % b; }
    if (Array.isArray(value.$min)) return Math.min(...value.$min.map(A));
    if (Array.isArray(value.$max)) return Math.max(...value.$max.map(A));
    const out = {};
    for (const k of Object.keys(value)) out[k] = substitute(value[k], scope);
    return out;
  }
  return value;
}

// Shared operand evaluator: resolves value tokens + arithmetic ops against a scope.
// expand passes {i,count,item,rng}; core/rules.js passes {dyn:true, state, config,
// payload, wallet}. Both run through the same $add/$mul/$state/… machinery so the
// manifest has ONE expression language. Also exported as `path` for path lookups.
export function substituteValue(value, scope = {}) { return substitute(value, scope); }
export { path as getPath };

// ── `over` generators → concrete item arrays ─────────────────────────────────
function buildRange([start, end, step = 1]) {
  const out = [];
  if (step === 0) return out;
  if (step > 0) for (let v = start; v <= end + 1e-9; v += step) out.push(v);
  else for (let v = start; v >= end - 1e-9; v += step) out.push(v);
  return out;
}
function buildGrid(g) {
  const cols = Array.isArray(g) ? g[0] : (g.cols ?? 1);
  const rows = Array.isArray(g) ? g[1] : (g.rows ?? 1);
  const x0 = g.x0 ?? 0, y0 = g.y0 ?? 0, dx = g.dx ?? 1, dy = g.dy ?? 1;
  const cx = g.center ? (cols - 1) / 2 : 0, cy = g.center ? (rows - 1) / 2 : 0;
  const out = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    out.push({ col, row, x: x0 + (col - cx) * dx, y: y0 + (row - cy) * dy });
  }
  return out;
}
function buildRing(r) {
  const count = r.count ?? 1, radius = r.radius ?? 1;
  const cx = r.cx ?? 0, cy = r.cy ?? 0, start = r.start ?? 0;
  const arc = r.arc ?? TAU, full = Math.abs(arc - TAU) < 1e-6;
  const out = [];
  const denom = full ? count : Math.max(1, count - 1);
  for (let i = 0; i < count; i++) {
    const angle = start + (arc * i) / denom;
    out.push({ i, angle, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
  }
  return out;
}
// a store/config value → an items array: an array is used as-is; a number N
// becomes N empty slots (drive purely off $i); anything else → no iteration.
function toItems(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'number' && v > 0) return Array.from({ length: v | 0 });
  return null;
}
function resolveOver(over, env) {
  if (Array.isArray(over)) return over;
  if (over && typeof over === 'object') {
    if (over.$range) return buildRange(over.$range);
    if (over.$grid) return buildGrid(over.$grid);
    if (over.$ring) return buildRing(over.$ring);
    // data-driven count/list straight from live state or config
    if (over.$state && env && env.store) {
      const s = env.store; return toItems(s.getIn ? s.getIn(over.$state) : s.get(over.$state));
    }
    if (over.$config && env && env.config) return toItems(path(env.config, over.$config));
  }
  return null;
}

// deep clone DATA but keep functions (handlers/format/fn) by reference — defs
// templates may carry callbacks, and structuredClone/JSON would drop or throw.
function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = clone(v[k]); return o; }
  return v;
}

// `extends: 'name'` → clone defs[name], then override with the spec's own keys.
// Recurses (a def may itself `extends`), capped to avoid a cycle hanging boot.
function applyExtends(spec, defs, depth = 0) {
  if (!spec || !spec.extends || depth > 8) return spec;
  const base = defs && defs[spec.extends];
  if (!base) { console.warn(`[expand] extends: unknown def "${spec.extends}"`); const { extends: _e, ...rest } = spec; return rest; }
  const { extends: _e, ...over } = spec;
  const merged = Object.assign(clone(base), over);     // spec keys win over the def
  return merged.extends ? applyExtends(merged, defs, depth + 1) : merged;
}

// deep-merge a `patch` object into `target`: plain objects merge recursively,
// arrays + scalars REPLACE. Lets `merge:` patch a nested def field (e.g. one
// palette key) without replacing the whole nested object.
function deepMerge(target, patch) {
  if (patch == null || Array.isArray(patch) || typeof patch !== 'object') return patch;
  const out = (target && typeof target === 'object' && !Array.isArray(target)) ? { ...target } : {};
  for (const k in patch) out[k] = deepMerge(out[k], patch[k]);
  return out;
}

// static condition for when/unless: bool/number direct; string = flag lookup
// ('!name' negates). Anything else → truthy test.
function cond(c, flags) {
  if (typeof c === 'boolean' || typeof c === 'number') return !!c;
  if (typeof c === 'string') {
    let k = c.trim(), neg = false;
    if (k[0] === '!') { neg = true; k = k.slice(1).trim(); }
    const v = !!(flags && flags[k]);
    return neg ? !v : v;
  }
  return !!c;
}

// arrays of child specs commonly nested inside a component spec
// 'levels' is level-host's DEFERRED spec dict — it must pass through VERBATIM (no
// parent substitute) so the `over`/`$item`/`{i}` tokens inside a level survive until
// level-host expands them itself with the right per-item scope. Without it, boot's
// pass-through substitute (scope.item=undefined) corrupts those tokens → e.g. all
// coins collapse to id "…-coin-0" at [null,_,null]. (It's an object, not an array, so
// expandNested skips it — being in NESTED only EXCLUDES it from substitute.)
const NESTED = ['components', 'children', 'overlays', 'items', 'widgets', 'frames', 'nodes', 'levels'];

function expandNested(spec, env) {
  for (const key of NESTED) {
    if (Array.isArray(spec[key])) spec[key] = expandSpecs(spec[key], env);
  }
  return spec;
}

export function expandSpecs(list, env = {}) {
  const defs = env.defs || {}, flags = env.flags || {};
  const out = [];
  for (const raw of list || []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { out.push(raw); continue; }
    // 0. `include: 'groupName'` — SPLICE a defs entry that is an ARRAY of specs
    //    into the list (vs `extends`, which clones ONE object spec). Reusable
    //    multi-component fragments. Optional `merge` deep-patches each member;
    //    `when`/`unless` gate the whole fragment. Members are cloned + recursively
    //    expanded (so they may carry their own repeat/extends/etc).
    if (raw.include) {
      if (raw.when !== undefined && !cond(raw.when, flags)) continue;
      if (raw.unless !== undefined && cond(raw.unless, flags)) continue;
      const group = defs[raw.include];
      if (!Array.isArray(group)) { console.warn(`[expand] include: "${raw.include}" is not an array def`); continue; }
      const patch = (raw.merge && typeof raw.merge === 'object' && !Array.isArray(raw.merge)) ? raw.merge : null;
      let frag = group.map(clone);
      if (patch) frag = frag.map((s) => (s && typeof s === 'object' && !Array.isArray(s)) ? deepMerge(s, patch) : s);
      for (const s of expandSpecs(frag, env)) out.push(s);
      continue;
    }
    // 1. resolve `extends` (template clone + shallow override) — universal, any type
    let spec = raw.extends ? applyExtends(raw, defs) : raw;
    // 2. `merge` deep-patch (override nested def fields without replacing them)
    if (spec.merge && typeof spec.merge === 'object' && !Array.isArray(spec.merge)) {
      const { merge, ...rest } = spec; spec = deepMerge(rest, merge);
    }
    // 3. static conditional include (boot-time, gated on env.flags)
    if (spec.when !== undefined && !cond(spec.when, flags)) continue;
    if (spec.unless !== undefined && cond(spec.unless, flags)) continue;
    // 4. iterate (repeat / over) or pass through; strip directive-only keys
    const overItems = resolveOver(spec.over, env);
    if (!spec.repeat && !overItems) {
      // not iterated, but still fold value-ops ($add/$round/$clamp/…) on the
      // spec's OWN fields (constant math, config-derived values). NESTED child
      // arrays are left for expandNested so their tokens keep their own scope.
      const { when, unless, ...clean } = spec;
      const scope = { i: 0, count: 1, item: undefined, rng: mulberry32(0x9e3779b9) };
      const folded = {};
      for (const k in clean) folded[k] = NESTED.includes(k) ? clean[k] : substitute(clean[k], scope);
      out.push(expandNested(folded, env));
      continue;
    }
    const items = overItems || Array.from({ length: spec.repeat | 0 });
    const count = items.length;
    const { repeat, over, seed, when, unless, ...template } = spec;
    items.forEach((item, i) => {
      const rng = mulberry32((seed ?? 0x9e3779b9) + i * 0x85ebca6b);
      out.push(expandNested(substitute(template, { i, item, rng, count }), env));
    });
  }
  return out;
}
