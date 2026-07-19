// core/gl/fps-input.js — pointer-lock mouselook + WASD state for FPS control.
//
//   const inp = createFPSInput(canvas, { sensitivity, onLock, onUnlock });
//   inp.getInput()              → { fwd, right, jump, sprint, yaw }
//   inp.getViewMatrix(eye, out) → mat4 view from yaw/pitch
//   inp.lookDir(out)            → forward unit vector (for hitscan)
//
// Safari/WebKit: requestPointerLock must NOT be passed {unadjustedMovement:true}
// (throws NotSupportedError). We try the options form and fall back to the
// bare call. Click-to-lock is wired by the caller (gl-scene), not here, so
// overlay UI can stopPropagation() on pointerdown per CLAUDE.md §9.

import { vec3, mat4 } from './math.js';

const KEYMAP = {
  KeyW: 'fwd+', ArrowUp: 'fwd+', KeyS: 'fwd-', ArrowDown: 'fwd-',
  KeyD: 'right+', ArrowRight: 'right+', KeyA: 'right-', ArrowLeft: 'right-',
  Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint',
  KeyC: 'down', ControlLeft: 'down',   // swim descend (land controllers ignore it)
};

export function createFPSInput(canvas, spec = {}) {
  let sensitivity = spec.sensitivity ?? 0.0022;
  // pitch clamp. Default ~85°. `freeLook:true` → unlimited (full 360° vertical;
  // the view flips past vertical, like a spectator cam). `pitchLimit` (degrees)
  // sets a custom cap.
  const pitchLimit = spec.freeLook ? Infinity
    : (spec.pitchLimit != null ? spec.pitchLimit * Math.PI / 180 : Math.PI / 2 - 0.05);
  // lock target: a PERSISTENT element (e.g. document.body) keeps the pointer
  // locked across level swaps that destroy the canvas; default = the canvas
  const lockEl = spec.lockEl || canvas;

  let yaw = spec.yaw ?? 0, pitch = spec.pitch ?? 0;
  let locked = false, frozen = false; // frozen: cutscenes — ignore look + keys
  const keys = { 'fwd+': 0, 'fwd-': 0, 'right+': 0, 'right-': 0, jump: 0, sprint: 0, down: 0 };
  const input = { fwd: 0, right: 0, jump: false, sprint: false, yaw: 0, up: 0, pitch: 0 };

  function requestLock() {
    // bare retry, rejection swallowed — the lock can legitimately refuse
    // (ESC cooldown, unfocused document); the user just clicks again
    const bare = () => { try { lockEl.requestPointerLock()?.catch?.(() => {}); } catch { /* ignore */ } };
    try {
      // options form (never unadjustedMovement:true — Safari throws)
      const p = lockEl.requestPointerLock({ unadjustedMovement: false });
      if (p?.catch) p.catch(bare);
    } catch { bare(); }
  }
  function exitLock() { if (locked) document.exitPointerLock?.(); }

  const onLockChange = () => {
    locked = document.pointerLockElement === lockEl;
    if (locked) spec.onLock?.(); else { resetKeys(); spec.onUnlock?.(); }
  };
  let lookDX = 0, lookDY = 0; // raw mouse movement since last consume (sway)
  let aimHeld = false;        // right mouse button while locked (ADS)
  const onMove = (e) => {
    if (!locked || frozen) return;
    yaw -= e.movementX * sensitivity;
    pitch -= e.movementY * sensitivity;
    if (pitch > pitchLimit) pitch = pitchLimit;
    if (pitch < -pitchLimit) pitch = -pitchLimit;
    lookDX += e.movementX; lookDY += e.movementY;
  };
  const onButton = (down) => (e) => {
    if (e.button !== 2) return;
    if (locked) { aimHeld = down; e.preventDefault(); }
    else if (!down) aimHeld = false;
  };
  const onButtonDown = onButton(true), onButtonUp = onButton(false);
  const onContextMenu = (e) => { if (locked) e.preventDefault(); };
  const onKey = (down) => (e) => {
    if (!locked || frozen) return;
    const k = KEYMAP[e.code];
    if (!k) return;
    keys[k] = down ? 1 : 0;
    e.preventDefault();
  };
  const onKeyDown = onKey(true), onKeyUp = onKey(false);
  const resetKeys = () => { for (const k in keys) keys[k] = 0; };

  document.addEventListener('pointerlockchange', onLockChange);
  // adopt an ALREADY-HELD lock (level swap: fresh input, same persistent lockEl)
  if (document.pointerLockElement === lockEl) { locked = true; spec.onLock?.(); }
  document.addEventListener('mousemove', onMove);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  // mousedown/up, NOT pointerdown/up: a mouse is ONE pointer, so chorded
  // buttons (LMB while RMB held = fire while ADS) never fire a 2nd pointerdown
  document.addEventListener('mousedown', onButtonDown);
  document.addEventListener('mouseup', onButtonUp);
  document.addEventListener('contextmenu', onContextMenu);

  function getInput() {
    input.fwd = keys['fwd+'] - keys['fwd-'];
    input.right = keys['right+'] - keys['right-'];
    input.jump = !!keys.jump;
    input.sprint = !!keys.sprint;
    input.yaw = yaw;
    input.up = keys.jump - keys.down;   // swim vertical axis: Space=up, C/Ctrl=down
    input.pitch = pitch;                 // swim moves along the look direction
    return input;
  }

  // view = R(-pitch) * R(-yaw) * T(-eye)   (column-major, -Z forward)
  function getViewMatrix(eye, out = mat4()) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    // basis vectors
    const rx = cy, ry = 0, rz = -sy;                 // right
    const ux = sy * sp, uy = cp, uz = cy * sp;       // up
    const fx = -sy * cp, fy = sp, fz = -cy * cp;     // forward (look dir)
    out[0] = rx; out[1] = ux; out[2] = -fx; out[3] = 0;
    out[4] = ry; out[5] = uy; out[6] = -fy; out[7] = 0;
    out[8] = rz; out[9] = uz; out[10] = -fz; out[11] = 0;
    out[12] = -(rx * eye[0] + ry * eye[1] + rz * eye[2]);
    out[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
    out[14] = (fx * eye[0] + fy * eye[1] + fz * eye[2]);
    out[15] = 1;
    return out;
  }

  function lookDir(out = vec3()) {
    const cp = Math.cos(pitch);
    out[0] = -Math.sin(yaw) * cp;
    out[1] = Math.sin(pitch);
    out[2] = -Math.cos(yaw) * cp;
    return out;
  }

  // raw look delta since last call — feel layers read this for weapon sway
  function consumeLookDelta(out = [0, 0]) {
    out[0] = lookDX; out[1] = lookDY;
    lookDX = 0; lookDY = 0;
    return out;
  }

  function destroy() {
    // only release the lock if WE own the element — a shared/persistent lockEl
    // (document.body across level swaps) must keep the lock through teardown
    if (locked && lockEl === canvas) exitLock();
    document.removeEventListener('pointerlockchange', onLockChange);
    document.removeEventListener('mousemove', onMove);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('mousedown', onButtonDown);
    document.removeEventListener('mouseup', onButtonUp);
    document.removeEventListener('contextmenu', onContextMenu);
  }

  return {
    requestLock, exitLock, getInput, getViewMatrix, lookDir, destroy, consumeLookDelta,
    get locked() { return locked; },
    get yaw() { return yaw; }, set yaw(v) { yaw = v; },
    get frozen() { return frozen; },
    set frozen(v) { frozen = !!v; if (frozen) resetKeys(); },
    get pitch() { return pitch; }, set pitch(v) { pitch = v; },
    get aim() { return aimHeld; },
    get sensitivity() { return sensitivity; }, set sensitivity(v) { sensitivity = v; },
  };
}
