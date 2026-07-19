// ─────────────────────────────────────────────────────────────────────────────
// wallet.js — the ONE core dependency: proofwallet's `CryptoClient`.
//
// We do not re-implement wallet connect, signing, RPC routing, or burners — the
// vendored `vendor/wallet.js` owns all of that. This module just:
//   1. instantiates `CryptoClient` from manifest config,
//   2. bridges its document-level events (`walletConnected` / `walletDisconnected`)
//      into our reactive store + bus, and
//   3. exposes the live instance to the rest of the app.
//
// `window.CryptoClient` is pinned by the inline bridge in index.html (the class
// is declared in a classic script, so it is otherwise only a bare global).
// ─────────────────────────────────────────────────────────────────────────────

// Opt-out: a manifest that makes no contract/wallet calls (e.g. a pure offline
// game) can set `config.wallet = { enabled: false }`. We then NEVER construct
// CryptoClient — so its auto-mounted floating connect button is never created —
// and return a no-op stub with the same shape so the rest of the app is happy.
function stubWallet({ store }) {
  store.set('wallet', { address: null, isConnected: false, isConnecting: false, activeWallet: null });
  const noop = () => {};
  return {
    client: null,
    connect: noop,
    connectTo: noop,
    disconnect: noop,
    autoReconnect: async () => {},
    signMessage: async () => { throw new Error('[wallet] disabled (config.wallet.enabled === false)'); },
    address: () => null,
    ensureBurner: async () => '',
  };
}

export function initWallet({ config, store, bus }) {
  if (config.wallet && config.wallet.enabled === false) return stubWallet({ store });

  const Crypto = window.CryptoClient;
  if (typeof Crypto !== 'function') {
    throw new Error(
      '[wallet] CryptoClient not found. Ensure vendor/wallet.js loaded before the app module.'
    );
  }

  // Seed wallet state so components can render a "disconnected" view immediately.
  store.set('wallet', { address: null, isConnected: false, isConnecting: false, activeWallet: null });

  // config.apiUrl is the BARE host (e.g. https://proofnetwork.lol) — the convention our
  // contract.js wrapper uses (it appends `/api` itself). The CryptoClient instead expects
  // its apiUrl to ALREADY include `/api` (its built-in default is `<host>/api`), so adapt
  // here: append `/api` to a bare host. Without this, client.callContract() POSTs to
  // `<host>/blockchain/contracts/call` (no /api) → 404 → contract writes silently fail.
  // Idempotent (strip any trailing /api, re-add). Unset → undefined → client's own default.
  const clientApiUrl = config.apiUrl
    ? config.apiUrl.replace(/\/+$/, '').replace(/\/api$/, '') + '/api'
    : undefined;

  const client = new Crypto({
    contractAddress: config.contractAddress,
    apiUrl: clientApiUrl,
    apiKey: config.apiKey,
    appName: config.appName,
    mountTo: config.mountTo,
    theme: config.theme,
    onVerify: config.onVerify,
  });

  // Expose for debugging / power-user console use; the app itself uses the return.
  window.wallet = client;

  // proofwallet sets --cc-primary/--cc-accent inline on <html> from its static
  // config (orange). Re-point them at the ACTIVE theme's --pf vars so its picker
  // modal / badges / focus rings follow our theme, and keep them in sync on
  // theme changes. (The connect button itself is already overridden in CSS.)
  function syncWalletTheme() {
    const cs = getComputedStyle(document.documentElement);
    const primary = cs.getPropertyValue('--pf-primary').trim();
    const accent = cs.getPropertyValue('--pf-accent').trim();
    if (primary) document.documentElement.style.setProperty('--cc-primary', primary);
    if (accent) document.documentElement.style.setProperty('--cc-accent', accent);
  }
  syncWalletTheme();
  bus.on('theme:changed', syncWalletTheme);

  syncFromClient();

  document.addEventListener('walletConnected', (e) => {
    const detail = e.detail || {};
    store.set('wallet', {
      address: detail.publicKey ?? client.state?.walletAddress ?? null,
      isConnected: true,
      isConnecting: false,
      activeWallet: detail.wallet ?? client.state?.activeWallet ?? null,
      walletName: detail.walletName,
    });
    bus.emit('wallet:connected', store.get('wallet'));
  });

  document.addEventListener('walletDisconnected', () => {
    store.set('wallet', { address: null, isConnected: false, isConnecting: false, activeWallet: null });
    bus.emit('wallet:disconnected', null);
  });

  // Mirror the library's internal state into our store shape.
  function syncFromClient() {
    const s = client.state || {};
    store.set('wallet', {
      address: s.walletAddress ?? null,
      isConnected: !!s.isConnected,
      isConnecting: !!s.isConnecting,
      activeWallet: s.activeWallet ?? null,
    });
  }

  return {
    client,
    connect: () => client.showOverlay(),
    connectTo: (id) => client.connectWallet(id),
    disconnect: () => client.disconnect(),
    autoReconnect: () => client.autoReconnect(),
    signMessage: (msg) => client.signMessage(msg),
    address: () => store.get('wallet')?.address ?? null,
    // Guarantee a usable wallet WITHOUT a "connect" click: if one is connected, return
    // its address; otherwise get-or-create proofwallet's own local BURNER (a real
    // Solana keypair, persisted in localStorage `cryptoClient_burnerWallets`), make it
    // active, and connect it SILENTLY (connectBurnerWallet = instant, no overlay). The
    // address is returned synchronously (from the keypair); the formal connect runs in
    // the background and updates the store via `walletConnected`. Lets `food` (and any
    // gated action) work for visitors who never connect — they can later switch wallets
    // from the button. Returns '' if the burner API / solanaWeb3 isn't available.
    ensureBurner: async () => {
      const cur = store.get('wallet')?.address;
      if (cur) return cur;
      if (!Crypto.generateBurnerWallet || !Crypto.getBurnerWallets) return '';
      // `solanaWeb3` (the keypair lib) loads ASYNC after boot, so a burner minted on
      // first paint fails — wait for it (up to ~5s) before generating.
      for (let i = 0; i < 50 && !(window.solanaWeb3 && window.solanaWeb3.Keypair); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!(window.solanaWeb3 && window.solanaWeb3.Keypair)) return '';
      // a wallet may have connected while we waited
      if (store.get('wallet')?.address) return store.get('wallet').address;
      try {
        let wallets = Crypto.getBurnerWallets();
        let activeId = Crypto.getActiveBurnerId ? Crypto.getActiveBurnerId() : null;
        if (!activeId || !wallets.some((w) => w.id === activeId)) {
          if (!wallets.length) { const w = Crypto.generateBurnerWallet(); wallets = Crypto.getBurnerWallets(); activeId = w && w.id; }
          else activeId = wallets[0].id;
          if (activeId && Crypto.setActiveBurnerId) Crypto.setActiveBurnerId(activeId);
        }
        const w = wallets.find((x) => x.id === activeId) || wallets[0];
        const addr = w ? w.publicKey : '';
        if (addr) Promise.resolve(client.connectWallet('burner')).catch(() => {}); // silent; updates store via walletConnected
        return addr;
      } catch (e) { return ''; }
    },
  };
}
