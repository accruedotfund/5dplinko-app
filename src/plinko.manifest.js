// ─────────────────────────────────────────────────────────────────────────────
// plinko — ProofFront viewer for the Plinko contract (0x2CwT8CXi1W1EJ4Kv).
// Server-authoritative Rapier physics (2.5D planar); this app is a pure RENDERER.
// Board bodies (walls / pegs / dividers / floor) are CANONICAL gl-scene children
// built once from getBodies; dropped balls (ids 'b<n>') are runtime meshes driven
// from the `s` delta channel via `netsync`. Shape + spawn pos arrive instantly on
// the `meta` channel; live score on the `score` channel. Same stack as physics-3d.
// ─────────────────────────────────────────────────────────────────────────────
import { h } from './core/dom.js';
import { placeHud } from './core/hud-layout.js';

const _buildTypes = [{ type: 'gl-scene' }, { type: 'gl-light' }, { type: 'gl-camera-static' }, { type: 'netsync' }]; // eslint-disable-line no-unused-vars

const ADDR = '0x2CwT8CXi1W1EJ4Kv';
const MULTS = [25, 8, 3, 1, 0.5, 1, 3, 8, 25];

// A spawn (dropped ball) has id 'b0','b1',… — NEVER canonical (board bodies are).
const isSpawn = (id) => /^b\d/.test(id);

function colorFor(m) {
  switch (m.role) {
    case 'peg': return [0.62, 0.68, 0.78];
    case 'divider': return [0.30, 0.36, 0.46];
    case 'wall': return [0.10, 0.12, 0.17];
    case 'floor': return [0.08, 0.10, 0.14];
    case 'ball': return [0.98, 0.75, 0.20];   // gold
    default: return [0.5, 0.5, 0.5];
  }
}

// Render spec for a body id + meta. type gl-sphere for balls/pegs, gl-box otherwise.
function glSpecFor(id, m) {
  const isBall = m.shape === 'ball';
  const spec = {
    id, type: isBall ? 'gl-sphere' : 'gl-box', shape: isBall ? 'ball' : 'box',
    position: [0, -80, 0], color: colorFor(m),
    roughness: m.role === 'ball' ? 0.3 : 0.7,
    metallic: m.role === 'ball' ? 0.4 : 0.0,
    emissive: m.role === 'ball' ? [0.35, 0.24, 0.03] : (m.role === 'peg' ? [0.05, 0.06, 0.08] : undefined),
  };
  if (isBall) spec.radius = m.r != null ? m.r : 0.5;
  else spec.size = [(m.hx || 0.5) * 2, (m.hy || 0.5) * 2, (m.hz || 0.5) * 2];
  return spec;
}

// gl-scene children: lights + camera + a primitive per NON-spawn (board) body.
function sceneChildren(w) {
  const kids = [
    { type: 'gl-light', kind: 'hemisphere', sky: [0.34, 0.40, 0.52], ground: [0.05, 0.06, 0.09] },
    { type: 'gl-light', kind: 'directional', dir: [0.2, -0.6, 0.75], color: [1, 0.97, 0.9], intensity: 1.5 },
    { type: 'gl-camera-static', pos: [0, 7.2, 26], target: [0, 7.2, 0] },
  ];
  for (const id in w) if (!isSpawn(id)) kids.push(glSpecFor(id, w[id]));
  return kids;
}

