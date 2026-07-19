// ─────────────────────────────────────────────────────────────────────────────
// core/easing.js — the shared EASING LIBRARY (the anime.js-grade set, zero-dep).
// Numeric functions f(t)→eased, t in 0..1, used by the JS animators (core/anim.js,
// svg-draw, motion). The full Penner set (quad…quint, sine, expo, circ) in in/out/
// inout, plus back / elastic / bounce, a real damped SPRING, steps(), and a
// cubic-bezier sampler so CSS-style curves also work in the JS path.
//
//   import { resolveEasing, EASINGS } from './easing.js';
//   const f = resolveEasing('easeOutElastic');   // → fn
//   const f = resolveEasing([.2,.8,.3,1]);        // cubic-bezier control points
//   const f = resolveEasing('spring(1,120,12,0)');// mass,stiffness,damping,velocity
//   const y = f(0.5);
//
// Names accept anime/easings.net style (easeInOutCubic, easeOutBack…), the short
// project aliases (in/out/inout/outBack/outElastic — back-compat with the old
// anim.js table), and CSS-ish (linear, ease-in, ease-out, ease-in-out).
// ─────────────────────────────────────────────────────────────────────────────

const C1 = 1.70158;            // back overshoot
const C2 = C1 * 1.525;         // inout back
const C3 = C1 + 1;
const E_C4 = (2 * Math.PI) / 3; // elastic (out/in)
const E_C5 = (2 * Math.PI) / 4.5; // elastic (inout)

// from an "in" base f(0)=0,f(1)=1, derive out/inout.
const outOf = (fin) => (t) => 1 - fin(1 - t);
const inoutOf = (fin) => (t) => (t < 0.5 ? fin(2 * t) / 2 : 1 - fin(2 - 2 * t) / 2);

const inQuad = (t) => t * t;
const inCubic = (t) => t * t * t;
const inQuart = (t) => t * t * t * t;
const inQuint = (t) => t * t * t * t * t;
const inSine = (t) => 1 - Math.cos((t * Math.PI) / 2);
const inExpo = (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10));
const inCirc = (t) => 1 - Math.sqrt(1 - t * t);
const inBack = (t) => C3 * t * t * t - C1 * t * t;

const outBounce = (t) => {
  const n1 = 7.5625, d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
};

const outElastic = (t) => (t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * E_C4) + 1);
const inElastic = (t) => (t === 0 ? 0 : t === 1 ? 1 : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 0.75) * E_C4));
const inoutElastic = (t) => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5
  ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * E_C5)) / 2
  : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * E_C5)) / 2 + 1);
const inoutBack = (t) => (t < 0.5
  ? (Math.pow(2 * t, 2) * ((C2 + 1) * 2 * t - C2)) / 2
  : (Math.pow(2 * t - 2, 2) * ((C2 + 1) * (t * 2 - 2) + C2) + 2) / 2);

// A real underdamped damped-spring easing, normalized so the response SETTLES by
// t=1 (the envelope decays to ~0.1% at t=1). mass/stiffness/damping/velocity like
// anime.js; default ≈ a lively, lightly-damped bounce.
export function spring(mass = 1, stiffness = 100, damping = 10, velocity = 0) {
  const w0 = Math.sqrt(stiffness / mass);
  let zeta = damping / (2 * Math.sqrt(stiffness * mass));
  zeta = Math.min(0.9999, Math.max(0, zeta));
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  const settle = -Math.log(0.001) / (zeta * w0);            // seconds until envelope ≈ 0.1%
  const b = (zeta * w0 - velocity) / wd;
  return (t) => {
    if (t <= 0) return 0; if (t >= 1) return 1;
    const tau = t * settle;
    return 1 - Math.exp(-zeta * w0 * tau) * (Math.cos(wd * tau) + b * Math.sin(wd * tau));
  };
}

