// core/rules.js — manifest EVENT SHEETS (Construct-3 style "conditions → actions").
// A runtime logic layer expressed as pure manifest data and interpreted here. It is
// the connective tissue that replaces hand-wired `ctx.bus.on(...)`/`onClick` glue in
// one-off manifest components. Complements core/expand.js (which is build-time/static).
//
//   manifest.events = [
//     { id?, on?: 'topic'|['a','b'],   // bus trigger(s); 'door:*' = trailing wildcard
//                                      //   (expressions see `topic` = the exact topic)
//       every?: ms,                    // OR an interval trigger (expressions see `dt` s)
//                                      // OMIT both → re-eval on store change (edge-latch)
//       once?: false, repeat?: false,  // once = fire once; repeat = (untriggered) every eval
//       if?: <condition>,              // expression string or boolean tree; absent → true
//       do:  [ <action>, … ],          // run in order when trigger+if pass
//       else?: [ <action>, … ],        // run when if is false
//       events?: [ <rule>, … ] },      // SUB-EVENTS: run (inline-cond only) if parent passed
//     { group:'name', enabled?: true, events:[ <rule>, … ] },   // C3 GROUP (toggleable)
//     { include:'defName' },           // splice a rule ARRAY from manifest.defs (shared sheet)
//   ]
//   manifest.functions = {             // C3 FUNCTIONS: params + actions + return value
//     heal: { params:['amount'], do:[{ update:['hp', 'min(100, hp + amount)'] }] },
//     dps:  { params:['base'], return: 'base + combo * 2' },
//   }
//
// CONDITIONS (`if`):
//   'EXPRESSION'                     core/expr.js — `score > 10 && !won`, `len(items) == 0`,
//                                    `max(a,b) >= clamp(x,0,1)`… (legacy 'flag' / '!flag' /
//                                    '$state.path' strings are valid expressions — unchanged)
//   { eq|ne|gt|gte|lt|lte: [a, b] }  comparisons (operands resolved)
//   { in: [v, [..]] }                membership · { between: [v, lo, hi] }
//   { has: ['storePath', item] }     array-includes / object-has-key
//   { and:[..] } | { or:[..] } | { not: <cond> }
//   operands: literals, '$state.path', '$config.path', '$payload.x', '$wallet.address',
//             { $expr:'…' }, and any expand.js arithmetic op — ONE expression language.
//
// ACTIONS (`do`):
//   'topic'  (string shorthand → emit)
//   { emit:'topic', with?:{…} }      bus.emit (with = payload; substituted)
//   { send:'event', with?:… }        emit an fsm transition event (fsm subscribes by name)
//   { set:['key', value] }           store.setIn — value may be { $expr:'…' } / ops
//   { update:['key', v] } · { patch:['key', {…}] }   store update / shallow-merge
//   { let:['name', v] }              LOCAL var for the rest of this rule (expressions see it)
//   { sound:'ref' | {ref,opts} }     ctx.sound.play
//   { theme:'id' | 'next' }          ctx.theme
//   { call:['contract.fn', inputs?, {signed?}], into?:'key' }  await a contract view/write
//   { act:['behaviorId.action', ...args], into? }  call a registered BEHAVIOR action
//   { fn:['name', ...args], into? }  call a manifest FUNCTION (awaited; return → into)
//   { return: v? }                   (inside a function) return a value / end the function
//   { repeat: n, do:[…] }            loop n times — locals `loopindex`/`index`
//   { forEach: coll, as?:'item', do:[…] }  loop an array/object — locals item+index
//   { while: <cond>, do:[…], max?: 10000 } conditional loop (re-evaluated each pass)
//   { stopLoop: true }               break the innermost repeat/forEach/while
//   { stop: true }                   stop this rule (skips remaining actions + sub-events)
//   { if: <cond>, do:[…], else?:[…] }  inline branch (usable INSIDE loops/functions)
//   { wait: ms }                     INLINE pause (remaining actions continue after)
//   { after: ms, do:[…] }            delay a nested action list (non-blocking variant)
//   { signal:'name' }                fire a signal · { waitSignal:'name', timeout?: ms }
//   { enableGroup:'g' } · { disableGroup:'g' } · { toggleGroup:'g' }   event groups
//   { log:'msg' }                    dev breadcrumb
//   unknown verb → console.warn + skip (never throws).
//
// Triggers: rules with `on` fire per event · `every` fires on an interval · neither =
// UNTRIGGERED (re-eval on store change; fires on the FALSE→TRUE edge — C3's "trigger
// once while true" — `repeat:true` opts into every-eval). `start()` emits `rules:start`
// (C3 "on start of layout"). Sub-events cannot carry their own `on` (register at top level).

