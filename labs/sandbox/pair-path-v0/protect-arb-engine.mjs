/**
 * Protect + Arb V1 — pure event engine (no I/O).
 * Contrato: MACHINE-PROTECT-ARB-V1.md
 *
 * Modes:
 *   v0-naked | prot-sell | prot-hedge | prot-min | prot-min-ready | arb-atomic
 * Pair-Gate arm vive em pair-gate-engine.mjs (lab importa separado).
 */

export const DEFAULT_PARAMS = {
  openShares: 5,
  openAskLo: 0.52,
  openAskHi: 0.62,
  openTrigger: 0.55,
  openCap: 0.02,
  maxOpenAttempts: 3,
  tauOpenMin: 40,
  tauOpenMax: 240,
  hedgeAskMax: 0.42,
  avgSumMax: 0.96,
  tauHedgeMin: 15,
  maxHedgeAttempts: 8,
  maxEventNotional: 8,
  feeRate: 0.07,
  openBookSumMin: 0.95,
  openBookSumMax: 1.05,
  openRequireHedgeReady: false,
  openHedgeSlackCents: 8,
  openPairSumMaxAtOpen: null,
  /** off | sell | hedge | min */
  protectMode: 'off',
  /** Force flatten when tau <= this (protect modes). */
  tauForceProtect: 20,
  /** Flatten only after this many seconds without cheap hedge. */
  protectTimeoutSec: 45,
  /** Adverse: favorite bid dropped at least this many cents from open. */
  protectAdverseCents: 4,
  /** Adverse: opposite ask rose above hedgeAskMax since open (true | cents margin). */
  protectOppBeyondHedge: true,
  /** Escape hedge may go up to this avgSum when protecting. */
  protectAvgSumMax: 1.0,
  /** arb-atomic: eps in dollars (1 − eps ceiling after fees). */
  atomicEps: 0.02,
  /** When bid missing, use ask − bidProxyCents/100. */
  bidProxyCents: 1,
};

export function mergeParams(raw = {}) {
  return { ...DEFAULT_PARAMS, ...raw };
}

function clamp01(x) {
  return Math.min(0.99, Math.max(0.01, Number(x)));
}

export function feeFor(price, shares, rate = DEFAULT_PARAMS.feeRate) {
  const p = clamp01(price);
  return rate * p * (1 - p) * shares;
}

function opposite(side) {
  return side === 'UP' ? 'DOWN' : 'UP';
}

/**
 * Estimate economic cost of flattening residual (lower = better).
 * sellCost ≈ openAvg − bid − fee  (PnL impact if we sell; positive = loss)
 * hedgeCost ≈ openAvg + askOpp − 1 − fee (locked loss if we complete set)
 */
export function evaluateProtectTriggers({
  elapsedSinceOpenSec = 0,
  protectTimeoutSec = DEFAULT_PARAMS.protectTimeoutSec,
  bidOpen,
  openAvg,
  protectAdverseCents = DEFAULT_PARAMS.protectAdverseCents,
  askOpp,
  openOppAsk = null,
  hedgeAskMax = DEFAULT_PARAMS.hedgeAskMax,
  protectOppBeyondHedge = DEFAULT_PARAMS.protectOppBeyondHedge,
  tau,
  tauForceProtect = DEFAULT_PARAMS.tauForceProtect,
}) {
  const force =
    tau != null && tau <= Number(tauForceProtect) + 1e-12;
  if (force) {
    return {
      armed: true,
      force: true,
      reason: 'force_tau',
      timedOut: false,
      adverse: false,
      favDrop: false,
      oppBeyond: false,
    };
  }

  const timedOut =
    Number(elapsedSinceOpenSec) >= Number(protectTimeoutSec) - 1e-12;

  const favDrop =
    Number.isFinite(Number(bidOpen)) &&
    Number.isFinite(Number(openAvg)) &&
    Number(bidOpen) <=
      Number(openAvg) - Number(protectAdverseCents) / 100 + 1e-12;

  let oppBeyond = false;
  if (protectOppBeyondHedge) {
    const margin =
      typeof protectOppBeyondHedge === 'number'
        ? Number(protectOppBeyondHedge) / 100
        : 0;
    const threshold = Number(hedgeAskMax) + margin;
    const rose =
      openOppAsk != null &&
      Number.isFinite(Number(askOpp)) &&
      Number(askOpp) > Number(openOppAsk) + 1e-12;
    oppBeyond =
      Number.isFinite(Number(askOpp)) &&
      Number(askOpp) > threshold + 1e-12 &&
      (openOppAsk == null || rose);
  }

  const adverse = favDrop || oppBeyond;
  const armed = timedOut || adverse;

  return {
    armed,
    force: false,
    reason: timedOut
      ? 'timeout'
      : favDrop
        ? 'adverse_fav'
        : oppBeyond
          ? 'adverse_opp'
          : null,
    timedOut,
    adverse,
    favDrop,
    oppBeyond,
  };
}

