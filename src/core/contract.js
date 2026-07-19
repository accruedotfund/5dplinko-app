// ─────────────────────────────────────────────────────────────────────────────
// contract.js — a generic client for ProofNetwork contracts.
//
// Wraps the three call shapes documented by the proofnetwork-frontend skill so
// the rest of the app never hand-rolls a challenge/sign/submit dance:
//
//   view(fn, inputs)            → single round-trip read / unsigned write
//   write(fn, inputs, opts)     → signed two-step (verifyTimeBoundSignature)
//   batch(operations)           → atomic, all-or-nothing multi-call
//   abi()                       → fetch + cache the contract ABI
//
// …plus the full ProofNetwork realtime (/ws) surface, multiplexed over ONE socket:
//   watch(onChange)                  → contract_state_changed pings (refetch cue)
//   subscribeChannel(channel, cb)    → rt.broadcast(channel, payload) deltas
//   authenticate({wallet, authToken})→ enable rt.emit(wallet, …) per-wallet pushes
//   onEmit(event, cb)                → handle an rt.emit event
//   callOverWs(fn, inputs, opts)     → call a function over the socket (no HTTP)
//   closeSocket() / wsState()        → teardown / readyState
//   ws.{write,send,watch,…}          → the whole realtime surface under one handle
//                                      (ws.write = await result; ws.send = fire-and-forget)
//
// Everything is driven by data: a manifest "action" just names a function and
// whether it is signed; this layer figures out the rest.
// ─────────────────────────────────────────────────────────────────────────────