// The driver — netsync-backed renderer (see physics-3d.manifest.js for the model).
function plinko(spec, ctx) {
  const el = h('div', { 'data-component': 'plinko', style: { position: 'fixed', inset: '0' } });
  let scene = null, world = null, meta = {}, sync = null, syncInst = null, unbind = null;
  let offOpen = null, offClose = null, offMeta = null, offScore = null, metaFetching = false;
  const present = new Set(), canonical = new Set();

  async function refreshMeta() {
    if (metaFetching) return; metaFetching = true;
    try { const m = (await ctx.contract.view('getBodies')) || {}; meta = m.w || {}; }
    finally { metaFetching = false; }
  }

  async function build() {
    await refreshMeta();
    scene = ctx.registry.create({
      type: 'gl-scene', id: 'plinko', fill: true,
      clear: [0.03, 0.04, 0.06], fov: 42, near: 0.05, far: 120,
      children: sceneChildren(meta),
    }, ctx);
    el.appendChild(scene.el);
    canonical.clear(); present.clear();
    Object.keys(meta).forEach((id) => { if (!isSpawn(id)) canonical.add(id); });
    world = null;
    ctx.bus.once('glscene:plinko:ready', () => { world = (scene && scene.inner && scene.inner.el && scene.inner.el.world) || null; });
  }

  function apply(ents) {
    if (!world && scene && scene.inner && scene.inner.el) world = scene.inner.el.world || null;
    if (!world) return;
    for (const id in ents) {
      if (!present.has(id) && !canonical.has(id)) {
        const m = meta[id];
        if (!m) { refreshMeta(); continue; }
        world.addModel(glSpecFor(id, m)); present.add(id);
      }
      const e = ents[id];
      world.setModelTransform(id, { position: e.p, rotation: e.q });
    }
    for (const rid of world.modelIds()) if (!ents[rid] && !canonical.has(rid)) { world.removeModel(rid); present.delete(rid); }
    ctx.store.set('plinko.count', canonical.size + present.size);
  }

  const resync = async () => {
    try {
      const s = await ctx.contract.view('getScene');
      for (const b of (s && s.w) || []) sync.ingest(b.id, { p: [b.x, b.y, b.z || 0], q: [b.qx || 0, b.qy || 0, b.qz || 0, b.qw != null ? b.qw : 1] });
      if (s) ctx.store.set('plinko.tick', s.tick || 0);
      const r = await ctx.contract.view('getResults');
      if (r) { ctx.store.set('plinko.score', r.total || 0); ctx.store.set('plinko.drops', r.drops || 0); }
    } catch (e) { /* resync */ }
  };

  (async () => {
    await build();
    syncInst = ctx.registry.create({ type: 'netsync', id: 'plinkosync', interpMs: 85 }, ctx);
    sync = syncInst.api;
    sync.attachPhysics('s', {
      dim: '3d',
      onFrame: (f) => ctx.store.set('plinko.tick', f.t || 0),
      onReset: () => {
        if (!world && scene && scene.inner && scene.inner.el) world = scene.inner.el.world || null;
        if (world) { world.clearModels(); present.clear(); }
        ctx.store.set('plinko.score', 0); ctx.store.set('plinko.drops', 0);
      },
    });
    unbind = sync.bind(apply);
    // instant ball shape + spawn position
    try {
      offMeta = ctx.contract.subscribeChannel('meta', (msg) => {
        const f = (msg && (msg.payload || msg)) || null;
        if (!f || !f.id || !f.m) return;
        meta[f.id] = f.m;
        if (f.p && sync) sync.ingest(f.id, { p: f.p, q: [0, 0, 0, 1] });
      });
    } catch (e) { /* fallback: refreshMeta learns it */ }
    // live score ticker
    try {
      offScore = ctx.contract.subscribeChannel('score', (msg) => {
        const f = (msg && (msg.payload || msg)) || null;
        if (!f) return;
        if (f.total != null) ctx.store.set('plinko.score', f.total);
        ctx.bus.emit('plinko:hit', f);
      });
    } catch (e) { /* score still shown via resync */ }
    offOpen = ctx.bus.on('contract:ws-open', resync);
    offClose = ctx.bus.on('contract:ws-close', resync);
    resync();
  })();

  return {
    el,
    destroy() { if (unbind) unbind(); if (offMeta) offMeta(); if (offScore) offScore(); if (offOpen) offOpen(); if (offClose) offClose(); if (syncInst && syncInst.destroy) syncInst.destroy(); if (scene && scene.destroy) scene.destroy(); if (scene && scene.el && scene.el.remove) scene.el.remove(); },
  };
}

