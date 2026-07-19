// core/gl/procgen3d/gen-animation.js — procedural (math-driven) animation graph.
//
// Not keyframes/mocap — poses are computed from time. A "pose" is a map of
// part-name → { rot:[x,y,z] radians, off:[x,y,z] meters } applied to the named
// pivots a character generator exposes (sg.procgen.parts: headPivot, shoulderL/R,
// hipL/R). The animator blends between clips.
//
//   const anim = makeAnimator();
//   anim.play('idle');  anim.blendTo('walk', 0.2);
//   const pose = anim.update(dt);    // → { shoulderL:{rot:[…]}, hipR:{…}, … }
//
// REAL today: idle (breathing bob), walk (opposite arm/leg swing + torso bob +
// head stabilize), run (bigger stride + forward lean). STUBS (fall back to idle):
// jump/fall/land/attack/wave — fill these in the animation phase.

import { register } from './registry.js';

const TAU = Math.PI * 2;
const z = () => ({ rot: [0, 0, 0], off: [0, 0, 0] });

// each clip: (t seconds, speed) → pose. Limb rotations are about local X (swing).
export const CLIPS = {
  idle(t) {
    const b = Math.sin(t * 1.6) * 0.5 + 0.5;          // slow breath
    return {
      headPivot: { rot: [0, 0, 0], off: [0, b * 0.01, 0] },
      shoulderL: { rot: [Math.sin(t * 1.6) * 0.05, 0, 0.08], off: [0, 0, 0] },
      shoulderR: { rot: [Math.sin(t * 1.6 + Math.PI) * 0.05, 0, -0.08], off: [0, 0, 0] },
      hipL: z(), hipR: z(),
      _root: { off: [0, b * 0.015, 0] },
    };
  },
  walk(t, speed = 1) {
    const p = t * TAU * 1.4 * speed, sw = 0.6;
    const bob = Math.abs(Math.sin(p)) * 0.05;
    return {
      headPivot: { rot: [0, 0, 0], off: [0, -bob * 0.4, 0] },   // stabilize head vs bob
      shoulderL: { rot: [Math.sin(p) * sw, 0, 0.06], off: [0, 0, 0] },
      shoulderR: { rot: [Math.sin(p + Math.PI) * sw, 0, -0.06], off: [0, 0, 0] },
      hipL: { rot: [Math.sin(p + Math.PI) * sw, 0, 0], off: [0, 0, 0] }, // legs opposite arms
      hipR: { rot: [Math.sin(p) * sw, 0, 0], off: [0, 0, 0] },
      _root: { off: [0, bob, 0] },
    };
  },
  run(t, speed = 1) {
    const p = t * TAU * 2.1 * speed, sw = 1.05;
    const bob = Math.abs(Math.sin(p)) * 0.09;
    return {
      headPivot: { rot: [0.18, 0, 0], off: [0, -bob * 0.4, 0] },        // forward lean
      shoulderL: { rot: [Math.sin(p) * sw, 0, 0.1], off: [0, 0, 0] },
      shoulderR: { rot: [Math.sin(p + Math.PI) * sw, 0, -0.1], off: [0, 0, 0] },
      hipL: { rot: [Math.sin(p + Math.PI) * sw, 0, 0], off: [0, 0, 0] },
      hipR: { rot: [Math.sin(p) * sw, 0, 0], off: [0, 0, 0] },
      _root: { off: [0, bob, 0], rot: [0.12, 0, 0] },
    };
  },
  // STUBS — return idle for now; real clips land in the animation phase.
  jump(t) { return CLIPS.idle(t); },
  fall(t) { return CLIPS.idle(t); },
  land(t) { return CLIPS.idle(t); },
  attack(t) { return CLIPS.idle(t); },
  wave(t) { return CLIPS.idle(t); },
};

// blend two poses part-by-part (linear) — k=0 → a, k=1 → b.
function blendPose(a, b, k) {
  const out = {}; const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const pa = a[key] || z(), pb = b[key] || z();
    const lerp3 = (u, v) => [u[0] + (v[0] - u[0]) * k, u[1] + (v[1] - u[1]) * k, u[2] + (v[2] - u[2]) * k];
    out[key] = { rot: lerp3(pa.rot || [0, 0, 0], pb.rot || [0, 0, 0]), off: lerp3(pa.off || [0, 0, 0], pb.off || [0, 0, 0]) };
  }
  return out;
}

// animation graph: a current clip, an optional blend target, and a clock.
export function makeAnimator(initial = 'idle') {
  let cur = initial, next = null, blendT = 0, blendDur = 0, t = 0, speed = 1;
  return {
    play(name) { if (CLIPS[name]) { cur = name; next = null; } },
    blendTo(name, dur = 0.2) { if (CLIPS[name] && name !== cur) { next = name; blendDur = Math.max(0.01, dur); blendT = 0; } },
    setSpeed(s) { speed = s; },
    get clip() { return cur; },
    update(dt) {
      t += dt;
      const a = (CLIPS[cur] || CLIPS.idle)(t, speed);
      if (!next) return a;
      blendT += dt;
      const k = Math.min(1, blendT / blendDur);
      const b = (CLIPS[next] || CLIPS.idle)(t, speed);
      const pose = blendPose(a, b, k);
      if (k >= 1) { cur = next; next = null; }
      return pose;
    },
  };
}

// registry entry: returns the animator factory + clip names (data, not a mesh).
register('animation', (params = {}) => ({ animator: makeAnimator(params.initial || 'idle'), clips: Object.keys(CLIPS) }),
  { mesh: false, kind: 'animation' });
