// ─────────────────────────────────────────────────────────────────────────────
// dom.js — hyperscript + a tiny "live region" helper. No framework.
//
// `h(tag, props, ...children)` builds real DOM nodes. It is deliberately small:
// it covers attributes, `class`, `style` objects, `on*` event handlers, the
// mandatory `data-*` convention, and child flattening. That is enough to drive
// every component declaratively from the manifest.
//
// `live(store, keys, render)` returns a node that re-renders itself whenever any
// of the named store keys change — this is how data flows to the screen.
// ─────────────────────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set([
  'svg', 'path', 'circle', 'rect', 'g', 'line', 'polyline', 'polygon', 'text',
  'ellipse', 'defs', 'linearGradient', 'radialGradient', 'stop', 'use', 'clipPath', 'tspan',
]);

export function h(tag, props = {}, ...children) {
  const el = SVG_TAGS.has(tag)
    ? document.createElementNS(SVG_NS, tag)
    : document.createElement(tag);

  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;

    if (key === 'class' || key === 'className') {
      el.setAttribute('class', Array.isArray(value) ? value.filter(Boolean).join(' ') : value);
    } else if (key === 'style' && typeof value === 'object') {
      // CSS custom properties (--x) need setProperty — Object.assign(el.style, …)
      // silently no-ops on them. Route those through setProperty; everything else
      // keeps the camelCase assignment Object.assign did. Skip nullish values.
      for (const [k, v] of Object.entries(value)) {
        if (v == null) continue;
        if (k.startsWith('--')) el.style.setProperty(k, v);
        else el.style[k] = v;
      }
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.assign(el.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') {
      el.innerHTML = value; // caller owns trust of this string
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, value);
    }
  }

  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

// Replace the contents of `el` with `nodes` (array | node | string).
export function mount(el, nodes) {
  el.replaceChildren();
  appendChildren(el, [nodes]);
  return el;
}

// A self-updating container. `render(store)` returns nodes; it re-runs whenever
// any subscribed key changes. Returns { el, destroy }.
export function live(store, keys, render, wrapper = { tag: 'div', props: {} }) {
  const el = h(wrapper.tag, { 'data-live': keys.join(','), ...wrapper.props });
  const rerender = () => mount(el, render(store));
  const unsubs = keys.map((k) => store.subscribe(k, rerender));
  rerender();
  return {
    el,
    destroy() {
      unsubs.forEach((u) => u());
    },
  };
}

// ── Keyed list reconciliation ────────────────────────────────────────────────
// Update a list IN PLACE: reuse existing nodes by key, create only new ones,
// remove gone ones, reorder the rest. Unlike mount() (which replaceChildren and
// recreates everything — re-triggering CSS enter-animations and churning the
// DOM), only genuinely-new rows are created, so only THEY animate.
//
//   keyedList(parent, items, {
//     key?:    (item, i) => any,        // identity (default: index)
//     create:  (item, i) => Node,       // build a new row
//     update?: (node, item, i) => void, // refresh a reused row (optional)
//   })
const LIST_KEYS = new WeakMap();

export function keyedList(parent, items, { key, create, update } = {}) {
  const prev = LIST_KEYS.get(parent) || new Map();
  const next = new Map();
  const ordered = [];

  items.forEach((item, i) => {
    const k = key ? key(item, i) : i;
    let node = prev.get(k);
    if (node) update?.(node, item, i); // reuse
    else node = create(item, i);       // create new (this one animates)
    next.set(k, node);
    ordered.push(node);
  });

  // remove anything not in the new set (covers gone keys AND stray nodes)
  const keep = new Set(ordered);
  for (const child of [...parent.childNodes]) if (!keep.has(child)) child.remove();

  // place nodes in order, inserting/moving only when needed
  let cursor = parent.firstChild;
  for (const node of ordered) {
    if (node === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(node, cursor);
  }

  LIST_KEYS.set(parent, next);
  return parent;
}

// Forget a parent's keyed state (call before switching it to non-keyed content).
export function clearKeyed(parent) {
  LIST_KEYS.delete(parent);
}

// Resolve a mount target: accepts an Element or a CSS selector string.
export function resolveTarget(target) {
  if (target instanceof Element) return target;
  const el = document.querySelector(target);
  if (!el) throw new Error(`[dom] mount target not found: ${target}`);
  return el;
}
