// hud-layout — anchor-based non-overlapping HUD placement (ported from stationvaldosta).
//
// `HudLayout` is the pure solver: widgets either `reserve(name, rect)` a footprint or
// `allocate({w,h,anchor,pad,weight})` a free slot. Allocation walks INTO the screen from the
// anchor edge and takes the first rect that overlaps nothing reserved — the visual analogue of
// physics solidity for UI, so HUD elements can't stack on top of each other.
//
// `placeHud(el, {anchor,pad,weight})` is the DOM adapter: it portals a HUD element to <body>,
// measures it, and positions it (position:fixed left/top) into a SHARED viewport layout so ALL
// registered HUD elements route around one another. Re-solves on resize / add / remove.

const ANCHORS = {
  'top-left':      { ox: 0,   oy: 0,   sx: 0, sy: 1 },
  'top-right':     { ox: 1,   oy: 0,   sx: 0, sy: 1 },
  'bottom-left':   { ox: 0,   oy: 1,   sx: 0, sy: -1 },
  'bottom-right':  { ox: 1,   oy: 1,   sx: 0, sy: -1 },
  'top-center':    { ox: 0.5, oy: 0,   sx: 0, sy: 1 },
  'bottom-center': { ox: 0.5, oy: 1,   sx: 0, sy: -1 },
  'left-center':   { ox: 0,   oy: 0.5, sx: 1, sy: 0 },
  'right-center':  { ox: 1,   oy: 0.5, sx: -1, sy: 0 },
};
const rectsOverlap = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

export class HudLayout {
  constructor(width, height) { this.w = width; this.h = height; this.ins = { l: 0, t: 0, r: 0, b: 0 }; this.reserved = []; this.allocations = []; }
  reset(width, height, ins) { this.w = width; this.h = height; this.ins = ins || { l: 0, t: 0, r: 0, b: 0 }; this.reserved.length = 0; this.allocations.length = 0; }
  reserve(name, rect) { this.reserved.push({ name, rect }); return rect; }
  allocate({ w, h, anchor = 'top-left', pad = 4, weight = 0, name }) {
    const ref = { x: 0, y: 0, w, h };
    this.allocations.push({ ref, anchor, pad, weight, name, w, h });
    this._resolve();
    return ref;
  }
  _resolve() {
    this.reserved = this.reserved.filter((r) => !r._alloc);
    const groups = new Map();
    for (const a of this.allocations) { let g = groups.get(a.anchor); if (!g) groups.set(a.anchor, g = []); g.push(a); }
    for (const [, list] of groups) {
      list.sort((a, b) => b.weight - a.weight);                 // heaviest sits closest to the edge
      for (const item of list) {
        const slot = this._findSlot(item);
        if (slot) { item.ref.x = slot.x; item.ref.y = slot.y; this.reserved.push({ name: item.name || '<alloc>', rect: item.ref, _alloc: true }); }
        else { item.ref.x = -9999; item.ref.y = -9999; }        // off-screen sentinel (nowhere fits)
      }
    }
  }
  _findSlot({ w, h, anchor, pad }) {
    const a = ANCHORS[anchor] || ANCHORS['top-left'];
    // Usable region is INSET by safe-area insets (notches / rounded corners), so
    // edge-anchored widgets never tuck under a notch or the rounded screen corner.
    const ins = this.ins || { l: 0, t: 0, r: 0, b: 0 };
    const minX = ins.l, minY = ins.t, maxX = this.w - ins.r, maxY = this.h - ins.b;
    const baseX = a.ox === 0 ? minX + pad : a.ox === 1 ? maxX - w - pad : Math.round((minX + maxX - w) / 2);
    const baseY = a.oy === 0 ? minY + pad : a.oy === 1 ? maxY - h - pad : Math.round((minY + maxY - h) / 2);
    const stepX = a.sx * (w + pad), stepY = a.sy * (h + pad);
    for (let i = 0; i < 64; i++) {
      const rect = { x: Math.round(baseX + stepX * i), y: Math.round(baseY + stepY * i), w, h };
      if (rect.x < minX || rect.y < minY || rect.x + rect.w > maxX || rect.y + rect.h > maxY) return null;
      let clear = true;
      for (const r of this.reserved) if (rectsOverlap(rect, r.rect)) { clear = false; break; }
      if (clear) return rect;
    }
    return null;
  }
}

// ── shared DOM HUD manager ─────────────────────────────────────────────────────
const shared = typeof window !== 'undefined' ? new HudLayout(window.innerWidth, window.innerHeight) : null;
const entries = [];          // { el, anchor, pad, weight, id }
let raf = 0;

// Safe-area insets (notch / rounded corners / home indicator) measured from a probe
// element, cached, invalidated on resize (orientation change alters them).
let _ins = null;
function safeInsets() {
  if (_ins) return _ins;
  if (typeof document === 'undefined') return { l: 0, t: 0, r: 0, b: 0 };
  const p = document.createElement('div');
  p.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.appendChild(p);
  const cs = getComputedStyle(p);
  _ins = { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
  p.remove();
  return _ins;
}

// Fixed on-screen UI that HUD slots must route AROUND (its live bounding rect is
// reserved each solve). Selectors or elements. The wallet button + anything tagged
// [data-hud-reserve] are reserved by default; a game adds a minimap / joystick / etc.
const domReserves = new Set(['#wallet-button', '[data-hud-reserve]']);
export function reserveHudRegion(selectorOrEl) { domReserves.add(selectorOrEl); schedule(); }
export function unreserveHudRegion(selectorOrEl) { domReserves.delete(selectorOrEl); schedule(); }

function solve() {
  if (!shared) return;
  shared.reset(window.innerWidth, window.innerHeight, safeInsets());
  // reserve fixed UI regions so allocated slots never overlap them
  for (const sel of domReserves) {
    const els = typeof sel === 'string' ? document.querySelectorAll(sel) : [sel];
    els.forEach((el) => {
      if (!el || (el.offsetParent === null && el !== document.body)) return;   // skip display:none
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) shared.reserve('dom', { x: r.left, y: r.top, w: r.width, h: r.height });
    });
  }
  for (const e of entries) {
    const w = e.el.offsetWidth || 1, h = e.el.offsetHeight || 1;
    e.ref = shared.allocate({ w, h, anchor: e.anchor, pad: e.pad, weight: e.weight, name: e.id });
  }
  for (const e of entries) {
    const r = e.ref; if (!r) continue;
    e.el.style.position = 'fixed';
    e.el.style.left = `${r.x}px`;
    e.el.style.top = `${r.y}px`;
    if (!e.el.style.zIndex) e.el.style.zIndex = '9000';
  }
}
const schedule = () => { if (!raf && shared) raf = requestAnimationFrame(() => { raf = 0; solve(); }); };
if (typeof window !== 'undefined') window.addEventListener('resize', () => { _ins = null; schedule(); });

// Portal `el` to <body> and place it at `anchor` without overlapping any other placed HUD element.
// Returns an unregister fn. Re-measures a frame later (content lays out async) and re-solves.
export function placeHud(el, { anchor = 'top-left', pad = 8, weight = 0, id } = {}) {
  const entry = { el, anchor, pad, weight, id };
  entries.push(entry);
  document.body.appendChild(el);
  schedule();
  requestAnimationFrame(schedule);   // re-measure after layout
  return () => { const i = entries.indexOf(entry); if (i >= 0) entries.splice(i, 1); el.remove(); schedule(); };
}
export const reflowHud = schedule;
