// ─────────────────────────────────────────────────────────────────────────────
// component: netsync — the GENERAL client networking core (netcode's successor).
//
// Every networked game has the same three problems; netsync owns the first two so
// a manifest never re-hand-rolls them, and hands the third to `netpredict`:
//   1. TRANSPORT   — subscribe to a channel, decode the compact wire, track a
//                    roster of live entities (add/remove).
//   2. INTERPOLATION — buffer per-entity timestamped transforms, render ~interpMs
//                    IN THE PAST, and interpolate between the two samples that
//                    bracket render-time. Position lerps; ROTATION is handled
//                    correctly (2D angle lerp, 3D quaternion nlerp, shortest-arc);
//                    non-transform scalars (hp, aim…) carry as latest-value.
//   3. PREDICTION  — for a LOCALLY-controlled entity (see `netpredict`): render in
//                    the FUTURE (apply input now) and reconcile against the
//                    authoritative buffer this component holds.
//
// It supersedes `netcode` (which is 2D-x,y only): netsync is dimension-agnostic —
// an entity's transform is `{ p:[x,y(,z)], q:[angle] | [x,y,z,w], s:{…scalars} }`.
// Feed it from a realtime channel AND/OR a poll; it smooths both uniformly.
//
//   spec: { type:'netsync', id:'sync', interpMs?:90, maxBuffer?:12, idleSnapMs?:260 }
//
// CONSUME (from a sibling component):
//   import { getSync } from './components/netsync.js';
//   const sync = getSync('sync');
//   // decode a `physics.frame` delta channel ({t,k,b,r} of quantized rows):
//   sync.attachPhysics('s3', { dim:'3d', onAdd:id=>addModel(id), onRemove:id=>removeModel(id) });
//   // per rAF, read every entity's interpolated transform and apply it:
//   sync.bind(ents => { for (const id in ents) world.setModelTransform(id, {position:ents[id].p, rotation:ents[id].q}); });
//   // or feed it from any source directly:  sync.ingest('e7', { p:[x,y,z], q:[qx,qy,qz,qw] });
//
// Headless: hidden <span>; API on `instance.api` + `el.__netsync`, registered for
// `getSync(id)` sibling lookup. Interpolated snapshots are AUTHORITATIVE OUTPUT —
// `netpredict` reads this buffer to reconcile a predicted local entity against it.
// ─────────────────────────────────────────────────────────────────────────────
import { h } from '../core/dom.js';

const SYNCS = new Map();
export const getSync = (id = 'sync') => SYNCS.get(id) || null;

const lerp = (a, b, x) => a + (b - a) * x;
// shortest-arc normalized quaternion lerp (nlerp) — cheap, plenty smooth at 30Hz
function nlerpQ(a, b, x) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = dot < 0 ? -1 : 1;
  const q = [lerp(a[0], s * b[0], x), lerp(a[1], s * b[1], x), lerp(a[2], s * b[2], x), lerp(a[3], s * b[3], x)];
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
// interpolate two transform samples (position + rotation) by fraction f
function tween(from, to, f) {
  const p = [];
  for (let i = 0; i < to.p.length; i++) p.push(lerp(from.p[i] ?? to.p[i], to.p[i], f));
  let q = to.q;
  if (to.q && from.q) q = to.q.length === 4 ? nlerpQ(from.q, to.q, f)
    : [lerp(from.q[0], to.q[0], f)];                       // 2D single-angle
  return { p, q, s: to.s || null };
}

