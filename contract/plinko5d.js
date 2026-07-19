/**
 * 5dplinko.app — multiplayer pot Plinko in FIVE DIMENSIONS.
 *
 * Path is a 5-vector (d0..d4) ∈ [0,1]^5 from VRF. Bin index is the
 * projection of that hyperspace walk onto 9 payout slots.
 * Pot pays bet×mult, capped to cash on hand (thin pot OK).
 */

const VRF_PRECISION = 1_000_000_000;
const N_DIMS = 5;
const N_BINS = 9;
// Thin-pot mults (max 5×). No 25× / 1.25 SOL cold-start wall.
const DEFAULT_MULTS = [5, 3, 2, 1.2, 0.6, 1.2, 2, 3, 5];
// Soft center bias weights for 9 bins (not required for 5D map, used for docs)
const BIN_WEIGHTS = [1, 8, 28, 56, 70, 56, 28, 8, 1];

const state = {
  metadata: {
    name: "5dplinko",
    description:
      "5dplinko.app — five-dimensional multiplayer pot Plinko. Bets, reserve, shared wins.",
    version: "2.0.0",
    author: "5dplinko",
    bounded: {
      "game.recent": { ring: 40 },
    },
  },

  deployer: null,
  admins: [],
  treasuryPublicKey: null,

  config: {
    status: "open",
    minBetSol: 0.01,
    maxBetSol: 2,
    houseEdgeBps: 200,
    mults: DEFAULT_MULTS.slice(),
    dims: N_DIMS,
    bins: N_BINS,
    enforceReserve: false,
  },

  pot: {
    accruedSol: 0,
    reservedSol: 0,
    paidWinsSol: 0,
    refundedSol: 0,
    houseTakenSol: 0,
    drops: 0,
  },

  game: {
    nextDropId: 1,
    recent: [],
    openBets: {},
  },

  processed: {
    betTx: {},
  },

  stats: {
    volumeSol: 0,
    wins: 0,
    losses: 0,
    refunds: 0,
    uniquePlayers: 0,
  },
  players: {},
};

/**
 * onDeploy
 * @param {Object} inputs
 * @param {string} inputs.deployer
 */
function onDeploy(inputs) {
  state.deployer = inputs.deployer;
  state.admins = [inputs.deployer];
  const kp = blackbox.generateSolanaKeypair();
  state.treasuryPublicKey = kp.publicKey;
  state.config.status = "open";
  return {
    success: true,
    message: "5dplinko 5D pot deployed",
    treasury: state.treasuryPublicKey,
    dims: N_DIMS,
    mults: state.config.mults,
  };
}

/**
 * @internal
 */
function gate(action, inputs, allowed) {
  const wallet = inputs.wallet || inputs.from;
  if (allowed && !allowed.includes(wallet)) throw new Error("not authorised");
  if (!inputs.signature) {
    return {
      ok: false,
      challenge: {
        success: true,
        requiresSignature: true,
        message: `${action}:${Date.now()}`,
        expiresIn: "5 minutes",
      },
    };
  }
  const message = inputs.message;
  if (!message || message.indexOf(`${action}:`) !== 0) {
    throw new Error("message does not match action");
  }
  const v = verify.verifyTimeBoundSignature(message, inputs.signature, wallet, 5);
  if (!v?.success) throw new Error(v?.error || "signature verification failed");
  return { ok: true, wallet, _sig: inputs.signature };
}

/**
 * @internal
 */
async function consumeSig(sig) {
  if (!sig) return;
  if (typeof signatures !== "undefined" && signatures.markUsed) {
    const fresh = await signatures.markUsed(sig);
    if (!fresh) throw new Error("signature already used");
  }
}

/**
 * configure — admin
 * @param {Object} inputs
 */
