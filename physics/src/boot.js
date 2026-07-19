// ─────────────────────────────────────────────────────────────────────────────
// boot.js — the runtime. Turns a manifest (data) into a running app.
//
// Pipeline:
//   1. build core services (bus, store, wallet, contract, registry)
//   2. register built-in component types
//   3. walk manifest.layout and instantiate each component into its target
//   4. auto-reconnect the wallet
//
// Nothing here knows about any specific screen. To add a feature you add a
// component spec to the manifest (and, if it is a new kind, register a type).
// ─────────────────────────────────────────────────────────────────────────────

import { createBus } from './core/bus.js';
import { createPool } from './core/pool.js';
import { expandSpecs } from './core/expand.js';
import { createStore } from './core/store.js';
import { createRegistry } from './core/registry.js';
import { initWallet } from './core/wallet.js';
import { createContract } from './core/contract.js';
import { createMockContract } from './core/mock-contract.js';
import { initSound } from './core/sound.js';
import { initTheme } from './core/theme.js';
import { initLoader } from './core/loader.js';
import { preloadAssets, collectAssets, collectTypes } from './core/preload.js';
import { h, resolveTarget } from './core/dom.js';

// pf-build:imports-start
import { netsyncComponent } from './components/netsync.js';
// pf-build:imports-end
// engine-backed components (pixel-sprite/scene) are LAZY-loaded — see lazyComponent below.
// Their pixel-art engine (src/core/*, ~30k lines) must NOT be pulled into boot.js, or it
// would load on every page + every per-entry build. They're dynamic-imported on first use.
function lazyComponent(loader, name) {
  const factory = (spec, ctx) => {
    const host = h('div', { 'data-component': spec.type, 'data-lazy': '', style: { display: 'contents' } });
    let inst = null, dead = false;
    // `inner` exposes the real instance once loaded so the behaviors registry (which
    // captured this lazy host at create time) can resolve `act` calls against the real
    // component's API (el.world/el.camera/…) — see instanceSurface in core/behaviors.js.
    const ret = { el: host, inner: null, destroy() { dead = true; inst?.destroy?.(); } };
    loader().then((m) => { if (dead) return; try { inst = m[name](spec, ctx); if (inst?.el) host.appendChild(inst.el); ret.inner = inst; } catch (e) { console.error('[lazy] ' + spec.type, e); } })
      .catch((e) => console.error('[lazy import] ' + spec.type, e));
    return ret;
  };
  factory.__lazyLoad = loader; // expose the import() thunk so boot can PREWARM the module/engine
  return factory;
}
import { createReconciler } from './core/reconcile.js';
import { createRules } from './core/rules.js';
import { createBehaviors } from './core/behaviors.js';
import { configureWorld } from './components/_canvas.js';

