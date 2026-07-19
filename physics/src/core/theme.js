// ─────────────────────────────────────────────────────────────────────────────
// theme.js — runtime theme switching via a [data-theme] attribute on <html>.
//
// Themes are pure CSS-variable sets in styles/themes.css; this module just flips
// the attribute, persists the choice to localStorage, and mirrors it into the
// store (key 'ui:theme') so a `select`/badge can reflect it. Because every
// component (and the proofwallet button override) reads --pf-* vars, switching
// the attribute re-themes the whole app — no component touches needed.
//
// To avoid a flash of the default theme, index.html sets the attribute from
// localStorage inline before first paint; this reconciles on boot.
// ─────────────────────────────────────────────────────────────────────────────

const LS_KEY = 'prooffront:theme';

const BUILTIN = [
  { id: 'retro', label: 'Retro (orange)' },
  { id: 'midnight', label: 'Midnight (blue)' },
  { id: 'hacker', label: 'Hacker (green)' },
  { id: 'amber', label: 'Amber' },
];

export function initTheme({ store, bus, config = {} }) {
  const list = config.list || BUILTIN;
  const fallback = config.default || 'retro';
  const valid = (id) => list.some((t) => t.id === id);

  const stored = safeGet();
  let current = valid(stored) ? stored : fallback;
  apply(current);

  function apply(id) {
    document.documentElement.setAttribute('data-theme', id);
    current = id;
    store.set('ui:theme', id);
    bus.emit('theme:changed', id);
  }

  function set(id) {
    if (!valid(id) || id === current) return;
    safeSet(id);
    apply(id);
  }

  function next() {
    const i = list.findIndex((t) => t.id === current);
    set(list[(i + 1) % list.length].id);
  }

  return { list, get: () => current, set, next };
}

function safeGet() {
  try { return localStorage.getItem(LS_KEY); } catch { return null; }
}
function safeSet(v) {
  try { localStorage.setItem(LS_KEY, v); } catch { /* private mode */ }
}
