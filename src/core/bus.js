// ─────────────────────────────────────────────────────────────────────────────
// bus.js — a tiny typed event bus.
//
// The whole app is decoupled through this: components never import each other,
// they publish/subscribe by topic. proofwallet itself is event-driven
// (`walletConnected` on `document`); we mirror that style internally so the
// codebase has one consistent messaging model.
// ─────────────────────────────────────────────────────────────────────────────

export function createBus() {
  /** @type {Map<string, Set<Function>>} */
  const topics = new Map();
  // trailing-* WILDCARD subscriptions ('door:*' matches door:gate:open …). Kept in a
  // separate list so exact-topic emit stays a single Map lookup; the prefix scan only
  // runs when at least one pattern exists. Handlers get (payload, topic) — the second
  // arg tells a wildcard listener WHICH topic fired (exact handlers may ignore it).
  const patterns = [];

  function on(topic, handler) {
    if (typeof topic === 'string' && topic.endsWith('*')) {
      const entry = { prefix: topic.slice(0, -1), handler };
      patterns.push(entry);
      return () => { const i = patterns.indexOf(entry); if (i >= 0) patterns.splice(i, 1); };
    }
    let set = topics.get(topic);
    if (!set) topics.set(topic, (set = new Set()));
    set.add(handler);
    return () => off(topic, handler); // unsubscribe
  }

  function off(topic, handler) {
    topics.get(topic)?.delete(handler);
  }

  function once(topic, handler) {
    const unsub = on(topic, (payload, t) => {
      unsub();
      handler(payload, t);
    });
    return unsub;
  }

  function emit(topic, payload) {
    const set = topics.get(topic);
    if (set) {
      // copy so handlers can unsubscribe during dispatch without skipping peers
      for (const handler of [...set]) {
        try {
          handler(payload, topic);
        } catch (err) {
          console.error(`[bus] handler for "${topic}" threw:`, err);
        }
      }
    }
    if (patterns.length) {
      for (const p of [...patterns]) {
        if (!topic.startsWith(p.prefix)) continue;
        try {
          p.handler(payload, topic);
        } catch (err) {
          console.error(`[bus] wildcard handler for "${p.prefix}*" threw:`, err);
        }
      }
    }
  }

  return { on, off, once, emit };
}
