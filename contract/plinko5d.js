/**
 * 5dplinko.app — multiplayer pot Plinko on ProofNetwork.
 *
 * Shared house pot. Players bet SOL → VRF picks a bin (plinko-weighted) →
 * win = bet × mult (if pot can pay; else full refund). Reserve tracks max
 * outstanding liability for concurrent in-flight bets.
 *
 * Bins match FreeSol board mults: [25, 8, 3, 1, 0.5, 1, 3, 8, 25]
 */

const VRF_PRECISION = 1_000_000_000;
// Binomial weights for 8-row plinko → 9 bins (C(8,k))
const BIN_WEIGHTS = [1, 8, 28, 56, 70, 56, 28, 8, 1]; // sum 256
// Thin-pot friendly mults (max 5×). Old FreeSol ×25 needs fat bankroll (0.05→1.25).
const DEFAULT_MULTS = [5, 3, 2, 1.2, 0.6, 1.2, 2, 3, 5];

const state = {
  metadata: {
    name: "5dplinko",
    description: "Multiplayer pot Plinko — bets, reserve, shared wins. 5dplinko.app",
    version: "1.0.0",
    author: "5dplinko",
    bounded: {
      "game.recent": { ring: 40 },
    },
  },

  deployer: null,
  admins: [],
  treasuryPublicKey: null,

  config: {
    status: "setup", // setup | open | closed
    minBetSol: 0.01,
    maxBetSol: 2,
    // house keeps this fraction of each bet into pot before roll (edge)
    // wins pay mult of the FULL bet; edge is volume edge not haircut on wins
    houseEdgeBps: 200, // 2% of bet stays as pure house on every drop
    mults: DEFAULT_MULTS.slice(),
    // if true, reject bets when free+bet < bet*maxMult (blocks cold start)
    // default false: accept bets; refund full stake if pot can't pay the hit bin
    enforceReserve: false,
  },

  pot: {
    accruedSol: 0, // all bets in
    reservedSol: 0, // open bets' max liability
    paidWinsSol: 0,
    refundedSol: 0,
    houseTakenSol: 0, // edge skim
    drops: 0,
  },

  game: {
    nextDropId: 1,
    recent: [], // ring of drops for multiplayer feed
    openBets: {}, // dropId -> { from, bet, reserved, at }
  },

  processed: {
    betTx: {}, // txSignature -> drop result
  },

  stats: {
    volumeSol: 0,
    wins: 0,
    losses: 0,
    refunds: 0,
    uniquePlayers: 0,
  },
  players: {}, // wallet -> { drops, wagered, won }
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
  // open immediately for play
  state.config.status = "open";
  return {
    success: true,
    message: "5dplinko deployed",
    treasury: state.treasuryPublicKey,
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
  if (Array.isArray(inputs.mults) && inputs.mults.length === 9) {
    state.config.mults = inputs.mults.map(Number);
  }
  if (typeof inputs.enforceReserve === "boolean") {
    state.config.enforceReserve = inputs.enforceReserve;
  }
  return { success: true, config: publicConfig() };
}

/**
 * openGame — admin
 * @param {Object} inputs
 */
async function openGame(inputs) {
  const g = gate(`plinko:open:${inputs.wallet || inputs.from}`, inputs, state.admins);
  if (!g.ok) return g.challenge;
  await consumeSig(g._sig);
  state.config.status = "open";
  return { success: true, config: publicConfig() };
}

/**
 * closeGame — admin
 * @param {Object} inputs
 */
async function closeGame(inputs) {
  const g = gate(`plinko:close:${inputs.wallet || inputs.from}`, inputs, state.admins);
  if (!g.ok) return g.challenge;
  await consumeSig(g._sig);
  state.config.status = "closed";
  return { success: true, config: publicConfig() };
}

/**
 * drop — multiplayer bet + VRF settle (2-step commerce.charge)
 * @bounded
 * @param {Object} inputs
 * @param {string} inputs.from
 * @param {number} [inputs.betSol]
 * @param {string} [inputs.txSignature]
 */
async function drop(inputs) {
  const from = inputs.from;
  if (!from || from === "guest") throw new Error("wallet required");
  if (state.config.status !== "open") throw new Error("game not open");

  const bet = Number(inputs.betSol);
  if (!(bet >= state.config.minBetSol && bet <= state.config.maxBetSol)) {
    throw new Error(
      `bet must be ${state.config.minBetSol}..${state.config.maxBetSol} SOL`
    );
  }

  const maxMult = maxMultiplier();
  // Reserve only what pot can actually pay after this bet lands (no 1.25 SOL cold-start wall)
  const free = freePotSol();
  const maxPayable = round6(free + bet);
  const maxLiability = round6(Math.min(bet * maxMult, maxPayable));
  if (state.config.enforceReserve && maxLiability + 1e-12 < bet * 0.5) {
    throw new Error(`pot too thin to open a drop (free ${free} SOL)`);
  }

  const paySig = inputs.txSignature || null;
  if (paySig && state.processed.betTx[paySig]) {
    return { success: true, already: true, ...state.processed.betTx[paySig] };
  }

  const charge = await commerce.charge({
    buyer: from,
    amount: bet,
    priceCurrency: "SOL",
    acceptedCurrencies: ["SOL"],
    treasury: state.treasuryPublicKey,
    memo: `plinko:drop:${from.slice(0, 8)}`,
    signature: paySig || undefined,
  });

  if (charge.requiresPayment) {
    return {
      success: true,
      requiresPayment: true,
      transaction: charge.transaction,
      currency: charge.currency,
      amount: charge.amount,
      treasury: state.treasuryPublicKey,
      betSol: bet,
      maxWinSol: maxLiability,
      mults: state.config.mults,
    };
  }
  if (!charge.confirmed) return { success: false, message: "charge not confirmed" };

  const confirmedSig = charge.txSignature || paySig;
  if (confirmedSig && state.processed.betTx[confirmedSig]) {
    return { success: true, already: true, ...state.processed.betTx[confirmedSig] };
  }
  if (confirmedSig && typeof signatures !== "undefined" && signatures.markUsed) {
    await signatures.markUsed("plinko:drop:" + confirmedSig);
  }

  // credit pot
  state.pot.accruedSol = round6(state.pot.accruedSol + bet);
  state.stats.volumeSol = round6(state.stats.volumeSol + bet);

  const edge = round6((bet * (state.config.houseEdgeBps || 0)) / 10000);
  state.pot.houseTakenSol = round6(state.pot.houseTakenSol + edge);

  // reserve worst-case until settled
  state.pot.reservedSol = round6(state.pot.reservedSol + maxLiability);

  const dropId = state.game.nextDropId++;
  state.game.openBets[String(dropId)] = {
    from,
    bet,
    reserved: maxLiability,
    at: Date.now(),
  };

  // VRF → bin
  const roll = await vrfApi.selectNumber(1, VRF_PRECISION);
  const slot = pickBin(roll.result);
  const mult = Number(state.config.mults[slot]) || 0;
  let idealPayout = round6(bet * mult);
  let payout = idealPayout;
  let outcome = "win";
  let paySignature = null;
  let potCapped = false;

  // release reserve first
  state.pot.reservedSol = round6(
    Math.max(0, state.pot.reservedSol - maxLiability)
  );
  delete state.game.openBets[String(dropId)];

  // Pay what the pot can actually cover — no "need 1.25 SOL" gate
  const cash = cashPotSol();
  if (payout > cash + 1e-9) {
    payout = cash;
    potCapped = true;
  }
  if (payout > 0) {
    if (payout + 1e-9 >= bet) state.stats.wins += 1;
    else state.stats.losses += 1;
    paySignature = await payFromTreasury(from, payout);
    state.pot.paidWinsSol = round6(state.pot.paidWinsSol + payout);
  } else {
    state.stats.losses += 1;
  }
  if (potCapped) state.stats.refunds += 1; // reuse counter as "capped pays"

  state.pot.drops += 1;
  trackPlayer(from, bet, payout);

  const finalOutcome = potCapped ? "capped" : outcome;
  const result = {
    success: true,
    dropId,
    from,
    betSol: bet,
    slot,
    mult,
    payoutSol: payout,
    profitSol: round6(payout - bet),
    outcome: finalOutcome,
    potCapped,
    idealPayoutSol: idealPayout,
    edgeSol: edge,
    paySignature,
    vrfProof: roll.proof,
    rng: roll.result,
    txSignature: confirmedSig,
    pot: publicPot(),
    pathSeed: roll.result, // FE uses for animation
  };
  pushRecent({
    dropId,
    from,
    betSol: bet,
    slot,
    mult,
    payoutSol: payout,
    outcome: finalOutcome,
    at: Date.now(),
  });

  if (confirmedSig) {
    state.processed.betTx[confirmedSig] = {
      dropId,
      slot,
      mult,
      payoutSol: payout,
      outcome: finalOutcome,
      from,
      betSol: bet,
    };
  }

  try {
    if (typeof rt !== "undefined" && rt.broadcast) {
      rt.broadcast("drops", {
        dropId,
        from,
        betSol: bet,
        slot,
        mult,
        payoutSol: payout,
        outcome: finalOutcome,
      });
      rt.broadcast("pot", publicPot());
    }
  } catch (e) {
    /* optional */
  }

  return result;
}

/**
 * getLobby — pot + config + recent (multiplayer surface)
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
      pApprox: BIN_WEIGHTS[slot] / 256,
    })),
  };
}

/**
 * getPot
 */
function getPot() {
  return publicPot();
}

/**
 * getConfig
 */
function getConfig() {
  return publicConfig();
}

/**
 * getRecent
 */
function getRecent() {
  return { recent: state.game.recent.slice(-40).reverse() };
}

/**
 * getPlayer
 * @param {Object} inputs
 */
function getPlayer(inputs) {
  const w = inputs.wallet || inputs.from;
  return { wallet: w, stats: state.players[w] || { drops: 0, wagered: 0, won: 0 } };
}

/**
 * withdrawHouse — admin free pot only (not reserved)
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
  // account as paid (reduces cash)
  state.pot.paidWinsSol = round6(state.pot.paidWinsSol + amount);
  return { success: true, amount, destination: dest, paySignature, pot: publicPot() };
}

// ─── internals ───────────────────────────────────────────────────────────

/**
 * @internal
 */
function pickBin(rng) {
  // rng in 1..VRF_PRECISION
  const total = BIN_WEIGHTS.reduce((a, b) => a + b, 0);
  let x = ((rng - 1) / VRF_PRECISION) * total;
  for (let i = 0; i < BIN_WEIGHTS.length; i++) {
    x -= BIN_WEIGHTS[i];
    if (x < 0) return i;
  }
  return BIN_WEIGHTS.length - 1;
}

/**
 * @internal
 */
function maxMultiplier() {
  return state.config.mults.reduce((a, b) => (Number(b) > a ? Number(b) : a), 0);
}

/**
 * @internal cash on hand
 */
function cashPotSol() {
  const raw =
    state.pot.accruedSol -
    state.pot.paidWinsSol -
    state.pot.refundedSol;
  return Math.max(0, round6(raw));
}

/**
 * @internal free after reserve
 */
function freePotSol() {
  return Math.max(0, round6(cashPotSol() - state.pot.reservedSol));
}

/**
 * @internal
 */
async function payFromTreasury(destination, amount) {
  if (!(amount > 0)) return null;
  const kp = blackbox.getKey(0);
  const u = umi.setKeypairIdentity(umi.createUmi(), kp.secretKey || kp.privateKey);
  const builder = umi.transactionBuilder().add(
    umi.transferSol(u, {
      source: u.identity,
      destination: umi.publicKey(destination),
      amount: umi.sol(amount),
    })
  );
  const res = await umi.safeSend(u, builder, u.identity, {
    commitment: "processed",
    skipPreflight: false,
    maxAttempts: 2,
  });
  return res.signature;
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
  const free = freePotSol();
  return {
    accruedSol: state.pot.accruedSol,
    reservedSol: state.pot.reservedSol,
    paidWinsSol: state.pot.paidWinsSol,
    refundedSol: state.pot.refundedSol,
    houseTakenSol: state.pot.houseTakenSol,
    cashSol: cash,
    freeSol: free,
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
    enforceReserve: state.config.enforceReserve,
    treasury: state.treasuryPublicKey,
    bins: 9,
  };
}

/**
 * @internal
 */
function round6(n) {
  return Math.floor(Number(n) * 1e6 + 1e-9) / 1e6;
}