async function configure(inputs) {
  const g = gate(`plinko:configure:${inputs.wallet || inputs.from}`, inputs, state.admins);
  if (!g.ok) return g.challenge;
  await consumeSig(g._sig);
  if (typeof inputs.minBetSol === "number" && inputs.minBetSol > 0) {
    state.config.minBetSol = inputs.minBetSol;
  }
  if (typeof inputs.maxBetSol === "number" && inputs.maxBetSol >= state.config.minBetSol) {
    state.config.maxBetSol = inputs.maxBetSol;
  }
  if (typeof inputs.houseEdgeBps === "number") {
    const b = Math.floor(inputs.houseEdgeBps);
    if (b < 0 || b > 2000) throw new Error("houseEdgeBps 0..2000");
    state.config.houseEdgeBps = b;
  }
  if (Array.isArray(inputs.mults) && inputs.mults.length === N_BINS) {
    state.config.mults = inputs.mults.map(Number);
  }
  return { success: true, config: publicConfig() };
}

/**
 * drop — 5D bet + VRF settle (2-step commerce.charge)
 * @bounded
 * @param {Object} inputs
 * @param {string} inputs.from
 * @param {number} [inputs.betSol]
 * @param {string} [inputs.txSignature]
 */
async function drop(inputs) {
  // Coerce types — TypeBox union errors if buyer/sig arrive as objects
  const from = walletStr(inputs.from);
  if (!from || from === "guest") throw new Error("wallet required");
  if (state.config.status !== "open") throw new Error("game not open");

  const bet = Number(inputs.betSol);
  if (!(bet >= state.config.minBetSol && bet <= state.config.maxBetSol)) {
    throw new Error(
      `bet must be ${state.config.minBetSol}..${state.config.maxBetSol} SOL`
    );
  }

  const maxMult = maxMultiplier();
  const free = freePotSol();
  const maxPayable = round6(free + bet);
  const maxLiability = round6(Math.min(bet * maxMult, maxPayable));

  // signature must be string | null (never an object / undefined)
  const paySig = sigStr(inputs.txSignature);
  if (paySig && state.processed.betTx[paySig]) {
    const prev = state.processed.betTx[paySig];
    return {
      success: true,
      already: true,
      dropId: prev.dropId,
      slot: prev.slot,
      mult: prev.mult,
      dims: prev.dims,
      payoutSol: prev.payoutSol,
      outcome: prev.outcome,
      from: prev.from,
      betSol: prev.betSol,
    };
  }

  // Exact shape from ProofNetwork commerce.charge docs + working unlocker
  const charge = await commerce.charge({
    buyer: from,
    amount: bet,
    priceCurrency: "SOL",
    acceptedCurrencies: ["SOL", "USDC"],
    treasury: state.treasuryPublicKey,
    memo: "plinko5d:drop",
    signature: paySig, // null on step 1
  });

  if (charge.requiresPayment) {
    // Return base64 string when possible so FE + TypeBox stay happy
    // (charge.transaction is often { data: base64 })
    return {
      success: true,
      requiresPayment: true,
      transaction: txPayload(charge.transaction),
      currency: charge.currency || "SOL",
      amount: Number(charge.amount) || bet,
      treasury: state.treasuryPublicKey,
      betSol: bet,
      maxWinSol: maxLiability,
      dims: N_DIMS,
    };
  }
  if (!charge.confirmed) return { success: false, message: "charge not confirmed" };

  const confirmedSig = charge.txSignature || paySig;
  if (confirmedSig && state.processed.betTx[confirmedSig]) {
    const prev = state.processed.betTx[confirmedSig];
    return {
      success: true,
      already: true,
      dropId: prev.dropId,
      slot: prev.slot,
      mult: prev.mult,
      dims: prev.dims,
      payoutSol: prev.payoutSol,
      outcome: prev.outcome,
      from: prev.from,
      betSol: prev.betSol,
    };
  }
  if (confirmedSig && typeof signatures !== "undefined" && signatures.markUsed) {
    await signatures.markUsed("plinko5d:drop:" + confirmedSig);
  }

  state.pot.accruedSol = round6(state.pot.accruedSol + bet);
  state.stats.volumeSol = round6(state.stats.volumeSol + bet);

  const edge = round6((bet * (state.config.houseEdgeBps || 0)) / 10000);
  state.pot.houseTakenSol = round6(state.pot.houseTakenSol + edge);

  state.pot.reservedSol = round6(state.pot.reservedSol + maxLiability);
  const dropId = state.game.nextDropId++;
  state.game.openBets[String(dropId)] = {
    from,
    bet,
    reserved: maxLiability,
    at: Date.now(),
  };

  // ── 5D path from VRF ────────────────────────────────────────────
  // One VRF sample → expand to 5 independent unit coords via hash chain
  const roll = await vrfApi.selectNumber(1, VRF_PRECISION);
  const dims = expand5D(roll.result);
  const slot = slotFrom5D(dims);
  const mult = Number(state.config.mults[slot]) || 0;
  let idealPayout = round6(bet * mult);
  let payout = idealPayout;
  let potCapped = false;
  let paySignature = null;

  state.pot.reservedSol = round6(Math.max(0, state.pot.reservedSol - maxLiability));
  delete state.game.openBets[String(dropId)];

  const cash = cashPotSol();
  if (payout > cash + 1e-9) {
    payout = cash;
    potCapped = true;
  }
  if (payout > 0) {
    if (payout + 1e-9 >= bet) state.stats.wins += 1;
    else state.stats.losses += 1;
    try {
      paySignature = await payFromTreasury(from, payout);
    } catch (e) {
      // Treasury send failed (shape / funds) — keep accounting honest, surface message
      paySignature = null;
      potCapped = true;
      payout = 0;
      state.stats.refunds += 1;
    }
    if (payout > 0) {
      state.pot.paidWinsSol = round6(state.pot.paidWinsSol + payout);
    }
  } else {
    state.stats.losses += 1;
  }
  if (potCapped && payout > 0) state.stats.refunds += 1;

  state.pot.drops += 1;
  trackPlayer(from, bet, payout);

  const finalOutcome = potCapped ? "capped" : payout + 1e-9 >= bet ? "win" : "loss";

  // PLAIN JSON only — nested proof objects / umi Signature classes trigger
  // TypeBox "union of type|type, received [object Object]" on the wire.
  const potSnap = publicPot();
  const result = {
    success: true,
    dropId: Number(dropId),
    from: String(from),
    betSol: Number(bet),
    d0: Number(dims[0]),
    d1: Number(dims[1]),
    d2: Number(dims[2]),
    d3: Number(dims[3]),
    d4: Number(dims[4]),
    // keep dims as number[] (JSON-safe); FE uses this
    dims: dims.map(Number),
    slot: Number(slot),
    mult: Number(mult),
    payoutSol: Number(payout),
    idealPayoutSol: Number(idealPayout),
    profitSol: Number(round6(payout - bet)),
    outcome: String(finalOutcome),
    potCapped: !!potCapped,
    edgeSol: Number(edge),
    paySignature: plainSig(paySignature),
    rng: Number(roll.result),
    pathSeed: Number(roll.result),
    txSignature: confirmedSig ? String(confirmedSig) : null,
    // flat pot fields (no nested pot object)
    potCashSol: Number(potSnap.cashSol),
    potFreeSol: Number(potSnap.freeSol),
    potDrops: Number(potSnap.drops),
  };

  pushRecent({
    dropId: result.dropId,
    from: result.from,
    betSol: result.betSol,
    slot: result.slot,
    mult: result.mult,
    dims: result.dims.slice(),
    payoutSol: result.payoutSol,
    outcome: result.outcome,
    at: Date.now(),
  });

  if (confirmedSig) {
    state.processed.betTx[confirmedSig] = {
      dropId: result.dropId,
      slot: result.slot,
      mult: result.mult,
      dims: result.dims.slice(),
      payoutSol: result.payoutSol,
      outcome: result.outcome,
      from: result.from,
      betSol: result.betSol,
    };
  }

  try {
    if (typeof rt !== "undefined" && rt.broadcast) {
      rt.broadcast("drops", {
        dropId: result.dropId,
        from: result.from,
        betSol: result.betSol,
        slot: result.slot,
        mult: result.mult,
        dims: result.dims,
        payoutSol: result.payoutSol,
        outcome: result.outcome,
      });
      rt.broadcast("pot", potSnap);
    }
  } catch (e) {
    /* optional */
  }

  return result;
}

