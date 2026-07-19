// ─────────────────────────────────────────────────────────────────────────────
// _canvas.js — a shared, body-portaled STAGE for things dropped onto the world stage
// (items dragged out of an inventory, `draggable` props, sprites…).
//
// The stage is a UNIFORM WORLD: a fixed-aspect canvas (REF, matching the scene
// image) that is COVER-scaled to the viewport and centered via a single transform.
// Everything inside is positioned + sized in WORLD coordinates, so it all scales
// as ONE unit — positions stay locked relative to each other and to the scene,
// sizes stay proportional, and a resize just re-fits the stage (one transform, no
// transition) instead of repositioning every item (which caused drift + "snap
// back"). Items still persist across overlay churn and are drag/double-click.
// ─────────────────────────────────────────────────────────────────────────────

import { h } from '../core/dom.js';
import { onDrag } from './_drag.js';

// Reference world size. Set per-app via manifest `config.world`; defaults to 3:2
// (1536×1024 = thegreatforest.png). For a perfect lock, match it to the scene's
// image aspect (a 16:9 scene → {width:1280,height:720}); items lock to EACH OTHER
// regardless of the value.
// REF = the FULL world (the whole scene, incl. decorative margins). PLAY = the
// central SAFE AREA where gameplay/content lives. When REF is WIDER than the
// screen, cover scales by HEIGHT → full vertical content is always visible and
// only the decorative margins (the difference between REF and PLAY) crop — so
// nothing in the play area is ever cropped, with no letterbox. PLAY defaults to
// REF (no margins). Content x/y% are % of PLAY; toStage/dropped use REF coords.
const REF = { w: 1536, h: 1024 };
const PLAY = { w: 1536, h: 1024 };
let PX = 0, PY = 0;          // play-area offset within REF (centered)
let FIT = 'cover';           // 'cover' = fill the screen (crop overflow, NO letterbox)
let FX = 0.5, FY = 0.5;      // focal point of the crop, 0..1 (like object-position)
let S = 1, TX = 0, TY = 0;
const stages = new Map();    // z-index → REF layer (all share ONE transform)
const plays = new Map();     // z-index → PLAY sub-layer (for %-positioned components)
let resizeBound = false;

let explicit = false;                 // did the manifest set config.world?
const worldListeners = new Set();
export function onWorldChange(fn) { worldListeners.add(fn); return () => worldListeners.delete(fn); }

function applyWorld(world) {
  if (world?.width) REF.w = world.width;
  if (world?.height) REF.h = world.height;
  PLAY.w = world?.play?.width ?? REF.w;
  PLAY.h = world?.play?.height ?? REF.h;
  PX = (REF.w - PLAY.w) / 2;
  PY = (REF.h - PLAY.h) / 2;
  if (world?.fit) FIT = world.fit;
  if (world?.focusX != null) FX = world.focusX;
  if (world?.focusY != null) FY = world.focusY;
  for (const pl of plays.values()) { pl.style.left = `${PX}px`; pl.style.top = `${PY}px`; pl.style.width = `${PLAY.w}px`; pl.style.height = `${PLAY.h}px`; }
  fit();
  for (const fn of worldListeners) fn(); // content re-resolves its play-% position
}
// explicit manifest config (wins over auto-derived)
export function configureWorld(world) { if (world) { explicit = true; applyWorld(world); } }
// auto-derived by the `scene` from its image (only if the manifest didn't set one)
export function autoConfigureWorld(world) { if (!explicit) applyWorld(world); }
export function worldSize() { return { w: REF.w, h: REF.h }; }
export function playSize() { return { w: PLAY.w, h: PLAY.h }; }
export function worldFit() { return { fit: FIT, focusX: FX, focusY: FY }; }

function fit() {
  // COVER (default) fills the screen with NO letterboxing, cropping the overflow at
  // the focal anchor (FX/FY) — FY>0.5 crops the sky and keeps the ground/content.
  // CONTAIN fits the whole world (letterboxed; scene adds a blurred fill).
  const sx = window.innerWidth / REF.w, sy = window.innerHeight / REF.h;
  S = FIT === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
  TX = (window.innerWidth - REF.w * S) * FX;
  TY = (window.innerHeight - REF.h * S) * FY;
  for (const el of stages.values()) {
    el.style.width = `${REF.w}px`; el.style.height = `${REF.h}px`;
    el.style.transform = `translate(${TX}px, ${TY}px) scale(${S})`;
  }
}