export function protectCosts({
  openAvg,
  bidOpen,
  askOpp,
  shares,
  feeRate = DEFAULT_PARAMS.feeRate,
}) {
  const sh = Number(shares);
  const feeSell = feeFor(bidOpen, sh, feeRate);
  const feeBuy = feeFor(askOpp, sh, feeRate);
  const sellCostPerShare = openAvg - bidOpen + feeSell / sh;
  const hedgeCostPerShare = openAvg + askOpp - 1 + feeBuy / sh;
  return {
    sellCostPerShare,
    hedgeCostPerShare,
    sellCost: sellCostPerShare * sh,
    hedgeCost: hedgeCostPerShare * sh,
    feeSell,
    feeBuy,
    prefer: sellCostPerShare <= hedgeCostPerShare + 1e-12 ? 'sell' : 'hedge',
  };
}

export function createProtectArbEngine(paramsRaw = {}, meta = {}) {
  const p = mergeParams(paramsRaw);
  const state = {
    meta,
    mode: 'idle', // idle | opened | done | blocked
    sideOpen: null,
    inv: {
      UP: { shares: 0, cost: 0, fees: 0 },
      DOWN: { shares: 0, cost: 0, fees: 0 },
    },
    cash: 0, // proceeds from sells (gross px*sh, fees tracked separately)
    realizedPnl: 0, // sell proceeds − cost basis released
    openAttempts: 0,
    hedgeAttempts: 0,
    protectAttempts: 0,
    fills: [],
    blocks: [],
    events: [],
    bidProxyUsed: false,
    nProtectSell: 0,
    nProtectHedge: 0,
    openAvgAtEntry: null,
    openOppAskAtEntry: null,
    openedAtTau: null,
    skipProtectThisTick: false,
  };

  function invested() {
    return state.inv.UP.cost + state.inv.DOWN.cost;
  }

  function avg(side) {
    const x = state.inv[side];
    return x.shares > 1e-9 ? x.cost / x.shares : null;
  }

  function avgSum() {
    const a = avg('UP');
    const b = avg('DOWN');
    if (a == null || b == null) return null;
    return a + b;
  }

  function residualShares() {
    return Math.abs(state.inv.UP.shares - state.inv.DOWN.shares);
  }

  function residualSideNeed() {
    const d = state.inv.UP.shares - state.inv.DOWN.shares;
    if (Math.abs(d) < 1e-9) return null;
    return d > 0 ? 'DOWN' : 'UP';
  }

  function openSideLong() {
    if (state.inv.UP.shares > state.inv.DOWN.shares + 1e-9) return 'UP';
    if (state.inv.DOWN.shares > state.inv.UP.shares + 1e-9) return 'DOWN';
    return state.sideOpen;
  }

  function block(reason, extra = {}) {
    state.blocks.push({ reason, ...extra });
  }

  function recordBuy(side, px, sh, kind) {
    const fee = feeFor(px, sh, p.feeRate);
    state.inv[side].shares += sh;
    state.inv[side].cost += px * sh;
    state.inv[side].fees += fee;
    state.fills.push({ kind, side, px, sh, fee, action: 'buy' });
    state.events.push({ kind, side, px, sh, action: 'buy' });
  }

  function recordSell(side, px, sh, kind) {
    const fee = feeFor(px, sh, p.feeRate);
    const held = state.inv[side].shares;
    const take = Math.min(sh, held);
    if (take <= 1e-9) return 0;
    const avgPx = avg(side) ?? px;
    const costReleased = avgPx * take;
    const feeShare =
      held > 1e-9 ? (state.inv[side].fees * take) / held : 0;
    state.inv[side].shares -= take;
    state.inv[side].cost = Math.max(0, state.inv[side].cost - costReleased);
    state.inv[side].fees = Math.max(0, state.inv[side].fees - feeShare);
    const proceeds = px * take;
    state.cash += proceeds;
    // sell fee + released open fee hit realized
    const realized = proceeds - costReleased - fee - feeShare;
    state.realizedPnl += realized;
    state.fills.push({
      kind,
      side,
      px,
      sh: take,
      fee,
      action: 'sell',
      realized,
    });
    state.events.push({ kind, side, px, sh: take, action: 'sell' });
    return take;
  }

  function resolveBid(side, upAsk, downAsk, upBid, downBid) {
    const raw = side === 'UP' ? upBid : downBid;
    if (raw != null && Number.isFinite(raw) && raw > 0) return Number(raw);
    const ask = side === 'UP' ? upAsk : downAsk;
    if (ask == null || !Number.isFinite(ask)) return null;
    state.bidProxyUsed = true;
    return Math.max(0.01, Number(ask) - p.bidProxyCents / 100);
  }

  function pickChase(upAsk, downAsk) {
    if (upAsk == null || downAsk == null) return null;
    return upAsk >= downAsk ? 'UP' : 'DOWN';
  }

  function tryOpen(upAsk, downAsk, tau) {
    if (state.mode !== 'idle') return;
    if (tau == null || tau < p.tauOpenMin || tau > p.tauOpenMax) return;
    if (state.openAttempts >= p.maxOpenAttempts) return;

    // arb-atomic: both legs same tick
    if (p.protectMode === 'atomic' || meta.variant === 'arb-atomic') {
      tryAtomic(upAsk, downAsk, tau);
      return;
    }

    const side = pickChase(upAsk, downAsk);
    if (!side) return;
    const ask = side === 'UP' ? upAsk : downAsk;
    const other = side === 'UP' ? downAsk : upAsk;
    if (ask == null || other == null) return;

    const sum = ask + other;
    if (sum < p.openBookSumMin || sum > p.openBookSumMax) {
      block('BOOK_SUM', { sum, tau });
      return;
    }
    if (ask < p.openAskLo || ask > p.openAskHi) return;
    if (ask + 1e-12 < p.openTrigger) return;

    if (p.openRequireHedgeReady) {
      const oppMax = p.hedgeAskMax + (p.openHedgeSlackCents || 0) / 100;
      if (other > oppMax + 1e-12) {
        block('OPEN_HEDGE_NOT_READY', { ask, other, oppMax, tau });
        return;
      }
      const pairMax =
        p.openPairSumMaxAtOpen != null ? p.openPairSumMaxAtOpen : p.avgSumMax;
      if (sum > pairMax + 1e-12) {
        block('OPEN_PAIR_NOT_CHEAP', { sum, pairMax, tau });
        return;
      }
    }

    const limitPx = Math.min(ask, p.openTrigger + p.openCap);
    state.openAttempts += 1;
    if (ask > p.openTrigger + p.openCap + 1e-12) {
      block('OPEN_MISS_CAP', { ask, tau });
      return;
    }
    const sh = p.openShares;
    if (invested() + sh * limitPx > p.maxEventNotional + 1e-9) {
      block('TETO', { tau });
      return;
    }
    recordBuy(side, limitPx, sh, 'open');
    state.sideOpen = side;
    state.openAvgAtEntry = limitPx;
    state.openOppAskAtEntry = other;
    state.openedAtTau = tau;
    state.mode = 'opened';
    state.skipProtectThisTick = true; // give cheap hedge a tick before protect
  }

  function tryAtomic(upAsk, downAsk, tau) {
    if (tau == null || tau < p.tauOpenMin || tau > p.tauOpenMax) return;
    if (upAsk == null || downAsk == null) return;
    const feeU = feeFor(upAsk, 1, p.feeRate);
    const feeD = feeFor(downAsk, 1, p.feeRate);
    const proj = upAsk + downAsk + feeU + feeD;
    if (proj > 1 - p.atomicEps + 1e-12) {
      block('ATOMIC_NOT_CHEAP', { proj, upAsk, downAsk, tau });
      return;
    }
    const sh = p.openShares;
    const notional = sh * (upAsk + downAsk);
    if (notional > p.maxEventNotional + 1e-9) {
      block('TETO', { tau });
      return;
    }
    state.openAttempts += 1;
    recordBuy('UP', upAsk, sh, 'atomic_up');
    recordBuy('DOWN', downAsk, sh, 'atomic_down');
    state.sideOpen = upAsk >= downAsk ? 'UP' : 'DOWN';
    state.mode = 'done';
  }

  function tryCheapHedge(upAsk, downAsk, tau) {
    if (state.mode !== 'opened') return false;
    if (tau == null || tau < p.tauHedgeMin) return false;
    if (state.hedgeAttempts >= p.maxHedgeAttempts) return false;

    const need = residualSideNeed();
    if (!need) {
      state.mode = 'done';
      return true;
    }
    const ask = need === 'UP' ? upAsk : downAsk;
    if (ask == null) return false;
    if (ask > p.hedgeAskMax + 1e-12) return false;

    const rem = residualShares();
    const openA = avg(opposite(need));
    if (openA == null) return false;
    const proj = openA + ask;
    if (proj > p.avgSumMax + 1e-12) {
      block('HEDGE_REFUSE_AVGSUM', { proj, ask, tau });
      return false;
    }
    if (invested() + rem * ask > p.maxEventNotional + 1e-9) {
      block('TETO_HEDGE', { tau });
      return false;
    }
    state.hedgeAttempts += 1;
    recordBuy(need, ask, rem, 'hedge');
    if (residualShares() < 1e-6) state.mode = 'done';
    return true;
  }

  function tryProtect(upAsk, downAsk, upBid, downBid, tau) {
    const mode = p.protectMode;
    if (mode === 'off' || mode === 'atomic') return;
    if (state.mode !== 'opened') return;
    if (state.skipProtectThisTick) return;
    const rem = residualShares();
    if (rem < 1e-6) {
      state.mode = 'done';
      return;
    }

    const force = tau != null && tau <= p.tauForceProtect + 1e-12;
    const longSide = openSideLong();
    if (!longSide) return;
    const need = residualSideNeed();
    const openA = avg(longSide) ?? state.openAvgAtEntry;
    if (openA == null || need == null) return;

    const bidOpen = resolveBid(longSide, upAsk, downAsk, upBid, downBid);
    const askOpp = need === 'UP' ? upAsk : downAsk;
    if (bidOpen == null || askOpp == null) return;

    // Cheap hedge still available — do not steal the path (unless force).
    const cheapHedgeReady =
      askOpp <= p.hedgeAskMax + 1e-12 && openA + askOpp <= p.avgSumMax + 1e-12;
    if (!force && cheapHedgeReady) return;

    const elapsedSinceOpenSec =
      state.openedAtTau != null && tau != null
        ? Math.max(0, state.openedAtTau - tau)
        : 0;
    const triggers = evaluateProtectTriggers({
      elapsedSinceOpenSec,
      protectTimeoutSec: p.protectTimeoutSec,
      bidOpen,
      openAvg: openA,
      protectAdverseCents: p.protectAdverseCents,
      askOpp,
      openOppAsk: state.openOppAskAtEntry,
      hedgeAskMax: p.hedgeAskMax,
      protectOppBeyondHedge: p.protectOppBeyondHedge,
      tau,
      tauForceProtect: p.tauForceProtect,
    });
    if (!triggers.armed) return;

    const costs = protectCosts({
      openAvg: openA,
      bidOpen,
      askOpp,
      shares: rem,
      feeRate: p.feeRate,
    });

    let action = null;
    if (mode === 'sell') action = 'sell';
    else if (mode === 'hedge') action = 'hedge';
    else if (mode === 'min') action = costs.prefer;

    if (!force && (mode === 'hedge' || (mode === 'min' && action === 'hedge'))) {
      const proj = openA + askOpp;
      if (proj > p.protectAvgSumMax + 1e-12) {
        block('PROTECT_HEDGE_AVGSUM', { proj, tau });
        // if min preferred hedge but too expensive, fall back to sell
        if (mode === 'min') action = 'sell';
        else return;
      }
    }

    if (!action) return;
    state.protectAttempts += 1;

    if (action === 'sell') {
      const sold = recordSell(longSide, bidOpen, rem, 'protect_sell');
      if (sold > 0) state.nProtectSell += 1;
      if (residualShares() < 1e-6) state.mode = 'done';
      return;
    }

    // hedge protect
    if (!force) {
      const proj = openA + askOpp;
      if (proj > p.protectAvgSumMax + 1e-12) {
        block('PROTECT_HEDGE_AVGSUM', { proj, tau });
        return;
      }
    }
    if (invested() + rem * askOpp > p.maxEventNotional * 1.5 + 1e-9 && !force) {
      block('TETO_PROTECT', { tau });
      return;
    }
    recordBuy(need, askOpp, rem, 'protect_hedge');
    state.nProtectHedge += 1;
    if (residualShares() < 1e-6) state.mode = 'done';
  }

  function onTick(tick) {
    const {
      upAsk,
      downAsk,
      upBid = null,
      downBid = null,
      tau,
    } = tick;

    if (state.mode === 'idle') {
      tryOpen(upAsk, downAsk, tau);
    }
    if (state.mode === 'opened') {
      const hedged = tryCheapHedge(upAsk, downAsk, tau);
      if (!hedged) tryProtect(upAsk, downAsk, upBid, downBid, tau);
      state.skipProtectThisTick = false;
    }
  }

  function finish(winner = null) {
    const feeTotal = state.inv.UP.fees + state.inv.DOWN.fees;
    const paired = Math.min(state.inv.UP.shares, state.inv.DOWN.shares);
    const res = residualShares();

    let settlement = 0;
    if (res < 1e-6 && paired > 1e-9) {
      settlement = paired - invested() - feeTotal;
    } else if (winner === 'UP' || winner === 'DOWN') {
      settlement = state.inv[winner].shares - invested() - feeTotal;
    } else {
      settlement = Math.min(state.inv.UP.shares, state.inv.DOWN.shares) - invested() - feeTotal;
    }
    const pnl = state.realizedPnl + settlement;

    const worstSettlement =
      Math.min(state.inv.UP.shares, state.inv.DOWN.shares) - invested() - feeTotal;
    const worst = state.realizedPnl + worstSettlement;

    const blockCounts = {};
    for (const b of state.blocks) {
      blockCounts[b.reason] = (blockCounts[b.reason] || 0) + 1;
    }

    const flattenedBySell = state.fills.some((f) => f.kind === 'protect_sell');
    const equalized =
      (res < 1e-6 && paired > 1e-9) ||
      (flattenedBySell && res < 1e-6) ||
      (res < 1e-6 && state.fills.some((f) => f.kind === 'protect_hedge'));

    return {
      mode: state.mode,
      sideOpen: state.sideOpen,
      inv: state.inv,
      cash: state.cash,
      realizedPnl: state.realizedPnl,
      invested: invested(),
      fees: feeTotal + state.fills.filter((f) => f.action === 'sell').reduce((s, f) => s + f.fee, 0),
      avgSum: avgSum(),
      residual: res,
      paired,
      pnl,
      worst,
      fills: state.fills,
      nProtectSell: state.nProtectSell,
      nProtectHedge: state.nProtectHedge,
      openAttempts: state.openAttempts,
      hedgeAttempts: state.hedgeAttempts,
      protectAttempts: state.protectAttempts,
      bidProxyUsed: state.bidProxyUsed,
      blockCounts,
      winner,
      equalized,
      flattened:
        equalized ||
        state.fills.some((f) => f.kind === 'protect_sell' || f.kind === 'protect_hedge'),
    };
  }

  return { onTick, finish, state, params: p };
}

/** Variant presets for the lab matrix. */
export const VARIANT_PRESETS = {
  'v0-naked': {
    protectMode: 'off',
    openRequireHedgeReady: false,
  },
  'prot-sell': {
    protectMode: 'sell',
    openRequireHedgeReady: false,
  },
  'prot-hedge': {
    protectMode: 'hedge',
    openRequireHedgeReady: false,
    protectAvgSumMax: 1.0,
  },
  'prot-min': {
    protectMode: 'min',
    openRequireHedgeReady: false,
    protectAvgSumMax: 1.0,
    tauForceProtect: 20,
    protectTimeoutSec: 45,
    protectAdverseCents: 4,
    protectOppBeyondHedge: true,
  },
  'prot-min-ready': {
    protectMode: 'min',
    openRequireHedgeReady: true,
    openHedgeSlackCents: 8,
    openPairSumMaxAtOpen: 0.98,
    protectAvgSumMax: 1.0,
    tauForceProtect: 20,
    protectTimeoutSec: 45,
    protectAdverseCents: 4,
    protectOppBeyondHedge: true,
  },
  'arb-atomic': {
    protectMode: 'atomic',
    atomicEps: 0.02,
    maxEventNotional: 8,
  },
};
