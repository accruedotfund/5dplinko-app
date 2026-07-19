// ─────────────────────────────────────────────────────────────────────────────
// registry.js — the modular seam.
//
// A component "type" (string) maps to a factory: (spec, ctx) => { el, destroy? }.
// The manifest references components purely by type + data; new capabilities are
// added by registering a new type, never by editing the runtime. This is what
// makes the front end "modular and data-driven": the core knows nothing about
// any specific screen.
//
//   ctx = { store, bus, wallet, contract, registry, config }
// ─────────────────────────────────────────────────────────────────────────────

import { registerInstance } from './behaviors.js';

export function createRegistry() {
  const types = new Map();

  function register(type, factory) {
    if (types.has(type)) console.warn(`[registry] overriding component type "${type}"`);
    types.set(type, factory);
    return api;
  }

  function has(type) {
    return types.has(type);
  }

  // Instantiate a component from its manifest spec.
  function create(spec, ctx) {
    const factory = types.get(spec.type);
    if (!factory) {
      throw new Error(`[registry] unknown component type "${spec.type}". Registered: ${[...types.keys()].join(', ')}`);
    }
    const instance = factory(spec, ctx);
    if (!instance || !(instance.el instanceof Node)) {
      throw new Error(`[registry] component "${spec.type}" must return { el: Node }`);
    }
    // generic attribute passthrough: spec.attrs lands on the root element of ANY
    // component (ids, data-occlude / data-emit for the lighting engine, aria-*)
    if (spec.attrs && instance.el.setAttribute) {
      for (const [k, v] of Object.entries(spec.attrs)) instance.el.setAttribute(k, String(v));
    }
    // UNIVERSAL behavior exposure: any component with a manifest `id` becomes
    // addressable by event sheets via `{ act: ['<id>.<method>', …] }` — its instance
    // API / `el` hooks are wrapped as a behavior surface. Explicit behaviors (a
    // component that called ctx.behaviors.register itself) win, so we only auto-register
    // an unclaimed id. Unregistered on destroy.
    if (spec.id != null && ctx && ctx.behaviors) {
      const off = registerInstance(ctx.behaviors, spec, instance);
      const orig = instance.destroy;
      instance.destroy = () => { off(); if (orig) orig.call(instance); };
    }
    return instance;
  }

  const api = { register, has, create, types };
  return api;
}
