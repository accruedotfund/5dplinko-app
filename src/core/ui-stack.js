// ─────────────────────────────────────────────────────────────────────────────
// ui-stack.js — a shared modal/overlay FOCUS stack for the menu UI primitives
// (menu · dialog · radial …). Open overlays push a token; the TOP token owns the
// keyboard. A base (non-overlay) widget is active only when the stack is empty. This
// gives consistent modal capture + layering ACROSS the different components (a dialog
// over a menu freezes the menu; a menu over a dialog freezes the dialog; etc.).
// ─────────────────────────────────────────────────────────────────────────────

const STACK = [];
const LISTENERS = new Set();

// change notifications fire SYNCHRONOUSLY inside push/pop — i.e. still within
// the user gesture (click/keydown) that opened/closed the modal. Pointer-lock
// re-acquisition (gl-scene) depends on that: requestPointerLock outside a
// gesture is rejected by the browser.
function notify() { for (const fn of LISTENERS) { try { fn(); } catch { /* listener's problem */ } } }
export function onStackChange(fn) { LISTENERS.add(fn); return () => LISTENERS.delete(fn); }

export function pushModal(token) { if (token && !STACK.includes(token)) { STACK.push(token); notify(); } }
export function popModal(token) { const i = STACK.indexOf(token); if (i >= 0) { STACK.splice(i, 1); notify(); } }
export function isTop(token) { return STACK.length > 0 && STACK[STACK.length - 1] === token; }
export function modalOpen() { return STACK.length > 0; }