// A world STAGE layer at z-index `z`. Multiple layers (scene behind, hotspots,
// sprites, dropped items in front) all share the SAME cover transform, so every
// world layer scales as one unit. Children positioned in % are world-relative.
export function worldLayer(z = 945) {
  let layer = stages.get(z);
  if (!layer || !layer.isConnected) {
    layer = h('div', { class: 'pf-world', 'data-world': String(z) });
    layer.style.cssText = `position:fixed;left:0;top:0;width:${REF.w}px;height:${REF.h}px;transform-origin:0 0;z-index:${z};pointer-events:none;`;
    document.body.appendChild(layer);
    stages.set(z, layer);
    if (!resizeBound) { window.addEventListener('resize', fit); resizeBound = true; }
    fit();
  }
  return layer;
}

// A PLAY sub-layer at z: a PLAY-sized box at the play offset INSIDE worldLayer(z),
// so a child positioned in % is relative to the PLAY area (gameplay coords), while
// the scene (in the REF layer) extends into the margins. For %-positioned world
// components (hotspots, spline, chest).
export function playLayer(z = 6) {
  let pl = plays.get(z);
  if (!pl || !pl.isConnected) {
    pl = h('div', { class: 'pf-play', 'data-play': String(z) });
    pl.style.cssText = `position:absolute;left:${PX}px;top:${PY}px;width:${PLAY.w}px;height:${PLAY.h}px;pointer-events:none;`;
    worldLayer(z).appendChild(pl);
    plays.set(z, pl);
  }
  return pl;
}

// viewport px → REF world coords (inverse of the shared stage transform)
export function toStage(vx, vy) { worldLayer(); return { x: (vx - TX) / S, y: (vy - TY) / S }; }
// PLAY % → REF world px (declarative placement, e.g. draggable x/y — in the safe area)
export function pctToStage(xPct, yPct) { return { x: PX + (xPct / 100) * PLAY.w, y: PY + (yPct / 100) * PLAY.h }; }

// Drop `node` onto the stage at WORLD point (sx, sy) — centered there, draggable to
// reposition, optional double-click to remove. Position + scale are one transform
// (no left/top → no WebKit repaint trails). `onDrop({x,y})` gets VIEWPORT coords
// (for slot hit-testing); truthy = claimed elsewhere, so this element removes itself.
export function dropOnWorld(node, sx, sy, { draggable = true, removeOnDblClick = true, onRemove, onClick, onDrop, id } = {}) {
  const host = worldLayer(945);
  const item = h('div', { class: 'pf-spawned', 'data-role': 'spawned', 'data-spawned': id || null }, node);
  host.appendChild(item);

  let s = 0; // scale: 0→1 entrance, 1.12 grab, 0 exit
  const render = () => { item.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%) scale(${s})`; };
  render();
  requestAnimationFrame(() => { s = 1; item.style.opacity = '1'; render(); }); // entrance pop

  let off = { x: 0, y: 0 };
  let cleanup = () => {};
  if (draggable) {
    cleanup = onDrag(item, {
      onStart: ({ x, y }) => {
        const r = item.getBoundingClientRect();
        const cS = toStage(r.left + r.width / 2, r.top + r.height / 2), pS = toStage(x, y);
        off = { x: pS.x - cS.x, y: pS.y - cS.y };
        s = 1.12; item.classList.add('is-dragging'); render(); // .is-dragging kills the transition → instant follow
      },
      onMove: ({ x, y }) => { const p = toStage(x, y); sx = p.x - off.x; sy = p.y - off.y; render(); },
      onEnd: ({ x, y, moved }) => {
        if (!moved) { s = 1; item.classList.remove('is-dragging'); render(); onClick?.(); return; }
        const claimed = onDrop ? onDrop({ x, y }) : false; // viewport coords for slot hit-testing
        s = 1; item.classList.remove('is-dragging'); render();
        if (claimed) { cleanup(); item.remove(); } // moved into a slot
      },
    });
  }

  const remove = () => {
    cleanup();
    s = 0; item.style.opacity = '0'; render(); // exit
    setTimeout(() => item.remove(), 200);
    onRemove?.();
  };
  if (removeOnDblClick) item.addEventListener('dblclick', remove);

  // reposition to a new WORLD point (e.g. when the world is re-derived on scene load)
  const setWorld = (nx, ny) => { sx = nx; sy = ny; render(); };
  return { el: item, remove, setWorld };
}

// deprecated alias — the world stage used to be called "the canvas" (which clashed
// with HTML <canvas>). Kept so older imports keep working; prefer dropOnWorld.
export const dropOnCanvas = dropOnWorld;