export function netsyncComponent(spec, ctx) {
  const INTERP = spec.interpMs ?? 90;         // render delay (ms of playout buffer)
  const MAXBUF = spec.maxBuffer ?? 12;        // samples kept per entity
  const IDLE_SNAP = spec.idleSnapMs ?? 260;   // gap → snap (don't smear across a rest pause)
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const ents = new Map();        // id -> { buf:[{t,p,q,s}], out }
  const channels = new Map();    // channel -> unsubscribe
  const addCbs = [];             // (id) => void   — fired when an entity first appears
  const remCbs = [];             // (id) => void   — fired when an entity leaves
  let raf = 0, alive = true, lastStep = now();

  // ── server-clock mapping ──────────────────────────────────────────────────
  // TCP coalescing can deliver two 30Hz frames in the SAME burst; stamping them
  // at ARRIVAL time gives them near-identical buffer timestamps and the
  // interpolator renders a freeze-then-jump. The server stamps every
  // channel_message with its own Date.now() at dispatch — 33ms apart even when
  // co-arriving — so we buffer on SERVER time mapped into the local clock
  // domain: buffer t = serverTs + chronoOffset. The offset is ANCHORED on the
  // first frame and then SLEWED ≤0.5ms/frame toward each observation — a rolling
  // mean would re-compress the inter-frame spacing we're preserving (early
  // samples shift it by 1/n per frame), while a bounded slew keeps co-arriving
  // frames their true 33ms apart to within 0.5ms yet still tracks clock drift
  // (≤15ms/s at 30Hz) and route changes.
  let chronoOffset = null;
  function updateChrono(raw) {
    if (!raw || typeof raw.timestamp !== 'number') return;
    const sample = now() - raw.timestamp;
    if (chronoOffset == null) { chronoOffset = sample; return; }
    const err = sample - chronoOffset;
    chronoOffset += Math.max(-0.5, Math.min(0.5, err * 0.05));
  }

  function fireAdd(id) { for (const cb of addCbs) { try { cb(id); } catch (e) {} } }
  function fireRem(id) { for (const cb of remCbs) { try { cb(id); } catch (e) {} } }

  // Feed one authoritative sample for an entity. transform = { p:number[], q?:number[], s?:object }.
  function ingest(id, transform, t) {
    if (id == null || !transform || !transform.p) return;
    t = t == null ? now() : t;
    let e = ents.get(id);
    if (!e) { e = { buf: [], out: null }; ents.set(id, e); fireAdd(id); }
    const b = e.buf;
    // idle gap → drop history so we don't interpolate across a long pause (snap)
    if (b.length && t - b[b.length - 1].t > IDLE_SNAP) b.length = 0;
    if (b.length && t <= b[b.length - 1].t) t = b[b.length - 1].t + 1;   // keep monotonic
    b.push({ t, p: transform.p, q: transform.q || null, s: transform.s || null });
    if (b.length > MAXBUF) b.shift();
  }

  function remove(id) { if (ents.delete(id)) fireRem(id); }
  function clearAll() { const ids = Array.from(ents.keys()); ents.clear(); for (const id of ids) fireRem(id); }

  // sample one entity's buffer at render-time rt → interpolated transform (exact when
  // rt falls between two real samples; else hold the newest so at-rest bodies sit still).
  function sampleAt(b, rt) {
    if (!b.length) return null;
    if (rt <= b[0].t) return { ...tween(b[0], b[0], 0), exact: true };
    for (let i = b.length - 1; i > 0; i--) {
      if (rt >= b[i - 1].t && rt <= b[i].t) {
        const span = b[i].t - b[i - 1].t || 1;
        return { ...tween(b[i - 1], b[i], (rt - b[i - 1].t) / span), exact: true };
      }
    }
    const last = b[b.length - 1];
    return { ...tween(last, last, 0), exact: false };       // starved → hold newest
  }

  // compute EVERY entity's interpolated transform at now-INTERP. Returns { id: {p,q,s} }.
  function read() {
    const rt = now() - INTERP, out = {};
    for (const [id, e] of ents) {
      const seg = sampleAt(e.buf, rt);
      if (!seg) continue;
      e.out = { p: seg.p, q: seg.q, s: seg.s };
      out[id] = e.out;
    }
    return out;
  }

  // push-style: self-driving rAF that calls render(entities) each frame.
  function bind(render) {
    if (raf) cancelAnimationFrame(raf);
    lastStep = now();
    const loop = () => { if (!alive) return; try { render(read()); } catch (e) {} raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); raf = 0; };
  }

  // ── decoders ────────────────────────────────────────────────────────────────
  // Generic: subscribe a channel and hand each message to `decode(msg, raw)`.
  // raw is the full wire frame (carries the server dispatch `timestamp`).
  function attach(channel, decode) {
    if (!channel || !ctx.contract || !ctx.contract.subscribeChannel || channels.has(channel)) return;
    try {
      const off = ctx.contract.subscribeChannel(channel, (m, raw) => {
        updateChrono(raw);                         // keep the clock map fresh on EVERY frame
        if (alive && m) try { decode(m, raw); } catch (e) {}
      });
      channels.set(channel, off);
    } catch (e) { /* no realtime — direct ingest()/poll still drives interpolation */ }
  }

  // `physics.frame` delta channel: { t, k:0|1, b:[[id, ...quantInts]], r:[ids] }.
  //   2D row: [id, x*100, y*100, angle*1000]        → p:[x,y]   q:[angle]
  //   3D row: [id, x*100, y*100, z*100, qx..qw*1000] → p:[x,y,z] q:[qx,qy,qz,qw]
  // t going BACKWARD = a structural reset (server rebuilt the world) → drop entities
  // not re-announced. k=1 (keyframe) = authoritative full set → same reconcile.
  function attachPhysics(channel, opts = {}) {
    if (opts.onAdd) addCbs.push(opts.onAdd);
    if (opts.onRemove) remCbs.push(opts.onRemove);
    const is3d = opts.dim === '3d';
    let lastT = 0;
    attach(channel, (m, raw) => {
      const f = m.payload || m;                    // channel_message wraps in .payload
      if (!f || !Array.isArray(f.b)) return;
      // Server-injected join/reconnect replays (burst:true) carry the last CACHED
      // keyframe — its `t` is naturally OLDER than a pre-disconnect lastT. That is
      // NOT a world reset: skip the reset guard, don't regress lastT, and don't
      // let its (≤5s stale) entity set prune newer entities via the k=1 branch.
      const isBurst = !!(raw && raw.burst);
      // reset: the server tick jumped BACKWARD. On a reliable ordered socket `t` is
      // strictly monotonic except when the world is rebuilt, so any decrease = reset.
      if (!isBurst && f.t != null && f.t < lastT) {
        clearAll();                                // drop ALL buffered entities (fresh slate)
        if (opts.onReset) { try { opts.onReset(); } catch (e) {} }  // consumer clears its meshes too
      }
      lastT = isBurst ? Math.max(lastT, f.t || 0) : (f.t || 0);
      // Buffer on SERVER dispatch time mapped to the local clock (see updateChrono):
      // co-arriving TCP-coalesced frames keep their true 33ms spacing instead of
      // collapsing onto one arrival timestamp. Falls back to arrival time (undefined
      // → ingest uses now()) when the frame carries no timestamp (e.g. direct ingest).
      const bt = (raw && typeof raw.timestamp === 'number' && chronoOffset != null) ? raw.timestamp + chronoOffset : undefined;
      const seen = new Set();
      for (const row of f.b) {
        const id = row[0]; seen.add(id);
        if (is3d) {
          ingest(id, {
            p: [row[1] / 100, row[2] / 100, row[3] / 100],
            q: [row[4] / 1000, row[5] / 1000, row[6] / 1000, row[7] / 1000],
          }, bt);
        } else {
          ingest(id, { p: [row[1] / 100, row[2] / 100], q: [row[3] / 1000] }, bt);
        }
      }
      if (Array.isArray(f.r)) for (const id of f.r) remove(id);
      if (f.k === 1 && !isBurst) for (const id of Array.from(ents.keys())) if (!seen.has(id)) remove(id);
      if (opts.onFrame) { try { opts.onFrame(f); } catch (e) {} }   // e.g. surface server tick to a HUD
    });
  }

  function onAdd(cb) { if (cb) addCbs.push(cb); }
  function onRemove(cb) { if (cb) remCbs.push(cb); }
  function has(id) { return ents.has(id); }

  function stop() {
    cancelAnimationFrame(raf); raf = 0;
    for (const off of channels.values()) { try { off && off(); } catch (e) {} }
    channels.clear(); ents.clear();
  }

  const api = { ingest, remove, clearAll, read, bind, attach, attachPhysics, onAdd, onRemove, has, ents, stop,
    get clockOffset() { return chronoOffset ?? 0; } };  // diagnostic: local−server clock map (ms)
  const el = h('span', { hidden: '', 'data-component': 'netsync' });
  el.__netsync = api;
  const id = spec.id || 'sync';
  SYNCS.set(id, api);
  return { el, api, destroy() { alive = false; stop(); if (SYNCS.get(id) === api) SYNCS.delete(id); } };
}