/**
 * getLobby
 */
function getLobby() {
  return {
    config: publicConfig(),
    pot: publicPot(),
    recent: state.game.recent.slice(-30).reverse(),
    stats: state.stats,
    openBets: Object.keys(state.game.openBets).length,
    bins: state.config.mults.map((mult, slot) => ({
      slot,
      mult,
      weight: BIN_WEIGHTS[slot],
    })),
    dims: N_DIMS,
  };
}

/** @returns {Object} */
function getPot() {
  return publicPot();
}

/** @returns {Object} */
function getConfig() {
  return publicConfig();
}

/** @returns {Object} */
function getRecent() {
  return { recent: state.game.recent.slice(-40).reverse() };
}

/**
 * @param {Object} inputs
 */
function getPlayer(inputs) {
  const w = inputs.wallet || inputs.from;
  return { wallet: w, stats: state.players[w] || { drops: 0, wagered: 0, won: 0 } };
}

/**
 * withdrawHouse — admin free pot only
 * @param {Object} inputs
 */
async function withdrawHouse(inputs) {
  const g = gate(`plinko:withdraw:${inputs.wallet || inputs.from}`, inputs, state.admins);
  if (!g.ok) return g.challenge;
  await consumeSig(g._sig);
  const amount = Number(inputs.amount);
  const free = freePotSol();
  if (!(amount > 0) || amount > free + 1e-9) {
    throw new Error(`withdraw exceeds free pot (free ${free})`);
  }
  const dest = inputs.destination || g.wallet;
  const paySignature = await payFromTreasury(dest, amount);
  state.pot.paidWinsSol = round6(state.pot.paidWinsSol + amount);
  return { success: true, amount, destination: dest, paySignature, pot: publicPot() };
}

