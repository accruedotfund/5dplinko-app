/**
 * 5dplinko.app — FIVE-DIMENSIONAL multiplayer pot Plinko
 * Path = 5-vector from VRF; board shows 5 dimension layers the ball tunnels through.
 */
(() => {
  'use strict';

  const CFG = Object.assign(
    {
      contractAddress: '',
      apiUrl: 'https://proofnetwork.lol/api',
      apiKey: '',
      mock: true,
    },
    window.PLINKO_CONFIG || {}
  );

  const MULTS = [5, 3, 2, 1.2, 0.6, 1.2, 2, 3, 5];
  const N_DIMS = 5;
  const DIM_LABELS = ['D₁', 'D₂', 'D₃', 'D₄', 'D₅'];

  let client = null;
  let betSol = 0.05;
  let dropping = false;

  const $ = (id) => document.getElementById(id);

  function ensureClient() {
    if (client) return client;
    if (typeof CryptoClient !== 'function') throw new Error('CryptoClient missing');
    client = new CryptoClient({
      contractAddress: CFG.contractAddress,
      apiUrl: CFG.apiUrl,
      apiKey: CFG.apiKey || undefined,
      mountTo: '#wallet-button',
    });
    return client;
  }

  /** Always a base58 string — objects break commerce.charge TypeBox unions. */
  function address() {
    try {
      const c = ensureClient();
      let w = c.state?.walletAddress || c.getWalletAddress?.() || null;
      if (w && typeof w !== 'string') {
        if (typeof w.toBase58 === 'function') w = w.toBase58();
        else if (typeof w.toString === 'function') {
          const s = w.toString();
          w = s && s !== '[object Object]' ? s : null;
        } else w = null;
      }
      return w || null;
    } catch {
      return null;
    }
  }

  function unwrap(res) {
    if (res && typeof res === 'object' && 'result' in res) return res.result;
    if (res?.transaction?.outputs) return res.transaction.outputs;
    // responseMode:minimal → top-level outputs already unwrapped by CryptoClient
    if (res?.outputs && typeof res.outputs === 'object' && !res.requiresPayment && res.success !== false) {
      // only if this looks like the API envelope
      if ('config' in res.outputs || 'requiresPayment' in res.outputs || 'dropId' in res.outputs) {
        return res.outputs;
      }
    }
    return res;
  }

  function paymentTx(tx) {
    if (!tx) return null;
    if (typeof tx === 'string') return tx;
    if (typeof tx === 'object') {
      if (typeof tx.data === 'string') return tx.data;
      if (typeof tx.serialized === 'string') return tx.serialized;
      if (typeof tx.transaction === 'string') return tx.transaction;
    }
    return null;
  }

  async function call(fn, inputs = {}) {
    if (CFG.mock || !CFG.contractAddress) return mockCall(fn, inputs);
    const c = ensureClient();
    const from = address() || 'guest';
    if (from !== 'guest' && typeof from !== 'string') throw new Error('wallet address not a string');
    const res = await c.callContract(fn, { ...inputs, from }, { fromAddress: from });
    return unwrap(res);
  }

  const mock = {
    pot: {
      accruedSol: 1,
      reservedSol: 0,
      paidWinsSol: 0,
      refundedSol: 0,
      houseTakenSol: 0,
      cashSol: 1,
      freeSol: 1,
      drops: 0,
      maxMult: 5,
    },
    recent: [],
    n: 0,
  };

  function expand5D(seed) {
    let s = (Number(seed) >>> 0) || 1;
    const dims = [];
    for (let i = 0; i < N_DIMS; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      dims.push(s / 4294967296);
    }
    return dims;
  }

  function slotFrom5D(dims) {
    let score = 0;
    for (let i = 0; i < N_DIMS; i++) if (dims[i] >= 0.5) score += 1;
    let slot = Math.round((score / N_DIMS) * 8);
    let frac = dims.reduce((a, b) => a + b, 0) / N_DIMS;
    const jitter = Math.floor((frac - 0.5) * 3);
    return Math.min(8, Math.max(0, slot + jitter));
  }

  function mockCall(fn, inputs) {
    if (fn === 'getLobby') {
      return {
        config: {
          status: 'open',
          minBetSol: 0.01,
          maxBetSol: 2,
          mults: MULTS,
          houseEdgeBps: 200,
          dims: 5,
        },
        pot: mock.pot,
        recent: mock.recent.slice(0, 20),
        stats: { volumeSol: mock.pot.accruedSol },
        dims: 5,
      };
    }
    if (fn === 'drop') {
      if (!inputs.txSignature) {
        return {
          requiresPayment: true,
          transaction: { data: 'mock' },
          amount: inputs.betSol || betSol,
        };
      }
      const seed = Math.floor(Math.random() * 1e9);
      const dims = expand5D(seed);
      const slot = slotFrom5D(dims);
      const mult = MULTS[slot];
      const bet = Number(inputs.betSol) || betSol;
      let payout = Math.floor(bet * mult * 1e6) / 1e6;
      mock.pot.accruedSol += bet;
      const cash = mock.pot.accruedSol - mock.pot.paidWinsSol;
      let potCapped = false;
      if (payout > cash) {
        payout = cash;
        potCapped = true;
      }
      mock.pot.paidWinsSol += payout;
      mock.pot.cashSol = mock.pot.accruedSol - mock.pot.paidWinsSol;
      mock.pot.freeSol = mock.pot.cashSol;
      mock.pot.drops += 1;
      const row = {
        success: true,
        dropId: ++mock.n,
        from: inputs.from || 'Mock',
        betSol: bet,
        dims,
        slot,
        mult,
        payoutSol: payout,
        potCapped,
        outcome: potCapped ? 'capped' : 'win',
        pathSeed: seed,
        at: Date.now(),
      };
      mock.recent.unshift(row);
      return row;
    }
    return {};
  }

  // ── 5D board: 5 dimension layers + terminal rail ─────────────────
  function buildBoard() {
    const layers = $('layers');
    const bins = $('bins');
    layers.innerHTML = '';
    bins.innerHTML = '';
    for (let d = 0; d < N_DIMS; d++) {
      const layer = document.createElement('div');
      layer.className = 'dim-layer';
      layer.dataset.dim = String(d);
      layer.style.setProperty('--z', String(d));
      layer.innerHTML = `
        <div class="dim-label">${DIM_LABELS[d]}</div>
        <div class="dim-gate" data-side="L">L</div>
        <div class="dim-gate" data-side="R">R</div>
        <div class="dim-track"><div class="dim-node" data-role="node"></div></div>
      `;
      layers.appendChild(layer);
    }
    MULTS.forEach((m, i) => {
      const b = document.createElement('div');
      b.className = 'bin' + (m >= 3 ? ' bin--hot' : m < 1 ? ' bin--cold' : '');
      b.dataset.slot = String(i);
      b.innerHTML = `<span>×${m}</span>`;
      bins.appendChild(b);
    });
  }

  /**
   * Animate ball through 5 dimension layers then into payout slot.
   * dims[i] < 0.5 → left, else right on that dimension.
   */
  function animate5D(dims, slot) {
    return new Promise((resolve) => {
      const board = $('board');
      const ball = document.createElement('div');
      ball.className = 'ball';
      board.appendChild(ball);

      const layers = [...document.querySelectorAll('.dim-layer')];
      const W = board.clientWidth;
      const H = board.clientHeight;
      const layerTop = 48;
      const layerH = (H - 120) / N_DIMS;

      // reset nodes
      layers.forEach((layer, i) => {
        const node = layer.querySelector('[data-role="node"]');
        const side = dims[i] >= 0.5 ? 'R' : 'L';
        layer.querySelectorAll('.dim-gate').forEach((g) => {
          g.classList.toggle('is-active', g.dataset.side === side);
        });
        if (node) {
          node.style.left = side === 'L' ? '22%' : '78%';
          node.classList.remove('is-hit');
        }
      });

      let x = W / 2;
      let y = 12;
      ball.style.transform = `translate(${x - 10}px, ${y - 10}px) scale(1)`;

      const steps = [];
      for (let i = 0; i < N_DIMS; i++) {
        const side = dims[i] >= 0.5 ? 1 : -1;
        const ty = layerTop + layerH * i + layerH * 0.45;
        const tx = W / 2 + side * (W * 0.28);
        steps.push({ x: tx, y: ty, dim: i, t: 280 });
      }
      const binX = ((slot + 0.5) / MULTS.length) * W;
      steps.push({ x: binX, y: H - 40, dim: -1, t: 320 });

      let si = 0;
      const run = () => {
        if (si >= steps.length) {
          document.querySelectorAll('.bin').forEach((el) => el.classList.remove('is-hit'));
          const hit = document.querySelector(`.bin[data-slot="${slot}"]`);
          if (hit) hit.classList.add('is-hit');
          setTimeout(() => {
            ball.remove();
            resolve();
          }, 400);
          return;
        }
        const s = steps[si++];
        // travel
        ball.style.transition = `transform ${s.t}ms cubic-bezier(.2,.8,.2,1)`;
        ball.style.transform = `translate(${s.x - 10}px, ${s.y - 10}px) scale(${1 + (s.dim >= 0 ? s.dim * 0.04 : 0.1)})`;
        if (s.dim >= 0) {
          const layer = layers[s.dim];
          const node = layer?.querySelector('[data-role="node"]');
          if (node) {
            setTimeout(() => node.classList.add('is-hit'), s.t * 0.7);
          }
          layer?.classList.add('is-pass');
        }
        setTimeout(run, s.t + 40);
      };
      requestAnimationFrame(run);
    });
  }

  function paintDims(dims) {
    const el = $('dimReadout');
    if (!el || !dims) return;
    el.innerHTML = dims
      .map((v, i) => {
        const side = v >= 0.5 ? 'R' : 'L';
        return `<span class="dim-chip ${side === 'R' ? 'is-r' : 'is-l'}">${DIM_LABELS[i]} ${side} <small>${v.toFixed(2)}</small></span>`;
      })
      .join('');
  }

  function fmt(n) {
    if (n == null || Number.isNaN(n)) return '—';
    const x = Number(n);
    return x.toFixed(3).replace(/\.?0+$/, (m) => (m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m));
  }

  function short(w) {
    if (!w || w.length < 10) return w || '—';
    return w.slice(0, 4) + '…' + w.slice(-4);
  }

  function renderLobby(L) {
    const pot = L.pot || {};
    const cfg = L.config || {};
    $('statPot').textContent = fmt(pot.freeSol ?? pot.cashSol) + ' SOL';
    $('statReserved').textContent = fmt(pot.reservedSol) + ' SOL';
    $('statDrops').textContent = String(pot.drops ?? 0);
    $('statVolume').textContent = fmt(L.stats?.volumeSol ?? pot.accruedSol) + ' SOL';
    $('betMin').textContent = fmt(cfg.minBetSol);
    $('betMax').textContent = fmt(cfg.maxBetSol);
    $('statusLine').textContent = `${cfg.status || '—'} · ${cfg.dims || 5}D · free ${fmt(pot.freeSol)} · reserved ${fmt(pot.reservedSol)} · edge ${(cfg.houseEdgeBps || 0) / 100}%`;

    const feed = $('feed');
    const recent = L.recent || [];
    if (!recent.length) {
      feed.innerHTML = '<p class="empty">No drops yet — be first through the 5-manifold.</p>';
    } else {
      feed.innerHTML = recent
        .slice(0, 24)
        .map((r) => {
          const win = (r.payoutSol || 0) >= (r.betSol || 0);
          const d = (r.dims || []).map((v) => (v >= 0.5 ? 'R' : 'L')).join('');
          return `<div class="feed-row ${win ? 'is-win' : 'is-loss'}">
            <span>${short(r.from)}</span>
            <span class="feed-path">${d || '·····'}</span>
            <span>×${r.mult}</span>
            <span class="feed-pay">${fmt(r.payoutSol)}</span>
          </div>`;
        })
        .join('');
    }
  }

  function setBet(v) {
    betSol = Math.round(Number(v) * 1000) / 1000;
    $('betValue').textContent = fmt(betSol) + ' SOL';
    $('betRange').value = String(betSol);
  }

  async function refresh() {
    try {
      const L = await call('getLobby', { from: address() || 'guest' });
      renderLobby(L);
    } catch (e) {
      console.error(e);
      $('statusLine').textContent = e.message || 'refresh failed';
    }
  }

  async function onDrop() {
    if (dropping) return;
    dropping = true;
    const btn = $('btnDrop');
    btn.disabled = true;
    btn.textContent = 'Tunneling 5D…';
    try {
      let from = address();
      if (!CFG.mock) {
        const c = ensureClient();
        if (!from) {
          if (typeof c.connectWallet === 'function') await c.connectWallet();
          else if (typeof c.connect === 'function') await c.connect();
          from = address();
        }
        if (!from) throw new Error('connect wallet');
      } else from = 'MockPlayer';

      let res = await call('drop', { from, betSol: Number(betSol) });
      if (res?.requiresPayment && res.transaction) {
        if (CFG.mock) {
          res = await call('drop', {
            from,
            betSol: Number(betSol),
            txSignature: 'mock-' + Date.now(),
          });
        } else {
          const c = ensureClient();
          const rawTx = paymentTx(res.transaction);
          if (!rawTx || typeof rawTx !== 'string') {
            throw new Error('payment tx missing base64 data');
          }
          const sent = await c.signAndSendTransaction(rawTx);
          let sig = sent?.signature || sent;
          if (sig && typeof sig !== 'string') {
            sig = sig.signature || sig.txSignature || null;
          }
          if (!sig || typeof sig !== 'string') throw new Error('payment not sent');
          res = await call('drop', {
            from,
            betSol: Number(betSol),
            txSignature: sig,
          });
        }
      }
      if (res?.success === false) throw new Error(res.message || res.error || 'drop failed');

      const dims = res.dims || expand5D(res.pathSeed || res.rng || Date.now());
      const slot = res.slot ?? slotFrom5D(dims);
      paintDims(dims);
      await animate5D(dims, slot);

      const toast = $('toast');
      toast.textContent = res.potCapped
        ? `5D ×${res.mult} pot-capped → ${fmt(res.payoutSol)} SOL`
        : `5D ×${res.mult} → ${fmt(res.payoutSol)} SOL`;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2800);
      await refresh();
    } catch (e) {
      console.error(e);
      const toast = $('toast');
      toast.textContent = e.message || String(e);
      toast.classList.add('show', 'err');
      setTimeout(() => toast.classList.remove('show', 'err'), 3500);
    } finally {
      dropping = false;
      btn.disabled = false;
      btn.textContent = 'Drop through 5D';
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    buildBoard();
    $('betRange').oninput = (e) => setBet(e.target.value);
    setBet(0.05);
    $('btnDrop').onclick = onDrop;
    $('btnRefresh').onclick = () => refresh();
    try {
      ensureClient();
    } catch (e) {
      console.warn(e);
    }
    refresh();
    setInterval(refresh, 8000);
  });
})();
