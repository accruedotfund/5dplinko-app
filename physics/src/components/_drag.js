// ─────────────────────────────────────────────────────────────────────────────
// _drag.js — a tiny POINTER-drag helper shared by inventory / chest / draggable.
//
// Uses Pointer Events (not HTML5 drag-and-drop): works on touch + Safari, lets us
// render a custom ghost, and reports drop targets. A press that never passes the
// `threshold` is treated as a CLICK (onEnd fires with moved:false) so the same
// element can be both clickable and draggable.
//
//   onDrag(handle, {
//     threshold?: 4,                       // px before a press becomes a drag
//     onStart?: ({x,y}) => void,           // first move past threshold
//     onMove?:  ({x,y,dx,dy}) => void,     // every move while dragging
//     onEnd?:   ({x,y,dx,dy,moved,target}) => void, // pointer up / cancel
//   }) → cleanup()
//
// `target` on onEnd is the element under the pointer at release (ghost ignored).
// ─────────────────────────────────────────────────────────────────────────────

export function onDrag(handle, { threshold = 4, onStart, onMove, onEnd } = {}) {
  const down = (e) => {
    if (e.button != null && e.button > 0) return; // primary button / touch only
    const sx = e.clientX, sy = e.clientY;
    let active = false, done = false;

    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!active && Math.hypot(dx, dy) >= threshold) {
        active = true;
        onStart?.({ x: ev.clientX, y: ev.clientY });
      }
      if (active) { ev.preventDefault(); onMove?.({ x: ev.clientX, y: ev.clientY, dx, dy }); }
    };
    const up = (ev) => {
      if (done) return; done = true; // run exactly once (up / cancel / lostcapture)
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.removeEventListener('lostpointercapture', up);
      try { handle.releasePointerCapture(e.pointerId); } catch { /* */ }
      // Make the dragged element transparent to hit-testing ONLY NOW, so onEnd's
      // elementFromPoint/slotAtPoint sees the slot/canvas UNDERNEATH it. We must
      // NOT do this during the drag: pointer-events:none on a pointer-CAPTURED
      // element breaks move/up delivery in WebKit → onEnd never fires, leaving a
      // stuck ghost + an uncleared slot ("a piece left behind"). The drag is over
      // here, so disabling it now is safe.
      const prevPE = handle.style.pointerEvents;
      if (active) handle.style.pointerEvents = 'none';
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      onEnd?.({ x: ev.clientX, y: ev.clientY, dx: ev.clientX - sx, dy: ev.clientY - sy, moved: active, target });
      handle.style.pointerEvents = prevPE; // restore (no-op if the node was removed)
    };

    try { handle.setPointerCapture(e.pointerId); } catch { /* */ }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    handle.addEventListener('lostpointercapture', up); // safety net: never strand a ghost
  };

  handle.addEventListener('pointerdown', down);
  return () => handle.removeEventListener('pointerdown', down);
}

// A floating "ghost" that follows the pointer during a drag. Cloned visual of the
// dragged thing; pointer-events:none so elementFromPoint sees through it.
export function makeGhost(node, x, y) {
  const ghost = document.createElement('div');
  ghost.className = 'pf-drag-ghost';
  ghost.setAttribute('data-role', 'drag-ghost');
  ghost.appendChild(node);
  // SELF-CLEAN: a ghost must never outlive the drag. A DOCUMENT-level pointerup/
  // cancel (capture phase) fires on release regardless of the dragged element's
  // pointer-events or capture state — so even if the owner's onEnd never runs
  // (the WebKit pointer-capture quirk), the ghost still removes itself.
  const kill = () => {
    ghost.remove();
    document.removeEventListener('pointerup', kill, true);
    document.removeEventListener('pointercancel', kill, true);
  };
  document.addEventListener('pointerup', kill, true);
  document.addEventListener('pointercancel', kill, true);
  // position + move via transform (composited; no WebKit repaint trails). Folds in
  // the -50% centering and the slight scale that used to be CSS individual props.
  const place = (nx, ny) => { ghost.style.transform = `translate(${nx}px, ${ny}px) translate(-50%, -50%) scale(1.15)`; };
  place(x, y);
  document.body.appendChild(ghost);
  return {
    el: ghost,
    move: place,
    destroy: kill, // owner's explicit destroy also detaches the self-clean listeners
  };
}
