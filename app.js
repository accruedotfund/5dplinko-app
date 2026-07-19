/**
 * 5dplinko.app — pot / bet / multiplayer FE
 * Physics aesthetic board + VRF settle against our pot contract.
 * (Optional FreeSol netsync board can sit beside; money path is 5dplinko contract.)
 */
(() => {
  'use strict';

  const CFG = Object.assign(
    {
      contractAddress: window.PLINKO_CONFIG?.contractAddress || '',
      apiUrl: 'https://proofnetwork.lol/api',
      apiKey: window.PLINKO_CONFIG?.apiKey || '',
      mock: !window.PLINKO_CONFIG?.contractAddress,
    },
    window.PLINKO_CONFIG || {}
  );

  const MULTS = [5, 3, 2, 1.2, 0.6, 1.2, 2, 3, 5];
  const ROWS = 10;

  let client = null;
  let betSol = 0.05;
  let dropping = false;
  let lobby = null;

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

  function address() {
    try {
      const c = ensureClient();
      return c.state?.walletAddress || c.getWalletAddress?.() || null;
    } catch {
      return null;
    }
  }

  function unwrap(res) {
    if (res && typeof res === 'object' && 'result' in res) return res.result;
    if (res?.transaction?.outputs) return res.transaction.outputs;
    return res;
  }

  async function call(fn, inputs = {}) {
    if (CFG.mock || !CFG.contractAddress) return mockCall(fn, inputs);
    const c = ensureClient();
    const from = address() || 'guest';
    const res = await c.callContract(fn, { ...inputs, from }, { fromAddress: from });
    return unwrap(res);
  }

  // ── mock for offline ─────────────────────────────────────────────
  const mock = {
    pot: { accruedSol: 5, reservedSol: 0, paidWinsSol: 0, refundedSol: 0, houseTakenSol: 0, cashSol: 5, freeSol: 5, drops: 0, maxMult: 25 },
    recent: [],
    drops: 0,
  };

  function mockCall(fn, inputs) {
    if (fn === 'getLobby') {
      return {
        config: { status: 'open', minBetSol: 0.01, maxBetSol: 2, mults: MULTS, houseEdgeBps: 200 },
        pot: mock.pot,
        recent: mock.recent.slice(0, 20),
        stats: { volumeSol: mock.pot.accruedSol, wins: 0, losses: 0 },
        bins: MULTS.map((mult, slot) => ({ slot, mult })),
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
      const slot = Math.floor(Math.random() * 9);
      const mult = MULTS[slot];
      const bet = Number(inputs.betSol) || betSol;
      const payout = Math.floor(bet * mult * 1e6) / 1e6;
      mock.pot.accruedSol += bet;
      mock.pot.paidWinsSol += payout;
      mock.pot.cashSol = mock.pot.accruedSol - mock.pot.paidWinsSol;
      mock.pot.freeSol = mock.pot.cashSol;
      mock.pot.drops += 1;
      const row = {
        dropId: ++mock.drops,
        from: inputs.from || 'Mock',
        betSol: bet,
        slot,
        mult,
        payoutSol: payout,
        outcome: payout >= bet ? 'win' : 'win',
        at: Date.now(),
        pathSeed: Math.floor(Math.random() * 1e9),
      };
      mock.recent.unshift(row);
      return { success: true, ...row, pathSeed: row.pathSeed };
    }
    return {};
  }

  // ── board animation ──────────────────────────────────────────────
  function buildBoard() {
    const pegs = $('pegs');
    const bins = $('bins');
    pegs.innerHTML = '';
    bins.innerHTML = '';
    const W = pegs.clientWidth || 360;
    const H = pegs.clientHeight || 420;
    const rowH = H / (ROWS + 1.5);
    for (let r = 0; r < ROWS; r++) {
      const n = r + 3;
      const y = rowH * (r + 1);
      for (let i = 0; i < n; i++) {
        const x = W / 2 + (i - (n - 1) / 2) * (W / (ROWS + 4));
        const peg = document.createElement('div');
        peg.className = 'peg';
        peg.style.left = x + 'px';
        peg.style.top = y + 'px';
        pegs.appendChild(peg);
      }
    }
    MULTS.forEach((m, i) => {
      const b = document.createElement('div');
      b.className = 'bin' + (m >= 8 ? ' bin--hot' : m < 1 ? ' bin--cold' : '');
      b.dataset.slot = String(i);
      b.innerHTML = `<span>×${m}</span>`;
      bins.appendChild(b);
    });
  }

  function animateDrop(pathSeed, slot) {
    return new Promise((resolve) => {
      const board = $('board');
      const ball = document.createElement('div');
      ball.className = 'ball';
      board.appendChild(ball);
      const W = board.clientWidth;
      const H = board.clientHeight;
      const rowH = H / (ROWS + 1.5);
      // derive L/R path from seed toward target slot
      let rng = pathSeed >>> 0;
      const next = () => {
        rng = (rng * 1664525 + 1013904223) >>> 0;
        return rng / 0xffffffff;
      };
      // start top center
      let x = W / 2;
      const steps = ROWS;
      // bias random walk to end near slot
      const targetX = ((slot + 0.5) / MULTS.length) * W;
      const frames = [];
      for (let r = 0; r <= steps; r++) {
        const t = r / steps;
        const y = rowH * (r + 0.3);
        const pull = (targetX - x) * 0.18;
        const jitter = (next() - 0.5) * (W / (ROWS + 2));
        x = x + pull + jitter;
        x = Math.max(20, Math.min(W - 20, x));
        frames.push({ x, y, t: r * 90 });
      }
      frames.push({ x: targetX, y: H - 36, t: steps * 90 + 200 });
      let i = 0;
      const tick = () => {
        if (i >= frames.length) {
          document.querySelectorAll('.bin').forEach((el) => el.classList.remove('is-hit'));
          const hit = document.querySelector(`.bin[data-slot="${slot}"]`);
          if (hit) hit.classList.add('is-hit');
          setTimeout(() => {
            ball.remove();
            resolve();
          }, 450);
          return;
        }
        const f = frames[i++];
        ball.style.transform = `translate(${f.x - 9}px, ${f.y - 9}px)`;
        setTimeout(tick, 70);
      };
      ball.style.transform = `translate(${W / 2 - 9}px, 8px)`;
      requestAnimationFrame(tick);
    });
  }

  // ── UI ───────────────────────────────────────────────────────────
  function fmt(n) {
    if (n == null || Number.isNaN(n)) return '—';
    return Number(n).toFixed(3).replace(/\.?0+$/, (m) => (m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m));
  }

  function short(w) {
    if (!w || w.length < 10) return w || '—';
    return w.slice(0, 4) + '…' + w.slice(-4);
  }

  function renderLobby(L) {
    lobby = L;
    const pot = L.pot || {};
    const cfg = L.config || {};
    $('statPot').textContent = fmt(pot.freeSol ?? pot.cashSol) + ' SOL';
    $('statReserved').textContent = fmt(pot.reservedSol) + ' SOL';
    $('statDrops').textContent = String(pot.drops ?? 0);
    $('statVolume').textContent = fmt(L.stats?.volumeSol ?? pot.accruedSol) + ' SOL';
    $('betMin').textContent = fmt(cfg.minBetSol);
    $('betMax').textContent = fmt(cfg.maxBetSol);
    $('statusLine').textContent = `${cfg.status || '—'} · free ${fmt(pot.freeSol)} · reserved ${fmt(pot.reservedSol)} · edge ${(cfg.houseEdgeBps || 0) / 100}%`;

    const feed = $('feed');
    const recent = L.recent || [];
    if (!recent.length) {
      feed.innerHTML = '<p class="empty">No drops yet — be first.</p>';
    } else {
      feed.innerHTML = recent
        .slice(0, 24)
        .map((r) => {
          const win = (r.payoutSol || 0) >= (r.betSol || 0);
          return `<div class="feed-row ${win ? 'is-win' : 'is-loss'}">
            <span>${short(r.from)}</span>
            <span>${fmt(r.betSol)} → ×${r.mult}</span>
            <span class="feed-pay">${fmt(r.payoutSol)} SOL</span>
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
    btn.textContent = 'Dropping…';
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
      } else {
        from = 'MockPlayer';
      }

      let res = await call('drop', { from, betSol });
      if (res?.requiresPayment && res.transaction) {
        if (CFG.mock) {
          res = await call('drop', { from, betSol, txSignature: 'mock-sig-' + Date.now() });
        } else {
          const c = ensureClient();
          const rawTx =
            typeof res.transaction === 'string'
              ? res.transaction
              : res.transaction.data || res.transaction.serialized;
          if (!rawTx) throw new Error('missing payment tx');
          const sent = await c.signAndSendTransaction(rawTx);
          const sig = sent?.signature || sent;
          if (!sig) throw new Error('payment not sent');
          res = await call('drop', {
            from,
            betSol,
            txSignature: typeof sig === 'string' ? sig : String(sig),
          });
        }
      }
      if (!res?.success && res?.already) {
        /* ok */
      } else if (res?.success === false) {
        throw new Error(res.message || res.error || 'drop failed');
      }

      const slot = res.slot ?? 4;
      const seed = res.pathSeed || res.rng || Date.now();
      await animateDrop(seed, slot);

      const toast = $('toast');
      toast.textContent = res.potCapped
        ? `×${res.mult} pot-capped → ${fmt(res.payoutSol)} SOL`
        : `×${res.mult} → ${fmt(res.payoutSol)} SOL`;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2800);

      await refresh();
    } catch (e) {
      console.error(e);
      const toast = $('toast');
      toast.textContent = e.message || String(e);
      toast.classList.add('show', 'err');
      setTimeout(() => toast.classList.remove('show', 'err'), 3200);
    } finally {
      dropping = false;
      btn.disabled = false;
      btn.textContent = 'Drop ball';
    }
  }

  // boot
  window.addEventListener('DOMContentLoaded', () => {
    buildBoard();
    window.addEventListener('resize', () => buildBoard());
    const cfgMin = 0.01;
    const cfgMax = 2;
    $('betRange').min = String(cfgMin);
    $('betRange').max = String(cfgMax);
    $('betRange').step = '0.01';
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