// HUD — stats island (top-left), actions island (top-right), a mult legend bottom-center.
// (writes are unsigned — playground contract; fired over the warm socket when available.)
function hud(spec, ctx) {
  const host = h('span', { hidden: '', 'data-component': 'plinko-hud' });
  const call = (fn) => {
    // optimistic HUD updates on click (server stays authoritative; resync/score channel correct)
    if (fn === 'drop') ctx.store.set('plinko.drops', (ctx.store.get('plinko.drops') || 0) + 1);
    else if (fn === 'initScene') { ctx.store.set('plinko.score', 0); ctx.store.set('plinko.drops', 0); }
    try { if (ctx.contract.ws && ctx.contract.ws.send) { ctx.contract.ws.send(fn, {}); return; } } catch (e) { /* fall through */ }
    ctx.contract.write(fn, {}, { signed: false }).catch(() => {});
  };

  const title = h('span', { style: { fontWeight: '800', color: '#fbbf24', letterSpacing: '0.5px' } }, '5D PLINKO');
  const score = h('span', { 'data-role': 'score', style: { color: '#e8edf5' } }, 'score 0');
  const drops = h('span', { 'data-role': 'drops', style: { color: '#8a93a6' } }, '0 drops');
  const stats = h('div', { 'data-component': 'plinko-stats', style: {
    display: 'flex', gap: '12px', alignItems: 'center', font: '14px ui-monospace, monospace',
    pointerEvents: 'none', textShadow: '0 1px 4px rgba(0,0,0,0.6)',
  } }, [title, score, drops]);

  const mkBtn = (label, fn, bg) => h('button', { 'data-role': 'btn', onclick: fn, style: {
    pointerEvents: 'auto', font: '13px ui-monospace, monospace', fontWeight: '800', color: '#0b0f17',
    background: bg, border: 'none', borderRadius: '9px', padding: '9px 16px', cursor: 'pointer',
    boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
  } }, label);
  const actions = h('div', { 'data-component': 'plinko-actions', style: {
    display: 'flex', gap: '8px', pointerEvents: 'none',
  } }, [
    mkBtn('▼ Drop', () => call('drop'), '#fbbf24'),
    mkBtn('Reset', () => call('initScene'), '#8a93a6'),
  ]);

  const legend = h('div', { 'data-component': 'plinko-legend', style: {
    display: 'flex', gap: '4px', pointerEvents: 'none', font: '12px ui-monospace, monospace',
  } }, MULTS.map((m, i) => h('span', {
    'data-role': 'mult', 'data-slot': String(i), style: {
      minWidth: '34px', textAlign: 'center', padding: '4px 2px', borderRadius: '6px',
      background: 'rgba(20,26,38,0.72)', color: m >= 8 ? '#fbbf24' : (m < 1 ? '#6b7280' : '#cbd5e1'),
      fontWeight: m >= 8 ? '800' : '600',
    },
  }, '×' + m)));

  const paint = () => {
    score.textContent = `score ${(ctx.store.get('plinko.score') ?? 0)}`;
    drops.textContent = `${ctx.store.get('plinko.drops') ?? 0} drops`;
  };
  ctx.store.subscribe('plinko.score', paint);
  ctx.store.subscribe('plinko.drops', paint);
  paint();

  const offHit = ctx.bus.on('plinko:hit', (f) => {
    const cell = legend.querySelector(`[data-slot="${f.slot}"]`);
    if (!cell) return;
    cell.style.transition = 'none'; cell.style.background = 'rgba(251,191,36,0.9)'; cell.style.color = '#0b0f17';
    setTimeout(() => { cell.style.transition = 'background 0.6s, color 0.6s'; cell.style.background = 'rgba(20,26,38,0.72)'; cell.style.color = f.mult >= 8 ? '#fbbf24' : (f.mult < 1 ? '#6b7280' : '#cbd5e1'); }, 40);
  });

  const offStats = placeHud(stats, { anchor: 'top-left', pad: 14, id: 'plinko-stats' });
  const offActions = placeHud(actions, { anchor: 'top-right', pad: 14, id: 'plinko-actions' });
  const offLegend = placeHud(legend, { anchor: 'bottom-center', pad: 14, id: 'plinko-legend' });
  return { el: host, destroy() { offStats(); offActions(); offLegend(); offHit(); } };
}

export const manifest = {
  config: {
    // Same FreeSol / ProofNetwork physics contract — server Rapier, FE is renderer.
    appName: '5dplinko',
    contractAddress: ADDR, // 0x2CwT8CXi1W1EJ4Kv
    apiUrl: 'https://proofnetwork.lol',
    // same bearer FreeSol ships in their FE (public on workers.dev already)
    apiKey: 'pk_b48a3dcd3dff1e2a936ab5832b6f190a8bace8ec93d17c944b44db63c3a46c91',
    mock: false,
    mountTo: '#wallet-button',
    // burner for unsigned drop playground (same as FreeSol stamp); no Phantom required
    wallet: { burnerOnly: true },
    themes: { default: 'midnight' },
    sound: { enabled: false },
    loader: {
      preset: 'classic', brand: '5dplinko', accent: '#fbbf24',
      background: 'radial-gradient(120% 90% at 50% 35%, #0d1119, #05070b)',
      textColor: '#e8edf5', muted: '#5b6472',
      stages: ['Loading board…', 'Warming Rapier…', 'Ready'], duration: 1.1,
    },
  },
  state: { 'plinko.tick': 0, 'plinko.count': 0, 'plinko.score': 0, 'plinko.drops': 0 },
  components: { 'plinko': plinko, 'plinko-hud': hud },
  layout: [
    { target: '#app', clear: true, components: [{ type: 'plinko' }, { type: 'plinko-hud' }] },
  ],
};