// CSS step() easing — n discrete jumps. pos: 'end' (default) | 'start'.
export function steps(n = 1, pos = 'end') {
  const start = pos === 'start';
  return (t) => {
    if (t <= 0) return 0; if (t >= 1) return 1;
    const s = Math.floor(t * n) / n;
    return start ? Math.min(1, s + 1 / n) : s;
  };
}

// Cubic-bezier sampler (Newton-Raphson + bisection fallback) — so any CSS
// cubic-bezier(x1,y1,x2,y2) curve evaluates as a JS easing fn too.
export function cubicBezier(x1, y1, x2, y2) {
  if (x1 === y1 && x2 === y2) return (t) => t;                // linear shortcut
  const A = (a, b) => 1 - 3 * b + 3 * a, B = (a, b) => 3 * b - 6 * a, Cc = (a) => 3 * a;
  const calc = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + Cc(a)) * t;
  const slope = (t, a, b) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + Cc(a);
  const tForX = (x) => {
    let g = x;
    for (let i = 0; i < 8; i++) { const s = slope(g, x1, x2); if (s === 0) break; g -= (calc(g, x1, x2) - x) / s; }
    let lo = 0, hi = 1, t = x;
    while (lo < hi) { const xv = calc(t, x1, x2); if (Math.abs(xv - x) < 1e-5) break; if (xv < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return g >= 0 && g <= 1 ? g : t;
  };
  return (t) => (t <= 0 ? 0 : t >= 1 ? 1 : calc(tForX(t), y1, y2));
}

// The numeric registry — name → fn. Includes anime/easings.net names, short
// project aliases, and CSS-ish names.
export const EASINGS = {
  linear: (t) => t,
  // back-compat short aliases (old anim.js table)
  in: inQuad, out: outOf(inQuad), inout: inoutOf(inQuad),
  outBack: outOf(inBack), outElastic,
  // CSS-ish
  'ease-in': inSine, 'ease-out': outOf(inSine), 'ease-in-out': inoutOf(inSine),
  // Penner families
  easeInQuad: inQuad, easeOutQuad: outOf(inQuad), easeInOutQuad: inoutOf(inQuad),
  easeInCubic: inCubic, easeOutCubic: outOf(inCubic), easeInOutCubic: inoutOf(inCubic),
  easeInQuart: inQuart, easeOutQuart: outOf(inQuart), easeInOutQuart: inoutOf(inQuart),
  easeInQuint: inQuint, easeOutQuint: outOf(inQuint), easeInOutQuint: inoutOf(inQuint),
  easeInSine: inSine, easeOutSine: outOf(inSine), easeInOutSine: inoutOf(inSine),
  easeInExpo: inExpo, easeOutExpo: outOf(inExpo), easeInOutExpo: inoutOf(inExpo),
  easeInCirc: inCirc, easeOutCirc: outOf(inCirc), easeInOutCirc: inoutOf(inCirc),
  easeInBack: inBack, easeOutBack: outOf(inBack), easeInOutBack: inoutBack,
  easeInElastic: inElastic, easeOutElastic: outElastic, easeInOutElastic: inoutElastic,
  easeInBounce: (t) => 1 - outBounce(1 - t), easeOutBounce: outBounce, easeInOutBounce: (t) => (t < 0.5 ? (1 - outBounce(1 - 2 * t)) / 2 : (1 + outBounce(2 * t - 1)) / 2),
  bounce: outBounce,
  spring: spring(),
};

// Parse a parametric easing string: cubic-bezier(...), spring(...), steps(...).
function parametric(name) {
  const m = /^([a-zA-Z-]+)\s*\(([^)]*)\)$/.exec(name.trim());
  if (!m) return null;
  const fn = m[1].toLowerCase();
  const args = m[2].split(',').map((s) => s.trim()).filter((s) => s !== '').map(Number);
  if (fn === 'cubic-bezier' && args.length === 4) return cubicBezier(...args);
  if (fn === 'spring') return spring(...args);
  if (fn === 'steps') return steps(args[0] || 1, /start/.test(m[2]) ? 'start' : 'end');
  return null;
}

