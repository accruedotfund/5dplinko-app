// ─────────────────────────────────────────────────────────────────────────────
// store.js — a minimal reactive key/value store.
//
// This is the spine of the "data-driven" design: every screen renders from data
// held here, and components subscribe to the keys they care about. There is no
// virtual DOM and no framework — a component re-renders its own subtree when a
// key it subscribed to changes.
//
// Keys are namespaced strings, e.g. 'wallet', 'view:leaderboard', 'abi'.
// Values are plain data. Treat them as immutable: always `set` a new value
// rather than mutating in place, so subscribers reliably fire.
// ─────────────────────────────────────────────────────────────────────────────

export function createStore(initial = {}) {
  const state = new Map(Object.entries(initial));
  const initialKeys = new Set(Object.keys(initial));
  const initialSnapshot = safeClone(initial); // for reset()
  /** @type {Map<string, Set<Function>>} */
  const subs = new Map();
  const wildcards = new Set();

  // batch() coalesces notifications: sets during a batch fire once, at the end.
  let batching = false;
  const pending = new Map(); // key -> prev value (recorded on first change)

  function get(key) {
    return state.get(key);
  }

  function set(key, value) {
    const prev = state.get(key);
    if (Object.is(prev, value)) return value;
    state.set(key, value);
    if (batching) { if (!pending.has(key)) pending.set(key, prev); }
    else notify(key, value, prev);
    return value;
  }

  // Functional update: update('count', n => n + 1)
  function update(key, updater) {
    return set(key, updater(state.get(key)));
  }

  // Shallow-merge into an existing object value (or seed a fresh one).
  function patch(key, partial) {
    const next = { ...(state.get(key) || {}), ...partial };
    return set(key, next);
  }

  // ── Nested / path updates — modify ONE deep field, immutably ────────────────
  // path: 'wallet.profile.name' or ['wallet','profile','name']. The first segment
  // is the store key; the rest is the path inside that key's value. Only the spine
  // along the path is cloned (siblings keep their reference), then the key is set.
  function getIn(path) {
    const [key, ...rest] = toParts(path);
    let node = state.get(key);
    for (const k of rest) { if (node == null) return undefined; node = node[k]; }
    return node;
  }

  function setIn(path, value) {
    const [key, ...rest] = toParts(path);
    if (!rest.length) return set(key, value);
    const root = cloneShallow(state.get(key));
    let node = root;
    for (let i = 0; i < rest.length - 1; i++) {
      node[rest[i]] = cloneShallow(node[rest[i]]);
      node = node[rest[i]];
    }
    node[rest[rest.length - 1]] = value;
    return set(key, root);
  }

  function updateIn(path, updater) {
    return setIn(path, updater(getIn(path)));
  }

  // ── Reset ───────────────────────────────────────────────────────────────────
  // reset()        → restore every key to its initial value (added keys removed)
  // reset('key')   → restore one key (or remove it if it had no initial)
  function reset(key) {
    if (key === undefined) {
      batch(() => {
        for (const k of [...state.keys()]) if (!initialKeys.has(k)) remove(k);
        for (const k of initialKeys) set(k, safeClone(initialSnapshot[k]));
      });
      return;
    }
    if (initialKeys.has(key)) set(key, safeClone(initialSnapshot[key]));
    else remove(key);
  }

  function remove(key) {
    if (!state.has(key)) return;
    const prev = state.get(key);
    state.delete(key);
    if (batching) { if (!pending.has(key)) pending.set(key, prev); }
    else notify(key, undefined, prev);
  }

  function notify(key, value, prev) {
    subs.get(key)?.forEach((cb) => safe(cb, value, prev, key));
    wildcards.forEach((cb) => safe(cb, value, prev, key));
  }

  function safe(cb, value, prev, key) {
    try {
      cb(value, prev, key);
    } catch (err) {
      console.error(`[store] subscriber for "${key}" threw:`, err);
    }
  }

  // subscribe('key', cb) — fires on change. Pass '*' to hear every change.
  function subscribe(key, cb) {
    if (key === '*') {
      wildcards.add(cb);
      return () => wildcards.delete(cb);
    }
    let set_ = subs.get(key);
    if (!set_) subs.set(key, (set_ = new Set()));
    set_.add(cb);
    return () => set_.delete(cb);
  }

  // select('key', s => s.score, cb) — fires cb ONLY when the derived slice
  // changes (not on every write to the key). Pass an equality fn for object
  // slices (e.g. shallowEqual). Returns an unsubscribe.
  function select(key, selector, cb, isEqual = Object.is) {
    let prevSel = selector(get(key));
    return subscribe(key, (value) => {
      const nextSel = selector(value);
      if (!isEqual(prevSel, nextSel)) {
        const p = prevSel;
        prevSel = nextSel;
        cb(nextSel, p);
      }
    });
  }

  // Run several writes, notify subscribers once at the end (deduped per key).
  function batch(fn) {
    if (batching) return fn(); // already inside a batch
    batching = true;
    try {
      fn();
    } finally {
      batching = false;
      const entries = [...pending];
      pending.clear();
      for (const [key, prev] of entries) notify(key, state.get(key), prev);
    }
  }

  function has(key) {
    return state.has(key);
  }
  function keys() {
    return [...state.keys()];
  }

  function snapshot() {
    return Object.fromEntries(state);
  }

  return {
    get, set, update, patch,
    getIn, setIn, updateIn,
    reset, remove,
    subscribe, select,
    batch, has, keys, snapshot,
  };
}

// ── binding helpers (path-aware) ─────────────────────────────────────────────
// A component `stateKey` may be a plain key ('play:hp') OR a dotted PATH into a
// key's value ('game.player.level'). These let components support both
// transparently. (Existing keys use ':' as a namespace separator, not '.', so
// splitting on '.' is safe.)

// Subscribe so `onValue` fires with the initial value AND only when the resolved
// value CHANGES. For paths it uses store.select (slice-reactive). Returns unsub.
export function bindState(store, key, onValue) {
  const parts = String(key).split('.');
  if (parts.length === 1) {
    onValue(store.get(key));
    return store.subscribe(key, onValue);
  }
  const [root, ...rest] = parts;
  const sel = (v) => rest.reduce((o, k) => (o == null ? undefined : o[k]), v);
  onValue(store.getIn(key));
  return store.select(root, sel, onValue);
}

export function readState(store, key) {
  return String(key).includes('.') ? store.getIn(key) : store.get(key);
}

export function writeState(store, key, val) {
  return String(key).includes('.') ? store.setIn(key, val) : store.set(key, val);
}

// ── helpers ──────────────────────────────────────────────────────────────────
function toParts(path) {
  return Array.isArray(path) ? path : String(path).split('.');
}

// Shallow clone preserving array vs object; nullish → fresh object so paths build.
function cloneShallow(o) {
  if (Array.isArray(o)) return o.slice();
  if (o && typeof o === 'object') return { ...o };
  return {};
}

// Best-effort deep clone for reset snapshots (plain data only).
function safeClone(v) {
  try { return structuredClone(v); }
  catch { return v; }
}

// Shallow equality — handy as the `isEqual` arg to select() for object slices.
export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a == null || b == null) return false;
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => Object.is(a[k], b[k]));
}
