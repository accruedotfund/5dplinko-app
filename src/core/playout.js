// ─────────────────────────────────────────────────────────────────────────────
// playout.js — time-based scheduling primitives. No deps.
//
// These drive *presentation* state over time so a single authoritative state
// change can be animated/stepped instead of snapped. Used by reconcile.js, but
// usable standalone from any component.
//
//   tween(opts)       — interpolate a number over a duration (requestAnimationFrame)
//   timeline(steps)   — fire a sequence of callbacks at given offsets (setTimeout)
//   wait(ms)          — promise delay
//   easings           — common easing curves
//
// Every scheduler takes an optional `signal` ({ cancelled:bool }) so a newer
// authoritative update can cancel an in-flight playout (reconciliation).
// ─────────────────────────────────────────────────────────────────────────────

import { EASINGS, steps as stepsEase } from './easing.js';

// Easings are the ONE shared library (core/easing.js) — the full Penner/back/
// elastic/bounce/spring set — so gl-tween/gl-spline, spline, counter, reconcile and
// cutscene all share it. The old short names are kept as aliases for back-compat.
export const easings = {
  ...EASINGS,
  easeIn: EASINGS.in, easeOut: EASINGS.out, easeInOut: EASINGS.inout,
  steps: (n) => stepsEase(n),     // chunky/pixel-friendly (kept call-with-n shape)
};

const dead = (sig) => sig && sig.cancelled;

// tween — call onFrame(value, progress) each animation frame from `from`→`to`.
// Returns a cancel function.
export function tween({ from = 0, to = 1, duration = 400, ease = easings.easeOut, onFrame, onDone, signal } = {}) {
  let raf;
  let start = null;
  const step = (now) => {
    if (dead(signal)) return;
    if (start == null) start = now;
    const p = duration <= 0 ? 1 : Math.min(1, (now - start) / duration);
    onFrame?.(from + (to - from) * ease(p), p);
    if (p < 1) raf = requestAnimationFrame(step);
    else onDone?.();
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

// timeline — steps: [{ at:<ms>, run:fn }]. Fires each `run` at its offset.
// Returns a cancel function that clears all pending steps.
export function timeline(steps = [], { signal, onDone } = {}) {
  const timers = [];
  let remaining = steps.length;
  for (const s of steps) {
    timers.push(
      setTimeout(() => {
        if (dead(signal)) return;
        s.run?.();
        if (--remaining === 0) onDone?.();
      }, s.at || 0)
    );
  }
  if (steps.length === 0) onDone?.();
  return () => timers.forEach(clearTimeout);
}

export function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