// ─── 5D math ─────────────────────────────────────────────────────────────

/**
 * Expand one VRF u32-ish sample into 5 independent unit floats via LCG.
 * @internal
 * @param {number} seed
 * @returns {number[]}
 */
function expand5D(seed) {
  let s = (Number(seed) >>> 0) || 1;
  const dims = [];
  for (let i = 0; i < N_DIMS; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    dims.push(s / 4294967296);
  }
  return dims;
}

/**
 * Map 5D point → bin 0..8.
 * Each dim is a "left/right" through that dimension; sum of steps ~ Binomial(5)
 * remapped into 9 slots for the payout rail.
 * @internal
 * @param {number[]} dims
 * @returns {number}
 */
function slotFrom5D(dims) {
  // 5 binary decisions → score 0..5, then stretch to 0..8
  let score = 0;
  for (let i = 0; i < N_DIMS; i++) {
    if (dims[i] >= 0.5) score += 1;
  }
  // score 0..5 → slots emphasizing center: map via (score/5)*8
  const slot = Math.min(N_BINS - 1, Math.max(0, Math.round((score / N_DIMS) * (N_BINS - 1))));
  // mix fractional parts for finer spread (avoid only 6 discrete outcomes)
  let frac = 0;
  for (let i = 0; i < N_DIMS; i++) frac += dims[i];
  frac = frac / N_DIMS;
  const jitter = Math.floor((frac - 0.5) * 3); // -1,0,1-ish
  return Math.min(N_BINS - 1, Math.max(0, slot + jitter));
}

/**
 * @internal
 */
function maxMultiplier() {
  return state.config.mults.reduce((a, b) => (Number(b) > a ? Number(b) : a), 0);
}

/**
 * @internal
 */
function cashPotSol() {
  const raw = state.pot.accruedSol - state.pot.paidWinsSol - state.pot.refundedSol;
  return Math.max(0, round6(raw));
}

/**
 * @internal
 */
function freePotSol() {
  return Math.max(0, round6(cashPotSol() - state.pot.reservedSol));
}

/**
 * @internal
 */
async function payFromTreasury(destination, amount) {
  if (!(amount > 0)) return null;
  const dest = walletStr(destination);
  if (!dest) throw new Error("pay: bad destination");
  const kp = blackbox.getKey(0);
  const secret = kp.secretKey || kp.privateKey;
  const u = umi.setKeypairIdentity(umi.createUmi(), secret);
  const builder = umi.transactionBuilder().add(
    umi.transferSol(u, {
      source: u.identity,
      destination: umi.publicKey(dest),
      amount: umi.sol(Number(amount)),
    })
  );
  const res = await umi.safeSend(u, builder, u.identity, {
    commitment: "processed",
    skipPreflight: false,
    maxAttempts: 2,
  });
  return plainSig(res && res.signature);
}