export function createContract({ config, wallet, store, bus }) {
  const apiUrl = (config.apiUrl || 'https://proofnetwork.lol').replace(/\/$/, '');
  const contractAddress = config.contractAddress;
  const authHeaders = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};

  // proofwallet's callContract returns either the value directly or { result }.
  const unwrap = (res) => (res && typeof res === 'object' && 'result' in res ? res.result : res);

  // ── A) View / unsigned write ────────────────────────────────────────────────
  async function view(fn, inputs = {}) {
    return unwrap(await wallet.client.callContract(fn, inputs));
  }

  // ── B) Signed write — the verifyTimeBoundSignature two-step ──────────────────
  // opts:
  //   signed         : default true. Pass false to skip the challenge (anon write).
  //   challengeFn    : override the challenge view name (default generate<Fn>Challenge)
  //   challengeInputs: extra inputs for the challenge call
  async function write(fn, inputs = {}, opts = {}) {
    const address = wallet.address();
    if (!address) throw new Error('Wallet not connected');

    let result;
    if (opts.signed === false) {
      result = unwrap(await wallet.client.callContract(fn, { walletAddress: address, ...inputs }));
    } else {
      const { challengeId, signature } = await sign(fn, opts);
      result = unwrap(
        await wallet.client.callContract(fn, { walletAddress: address, signature, challengeId, ...inputs })
      );
    }
    bus.emit(`result:${fn}`, result); // projections can play this out
    return result;
  }

  // Run the challenge → signMessage step and return { challengeId, signature }.
  // Reusable so signed ops can be assembled into a batch.
  async function sign(fn, opts = {}) {
    const address = wallet.address();
    if (!address) throw new Error('Wallet not connected');
    const challengeFn = opts.challengeFn || `generate${capitalize(fn)}Challenge`;
    const challenge = await view(challengeFn, { walletAddress: address, ...(opts.challengeInputs || {}) });
    if (!challenge?.challenge) {
      throw new Error(`Challenge "${challengeFn}" did not return a challenge string`);
    }
    // Sign the EXACT string — no trimming/reformatting, or verification fails.
    const { signatureBase58 } = await wallet.signMessage(challenge.challenge);
    return { challengeId: challenge.challengeId, signature: signatureBase58 };
  }

  // ── C) Atomic batch — proofwallet doesn't wrap this, so we POST directly ──────
  async function batch(operations) {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new Error('batch() needs a non-empty operations array');
    }
    if (operations.length > 20) throw new Error('batch() max is 20 operations');
    const address = wallet.address();
    const ops = operations.map((op) => ({
      contractAddress: op.contractAddress || contractAddress,
      functionName: op.functionName,
      inputs: op.inputs || {},
      from: op.from || address,
    }));
    const res = await fetch(`${apiUrl}/api/blockchain/contracts/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ operations: ops }),
    }).then((r) => r.json());
    if (res?.success === false) {
      throw new Error(`Batch rolled back at op #${res.failedAt}: ${res.error}`);
    }
    return res;
  }

  // ── ABI (fetched once, cached in the store) ──────────────────────────────────
  async function abi() {
    const cached = store.get('abi');
    if (cached) return cached;
    const data = await fetch(`${apiUrl}/api/blockchain/contracts/${contractAddress}/abi`, {
      headers: authHeaders,
    }).then((r) => r.json());
    store.set('abi', data);
    return data;
  }

  // ── D) Realtime over /ws ──────────────────────────────────────────────────────
  // ONE shared socket multiplexes all four ProofNetwork /ws message types:
  //   • watch_contract     → `contract_state_changed` pings (state mutated, refetch)
  //   • subscribe_channel  → `rt.broadcast(channel, payload)` room/channel deltas
  //                          (incl. `rt.snapshot` packets; the netcode component decodes them)
  //   • authenticate       → `rt.emit(wallet, event, payload)` per-wallet pushes
  //   • contract_call      → call a function over the socket (no HTTP round-trip)
  // Subscriptions are reference-counted and REPLAYED on reconnect, so a dropped
  // connection self-heals. The socket is lazy (opens on first use) and torn down
  // when the last subscription goes away.
  const wsUrl = config.wsUrl || `${apiUrl.replace(/^http/, 'ws')}/ws`;
  let sock = null;
  let isOpen = false;
  let manualClose = false;
  let backoff = 1000;
  let retryTimer = 0;
  let callSeq = 0;
  const sendQueue = [];                 // one-shot frames buffered until OPEN
  const stateWatchers = new Set();      // contract_state_changed callbacks
  const channelSubs = new Map();        // channel -> Set<cb>
  const emitHandlers = new Map();       // event   -> Set<cb>
  const pendingCalls = new Map();       // callId  -> { resolve, reject, timer }
  let authFrame = null;                 // last authenticate frame (replayed on reconnect)

  const hasWork = () =>
    stateWatchers.size || channelSubs.size || emitHandlers.size || authFrame || pendingCalls.size;

  // Subscription frames are replayed from the live sets on every (re)open, so they
  // are sent directly when open and otherwise simply skipped (NOT queued — the
  // replay covers them, avoiding duplicates).
  const sendNow = (obj) => { if (isOpen && sock?.readyState === 1) sock.send(JSON.stringify(obj)); };
  // One-shot frames (contract_call) are buffered until the socket is open.
  const sendQueued = (obj) => {
    const s = JSON.stringify(obj);
    if (isOpen && sock?.readyState === 1) sock.send(s); else sendQueue.push(s);
  };

  function ensureSocket() {
    if (sock && (sock.readyState === 0 || sock.readyState === 1)) return;
    connect();
  }

  function connect() {
    manualClose = false;
    sock = new WebSocket(wsUrl);
    sock.onopen = () => {
      isOpen = true;
      backoff = 1000;
      // replay every active subscription
      if (stateWatchers.size) {
        sendNow({ type: 'watch_contract', contractAddress });
        sendNow({ type: 'subscribe', contractAddress }); // back-compat alias
      }
      for (const ch of channelSubs.keys()) sendNow({ type: 'subscribe_channel', contractAddress, channel: ch });
      if (authFrame) sendNow(authFrame);
      // flush buffered one-shot frames
      while (sendQueue.length) sock.send(sendQueue.shift());
      bus.emit('contract:ws-open', { contractAddress });
    };
    sock.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      dispatch(msg);
    };
    sock.onclose = () => {
      isOpen = false;
      bus.emit('contract:ws-close', { contractAddress });
      if (manualClose || !hasWork()) return;
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000); // exponential backoff, capped
    };
    sock.onerror = () => { try { sock.close(); } catch {} };
  }

  function dispatch(msg) {
    bus.emit('contract:ws-message', msg); // raw escape hatch for unknown shapes

    // 1) state-changed ping
    if (msg.type === 'contract_state_changed' && (!msg.contractAddress || msg.contractAddress === contractAddress)) {
      bus.emit('contract:changed', msg);
      stateWatchers.forEach((cb) => { try { cb(msg); } catch (err) { console.error('[contract] watch cb', err); } });
      return;
    }
    // 2) contract_call result (best-effort id correlation)
    if (msg.id != null && pendingCalls.has(msg.id)) {
      const p = pendingCalls.get(msg.id);
      pendingCalls.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || msg.error));
      else p.resolve(msg.result ?? msg.data ?? msg);
      maybeClose();
      return;
    }
    // 3) rt.emit — per-wallet event (carries an event name, no channel)
    const ev = msg.event;
    if (ev && emitHandlers.has(ev)) {
      const payload = msg.payload ?? msg.data ?? msg;
      emitHandlers.get(ev).forEach((cb) => { try { cb(payload, msg); } catch (err) { console.error('[contract] emit cb', err); } });
      return;
    }
    // 4) rt.broadcast — channel-scoped delta
    const ch = msg.channel ?? msg.data?.channel;
    if (ch && channelSubs.has(ch)) {
      const payload = msg.payload ?? msg.data ?? msg;
      channelSubs.get(ch).forEach((cb) => { try { cb(payload, msg); } catch (err) { console.error('[contract] channel cb', err); } });
    }
  }

  // Close the socket once nothing needs it (lazy teardown).
  function maybeClose() {
    if (hasWork()) return;
    manualClose = true;
    clearTimeout(retryTimer);
    try { sock?.close(); } catch {}
    sock = null; isOpen = false;
  }

  // Subscribe to `contract_state_changed`. onChange(msg) fires on every write.
  function watch(onChange) {
    if (typeof onChange === 'function') stateWatchers.add(onChange);
    ensureSocket();
    sendNow({ type: 'watch_contract', contractAddress });
    sendNow({ type: 'subscribe', contractAddress });
    return () => {
      if (onChange) stateWatchers.delete(onChange);
      if (!stateWatchers.size) sendNow({ type: 'unwatch_contract', contractAddress });
      maybeClose();
    };
  }

  // Subscribe to an `rt.broadcast` channel (e.g. `lobby:L3`). onMessage(payload, raw).
  function subscribeChannel(channel, onMessage) {
    if (!channel) throw new Error('subscribeChannel(channel, cb) needs a channel');
    let set = channelSubs.get(channel);
    if (!set) { set = new Set(); channelSubs.set(channel, set); }
    if (typeof onMessage === 'function') set.add(onMessage);
    ensureSocket();
    sendNow({ type: 'subscribe_channel', contractAddress, channel });
    return () => {
      const s = channelSubs.get(channel);
      if (s) { s.delete(onMessage); if (!s.size) channelSubs.delete(channel); }
      sendNow({ type: 'unsubscribe_channel', contractAddress, channel });
      maybeClose();
    };
  }

  // Authenticate the socket so `rt.emit(wallet, …)` messages reach it. Pass an
  // authToken if the backend requires one; defaults to the connected wallet.
  function authenticate({ wallet: w, authToken } = {}) {
    const addr = w || wallet.address();
    if (!addr) throw new Error('authenticate() needs a wallet address');
    authFrame = { type: 'authenticate', wallet: addr, ...(authToken ? { authToken } : {}) };
    ensureSocket();
    sendNow(authFrame);
  }

  // Listen for an `rt.emit` event delivered to the authenticated wallet.
  function onEmit(event, handler) {
    if (!event) throw new Error('onEmit(event, cb) needs an event name');
    let set = emitHandlers.get(event);
    if (!set) { set = new Set(); emitHandlers.set(event, set); }
    if (typeof handler === 'function') set.add(handler);
    ensureSocket();
    return () => {
      const s = emitHandlers.get(event);
      if (s) { s.delete(handler); if (!s.size) emitHandlers.delete(event); }
      maybeClose();
    };
  }

  // Call a contract function over the socket instead of HTTP. Resolves with the
  // result, rejects on error or timeout. Best-effort id correlation (the server
  // echoes the id we send). For signed writes prefer write() (HTTP challenge flow).
  function callOverWs(fn, inputs = {}, opts = {}) {
    const id = `c${++callSeq}`;
    ensureSocket();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        reject(new Error(`WS contract_call "${fn}" timed out`));
        maybeClose();
      }, opts.timeoutMs || 15000);
      pendingCalls.set(id, { resolve, reject, timer });
      sendQueued({
        type: 'contract_call', id,
        data: { from: opts.from || wallet.address(), contractAddress, functionName: fn, inputs },
      });
    });
  }

  // Fire-and-forget contract_call over the socket: NO id, NO pending-call wait, NO
  // await — for high-FREQUENCY input (e.g. `move`) where a per-call response would be
  // wasteful. The contract still validates it authoritatively; you just don't block on it.
  function sendCall(fn, inputs = {}, opts = {}) {
    ensureSocket();
    sendQueued({
      type: 'contract_call',
      data: { from: opts.from || wallet.address(), contractAddress, functionName: fn, inputs },
    });
  }

  // Explicit teardown (boot can call on destroy).
  function closeSocket() {
    manualClose = true;
    clearTimeout(retryTimer);
    stateWatchers.clear(); channelSubs.clear(); emitHandlers.clear();
    pendingCalls.forEach((p) => { clearTimeout(p.timer); });
    pendingCalls.clear();
    authFrame = null;
    try { sock?.close(); } catch {}
    sock = null; isOpen = false;
  }

  const wsState = () => (sock ? sock.readyState : 3); // 0..3 (CONNECTING/OPEN/CLOSING/CLOSED)

  // The whole realtime surface under ONE handle: `ctx.contract.ws.*`.
  //   ws.write(fn, inputs)  → call over the socket, AWAIT the result (RPC-style)
  //   ws.send(fn, inputs)   → fire-and-forget contract_call (no await) — high-freq input
  //   ws.watch / subscribeChannel / authenticate / onEmit / raw / state / close / ensure
  const ws = {
    write: callOverWs, call: callOverWs, view: callOverWs,
    send: sendCall,
    watch, subscribeChannel, authenticate, onEmit,
    raw: (obj) => sendQueued(obj),
    state: wsState, close: closeSocket, ensure: ensureSocket,
  };

  return {
    view, write, sign, batch, abi,
    watch, subscribeChannel, authenticate, onEmit, callOverWs, closeSocket, wsState,
    ws,                                   // ctx.contract.ws.write / .send / …
    apiUrl, contractAddress,
  };
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
