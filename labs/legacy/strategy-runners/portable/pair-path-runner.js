/**
 * Pair-Path V0 / Clip-Path V1 — library runner for Backtest Studio.
 *
 * Pure event engine inlined from labs/sandbox/pair-path-v0/engine.mjs
 * (open + hedge / multi-clip hedgeLevels + optional EQ; no MULT/rearm).
 * Test surface: __pairPathExports
 */

const DEFAULT_PARAMS = {
  walletSize: 100,
  applyPolymarketFees: true,
  polymarketFeeCategory: 'crypto',
  requireQuality: true,
  minCoverage: 0.99,
  openShares: 10,
  openAskLo: 0.52,
  openAskHi: 0.62,
  openCapCents: 1,
  openTriggerCents: 55,
  maxOpenAttempts: 3,
  tauOpenMin: 40,
  tauOpenMax: 240,
  hedgeAskMax: 0.48,
  hedgeCapCents: 1,
  avgSumMax: 0.995,
  tauHedgeMin: 15,
  maxHedgeAttempts: 2,
  makerTimeoutSec: 30,
  /**
   * Studio default is honest: no full-maker-fill proxy.
   * `cross` preserves the legacy sandbox proxy when journals have TOB only.
   */
  restingFillModel: 'none',
  /** Require N consecutive qualifying ticks before a taker fill. */
  confirmationTicks: 2,
  /** Live posts one clip at a time; legacy sandbox was Infinity. */
  maxClipsPerTick: 1,
  eqAskMax: 0.05,
  eqAvgSumMax: 0.99,
  tauEqMin: 8,
  maxEventNotional: 25,
  feeRate: 0.07,
  legChoice: 'chase', // chase | fade
  /** Book sum window at open (default preserves legacy 0.95–1.05). */
  openBookSumMin: 0.95,
  openBookSumMax: 1.05,
  /**
   * If true, only open when opposite ask is already hedgeable:
   * askO <= hedgeAskMax + openHedgeSlackCents/100 AND ask+askO <= openPairSumMaxAtOpen (or avgSumMax).
   * Cuts residual risk (open without a ready hedge).
   */
  openRequireHedgeReady: false,
  /** Extra cents allowed on opposite ask at open vs hedgeAskMax (soft hedge-ready). */
  openHedgeSlackCents: 0,
  /** If set, open requires ask+askO <= this (defaults to avgSumMax when hedge-ready). */
  openPairSumMaxAtOpen: null,
  /**
   * Clip-Path multi-level hedge. null/[] = V0 single full hedge @ hedgeAskMax.
   * Example Clip-2: [{ askMax: 0.42, frac: 0.5 }, { askMax: 0.38, frac: 0.5 }]
   * On each tick, fills every unfinished clip whose askMax >= current ask (shallow→deep).
   */
  hedgeLevels: null,
  /**
   * Late escape: if still residual and tau <= tauHedgeEscape, fill remaining
   * at ask <= hedgeEscapeAskMax (default = hedgeAskMax) subject to avgSumMax.
   * null tau = disabled.
   */
  tauHedgeEscape: null,
  hedgeEscapeAskMax: null,
  /** Escape may use looser avgSum than clips (default = avgSumMax). Cap at 1.0 in labs. */
  escapeAvgSumMax: null,
  /** Net locked-PnL floor per balanced share for escape 1. */
  escapeMinLockedPnlPerShare: null,
  /**
   * Optional harder/later escape: if still residual and tau <= tauHedgeEscape2,
   * fill at ask <= hedgeEscapeAskMax2 with escapeAvgSumMax2 (e.g. 1.00).
   */
  tauHedgeEscape2: null,
  hedgeEscapeAskMax2: null,
  escapeAvgSumMax2: null,
  /** Net locked-PnL floor per balanced share for escape 2. */
  escapeMinLockedPnlPerShare2: null,
};

function mergeParams(raw = {}) {
  const params = { ...DEFAULT_PARAMS, ...raw };
  params.walletSize = Math.max(1, Number(raw.walletSize ?? DEFAULT_PARAMS.walletSize) || DEFAULT_PARAMS.walletSize);
  params.restingFillModel = String(params.restingFillModel || 'none').toLowerCase() === 'cross'
    ? 'cross'
    : 'none';
  const clips = Number(params.maxClipsPerTick);
  params.maxClipsPerTick = Number.isFinite(clips) && clips > 0 ? clips : 1;
  const conf = Number(params.confirmationTicks);
  params.confirmationTicks = Number.isFinite(conf) && conf >= 1 ? Math.floor(conf) : 2;
  if (params.hedgeLevels != null && !Array.isArray(params.hedgeLevels)) {
    params.hedgeLevels = null;
  }
  return params;
}

function clamp01(x) {
  return Math.min(0.99, Math.max(0.01, Number(x)));
}

function feeFor(price, shares, rate) {
  const p = clamp01(price);
  return rate * p * (1 - p) * shares;
}