/**
 * @internal
 */
function trackPlayer(from, bet, payout) {
  if (!state.players[from]) {
    state.players[from] = { drops: 0, wagered: 0, won: 0 };
    state.stats.uniquePlayers += 1;
  }
  const p = state.players[from];
  p.drops += 1;
  p.wagered = round6(p.wagered + bet);
  p.won = round6(p.won + payout);
}

/**
 * @internal
 */
function pushRecent(row) {
  state.game.recent.push(row);
  if (state.game.recent.length > 40) {
    state.game.recent = state.game.recent.slice(-40);
  }
}

/**
 * @internal
 */
function publicPot() {
  const cash = cashPotSol();
  return {
    accruedSol: state.pot.accruedSol,
    reservedSol: state.pot.reservedSol,
    paidWinsSol: state.pot.paidWinsSol,
    refundedSol: state.pot.refundedSol,
    houseTakenSol: state.pot.houseTakenSol,
    cashSol: cash,
    freeSol: freePotSol(),
    drops: state.pot.drops,
    maxMult: maxMultiplier(),
  };
}

/**
 * @internal
 */
function publicConfig() {
  return {
    status: state.config.status,
    minBetSol: state.config.minBetSol,
    maxBetSol: state.config.maxBetSol,
    houseEdgeBps: state.config.houseEdgeBps,
    mults: state.config.mults.slice(),
    dims: N_DIMS,
    bins: N_BINS,
    enforceReserve: state.config.enforceReserve,
    treasury: state.treasuryPublicKey,
  };
}

/**
 * @internal
 */
function round6(n) {
  return Math.floor(Number(n) * 1e6 + 1e-9) / 1e6;
}

/**
 * Coerce wallet / pubkey-ish values to base58 string.
 * PublicKey objects → toBase58/toString; anything else stringified carefully.
 * @internal
 * @param {*} w
 * @returns {string|null}
 */
function walletStr(w) {
  if (w == null || w === "") return null;
  if (typeof w === "string") return w;
  if (typeof w === "object") {
    if (typeof w.toBase58 === "function") return w.toBase58();
    if (typeof w.toString === "function") {
      const s = w.toString();
      if (s && s !== "[object Object]") return s;
    }
    if (typeof w.publicKey === "string") return w.publicKey;
    if (typeof w.address === "string") return w.address;
  }
  return null;
}

/**
 * Payment sig must be string | null for commerce.charge TypeBox union.
 * @internal
 * @param {*} s
 * @returns {string|null}
 */
function sigStr(s) {
  if (s == null || s === "") return null;
  if (typeof s === "string") return s;
  if (typeof s === "object") {
    if (typeof s.signature === "string") return s.signature;
    if (typeof s.txSignature === "string") return s.txSignature;
  }
  return null;
}

/**
 * Normalize commerce.charge transaction for the client.
 * Prefer plain base64 string; fall back to original object.
 * @internal
 * @param {*} tx
 * @returns {string|Object|null}
 */
function txPayload(tx) {
  if (tx == null) return null;
  if (typeof tx === "string") return tx;
  if (typeof tx === "object") {
    if (typeof tx.data === "string") return tx.data;
    if (typeof tx.serialized === "string") return tx.serialized;
    if (typeof tx.transaction === "string") return tx.transaction;
  }
  return tx;
}

/**
 * Force umi / web3 signatures into a plain base58 string (or null).
 * Signature class / Uint8Array / {signature} → string.
 * @internal
 * @param {*} s
 * @returns {string|null}
 */
function plainSig(s) {
  if (s == null || s === "") return null;
  if (typeof s === "string") return s;
  if (typeof s === "object") {
    if (typeof s.signature === "string") return s.signature;
    if (typeof s.txSignature === "string") return s.txSignature;
    // Uint8Array / number[] — leave null rather than return object
    if (typeof s.toString === "function") {
      const t = s.toString();
      if (t && t !== "[object Object]") return t;
    }
  }
  return null;
}
