// ─────────────────────────────────────────────────────────────────────────────
// mock-contract.js — a LOCAL stand-in for a ProofNetwork contract.
//
// Drop-in replacement for core/contract.js: identical surface
// (view / write / sign / batch / abi / watch), but state lives in-browser and
// the "functions" are plain JS handlers supplied as DATA via manifest.mock.
// Components can't tell mock from real — boot.js chooses the provider.
//
// In prod you set a real contractAddress (and/or config.mock:false) and the app
// talks to the real contract through proofwallet instead. Nothing else changes.
//
// manifest.mock shape:
//   {
//     state: { ... },                       // seed state (cloned on init)
//     latencyMs?: number,                   // simulated network delay (default 120)
//     abi?: [...],                          // optional; otherwise derived from functions
//     functions: {
//       getLeaderboard: (inputs, ctx) => any,        // ctx = { state, address, inputs, wallet }
//       submitScore:    (inputs, ctx) => any,        // mutate ctx.state, return a result
//       // generate<X>Challenge handlers are optional — auto-generated if absent
//     }
//   }
// ─────────────────────────────────────────────────────────────────────────────

export function createMockContract({ config, wallet, store, bus, mock = {} }) {
  const fns = mock.functions || {};
  const latency = mock.latencyMs ?? 120;
  // Deep-ish clone of seed state so re-boots start fresh and don't mutate the manifest.
  const state = structuredClone(mock.state ?? {});
  const challenges = new Map(); // challengeId -> { wallet, fn, expiresAt }

  const delay = () => new Promise((r) => setTimeout(r, latency));
  const newId = () =>
    (globalThis.crypto?.randomUUID?.() || `c_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);

  // Local stand-in for the sandbox `rt` API so mock contract functions can
  // `rt.broadcast(channel, payload)` / `rt.emit(wallet, event, payload)` exactly
  // like the real runtime — routed over the bus to the matching subscribers below.
  const rt = {
    broadcast(channel, payload) { bus.emit(`mock:ws:channel:${channel}`, payload); return 0; },
    emit(walletAddr, event, payload) { bus.emit(`mock:ws:emit:${walletAddr}:${event}`, payload); return 0; },
  };

  function ctxFor(inputs) {
    return { state, inputs, wallet, address: wallet.address(), bus, config, rt };
  }

  function isChallengeFn(fn) {
    return /^generate.*Challenge$/.test(fn);
  }

  // ── A) view / read ────────────────────────────────────────────────────────
  async function view(fn, inputs = {}) {
    await delay();
    if (typeof fns[fn] === 'function') return fns[fn](inputs, ctxFor(inputs));
    if (isChallengeFn(fn)) return issueChallenge(fn, inputs);
    throw new Error(`Function does not exist on contract: ${fn}`);
  }

  function issueChallenge(fn, inputs) {
    const id = newId();
    const walletAddress = inputs.walletAddress || wallet.address() || 'anon';
    const expiresAt = Date.now() + 5 * 60 * 1000;
    challenges.set(id, { wallet: walletAddress, fn, expiresAt });
    return {
      challengeId: id,
      challenge: `${config.contractAddress || 'mock'}:${fn}:${walletAddress}:${id}`,
      expiresAt,
    };
  }

  // ── B) signed write — runs the REAL signMessage so the flow is exercised ───
  async function sign(fn, opts = {}) {
    const address = wallet.address();
    if (!address) throw new Error('Wallet not connected');
    const challengeFn = opts.challengeFn || `generate${capitalize(fn)}Challenge`;
    const challenge = await view(challengeFn, { walletAddress: address, ...(opts.challengeInputs || {}) });
    const { signatureBase58 } = await wallet.signMessage(challenge.challenge);
    return { challengeId: challenge.challengeId, signature: signatureBase58 };
  }

  async function write(fn, inputs = {}, opts = {}) {
    const address = wallet.address();
    if (!address) throw new Error('Wallet not connected');

    let signed = {};
    if (opts.signed !== false) {
      const { challengeId, signature } = await sign(fn, opts);
      // Faithful single-use + TTL behaviour
      const rec = challenges.get(challengeId);
      if (!rec) throw new Error('challenge not found');
      if (Date.now() > rec.expiresAt) throw new Error('Signature verification failed (challenge expired)');
      challenges.delete(challengeId);
      signed = { challengeId, signature };
    }

    await delay();
    if (typeof fns[fn] !== 'function') throw new Error(`Function does not exist on contract: ${fn}`);
    const merged = { walletAddress: address, ...signed, ...inputs };
    const result = fns[fn](merged, ctxFor(merged));
    emitChange(fn, result);
    bus.emit(`result:${fn}`, result); // projections can play this out
    return result;
  }

  // ── C) atomic batch — all-or-nothing on a cloned state ─────────────────────
  async function batch(operations) {
    if (!Array.isArray(operations) || operations.length === 0) throw new Error('batch() needs operations');
    if (operations.length > 20) throw new Error('batch() max is 20 operations');
    await delay();
    const snapshot = structuredClone(state);
    const results = [];
    try {
      for (const op of operations) {
        const fn = op.functionName;
        if (typeof fns[fn] !== 'function') throw new Error(`Function does not exist: ${fn}`);
        const inputs = op.inputs || {};
        results.push(fns[fn](inputs, ctxFor(inputs)));
      }
    } catch (err) {
      // rollback
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, snapshot);
      return { success: false, failedAt: results.length, error: err.message };
    }
    emitChange('batch', results);
    return { success: true, batch: { results, processed: results.length, failed: 0 } };
  }

  // ── ABI ────────────────────────────────────────────────────────────────────
  async function abi() {
    await delay();
    if (mock.abi) return mock.abi;
    return Object.keys(fns).map((name) => ({
      name,
      inputs: [],
      outputs: [],
      description: `mock: ${name}`,
      signed: !isChallengeFn(name) && !/^get|^list|^read/i.test(name),
    }));
  }

  // ── live state — local pub/sub mirrors the real /ws contract_state_changed ──
  function emitChange(fn, result) {
    const msg = { type: 'contract_state_changed', contractAddress: config.contractAddress, fn, mock: true };
    store.set('mock:lastChange', { fn, at: Date.now() });
    bus.emit('contract:changed', msg);
    bus.emit('mock:changed', msg);
  }

  function watch(onChange) {
    return bus.on('mock:changed', (msg) => onChange?.(msg));
  }

  // ── realtime surface — mirrors core/contract.js so components don't branch ───
  // A mock function that calls ctx.rt.broadcast(channel, …) reaches these subs.
  function subscribeChannel(channel, onMessage) {
    if (!channel) throw new Error('subscribeChannel(channel, cb) needs a channel');
    return bus.on(`mock:ws:channel:${channel}`, (payload) => onMessage?.(payload, { channel, mock: true }));
  }
  // rt.emit targets a wallet; default to the connected one.
  function onEmit(event, handler, walletAddr) {
    if (!event) throw new Error('onEmit(event, cb) needs an event name');
    const addr = walletAddr || wallet.address() || 'anon';
    return bus.on(`mock:ws:emit:${addr}:${event}`, (payload) => handler?.(payload, { event, mock: true }));
  }
  function authenticate() { /* no-op locally — every socket is "authenticated" */ }
  // Call over "ws" → just run the function locally (signed:false path).
  function callOverWs(fn, inputs = {}, opts = {}) { return write(fn, inputs, { ...opts, signed: false }); }
  // Fire-and-forget over "ws" — run the mutation, don't await / surface errors.
  function sendCall(fn, inputs = {}, opts = {}) { Promise.resolve(callOverWs(fn, inputs, opts)).catch(() => {}); }
  function closeSocket() { /* nothing persistent to tear down in mock */ }
  function wsState() { return 1; } // always "open"

  // Same `ws` handle shape as core/contract.js so components never branch on provider.
  const ws = {
    write: callOverWs, call: callOverWs, view: callOverWs,
    send: sendCall,
    watch, subscribeChannel, authenticate, onEmit,
    raw() {}, state: wsState, close: closeSocket, ensure() {},
  };

  // ── server-authoritative tick (mirrors ProofNetwork metadata.tickRate + onTick)
  // Runs a periodic mutation and pushes authoritative state. This is what lets a
  // projection reconcile client prediction against the contract's truth.
  let tickTimer;
  if (mock.tick && typeof mock.tick.run === 'function') {
    tickTimer = setInterval(() => {
      try {
        mock.tick.run({ state, store, bus });
      } catch (e) {
        console.error('[mock] tick threw:', e);
      }
      emitChange('tick', null);
    }, mock.tick.everyMs || 5000);
  }

  return {
    destroy() { clearInterval(tickTimer); },
    view,
    write,
    sign,
    batch,
    abi,
    watch,
    subscribeChannel,
    authenticate,
    onEmit,
    callOverWs,
    closeSocket,
    wsState,
    ws,                                   // ctx.contract.ws.write / .send / …
    apiUrl: config.apiUrl,
    contractAddress: config.contractAddress,
    isMock: true,
    _state: state, // exposed for debugging via window.app.contract._state
  };
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
