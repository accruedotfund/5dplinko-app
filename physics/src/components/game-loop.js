// ─────────────────────────────────────────────────────────────────────────────
// component: game-loop — ONE authoritative rAF that anything can ride. Instead of
// every animated component spinning its own requestAnimationFrame (frame-rate-
// dependent, unordered), they share a single tick with a FIXED TIMESTEP for
// deterministic updates (physics/collision) + a once-per-frame render pass with an
// interpolation `alpha`.
//
//   spec: {
//     type: 'game-loop' | 'loop',
//     id?: 'main',            // name; topics are loop:<id>:fixed / :frame
//     fixed?: 60,             // fixed updates per second (accumulator-driven)
//     maxFrame?: 0.25,        // clamp dt (s) after a tab-switch so nothing teleports
//     timescale?: 1,          // global slow-mo / fast-forward (0 = freeze)
//     phases?: ['input','update','physics','render'],  // ordered subscribe buckets
//     global?: <id==='main'>, // also emit UNPREFIXED loop:fixed / loop:frame
//     autostart?: true,
//     pauseOn?: ev|[ev], resumeOn?: ev|[ev], paused?: false,
//   }
//
// TWO ways to ride it — use whichever fits, mix freely:
//   1. RAW BUS (decoupled, no import):
//        ctx.bus.on('loop:fixed', ({dt}) => { x += vx*dt; });
//   2. ORDERED PHASES (deterministic order, needs the handle):
//        import { getLoop } from './game-loop.js';
//        const off = getLoop('main').add(({dt}) => move(dt), { phase:'physics' });
//      add() runs in phase order, then by `order` within a phase; returns an unsub.
//      `kind:'frame'` rides the render pass (gets {dt,alpha}) instead of fixed.
// ─────────────────────────────────────────────────────────────────────────────

import { h } from '../core/dom.js';

// module-level registry so components can grab a loop by id without importing each
// other. getLoop(id) is the public accessor; a loop registers itself on create.
const LOOPS = new Map();
export function getLoop(id = 'main') { return LOOPS.get(id) || null; }
// convenience: subscribe even before the loop exists (queues until it registers).
const PENDING = new Map(); // id -> [{fn, opts}]
export function onTick(id, fn, opts) {
  const lp = LOOPS.get(id);
  if (lp) return lp.add(fn, opts);
  const q = PENDING.get(id) || PENDING.set(id, []).get(id);
  const entry = { fn, opts }; q.push(entry);
  return () => { const i = q.indexOf(entry); if (i >= 0) q.splice(i, 1); };
}

export function gameLoopComponent(spec, ctx) {
  const id = spec.id || 'main';
  const step = 1 / (spec.fixed || 60);                 // fixed timestep (s)
  const maxFrame = spec.maxFrame ?? 0.25;              // clamp huge dt
  const phases = spec.phases || ['input', 'update', 'physics', 'render'];
  const phaseIdx = Object.fromEntries(phases.map((p, i) => [p, i]));
  const global = spec.global != null ? spec.global : id === 'main';
  let timescale = spec.timescale ?? 1;

  const subs = [];   // { fn, phase, order, kind } — kind: 'fixed' | 'frame'
  let sorted = true;
  function ensureSorted() {
    if (sorted) return;
    subs.sort((a, b) => (phaseIdx[a.phase] ?? 99) - (phaseIdx[b.phase] ?? 99) || a.order - b.order);
    sorted = true;
  }

  const handle = {
    id, step,
    get timescale() { return timescale; },
    set timescale(v) { timescale = v; },
    // add(fn, { phase?, order?, kind? }) → unsubscribe. kind 'fixed' (default) gets
    // {dt} repeated per fixed step; 'frame' gets {dt,alpha} once per rendered frame.
    add(fn, opts = {}) {
      const entry = { fn, phase: opts.phase || (opts.kind === 'frame' ? 'render' : 'update'), order: opts.order || 0, kind: opts.kind || 'fixed' };
      subs.push(entry); sorted = false;
      return () => { const i = subs.indexOf(entry); if (i >= 0) subs.splice(i, 1); };
    },
    pause() { running = false; },
    resume() { if (!running) { running = true; last = now(); raf = requestAnimationFrame(frame); } },
    get paused() { return !running; },
    destroy,
  };
  LOOPS.set(id, handle);
  // flush any subscribers queued via onTick() before this loop existed
  const pend = PENDING.get(id);
  if (pend) { pend.forEach((e) => handle.add(e.fn, e.opts)); PENDING.delete(id); }

  const now = () => performance.now() / 1000;
  const run = (kind, payload) => { ensureSorted(); for (const s of subs) if (s.kind === kind) { try { s.fn(payload); } catch (e) { console.error(`[game-loop:${id}] ${s.phase} sub`, e); } } };

  let acc = 0, last = now(), running = spec.autostart !== false && !spec.paused, raf = 0, frameNo = 0;
  function frame() {
    if (!running) return;
    const t = now();
    let dt = (t - last) * timescale; last = t;
    if (dt > maxFrame) dt = maxFrame;                  // clamp post-tab-switch spikes
    acc += dt;
    // fixed updates: drain the accumulator → deterministic, frame-rate independent
    while (acc >= step) {
      const payload = { dt: step, t, frame: frameNo };
      run('fixed', payload);
      ctx.bus.emit(`loop:${id}:fixed`, payload);
      if (global) ctx.bus.emit('loop:fixed', payload);
      acc -= step;
    }
    // render pass: once per rAF, alpha = how far we are into the next fixed step
    const payload = { dt, t, frame: frameNo, alpha: acc / step };
    run('frame', payload);
    ctx.bus.emit(`loop:${id}:frame`, payload);
    if (global) ctx.bus.emit('loop:frame', payload);
    frameNo++;
    raf = requestAnimationFrame(frame);
  }
  if (running) raf = requestAnimationFrame(frame);

  // data-driven pause/resume via bus
  const offs = [];
  [].concat(spec.pauseOn || []).forEach((ev) => offs.push(ctx.bus.on(ev, () => handle.pause())));
  [].concat(spec.resumeOn || []).forEach((ev) => offs.push(ctx.bus.on(ev, () => handle.resume())));

  function destroy() {
    running = false; cancelAnimationFrame(raf);
    offs.forEach((u) => u && u());
    if (LOOPS.get(id) === handle) LOOPS.delete(id);
  }

  // headless: it renders nothing. A hidden anchor keeps the data-* convention.
  return { el: h('span', { class: 'pf-game-loop', 'data-component': 'game-loop', 'data-loop': id, hidden: '' }), handle, destroy };
}