export async function boot(manifest) {
  const config = manifest.config || {};

  // favicon — data-driven via config.icon (path traced + copied by pf-build). Inject or
  // update <link rel="icon"> so the manifest carries its own tab icon.
  if (config.icon) {
    let link = document.querySelector('link[rel~="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.href = config.icon;
  }

  // font — DATA-DRIVEN, per front end. `config.fonts` REGISTERS manifest-supplied @font-faces
  // (so a slug can bring its own woff2 without touching styles/fonts.css); `config.font` SELECTS
  // the UI face by overriding the --pf-font token. The token default (styles/tokens.css) applies
  // when config.font is absent, so existing sites are unchanged.
  for (const font of config.fonts || []) {
    if (!font || !font.family || !font.src) continue;   // src = a LITERAL path (pf-build traces it → woff2 copied)
    try {
      const ff = new FontFace(font.family, `url(${JSON.stringify(font.src)})`,
        { weight: font.weight || 'normal', style: font.style || 'normal', display: font.display || 'swap' });
      ff.load().then((f) => document.fonts.add(f)).catch(() => {});
    } catch (e) { /* bad descriptor — skip */ }
  }
  if (config.font) {
    // a bare family name ('Silver') → prepend to the standard fallback chain; a full stack
    // (contains a comma/quote) → use verbatim.
    const f = String(config.font).trim();
    // NOTE: detect quotes via charCode, NOT a /[,"']/ regex — a bare " or ' in source trips
    // pf-build's char-scanner (unbalanced-quote landmine) and drops the module graph below.
    const hasStackChar = f.indexOf(',') >= 0 || f.indexOf(String.fromCharCode(34)) >= 0 || f.indexOf(String.fromCharCode(39)) >= 0;
    const stack = hasStackChar ? f : `"${f}", "BoldPixels", Tahoma, Verdana, "MS Sans Serif", sans-serif`;
    document.documentElement.style.setProperty('--pf-font', stack);
  }

  // world/canvas coordinate space (cover-scaled stage shared by all canvas
  // components). Match config.world to the scene's aspect for a perfect lock.
  configureWorld(config.world);

  // ── 0. boot-screen preset (data-driven via config.loader) ─────────────────────
  // Builds #pf-boot per config.loader (one set of elements → no doubled bar) and
  // self-finalizes when the entry dismisses it (watches `.is-done`). Default = classic.
  const loaderHold = initLoader(config.loader || {}, config);

  // ── 1. core services ────────────────────────────────────────────────────────
  const bus = createBus();
  // initial state = wallet stub + whatever the manifest declares (reset() restores this)
  const store = createStore({ wallet: { address: null, isConnected: false }, ...(manifest.state || {}) });
  const theme = initTheme({ store, bus, config: config.themes });
  const registry = createRegistry();
  const wallet = initWallet({ config, store, bus });

  // Pick the contract provider: mock (local, in-browser) vs real (proofwallet).
  // - config.mock === true  → always mock
  // - config.mock === false → always real
  // - otherwise ('auto')    → mock when the contractAddress is still a placeholder
  const provider = pickProvider(config);
  const contract =
    provider === 'mock'
      ? createMockContract({ config, wallet, store, bus, mock: manifest.mock || {} })
      : createContract({ config, wallet, store, bus });
  store.set('provider', provider);
  console.info(`[ProofFront] contract provider: ${provider}`);

  const sound = initSound({ config: config.sound, bus });

  // Reconciler: drives presentation (view) state toward authoritative (truth)
  // state over time. Projections are data in manifest.projections.
  const reconcile = createReconciler({ store, bus });
  for (const projection of manifest.projections || []) reconcile.register(projection);

  // manifest.defs = a LIBRARY of reusable component specs (Flash symbols). A
  // `symbol`/`movieclip` with `use:'name'` clones defs[name] and overrides it.
  // pool = object-pooling core service (freelist + per-frame scratch arenas). Built
  // here (outside the pf-build tree-shake block) so it always ships as ctx.pool.
  const pool = createPool({ bus });
  const ctx = { config, bus, store, registry, wallet, contract, sound, reconcile, theme, pool, defs: manifest.defs || {} };

  // Behaviors: components register imperative action surfaces by id (physics/camera/fx);
  // event sheets DRIVE them via the `act` action. Construct's behavior model. Must exist
  // before createRules so the `act` verb can resolve it.
  ctx.behaviors = createBehaviors();

  // Rules: manifest.events = Construct-style "conditions → actions" sheets, run by
  // core/rules.js (reads store/bus, shares expand.js's expression evaluator). The
  // declarative replacement for hand-wired bus.on/onClick glue. Started after the
  // layout mounts (below) so initial untriggered rules see the first component state.
  const rules = createRules({ store, bus, ctx, flags: manifest.flags || {}, functions: manifest.functions || {}, defs: manifest.defs || {} });
  ctx.rules = rules;
  for (const rule of manifest.events || []) rules.register(rule);

  // ── 2. built-in component types (plus any from the manifest) ──────────────────
  // pf-build:register-start
  registry.register('netsync', netsyncComponent);      // general net core: N-D transform interpolation + physics-delta decode (netcode's successor)
  registry.register('gl-scene', lazyComponent(() => import('./components/gl-scene.js'), 'glSceneComponent')); // custom WebGL2 3D scene (src/core/gl/): GLB models, shader lighting, optional FPS controller + BVH collision
// pf-build:register-end
  for (const [type, factory] of Object.entries(manifest.components || {})) {
    registry.register(type, factory);
  }

  // ── preload + prewarm (drives the loader's REAL %) ────────────────────────────
  // Warm the scene's MEDIA (dmis/audio/video auto-discovered + config.preload) AND
  // PREWARM the lazy component modules it uses (the ~35k-line pixel-art engine etc.),
  // both CONCURRENTLY with mounting + the rest of boot. Audio decodes into the sound
  // system's own buffer cache; lazy import()s are deduped by the browser, so each
  // component's mount-time loader() then resolves instantly. ONE combined counter
  // (assets + modules) feeds loaderHold.setProgress → the bar shows real loading.
  // Only AWAITED just before app:ready (below), bounded so a hung asset can't freeze.
  // You stay in control of the bar three ways: (1) DEFAULT — boot's combined real %;
  // (2) `config.loader.realProgress:false` — opt OUT of the auto-feed, keeping the
  // timed/branded faux climb (config.loader.duration/fillMs); (3) a `loader:progress`
  // bus event (a number 0..1 OR `{value}`) — drive/override it live from anywhere.
  const useRealPct = config.loader?.realProgress !== false;
  bus.on('loader:progress', (p) => { const v = typeof p === 'number' ? p : (p && p.value); if (v != null) loaderHold.setProgress?.(v); });

  const assetUrls = [...collectAssets(manifest), ...(config.preload || [])];
  const lazyLoaders = [...collectTypes(manifest)]
    .map((t) => registry.types.get(t))
    .filter((f) => f && typeof f.__lazyLoad === 'function')
    .map((f) => f.__lazyLoad);
  const totalWarm = assetUrls.length + lazyLoaders.length;
  let assetsDone = 0, modulesDone = 0;
  const reportWarm = () => { if (useRealPct && totalWarm && loaderHold.setProgress) loaderHold.setProgress((assetsDone + modulesDone) / totalWarm); };
  const preloadHold = Promise.all([
    preloadAssets(assetUrls, { onProgress: (_f, d) => { assetsDone = d; reportWarm(); }, audio: (u) => sound.ensureBuffer(u) }),
    ...lazyLoaders.map((load) => Promise.resolve().then(load).then(() => { modulesDone++; reportWarm(); }, () => { modulesDone++; reportWarm(); })),
  ]);

  // ── 3. render the layout ─────────────────────────────────────────────────────
  const instances = [];
  for (const region of manifest.layout || []) {
    const target = resolveTarget(region.target);
    if (region.clear) target.replaceChildren();
    for (const spec of expandSpecs(region.components || [], { defs: manifest.defs, flags: manifest.flags, store, config })) { // repeat/over/extends/when/merge → concrete specs
      try {
        const instance = registry.create(spec, ctx);
        target.append(instance.el);
        instances.push(instance);
      } catch (err) {
        console.error(`[boot] failed to mount "${spec.type}":`, err);
      }
    }
  }

  // arm event sheets now that all components are mounted (untriggered rules get a
  // correct initial evaluation against the freshly-seeded store).
  rules.start();

  // ── 4. restore previous wallet session, if any ────────────────────────────────
  // BURNER-ONLY mode (config.wallet.burnerOnly): the app never asks the visitor to
  // "connect" — it silently get-or-mints a local burner keypair so every signed
  // write has an identity, and HIDES the wallet button entirely. Use for games
  // where the player is just an anonymous local actor (lobbies, walking around).
  if (config.wallet && config.wallet.burnerOnly) {
    const btn = document.querySelector(config.mountTo || '#wallet-button');
    if (btn) btn.style.display = 'none';
    try {
      const addr = await wallet.ensureBurner();
      console.info('[boot] burner-only wallet:', addr || '(none)');
    } catch (err) {
      console.warn('[boot] ensureBurner failed:', err?.message);
    }
  } else {
    try {
      await wallet.autoReconnect();
    } catch (err) {
      console.warn('[boot] autoReconnect failed (fine on first visit):', err?.message);
    }
  }

  // Expose the live app for debugging and incremental wiring from the console.
  const app = { ...ctx, instances, manifest };
  window.app = app;

  // Hold the reveal until preloaded assets are warm (bounded — a slow/hung asset can
  // never freeze boot). app:ready lifts the boot screen, so warming first kills pop-in.
  await Promise.race([preloadHold, new Promise((r) => setTimeout(r, 8000))]);
  bus.emit('app:ready', app);

  // Honor the loader's minimum on-screen time (config.loader.duration). The app
  // is fully built above — we only hold the boot OVERLAY here — so a long
  // `duration` doesn't delay any real work, it just keeps the screen up.
  await loaderHold;
  return app;
}

// mock when explicitly asked, or when no real contract address is configured yet.
function pickProvider(config) {
  if (config.mock === true) return 'mock';
  if (config.mock === false) return 'real';
  const addr = config.contractAddress || '';
  const isPlaceholder = !addr || /^0xYour/i.test(addr) || addr === 'mock';
  return isPlaceholder ? 'mock' : 'real';
}