function createEventEngine(paramsRaw = {}, meta = {}) {
  const p = mergeParams(paramsRaw);
  const state = {
    meta,
    mode: 'idle', // idle | opened | hedged | done | blocked
    sideOpen: null,
    inv: {
      UP: { shares: 0, cost: 0, fees: 0 },
      DOWN: { shares: 0, cost: 0, fees: 0 },
    },
    openAttempts: 0,
    hedgeAttempts: 0,
    eqAttempts: 0,
    resting: null, // { side, limit, placedTs, placedTau }
    /** @type {null | Array<{ askMax: number, targetSh: number, filled: number }>} */
    hedgePlan: null,
    fills: [],
    blocks: [],
    events: [], // decision log
    lastAsks: { UP: null, DOWN: null },
    qualifierCounts: {},
    qualifierSeen: new Set(),
  };

  function invested() {
    return state.inv.UP.cost + state.inv.DOWN.cost;
  }

  function avg(side) {
    const x = state.inv[side];
    return x.shares > 0 ? x.cost / x.shares : null;
  }

  function avgSum() {
    const a = avg('UP');
    const b = avg('DOWN');
    if (a == null || b == null) return null;
    return a + b;
  }

  function residual() {
    const d = state.inv.UP.shares - state.inv.DOWN.shares;
    if (Math.abs(d) < 1e-9) return { side: null, shares: 0 };
    return d > 0
      ? { side: 'DOWN', shares: d } // need more DOWN
      : { side: 'UP', shares: -d };
  }

  function worstPnl() {
    // if UP wins: shUP - totalCost; if DOWN wins: shDOWN - totalCost
    const cost = invested() + state.inv.UP.fees + state.inv.DOWN.fees;
    const up = state.inv.UP.shares - cost;
    const dn = state.inv.DOWN.shares - cost;
    return Math.min(up, dn);
  }

  function projectedAvgSum(side, px, sh) {
    if (sh <= 0) return avgSum();
    const cur = state.inv[side];
    const newSh = cur.shares + sh;
    const newAvg = (cur.cost + sh * px) / newSh;
    const other = side === 'UP' ? 'DOWN' : 'UP';
    const o = avg(other);
    if (o == null) return null;
    return newAvg + o;
  }

  function projectedWorst(side, px, sh) {
    const costAdd = sh * px + feeFor(px, sh, p.feeRate);
    const cost = invested() + state.inv.UP.fees + state.inv.DOWN.fees + costAdd;
    const shU = state.inv.UP.shares + (side === 'UP' ? sh : 0);
    const shD = state.inv.DOWN.shares + (side === 'DOWN' ? sh : 0);
    return Math.min(shU - cost, shD - cost);
  }

  function lockedPnlPerShare() {
    const balanced = Math.min(state.inv.UP.shares, state.inv.DOWN.shares);
    return balanced > 1e-9 ? worstPnl() / balanced : null;
  }

  function projectedLockedPnlPerShare(side, px, sh) {
    const shU = state.inv.UP.shares + (side === 'UP' ? sh : 0);
    const shD = state.inv.DOWN.shares + (side === 'DOWN' ? sh : 0);
    const balanced = Math.min(shU, shD);
    return balanced > 1e-9 ? projectedWorst(side, px, sh) / balanced : null;
  }

  function qualify(key) {
    state.qualifierSeen.add(key);
    const next = (state.qualifierCounts[key] || 0) + 1;
    state.qualifierCounts[key] = next;
    const required = Math.max(1, Number(p.confirmationTicks) || 1);
    return next >= required;
  }

  function finishQualifierTick() {
    for (const key of Object.keys(state.qualifierCounts)) {
      if (!state.qualifierSeen.has(key)) delete state.qualifierCounts[key];
    }
    state.qualifierSeen.clear();
  }

  function block(reason, extra = {}) {
    state.blocks.push({ reason, ...extra, t: state.events.length });
  }

  function buy(side, px, sh, kind, liquidity = 'taker') {
    if (sh <= 0) return 0;
    const notional = sh * px;
    if (invested() + notional > p.maxEventNotional + 1e-9) {
      block('TETO', { side, sh, px, kind });
      return 0;
    }
    const fee = liquidity === 'maker' ? 0 : feeFor(px, sh, p.feeRate);
    state.inv[side].shares += sh;
    state.inv[side].cost += notional;
    state.inv[side].fees += fee;
    const fill = {
      side,
      px,
      sh,
      kind,
      liquidity,
      fee,
      notional,
    };
    state.fills.push(fill);
    state.events.push({ type: 'fill', ...fill });
    return sh;
  }

  function pickOpenSide(asks) {
    const up = asks.UP;
    const dn = asks.DOWN;
    if (up == null || dn == null) return null;
    if (p.legChoice === 'fade') {
      // underdog
      return up <= dn ? 'UP' : 'DOWN';
    }
    // chase favorite
    return up >= dn ? 'UP' : 'DOWN';
  }

  function tryOpen(asks, tau, ts) {
    if (state.mode !== 'idle') return;
    if (tau == null || tau < p.tauOpenMin || tau > p.tauOpenMax) return;
    if (state.openAttempts >= p.maxOpenAttempts) return;

    const side = pickOpenSide(asks);
    if (!side) return;
    const ask = asks[side];
    const other = side === 'UP' ? 'DOWN' : 'UP';
    const askO = asks[other];
    if (ask == null || askO == null) return;

    const sum = ask + askO;
    const sumMin = p.openBookSumMin != null ? p.openBookSumMin : 0.95;
    const sumMax = p.openBookSumMax != null ? p.openBookSumMax : 1.05;
    if (sum < sumMin - 1e-12 || sum > sumMax + 1e-12) {
      block('BOOK_SUM', { sum, tau, sumMin, sumMax });
      return;
    }
    if (ask < p.openAskLo || ask > p.openAskHi) return;

    if (p.openRequireHedgeReady) {
      const slack = (p.openHedgeSlackCents || 0) / 100;
      const oppMax = p.hedgeAskMax + slack;
      if (askO > oppMax + 1e-12) {
        block('OPEN_HEDGE_NOT_READY', { ask, askO, oppMax, tau });
        return;
      }
      const pairMax =
        p.openPairSumMaxAtOpen != null ? p.openPairSumMaxAtOpen : p.avgSumMax;
      if (sum > pairMax + 1e-12) {
        block('OPEN_PAIR_NOT_CHEAP', { sum, pairMax, tau });
        return;
      }
    }

    const trigger = p.openTriggerCents / 100;
    // only open if at/above trigger for chase
    if (p.legChoice === 'chase' && ask + 1e-12 < trigger) return;

    // taker_limit: effective fill if ask within cap of "fair entry"
    // use previous mid band center or trigger as limit ref
    const limitRef = Math.max(trigger, p.openAskLo);
    const cap = p.openCapCents / 100;
    const gap = ask - limitRef;

    if (gap > cap + 1e-12) {
      state.openAttempts += 1;
      block('OPEN_MISS_CAP', { side, ask, limitRef, gapC: gap * 100, tau });
      state.events.push({ type: 'open_miss', side, ask, gapC: Math.round(gap * 1000) / 10, tau, ts });
      return;
    }

    const fillPx = ask; // would pay ask if within cap of limitRef
    // stricter: only if ask <= limitRef + cap
    if (ask > limitRef + cap + 1e-12) {
      block('OPEN_MISS_CAP', { side, ask, limitRef, tau });
      return;
    }
    if (!qualify(`open:${side}`)) return;
    state.openAttempts += 1;

    const sh = p.openShares;
    const got = buy(side, fillPx, sh, 'open', 'taker');
    if (got <= 0) return;
    state.sideOpen = side;
    state.mode = 'opened';
    state.events.push({ type: 'open', side, px: fillPx, sh, tau, ts });
  }

  function buildHedgePlan(openSh) {
    const levels = Array.isArray(p.hedgeLevels) ? p.hedgeLevels : [];
    if (!levels.length) return null;
    const plan = [];
    let allocated = 0;
    for (let i = 0; i < levels.length; i++) {
      const isLast = i === levels.length - 1;
      let targetSh;
      if (isLast) {
        targetSh = Math.round((openSh - allocated) * 1000) / 1000;
      } else {
        targetSh = Math.round(openSh * Number(levels[i].frac) * 1000) / 1000;
        allocated += targetSh;
      }
      if (targetSh > 0) {
        plan.push({
          askMax: Number(levels[i].askMax),
          targetSh,
          filled: 0,
        });
      }
    }
    return plan;
  }

  function nextClipAskMax() {
    if (!state.hedgePlan) return p.hedgeAskMax;
    for (const clip of state.hedgePlan) {
      if (clip.filled + 1e-9 < clip.targetSh) return clip.askMax;
    }
    return p.hedgeAskMax;
  }

  function tryBuyHedgeClip(
    side,
    fillPx,
    sh,
    kind,
    tau,
    ts,
    avgSumCeil = null,
    minLockedPnlPerShare = null,
  ) {
    if (sh <= 1e-9) return 0;
    const ceil = avgSumCeil != null ? avgSumCeil : p.avgSumMax;
    const proj = projectedAvgSum(side, fillPx, sh);
    if (proj != null && proj > ceil + 1e-12) {
      block('HEDGE_REFUSE_AVGSUM', { proj, ask: fillPx, sh, tau, ceil, kind });
      state.events.push({ type: 'hedge_refuse', proj, ask: fillPx, sh, tau, ts, ceil, kind });
      return 0;
    }
    const w0 = worstPnl();
    const w1 = projectedWorst(side, fillPx, sh);
    if (w1 < w0 - 1e-9) {
      block('HEDGE_WORST', { w0, w1, tau });
      return 0;
    }
    const lockedPerShare = projectedLockedPnlPerShare(side, fillPx, sh);
    if (
      minLockedPnlPerShare != null &&
      lockedPerShare != null &&
      lockedPerShare < Number(minLockedPnlPerShare) - 1e-9
    ) {
      block('HEDGE_REFUSE_LOCKED_PNL', {
        lockedPerShare,
        floor: Number(minLockedPnlPerShare),
        ask: fillPx,
        sh,
        tau,
        kind,
      });
      return 0;
    }
    return buy(side, fillPx, sh, kind, 'taker');
  }

  function applyEscapeFill(
    side,
    ask,
    remaining,
    openSh,
    tau,
    ts,
    kind,
    avgSumCeil,
    minLockedPnlPerShare,
  ) {
    if (state.hedgeAttempts >= p.maxHedgeAttempts) return false;
    if (!qualify(`${kind}:${side}`)) return false;
    const got = tryBuyHedgeClip(
      side,
      ask,
      remaining,
      kind,
      tau,
      ts,
      avgSumCeil,
      minLockedPnlPerShare,
    );
    if (got <= 0) return false;
    state.hedgeAttempts += 1;
    state.resting = null;
    let left = got;
    for (const clip of state.hedgePlan) {
      const need = clip.targetSh - clip.filled;
      if (need <= 0 || left <= 0) continue;
      const take = Math.min(need, left);
      clip.filled += take;
      left -= take;
    }
    const rem = openSh - state.inv[side].shares;
    if (rem <= 1e-9) {
      state.mode = 'hedged';
      state.events.push({ type: 'hedged', via: kind, tau, ts, avgSum: avgSum() });
    }
    return true;
  }

  function tryClipEscapes(side, ask, remaining, openSh, tau, ts) {
    const escMax =
      p.hedgeEscapeAskMax != null ? p.hedgeEscapeAskMax : p.hedgeAskMax;
    const escCeil = p.escapeAvgSumMax != null ? p.escapeAvgSumMax : p.avgSumMax;
    const stages = [
      {
        enabled: p.tauHedgeEscape2 != null,
        tauMax: p.tauHedgeEscape2,
        askMax: p.hedgeEscapeAskMax2 != null ? p.hedgeEscapeAskMax2 : escMax,
        avgSumMax: p.escapeAvgSumMax2 != null ? p.escapeAvgSumMax2 : escCeil,
        minLockedPnlPerShare: p.escapeMinLockedPnlPerShare2,
        kind: 'hedge_escape2',
      },
      {
        enabled: p.tauHedgeEscape != null,
        tauMax: p.tauHedgeEscape,
        askMax: escMax,
        avgSumMax: escCeil,
        minLockedPnlPerShare: p.escapeMinLockedPnlPerShare,
        kind: 'hedge_escape',
      },
    ];
    for (const stage of stages) {
      if (
        !stage.enabled ||
        tau > Number(stage.tauMax) + 1e-12 ||
        ask > Number(stage.askMax) + 1e-12
      ) {
        continue;
      }
      if (
        applyEscapeFill(
          side,
          ask,
          remaining,
          openSh,
          tau,
          ts,
          stage.kind,
          Number(stage.avgSumMax),
          stage.minLockedPnlPerShare,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  function tryHedgeClips(asks, tau, ts) {
    const side = state.sideOpen === 'UP' ? 'DOWN' : 'UP';
    const ask = asks[side];
    if (ask == null) return;

    const openSh = state.inv[state.sideOpen].shares;
    if (!state.hedgePlan) {
      state.hedgePlan = buildHedgePlan(openSh);
      state.events.push({
        type: 'hedge_plan',
        plan: state.hedgePlan.map((c) => ({ askMax: c.askMax, targetSh: c.targetSh })),
        tau,
        ts,
      });
    }

    let remaining = openSh - state.inv[side].shares;
    if (remaining <= 1e-9) {
      state.mode = 'hedged';
      return;
    }

    const nextMax = nextClipAskMax();
    if (ask > nextMax + 1e-12) {
      if (
        p.restingFillModel !== 'none' &&
        !state.resting &&
        ask <= nextMax + 0.05
      ) {
        state.resting = {
          side,
          limit: Math.min(ask, nextMax),
          placedTs: ts,
          placedTau: tau,
        };
        state.events.push({ type: 'hedge_rest', side, limit: state.resting.limit, tau, ts });
      }
      tryClipEscapes(side, ask, remaining, openSh, tau, ts);
      return;
    }

    if (state.hedgeAttempts >= p.maxHedgeAttempts) return;

    let bought = 0;
    let clipsBought = 0;
    for (let clipIndex = 0; clipIndex < state.hedgePlan.length; clipIndex++) {
      const clip = state.hedgePlan[clipIndex];
      const need = clip.targetSh - clip.filled;
      if (need <= 1e-9) continue;
      if (ask > clip.askMax + 1e-12) continue;
      if (!qualify(`clip:${side}:${clipIndex}`)) continue;
      const sh = Math.min(need, remaining - bought);
      if (sh <= 1e-9) break;
      const got = tryBuyHedgeClip(side, ask, sh, 'hedge_clip', tau, ts);
      if (got <= 0) break;
      clip.filled += got;
      bought += got;
      state.events.push({
        type: 'hedge_clip',
        side,
        px: ask,
        sh: got,
        askMax: clip.askMax,
        tau,
        ts,
        avgSum: avgSum(),
      });
      clipsBought += 1;
      if (clipsBought >= Number(p.maxClipsPerTick)) break;
    }

    if (bought > 0) {
      state.hedgeAttempts += 1;
      state.resting = null;
      remaining = openSh - state.inv[side].shares;
      if (remaining <= 1e-9) {
        state.mode = 'hedged';
        state.events.push({ type: 'hedged', via: 'clips', tau, ts, avgSum: avgSum() });
      }
    } else {
      tryClipEscapes(side, ask, remaining, openSh, tau, ts);
    }
  }

  function tryHedge(asks, tau, ts) {
    if (state.mode !== 'opened') return;
    if (tau == null) return;
    const escapeWindowOpen =
      (p.tauHedgeEscape != null && tau <= p.tauHedgeEscape + 1e-12) ||
      (p.tauHedgeEscape2 != null && tau <= p.tauHedgeEscape2 + 1e-12);
    if (tau < p.tauHedgeMin && !escapeWindowOpen) return;

    if (Array.isArray(p.hedgeLevels) && p.hedgeLevels.length > 0) {
      tryHedgeClips(asks, tau, ts);
      return;
    }

    if (state.hedgeAttempts >= p.maxHedgeAttempts) return;

    const side = state.sideOpen === 'UP' ? 'DOWN' : 'UP';
    const ask = asks[side];
    if (ask == null) return;
    if (ask > p.hedgeAskMax + 1e-12) {
      // optionally post resting
      if (
        p.restingFillModel !== 'none' &&
        !state.resting &&
        ask <= p.hedgeAskMax + 0.05
      ) {
        state.resting = {
          side,
          limit: Math.min(ask, p.hedgeAskMax),
          placedTs: ts,
          placedTau: tau,
        };
        state.events.push({ type: 'hedge_rest', side, limit: state.resting.limit, tau, ts });
      }
      // V0 late escape (same knobs as clip escape)
      const shNeed = state.inv[state.sideOpen].shares - state.inv[side].shares;
      if (shNeed > 1e-9 && state.hedgeAttempts < p.maxHedgeAttempts) {
        const escMax =
          p.hedgeEscapeAskMax != null ? p.hedgeEscapeAskMax : p.hedgeAskMax;
        const escCeil = p.escapeAvgSumMax != null ? p.escapeAvgSumMax : p.avgSumMax;
        const escMax2 = p.hedgeEscapeAskMax2 != null ? p.hedgeEscapeAskMax2 : escMax;
        const escCeil2 = p.escapeAvgSumMax2 != null ? p.escapeAvgSumMax2 : escCeil;
        const stages = [
          {
            enabled: p.tauHedgeEscape2 != null,
            tauMax: p.tauHedgeEscape2,
            askMax: escMax2,
            avgSumMax: escCeil2,
            minLockedPnlPerShare: p.escapeMinLockedPnlPerShare2,
            kind: 'hedge_escape2',
          },
          {
            enabled: p.tauHedgeEscape != null,
            tauMax: p.tauHedgeEscape,
            askMax: escMax,
            avgSumMax: escCeil,
            minLockedPnlPerShare: p.escapeMinLockedPnlPerShare,
            kind: 'hedge_escape',
          },
        ];
        for (const stage of stages) {
          if (
            !stage.enabled ||
            tau > Number(stage.tauMax) + 1e-12 ||
            ask > Number(stage.askMax) + 1e-12 ||
            !qualify(`${stage.kind}:${side}`)
          ) {
            continue;
          }
          const got = tryBuyHedgeClip(
            side,
            ask,
            shNeed,
            stage.kind,
            tau,
            ts,
            stage.avgSumMax,
            stage.minLockedPnlPerShare,
          );
          if (got > 0) {
            state.hedgeAttempts += 1;
            state.resting = null;
            state.mode =
              Math.abs(state.inv.UP.shares - state.inv.DOWN.shares) < 1e-6 ? 'hedged' : 'opened';
            if (state.mode === 'hedged') {
              state.events.push({ type: 'hedged', via: stage.kind, tau, ts, avgSum: avgSum() });
            }
            return;
          }
        }
      }
      return;
    }

    const shNeed = state.inv[state.sideOpen].shares - state.inv[side].shares;
    if (shNeed <= 1e-9) {
      state.mode = 'hedged';
      return;
    }

    const fillPx = ask;
    if (!qualify(`hedge:${side}`)) return;
    const got = tryBuyHedgeClip(side, fillPx, shNeed, 'hedge', tau, ts);
    if (got > 0) {
      state.hedgeAttempts += 1;
      state.resting = null;
      state.mode = Math.abs(state.inv.UP.shares - state.inv.DOWN.shares) < 1e-6 ? 'hedged' : 'opened';
      if (state.mode === 'hedged') state.events.push({ type: 'hedged', tau, ts, avgSum: avgSum() });
    }
  }

  function tryRestingFill(asks, tau, ts, prevAsks) {
    if (p.restingFillModel === 'none') {
      state.resting = null;
      return;
    }
    if (!state.resting || state.mode !== 'opened') return;
    const { side, limit, placedTs, placedTau } = state.resting;
    const age = placedTau != null && tau != null ? placedTau - tau : null;
    if (age != null && age > p.makerTimeoutSec) {
      state.events.push({ type: 'hedge_timeout', side, limit, tau, ts });
      state.resting = null;
      state.hedgeAttempts += 1;
      return;
    }
    const prev = prevAsks?.[side];
    const curr = asks[side];
    if (prev == null || curr == null) return;
    const thr = limit - 0.01;
    if (prev > thr + 1e-12 && curr <= thr + 1e-12) {
      const shNeed = state.inv[state.sideOpen].shares - state.inv[side].shares;
      if (shNeed <= 0) {
        state.resting = null;
        return;
      }
      const px = limit;
      const proj = projectedAvgSum(side, px, shNeed);
      if (proj != null && proj > p.avgSumMax) {
        block('REST_REFUSE_AVGSUM', { proj });
        state.resting = null;
        return;
      }
      const got = buy(side, px, shNeed, 'hedge', 'maker');
      state.resting = null;
      if (got > 0) {
        if (state.hedgePlan) {
          let left = got;
          for (const clip of state.hedgePlan) {
            const need = clip.targetSh - clip.filled;
            if (need <= 0 || left <= 0) continue;
            const take = Math.min(need, left);
            clip.filled += take;
            left -= take;
          }
        }
        state.mode = 'hedged';
        state.events.push({ type: 'hedge_maker_fill', side, px, sh: got, tau, ts, avgSum: avgSum() });
      }
    }
  }

  function tryEq(asks, tau, ts) {
    if (state.mode !== 'opened' && state.mode !== 'hedged') return;
    if (state.eqAttempts >= 1) return;
    if (tau == null || tau < p.tauEqMin) return;
    const r = residual();
    if (!r.side || r.shares < 1) {
      if (r.shares < 1e-9 && state.mode === 'hedged') state.mode = 'done';
      return;
    }
    const ask = asks[r.side];
    if (ask == null || ask > p.eqAskMax + 1e-12) return;
    const proj = projectedAvgSum(r.side, ask, r.shares);
    if (proj != null && proj > p.eqAvgSumMax) {
      block('EQ_REFUSE_AVGSUM', { proj, ask });
      return;
    }
    if (!qualify(`eq:${r.side}`)) return;
    state.eqAttempts += 1;
    const got = buy(r.side, ask, r.shares, 'eq', 'taker');
    if (got > 0) {
      state.mode = 'done';
      state.events.push({ type: 'eq', side: r.side, px: ask, sh: got, tau, ts, avgSum: avgSum() });
    }
  }

  function onTick(tick) {
    const asks = {
      UP: tick.upAsk != null ? Number(tick.upAsk) : null,
      DOWN: tick.downAsk != null ? Number(tick.downAsk) : null,
    };
    const tau = tick.tau != null ? Number(tick.tau) : null;
    const ts = tick.ts || null;
    const prev = { ...state.lastAsks };

    tryRestingFill(asks, tau, ts, prev);
    tryOpen(asks, tau, ts);
    tryHedge(asks, tau, ts);
    tryEq(asks, tau, ts);

    state.lastAsks = asks;
    finishQualifierTick();
  }

  /**
   * Vencedor proxy — NÃO é settlement de verdade.
   *
   * Na resolução o book fica de um lado só: o perdedor perde o bid, o vencedor
   * perde o ask. Comparar `Number(upAsk) >= Number(downAsk)` invertia o
   * resultado nesses casos, porque `Number(null) === 0` e `Number.isFinite(0)`
   * é true — o lado vencedor (ask nulo) virava 0 e "perdia". Media 10 de 14
   * eventos errados nos journals da baliza.
   *
   * Usa o bid como sinal de valor (o vencedor tem bid alto) e cai para o ask.
   * Aceita um tick só ou a série inteira — varre de trás para frente até achar
   * um tick decisivo.
   */
  function resolveWinner(tail) {
    const ticks = Array.isArray(tail) ? tail : tail ? [tail] : [];
    const num = (x) => {
      if (x == null) return null;
      const n = Number(x);
      return Number.isFinite(n) ? n : null;
    };
    for (let i = ticks.length - 1; i >= 0; i--) {
      const t = ticks[i];
      if (!t) continue;
      const uv = num(t.upBid) ?? num(t.upAsk);
      const dv = num(t.downBid) ?? num(t.downAsk);
      if (uv == null && dv == null) continue;
      if (uv == null) return dv >= 0.5 ? 'DOWN' : 'UP';
      if (dv == null) return uv >= 0.5 ? 'UP' : 'DOWN';
      if (Math.abs(uv - dv) < 1e-9) continue;
      return uv > dv ? 'UP' : 'DOWN';
    }
    return null;
  }

  function finish(lastTick = null) {
    const winner = resolveWinner(lastTick);
    const cost = invested();
    const fees = state.inv.UP.fees + state.inv.DOWN.fees;
    const balancedShares = Math.min(state.inv.UP.shares, state.inv.DOWN.shares);
    const netPairCost =
      balancedShares > 1e-9 ? (cost + fees) / balancedShares : null;
    let pnl = null;
    if (winner) {
      pnl = state.inv[winner].shares - cost - fees;
    }
    const r = residual();
    return {
      mode: state.mode,
      sideOpen: state.sideOpen,
      inv: {
        UP: { ...state.inv.UP },
        DOWN: { ...state.inv.DOWN },
      },
      invested: Math.round(cost * 100) / 100,
      fees: Math.round(fees * 1000) / 1000,
      avgSum: avgSum() != null ? Math.round(avgSum() * 1000) / 1000 : null,
      balancedShares: Math.round(balancedShares * 1000) / 1000,
      netPairCost:
        netPairCost != null ? Math.round(netPairCost * 10000) / 10000 : null,
      lockedPnlPerShare:
        lockedPnlPerShare() != null
          ? Math.round(lockedPnlPerShare() * 10000) / 10000
          : null,
      residual: r,
      worstPnl: Math.round(worstPnl() * 100) / 100,
      winner,
      pnl: pnl != null ? Math.round(pnl * 100) / 100 : null,
      fills: state.fills,
      openAttempts: state.openAttempts,
      hedgeAttempts: state.hedgeAttempts,
      eqAttempts: state.eqAttempts,
      blockCounts: state.blocks.reduce((m, b) => {
        m[b.reason] = (m[b.reason] || 0) + 1;
        return m;
      }, {}),
      nEvents: state.events.length,
      nFills: state.fills.length,
      hedgePlan: state.hedgePlan
        ? state.hedgePlan.map((c) => ({
            askMax: c.askMax,
            targetSh: c.targetSh,
            filled: c.filled,
          }))
        : null,
      nHedgeClips: state.fills.filter(
        (f) =>
          f.kind === 'hedge_clip' ||
          f.kind === 'hedge_escape' ||
          f.kind === 'hedge_escape2',
      ).length,
    };
  }

  return {
    params: p,
    state,
    onTick,
    finish,
    avgSum,
    residual,
    worstPnl,
  };
}

function toFiniteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function milliseconds(...candidates) {
  for (const value of candidates) {
    if (value == null || value === '') continue;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function tickTimeMs(tick) {
  return milliseconds(tick?._tsMs, milliseconds(tick?.ts));
}

function eventStartMs(tick) {
  return milliseconds(tick?._eventStartMs, milliseconds(tick?.event_start));
}

function eventEndMs(tick) {
  const explicit = milliseconds(tick?._eventEndMs, milliseconds(tick?.event_end));
  if (explicit != null) return explicit;
  const start = eventStartMs(tick);
  return start == null ? null : start + 300000;
}

function secondsRemaining(tick) {
  const now = tickTimeMs(tick);
  const end = eventEndMs(tick);
  if (now == null || end == null) return null;
  return Math.max(0, (end - now) / 1000);
}

function eventKey(tick) {
  const condition = String(tick?.condition_id ?? tick?.conditionId ?? '');
  const start = eventStartMs(tick);
  return `${condition}|${start ?? String(tick?.event_start ?? '')}`;
}

function qualityOk(tick, params) {
  if (!params.requireQuality) return true;
  if (tick?.degraded === true || tick?.degraded === 1 || tick?.degraded === 'true') return false;
  const coverage = toFiniteNumber(tick?.coverage);
  if (coverage == null) return false;
  return coverage >= params.minCoverage;
}

function sideAsk(tick, side) {
  const prefix = side === 'DOWN' ? 'down' : 'up';
  const fallback = toFiniteNumber(tick?.[`${prefix}_price`]);
  return toFiniteNumber(tick?.[`${prefix}_best_ask`], fallback);
}

function sideBid(tick, side) {
  const prefix = side === 'DOWN' ? 'down' : 'up';
  return toFiniteNumber(tick?.[`${prefix}_best_bid`]);
}

function toEngineTick(tick) {
  return {
    upAsk: sideAsk(tick, 'UP'),
    downAsk: sideAsk(tick, 'DOWN'),
    upBid: sideBid(tick, 'UP'),
    downBid: sideBid(tick, 'DOWN'),
    tau: secondsRemaining(tick),
    ts: tick?.ts || null,
  };
}

function createBacktestRunner(rawParams = {}) {
  const params = mergeParams(rawParams);
  let current = null;
  const completedEvents = new Set();
  const events = [];
  const equity = [];
  const log = [];
  let ticksProcessed = 0;
  let totalEvents = 0;
  let totalEntries = 0;
  let totalNoEntry = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalPnl = 0;
  let hedgedEvents = 0;
  let periodStart = null;
  let periodEnd = null;

  const finalizeCurrentEvent = (reason = 'expired', closedAt = null) => {
    if (!current) return;
    completedEvents.add(current.key);
    const engineResult = current.engine.finish([
      toEngineTick(current.lastTick || {}),
      ...(current.tailTicks || []),
    ]);
    const entered = engineResult.nFills > 0;
    const last = current.lastTick;
    const btcPrice = toFiniteNumber(last?.btc_price, toFiniteNumber(last?.underlying_price));
    const ptb = toFiniteNumber(current.priceToBeat, toFiniteNumber(last?.price_to_beat));
    const winnerSide =
      btcPrice != null && ptb != null
        ? btcPrice >= ptb
          ? 'UP'
          : 'DOWN'
        : engineResult.winner;

    const inv = engineResult.inv;
    const totalCost = inv.UP.cost + inv.DOWN.cost;
    let grossPnl = 0;
    if (entered && winnerSide) {
      const winnerShares = winnerSide === 'UP' ? inv.UP.shares : inv.DOWN.shares;
      // Fees applied later by applyPolymarketFeesToBacktestResult when enabled.
      grossPnl = winnerShares - totalCost;
      totalPnl += grossPnl;
      totalEntries += 1;
      if (grossPnl > 0) totalWins += 1;
      else if (grossPnl < 0) totalLosses += 1;
      if (engineResult.mode === 'hedged' || engineResult.mode === 'done') hedgedEvents += 1;
    } else {
      totalNoEntry += 1;
    }

    const allFills = (engineResult.fills || []).map((f) => ({
      side: f.side,
      qty: f.sh,
      shares: f.sh,
      price: f.px,
      cost: f.notional,
      source: f.kind,
      liquidity: f.liquidity || 'taker',
      fee: f.fee || 0,
      time: current.lastTick?.ts || closedAt,
    }));

    const orders = allFills.map((f) => ({
      type: 'entry',
      side: f.side,
      source: f.source,
      createdAt: f.time,
      shares: f.qty,
      filledQty: f.qty,
      avgPrice: f.price,
      price: f.price,
      cost: f.qty * f.price,
      notional: f.qty * f.price,
      liquidity: f.liquidity || 'taker',
      fills: [{ price: f.price, qty: f.qty, liquidity: f.liquidity || 'taker', side: f.side, time: f.time }],
    }));

    const finalTs = closedAt || current.eventEnd || last?.ts || current.eventStart;
    events.push({
      eventId: current.conditionId,
      eventStart: current.eventStart,
      eventEnd: current.eventEnd,
      entryTime: allFills[0]?.time ?? null,
      exitTime: finalTs,
      reason: entered ? reason : 'no_entry',
      positionType: entered ? 'BOTH' : null,
      winnerSide,
      quantity: inv.UP.shares + inv.DOWN.shares,
      upShares: inv.UP.shares,
      downShares: inv.DOWN.shares,
      cost: totalCost,
      avgUp: inv.UP.shares > 0 ? inv.UP.cost / inv.UP.shares : null,
      avgDown: inv.DOWN.shares > 0 ? inv.DOWN.cost / inv.DOWN.shares : null,
      avgSum: engineResult.avgSum,
      residual: engineResult.residual?.shares ?? 0,
      residualSide: engineResult.residual?.side ?? null,
      mode: engineResult.mode,
      sideOpen: engineResult.sideOpen,
      worstPnl: engineResult.worstPnl,
      lockedPnlPerShare: engineResult.lockedPnlPerShare,
      hedgePlan: engineResult.hedgePlan,
      nHedgeClips: engineResult.nHedgeClips,
      openAttempts: engineResult.openAttempts,
      hedgeAttempts: engineResult.hedgeAttempts,
      blockCounts: engineResult.blockCounts,
      fillCount: engineResult.nFills,
      finalPnl: grossPnl,
      finalPnlBeforeFees: grossPnl,
      orders,
      fills: allFills,
    });
    equity.push({ ts: finalTs, pnl: totalPnl });
    if (entered) {
      log.push({
        ts: finalTs,
        type: grossPnl >= 0 ? 'profit' : 'loss',
        msg: `PAIR_PATH | mode=${engineResult.mode} avgSum=${engineResult.avgSum ?? 'n/a'} residual=${engineResult.residual?.shares?.toFixed?.(2) ?? 0} pnl=${grossPnl.toFixed(2)}`,
      });
    }
    current = null;
  };

  const processTick = (tick) => {
    ticksProcessed += 1;
    if (!periodStart) periodStart = tick?.ts;
    periodEnd = tick?.ts;
    const key = eventKey(tick);
    if (!current && completedEvents.has(key)) return;

    if (!current || current.key !== key) {
      if (current) finalizeCurrentEvent('expired', current.eventEnd || current.lastTick?.ts);
      if (completedEvents.has(key)) return;
      current = {
        key,
        conditionId: tick?.condition_id ?? tick?.conditionId ?? null,
        eventStart: tick?.event_start ?? null,
        eventEnd: tick?.event_end ?? null,
        priceToBeat: toFiniteNumber(tick?.price_to_beat),
        lastTick: tick,
        tailTicks: [],
        engine: createEventEngine(params, {
          conditionId: tick?.condition_id ?? null,
          eventStart: tick?.event_start ?? null,
        }),
      };
      totalEvents += 1;
    }

    current.lastTick = tick;
    if (current.priceToBeat == null) current.priceToBeat = toFiniteNumber(tick?.price_to_beat);
    const engTick = toEngineTick(tick);
    current.tailTicks.push(engTick);
    if (current.tailTicks.length > 8) current.tailTicks.shift();

    const nowMs = tickTimeMs(tick);
    const endMs = eventEndMs(tick);
    if (nowMs != null && endMs != null && nowMs >= endMs) {
      finalizeCurrentEvent('expired', tick?.event_end || tick?.ts);
      return;
    }

    if (!qualityOk(tick, params)) return;
    current.engine.onTick(engTick);
  };

  const finish = () => {
    if (current) finalizeCurrentEvent('expired', current.eventEnd || current.lastTick?.ts);
    let maxDrawdown = 0;
    let peak = 0;
    for (const point of equity) {
      if (point.pnl > peak) peak = point.pnl;
      maxDrawdown = Math.max(maxDrawdown, peak - point.pnl);
    }
    return {
      params,
      strategy: 'PAIR_PATH_CLIP_PATH',
      summary: {
        totalEvents,
        totalEntries,
        totalNoEntry,
        totalWins,
        totalLosses,
        winRate: totalEntries > 0 ? (totalWins / totalEntries) * 100 : 0,
        totalPnl,
        avgPnl: totalEntries > 0 ? totalPnl / totalEntries : 0,
        maxDrawdown,
        finalWallet: params.walletSize + totalPnl,
        hedgedEvents,
        restingFillModel: params.restingFillModel,
        hasHedgeLevels: Array.isArray(params.hedgeLevels) && params.hedgeLevels.length > 0,
      },
      equity,
      events,
      log,
      ticksProcessed,
      periodStart,
      periodEnd,
    };
  };

  return { processTick, finish };
}

function runPairPathBacktest(rawParams, ticks) {
  const runner = createBacktestRunner(rawParams);
  for (const tick of ticks) runner.processTick(tick);
  return runner.finish();
}

var __pairPathExports = {
  DEFAULT_PARAMS,
  mergeParams,
  createEventEngine,
  createBacktestRunner,
  runPairPathBacktest,
  toEngineTick,
  secondsRemaining,
  eventKey,
};
