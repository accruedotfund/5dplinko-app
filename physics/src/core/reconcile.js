// ─────────────────────────────────────────────────────────────────────────────
// reconcile.js — bridge AUTHORITATIVE state (the contract's truth) to
// PRESENTATION state (what components render), playing out the difference.
//
// Why this exists (the ProofNetwork shape): a contract call usually returns the
// whole new state in ONE response — a fight is fully resolved, a timer already
// flipped a switch. If you bind the UI straight to that, it snaps. Instead we
// keep two store keys:
//
//   truthKey  — the authoritative value (from a contract return or /ws push)
//   viewKey   — what the UI renders; driven toward truth over TIME by `play`
//
// A projection is DATA in manifest.projections:
//   {
//     id,                       // unique
//     viewKey,                  // store key components render
//     truthKey?,                // store key holding authoritative value (subscribe)
//     on?,                      // OR a bus event carrying the new truth (e.g. 'result:fight')
//     initial?,                 // seed for viewKey
//     play?:    (prev, next, api) => void,   // how to animate prev→next (default: snap)
//     predict?: (api) => teardown?,          // optimistic LOCAL loop (e.g. local 5s timer)
//   }
//
// `api` = { set, get, truth, tween, timeline, easings, signal, store, bus }.
// Each new truth cancels the prior in-flight playout for that id (reconciliation):
// if the server contradicts what we predicted, the latest play wins.
// ─────────────────────────────────────────────────────────────────────────────

import { tween as _tween, timeline as _timeline, easings } from './playout.js';

export function createReconciler({ store, bus }) {
  const running = new Map(); // id -> { signal, cancels:[] }
  const teardowns = [];

  function cancel(id) {
    const r = running.get(id);
    if (!r) return;
    r.signal.cancelled = true;
    r.cancels.forEach((c) => c && c());
    running.delete(id);
  }

  function apiFor(id, viewKey, signal) {
    const track = (cancelFn) => {
      running.get(id)?.cancels.push(cancelFn);
      return cancelFn;
    };
    return {
      set: (v) => store.set(viewKey, v),
      get: () => store.get(viewKey),
      truth: (k) => store.get(k),
      easings,
      signal,
      store,
      bus,
      tween: (opts) => track(_tween({ ...opts, signal })),
      timeline: (steps, opts) => track(_timeline(steps, { ...opts, signal })),
    };
  }

  function register(spec) {
    const { id, truthKey, on, viewKey, initial, play, predict } = spec;

    // seed presentation
    if (viewKey != null && store.get(viewKey) === undefined) {
      store.set(viewKey, initial !== undefined ? initial : truthKey != null ? store.get(truthKey) : undefined);
    }

    const runPlay = (prev, next) => {
      cancel(id);
      const signal = { cancelled: false };
      running.set(id, { signal, cancels: [] });
      const api = apiFor(id, viewKey, signal);
      if (play) play(prev, next, api);
      else if (viewKey != null) api.set(next); // default: snap
    };

    // truth source A: a store key
    if (truthKey != null) {
      teardowns.push(store.subscribe(truthKey, (next, prev) => runPlay(prev, next)));
    }
    // truth source B: a bus event carrying the new truth value/payload
    if (on) {
      teardowns.push(bus.on(on, (payload) => runPlay(viewKey != null ? store.get(viewKey) : undefined, payload)));
    }
    // optimistic local prediction (own teardown)
    if (predict) {
      const td = predict(apiFor(id, viewKey, { cancelled: false }));
      if (typeof td === 'function') teardowns.push(td);
    }

    return { id };
  }

  function destroy() {
    teardowns.forEach((t) => t && t());
    [...running.keys()].forEach(cancel);
  }

  return { register, cancel, destroy };
}