// Resolve any easing spec → a numeric fn. Accepts: a function, a name (registry),
// a parametric string, or a [x1,y1,x2,y2] control-point array. Falls back to `def`.
export function resolveEasing(e, def = 'easeOutQuad') {
  if (typeof e === 'function') return e;
  if (Array.isArray(e) && e.length === 4) return cubicBezier(...e);
  if (typeof e === 'string') {
    if (EASINGS[e]) return EASINGS[e];
    const p = parametric(e);
    if (p) return p;
  }
  return EASINGS[def] || EASINGS.easeOutQuad;
}

// CSS timing-function string for the bezier-expressible names (for CSS-driven
// components — true elastic/bounce/spring can't be a cubic-bezier, so they map to
// their closest single-overshoot bezier and are best run on the JS path instead).
export const CSS_EASINGS = {
  linear: 'linear',
  in: 'cubic-bezier(.55,.085,.68,.53)', out: 'cubic-bezier(.25,.46,.45,.94)', inout: 'cubic-bezier(.45,.05,.55,.95)',
  'ease-in': 'cubic-bezier(.42,0,1,1)', 'ease-out': 'cubic-bezier(0,0,.58,1)', 'ease-in-out': 'ease-in-out',
  easeInQuad: 'cubic-bezier(.55,.085,.68,.53)', easeOutQuad: 'cubic-bezier(.25,.46,.45,.94)', easeInOutQuad: 'cubic-bezier(.455,.03,.515,.955)',
  easeInCubic: 'cubic-bezier(.55,.055,.675,.19)', easeOutCubic: 'cubic-bezier(.215,.61,.355,1)', easeInOutCubic: 'cubic-bezier(.645,.045,.355,1)',
  easeInQuart: 'cubic-bezier(.895,.03,.685,.22)', easeOutQuart: 'cubic-bezier(.165,.84,.44,1)', easeInOutQuart: 'cubic-bezier(.77,0,.175,1)',
  easeInQuint: 'cubic-bezier(.755,.05,.855,.06)', easeOutQuint: 'cubic-bezier(.23,1,.32,1)', easeInOutQuint: 'cubic-bezier(.86,0,.07,1)',
  easeInSine: 'cubic-bezier(.47,0,.745,.715)', easeOutSine: 'cubic-bezier(.39,.575,.565,1)', easeInOutSine: 'cubic-bezier(.445,.05,.55,.95)',
  easeInExpo: 'cubic-bezier(.95,.05,.795,.035)', easeOutExpo: 'cubic-bezier(.19,1,.22,1)', easeInOutExpo: 'cubic-bezier(1,0,0,1)',
  easeInCirc: 'cubic-bezier(.6,.04,.98,.335)', easeOutCirc: 'cubic-bezier(.075,.82,.165,1)', easeInOutCirc: 'cubic-bezier(.785,.135,.15,.86)',
  easeInBack: 'cubic-bezier(.6,-.28,.735,.045)', easeOutBack: 'cubic-bezier(.175,.885,.32,1.275)', easeInOutBack: 'cubic-bezier(.68,-.55,.265,1.55)',
  // physics easings have no exact bezier — closest single overshoot:
  easeOutElastic: 'cubic-bezier(.5,1.6,.5,1)', easeOutBounce: 'cubic-bezier(.34,1.56,.64,1)', spring: 'cubic-bezier(.5,1.6,.5,1)', bounce: 'cubic-bezier(.34,1.56,.64,1)',
};

// CSS timing-function for a name (falls back to the name itself, then a sane out).
export function cssEasing(name) {
  if (!name) return CSS_EASINGS.easeOutQuad;
  if (CSS_EASINGS[name]) return CSS_EASINGS[name];
  if (/^(cubic-bezier|steps)\(/.test(name) || name === 'linear' || name === 'ease' || name === 'ease-in' || name === 'ease-out' || name === 'ease-in-out') return name;
  return CSS_EASINGS.easeOutQuad;
}