import { substituteValue } from './expand.js';
import { compileExpr, truthyVal } from './expr.js';
import { wait } from './seq.js';

// control-flow sentinels thrown by actions and caught by their owners
const STOP_RULE = Symbol('rules.stop');
const STOP_LOOP = Symbol('rules.stopLoop');
class FnReturn { constructor(v) { this.v = v; } }
const isSentinel = (e) => e === STOP_RULE || e === STOP_LOOP || e instanceof FnReturn;
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const truthy = (v) => Array.isArray(v) ? v.length > 0 : (isObj(v) ? Object.keys(v).length > 0 : !!v);

export function createRules({ store, bus, ctx = {}, flags = {}, functions = {}, defs = {} } = {}) {
  const rules = [];
  const groups = new Map();                        // group name → { enabled, rules:[…] }
  let fireCount = 0;
  let running = false;
  const t0 = nowMs();

  // a per-fire scope for substituteValue + condition operands. `locals` is a prototype
  // chain: loops/functions layer child scopes on top without clobbering the parent.
  function makeScope(payload) {
    let address = null;
    try { address = ctx.wallet && typeof ctx.wallet.address === 'function' ? ctx.wallet.address() : null; } catch { /* noop */ }
    return {
      dyn: true,
      payload: payload || {},
      config: ctx.config || {},
      wallet: { address, isConnected: !!store.getIn('wallet.isConnected') },
      state: (p) => store.getIn(p),
      flags,
      locals: {},
      time: () => (nowMs() - t0) / 1000,
    };
  }
  const childScope = (scope, extra) => {
    const s = { ...scope, locals: Object.create(scope.locals) };
    if (extra) Object.assign(s.locals, extra);
    return s;
  };
  const resolve = (v, scope) => substituteValue(v, scope);

  // ── condition evaluator ────────────────────────────────────────────────────
  function evalCond(cond, scope) {
    if (cond == null) return true;
    if (typeof cond === 'boolean') return cond;
    if (typeof cond === 'number') return cond !== 0;
    if (typeof cond === 'string') {
      // EXPRESSION condition (core/expr.js). Legacy strings ('flag' / '!flag' /
      // '$state.path') are valid expressions with identical semantics: bare
      // identifiers resolve locals → store → flags, `!` uses the same truthiness.
      return truthyVal(compileExpr(cond)(scope));
    }
    if (isObj(cond)) {
      if (Array.isArray(cond.and)) return cond.and.every((c) => evalCond(c, scope));
      if (Array.isArray(cond.or)) return cond.or.some((c) => evalCond(c, scope));
      if ('not' in cond) return !evalCond(cond.not, scope);
      const cmp = (op, fn) => { if (Array.isArray(cond[op])) { const [a, b] = cond[op].map((x) => resolve(x, scope)); return { v: fn(a, b) }; } return null; };
      let r;
      if ((r = cmp('eq', (a, b) => a === b))) return r.v;
      if ((r = cmp('ne', (a, b) => a !== b))) return r.v;
      if ((r = cmp('gt', (a, b) => a > b))) return r.v;
      if ((r = cmp('gte', (a, b) => a >= b))) return r.v;
      if ((r = cmp('lt', (a, b) => a < b))) return r.v;
      if ((r = cmp('lte', (a, b) => a <= b))) return r.v;
      if (Array.isArray(cond.in)) { const v = resolve(cond.in[0], scope), arr = resolve(cond.in[1], scope); return Array.isArray(arr) && arr.includes(v); }
      if (Array.isArray(cond.between)) { const [v, lo, hi] = cond.between.map((x) => resolve(x, scope)); return v >= lo && v <= hi; }
      if (Array.isArray(cond.has)) { const coll = store.getIn(cond.has[0]); const item = resolve(cond.has[1], scope); return Array.isArray(coll) ? coll.includes(item) : (isObj(coll) ? item in coll : false); }
      console.warn('[rules] unknown condition', cond); return false;
    }
    return false;
  }

  // ── action runner ──────────────────────────────────────────────────────────
  async function runActions(list, scope) {
    for (const a of [].concat(list || [])) {
      if (a == null) continue;
      try { await runAction(a, scope); }
      catch (e) { if (isSentinel(e)) throw e; console.error('[rules] action error', a, e); }
    }
  }

  // manifest FUNCTION call — params bind as locals; `{return}` / def.return yields
  // the value; `{stop}` inside a function just ends it. Depth-guarded recursion.
  async function callFn(name, args, callerScope) {
    const def = functions[name];
    if (!def) { console.warn('[rules] unknown function', name); return undefined; }
    const depth = (callerScope._depth || 0) + 1;
    if (depth > 64) { console.warn('[rules] function recursion limit hit at', name); return undefined; }
    const scope = childScope(callerScope, { args });
    scope._depth = depth;
    (def.params || []).forEach((p, i) => { scope.locals[p] = args[i]; });
    let ret;
    try { await runActions(def.do, scope); }
    catch (e) {
      if (e instanceof FnReturn) ret = e.v;
      else if (e !== STOP_RULE && e !== STOP_LOOP) throw e;
    }
    if (ret === undefined && def.return !== undefined) ret = resolve(def.return, scope);
    return ret;
  }
  async function runAction(a, scope) {
    if (typeof a === 'string') { bus.emit(a, scope.payload); return; }
    if ('emit' in a) { bus.emit(a.emit, a.with !== undefined ? resolve(a.with, scope) : scope.payload); return; }
    if ('send' in a) { const ev = Array.isArray(a.send) ? a.send[0] : a.send; bus.emit(ev, a.with !== undefined ? resolve(a.with, scope) : undefined); return; }
    if ('set' in a) { store.setIn(a.set[0], resolve(a.set[1], scope)); return; }
    if ('update' in a) { store.setIn(a.update[0], resolve(a.update[1], scope)); return; }
    if ('patch' in a) { const cur = store.getIn(a.patch[0]); store.setIn(a.patch[0], { ...(isObj(cur) ? cur : {}), ...resolve(a.patch[1], scope) }); return; }
    if ('sound' in a) { if (ctx.sound) { const s = a.sound; typeof s === 'string' ? ctx.sound.play(s) : ctx.sound.play(s.ref, s.opts); } return; }
    if ('theme' in a) { if (ctx.theme) { a.theme === 'next' ? ctx.theme.next() : ctx.theme.set(a.theme); } return; }
    if ('call' in a) {
      const spec = a.call;
      const fnPath = Array.isArray(spec) ? spec[0] : spec;
      const inputs = Array.isArray(spec) ? resolve(spec[1], scope) : undefined;
      const opts = Array.isArray(spec) ? (spec[2] || {}) : {};
      const name = String(fnPath).replace(/^contract\./, '');
      if (ctx.contract) {
        const res = opts.signed ? await ctx.contract.write(name, inputs, opts) : await ctx.contract.view(name, inputs);
        if (a.into) store.setIn(a.into, res);
      }
      return;
    }
    if ('act' in a) {
      // call a registered BEHAVIOR action (Construct's "behavior: do action"):
      //   { act: ['player.impulse', [0,-200]] }  → behaviors.invoke('player.impulse', [[0,-200]])
      //   { act: 'fx.shake', args: [8] }
      const spec = a.act;
      const ref = Array.isArray(spec) ? spec[0] : spec;
      const args = (Array.isArray(spec) ? spec.slice(1) : (a.args || [])).map((x) => resolve(x, scope));
      const bh = ctx.behaviors;
      if (bh) { const r = bh.invoke(ref, args); if (a.into) store.setIn(a.into, await r); }
      else console.warn('[rules] no behaviors registry for act', ref);
      return;
    }
    if ('after' in a) { await wait(a.after); await runActions(a.do, scope); return; }
    // ── v2 verbs (Construct-3 parity) ─────────────────────────────────────────
    if ('let' in a) { scope.locals[a.let[0]] = resolve(a.let[1], scope); return; }
    if ('wait' in a) { await wait(resolve(a.wait, scope)); return; }
    if ('signal' in a) { bus.emit('rules:signal:' + resolve(a.signal, scope), scope.payload); return; }
    if ('waitSignal' in a) {
      const name = 'rules:signal:' + resolve(a.waitSignal, scope);
      await new Promise((res) => {
        const un = bus.once(name, () => { if (t) clearTimeout(t); res(); });
        const t = a.timeout ? setTimeout(() => { un(); res(); }, a.timeout) : null;
      });
      return;
    }
    if ('repeat' in a && 'do' in a) {
      const n = Math.max(0, resolve(a.repeat, scope) | 0);
      try { for (let i = 0; i < n; i++) await runActions(a.do, childScope(scope, { loopindex: i, index: i })); }
      catch (e) { if (e !== STOP_LOOP) throw e; }
      return;
    }
    if ('forEach' in a) {
      const coll = resolve(a.forEach, scope);
      const as = a.as || 'item';
      const arr = Array.isArray(coll) ? coll
        : (isObj(coll) ? Object.entries(coll).map(([key, value]) => ({ key, value })) : []);
      try { for (let i = 0; i < arr.length; i++) await runActions(a.do, childScope(scope, { [as]: arr[i], index: i, loopindex: i })); }
      catch (e) { if (e !== STOP_LOOP) throw e; }
      return;
    }
    if ('while' in a) {
      const max = a.max ?? 10000;
      let i = 0;
      try {
        while (evalCond(a.while, scope)) {
          if (i >= max) { console.warn('[rules] while: max iterations reached', a); break; }
          await runActions(a.do, childScope(scope, { loopindex: i, index: i }));
          i++;
        }
      } catch (e) { if (e !== STOP_LOOP) throw e; }
      return;
    }
    if ('stopLoop' in a) throw STOP_LOOP;
    if ('stop' in a) throw STOP_RULE;
    // inline conditional ACTION — a branch usable INSIDE loops/functions (C3 nests
    // sub-events anywhere; checked after repeat/forEach/while, which also carry `do`)
    if ('if' in a && ('do' in a || 'else' in a)) {
      if (evalCond(a.if, scope)) await runActions(a.do, scope);
      else if (a.else) await runActions(a.else, scope);
      return;
    }
    if ('return' in a) throw new FnReturn(a.return === true ? undefined : resolve(a.return, scope));
    if ('fn' in a) {
      const spec = Array.isArray(a.fn) ? a.fn : [a.fn];
      const ret = await callFn(spec[0], spec.slice(1).map((x) => resolve(x, scope)), scope);
      if (a.into) store.setIn(a.into, ret);
      return;
    }
    if ('enableGroup' in a) { setGroup(resolve(a.enableGroup, scope), true); return; }
    if ('disableGroup' in a) { setGroup(resolve(a.disableGroup, scope), false); return; }
    if ('toggleGroup' in a) { const g = resolve(a.toggleGroup, scope); setGroup(g, !(groups.get(g) || {}).enabled); return; }
    if ('log' in a) { console.log('[rules]', resolve(a.log, scope)); return; }
    console.warn('[rules] unknown action', a);
  }

  // ── rule firing ──────────────────────────────────────────────────────────
  async function runRule(r, scope) {
    if (r._disabled) return;
    fireCount++;
    try {
      await runActions(r.do, scope);
      // sub-events: inline-condition only, share parent scope/payload
      for (const sub of r.events || []) {
        if (sub.on) { console.warn('[rules] sub-events cannot have their own `on` (v1); register at top level', sub); continue; }
        if (evalCond(sub.if, scope)) await runRule(sub, scope);
        else if (sub.else) await runActions(sub.else, scope);
      }
    } catch (e) {
      if (!isSentinel(e)) throw e;                 // {stop}/stray {return}/{stopLoop} end the rule quietly
    }
    if (r.once) { r._disabled = true; disarm(r); }
  }
  function fire(r, scope) {
    if (r._disabled) return;
    if (evalCond(r.if, scope)) runRule(r, scope);
    else if (r.else) runActions(r.else, scope);
  }

  // ── arming ──────────────────────────────────────────────────────────────
  function microDebounce(fn) {
    let pending = false;
    return () => { if (pending) return; pending = true; Promise.resolve().then(() => { pending = false; fn(); }); };
  }
  function arm(r) {
    if (r._armed) return;
    if (r._group) { const g = groups.get(r._group); if (g && !g.enabled) return; }   // disabled group
    r._armed = true;
    if (r.on) {
      // 'door:*' wildcards supported (bus trailing-* patterns); expressions can read
      // `topic` to see which exact topic fired.
      r._subs = [].concat(r.on).map((t) => bus.on(t, (payload, topic) => {
        const scope = makeScope(payload);
        scope.locals.topic = topic || t;
        fire(r, scope);
      }));
    } else if (r.every) {
      // interval trigger (C3 "Every X seconds", here ms) — `dt` = measured seconds
      let last = nowMs();
      r._iv = setInterval(() => {
        if (r._disabled) return;
        const t = nowMs();
        const scope = makeScope();
        scope.locals.dt = (t - last) / 1000;
        last = t;
        fire(r, scope);
      }, Math.max(16, r.every));
    } else {
      // untriggered: re-eval on any store change. Default = FALSE→TRUE edge latch
      // (fires once per rising edge). `repeat:true` opts into every-eval.
      r._latched = false;
      const evalU = () => {
        if (r._disabled) return;
        const scope = makeScope();
        const pass = evalCond(r.if, scope);
        if (r.repeat) { if (pass) runRule(r, scope); }
        else if (pass && !r._latched) { r._latched = true; runRule(r, scope); }
        else if (!pass) r._latched = false;
      };
      r._sub = store.subscribe('*', microDebounce(evalU));
      evalU(); // initial evaluation
    }
  }
  function disarm(r) {
    (r._subs || []).forEach((u) => u && u()); r._subs = null;
    if (r._sub) { r._sub(); r._sub = null; }
    if (r._iv) { clearInterval(r._iv); r._iv = null; }
    r._armed = false;
  }

  // ── groups (C3: enable/disable whole blocks of events at runtime) ──────────
  function setGroup(name, on) {
    const g = groups.get(name);
    if (!g) { console.warn('[rules] unknown group', name); return; }
    if (g.enabled === !!on) return;
    g.enabled = !!on;
    // re-enabling re-arms with a FRESH edge latch (untriggered members re-evaluate)
    for (const r of g.rules) (g.enabled ? (running && arm(r)) : disarm(r));
  }

  function register(entry) {
    if (!entry) return entry;
    // { include:'defName' } — splice a shared rule sheet from manifest.defs
    if (entry.include) {
      const sheet = defs[entry.include];
      if (Array.isArray(sheet)) sheet.forEach(register);
      else console.warn('[rules] include: manifest.defs has no rule array named', entry.include);
      return entry;
    }
    // { group:'name', enabled?, events:[…] } — register members under a toggle
    if (entry.group) {
      let g = groups.get(entry.group);
      if (!g) { g = { enabled: entry.enabled !== false, rules: [] }; groups.set(entry.group, g); }
      else if (entry.enabled !== undefined) g.enabled = entry.enabled !== false;
      for (const sub of entry.events || []) {
        sub._group = entry.group;
        g.rules.push(sub);
        rules.push(sub);
        if (running && g.enabled) arm(sub);
      }
      return entry;
    }
    rules.push(entry);
    if (running) arm(entry);
    return entry;
  }

  return {
    register,
    start() { running = true; rules.forEach(arm); bus.emit('rules:start'); },   // C3 "on start of layout"
    stop() { running = false; rules.forEach(disarm); },
    setGroup,
    groupEnabled: (name) => !!(groups.get(name) || {}).enabled,
    call: (name, args) => callFn(name, args || [], makeScope()),   // invoke a manifest function imperatively
    get fireCount() { return fireCount; },
    // exposed for tests / dev
    _eval: (cond, payload) => evalCond(cond, makeScope(payload)),
    _run: (list, payload) => runActions(list, makeScope(payload)),
  };
}
