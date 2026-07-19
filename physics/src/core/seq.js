// ─────────────────────────────────────────────────────────────────────────────
// seq — a tiny promise-based STEP SEQUENCER. For "do this, wait, do that" flows
// that need a few ordered steps but not a whole `timeline` of element tweens.
//
//   seq()
//     .do(() => flash())        // run a step (awaited if it returns a promise)
//     .wait(110)                // pause N ms
//     .do(() => spawnCards())
//     .run();                   // → Promise<boolean> (resolves false if cancelled)
//
// The builder is chainable; nothing runs until .run(). The returned object also has
// .cancel() to stop a run in flight — it clears the pending wait and skips the rest,
// so call it from teardown/reset to avoid a late step firing into a torn-down view.
//
// Why this and not the `timeline` component: `timeline` is declarative ELEMENT
// tweening (move/spawn with reverse). seq() is for imperative ORDERED SIDE-EFFECTS
// (toggle a class, play a clip, build DOM) — lighter, promise-based, no element model.
// ─────────────────────────────────────────────────────────────────────────────

export function seq() {
  const steps = [];
  let timer = 0, resolveWait = null, cancelled = false, started = false;

  const api = {
    do(fn) { steps.push({ fn }); return api; },     // a step: run fn (await if it's async)
    wait(ms) { steps.push({ ms }); return api; },    // a pause
    async run() {
      if (started) return false; started = true;
      for (const s of steps) {
        if (cancelled) break;
        if (s.ms != null) {
          await new Promise((res) => { resolveWait = res; timer = setTimeout(res, s.ms); });
          resolveWait = null; timer = 0;
        } else {
          try { await s.fn?.(); } catch (e) { console.error('[seq] step failed:', e); }
        }
      }
      return !cancelled;
    },
    cancel() { cancelled = true; clearTimeout(timer); resolveWait?.(); },
    get cancelled() { return cancelled; },
  };
  return api;
}

// The atomic seq() is built on: a plain cancellable-by-GC delay promise. Handy on its
// own for `await wait(ms)` in any async flow.
export const wait = (ms) => new Promise((res) => setTimeout(res, ms));
