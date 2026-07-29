/**
 * Pair/Clip-Path replay against the local BTC 5m depth-25 lake.
 *
 * Unlike the 14-event top-book journal A/B, this runner:
 * - walks 25 ask levels;
 * - applies the crypto taker fee per fill level;
 * - submits one order at a time with configurable tick latency;
 * - books partial fills into inventory;
 * - infers no maker fills and uses no offline-only EQ;
 * - reports worst-case settlement PnL when inventory is residual.
 *
 * Usage:
 *   node labs/sandbox/pair-path-v0/lake-replay.mjs
 *   node labs/sandbox/pair-path-v0/lake-replay.mjs --from=2026-07-01 --to=2026-07-26
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const LAKE = path.join(
  ROOT,
  'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25',
);
const FEE_RATE = 0.07;
const OPERATIONAL_BUFFER_PER_PAIR = 0.002;

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const FROM = arg('from', '2026-04-23');
const TO = arg('to', '2026-07-26');
const PRIMARY_SHARES = Math.max(1, Number(arg('shares', '10')) || 10);
const STUDY = arg('study', 'baseline');
const OUT_DIR = path.join(
  ROOT,
  STUDY === 'baseline'
    ? '.tmp/pair-path-lake-replay'
    : `.tmp/pair-path-lake-replay-${STUDY}`,
);

function ladder(...levels) {
  return levels.map(([askMax, frac]) => ({ askMax, frac }));
}

const BASELINE_POLICY_TEMPLATES = [
  {
    name: 'v0',
    notes: '1 open + 1 hedge cheio @42; avgSumMax 0.95',
    hedgeAskMax: 0.42,
    hedgeLevels: null,
    avgSumMax: 0.95,
    maxHedgeAttempts: 2,
    escapes: [],
  },
  {
    name: 'tight2',
    notes: '50%@40 + 50%@36; escapes líquidos em 2 estágios',
    hedgeAskMax: 0.4,
    hedgeLevels: ladder([0.4, 0.5], [0.36, 0.5]),
    avgSumMax: 0.95,
    maxHedgeAttempts: 8,
    escapes: [
      {
        name: 'escape1',
        tauMax: 40,
        askMax: 0.42,
        avgSumMax: 0.98,
        minLockedPnlPerShare: -0.02,
      },
      {
        name: 'escape2',
        tauMax: 12,
        askMax: 0.45,
        avgSumMax: 1,
        minLockedPnlPerShare: -0.04,
      },
    ],
  },
  {
    name: 'deep3',
    notes: '40%@40 + 30%@36 + 30%@32; sweep winner in-sample sob auditoria',
    hedgeAskMax: 0.4,
    hedgeLevels: ladder([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
    avgSumMax: 0.94,
    maxHedgeAttempts: 8,
    escapes: [
      {
        name: 'escape1',
        tauMax: 40,
        askMax: 0.42,
        avgSumMax: 0.98,
        minLockedPnlPerShare: -0.02,
      },
      {
        name: 'escape2',
        tauMax: 12,
        askMax: 0.45,
        avgSumMax: 1,
        minLockedPnlPerShare: -0.04,
      },
    ],
  },
  {
    name: 'deep4-control',
    notes: '25%@42/38/34/30; controle agressivo de overfit',
    hedgeAskMax: 0.42,
    hedgeLevels: ladder(
      [0.42, 0.25],
      [0.38, 0.25],
      [0.34, 0.25],
      [0.3, 0.25],
    ),
    avgSumMax: 0.94,
    maxHedgeAttempts: 8,
    escapes: [
      {
        name: 'escape1',
        tauMax: 40,
        askMax: 0.42,
        avgSumMax: 0.98,
        minLockedPnlPerShare: -0.02,
      },
      {
        name: 'escape2',
        tauMax: 12,
        askMax: 0.45,
        avgSumMax: 1,
        minLockedPnlPerShare: -0.04,
      },
    ],
  },
];

const TIGHT2 = BASELINE_POLICY_TEMPLATES.find((policy) => policy.name === 'tight2');
const RISK_POLICY_TEMPLATES = [
  { ...TIGHT2, name: 'tight2-control' },
  {
    ...TIGHT2,
    name: 'tight2-losscut3',
    notes: 'tight2 + flatten adverso após queda de 3c no favorito',
    lossCut: {
      favoriteAskDrop: 0.03,
      askMax: 0.55,
      minLockedPnlPerShare: -0.12,
    },
  },
  {
    ...TIGHT2,
    name: 'tight2-momo2c10s',
    notes: 'tight2 + favorito precisa subir 2c em 10s antes do open',
    openMomentum: {
      lookbackMs: 10_000,
      minFavoriteAskRise: 0.02,
    },
  },
  {
    ...TIGHT2,
    name: 'tight2-momo2c10s-losscut3',
    notes: 'momentum 2c/10s + flatten adverso após queda de 3c',
    openMomentum: {
      lookbackMs: 10_000,
      minFavoriteAskRise: 0.02,
    },
    lossCut: {
      favoriteAskDrop: 0.03,
      askMax: 0.55,
      minLockedPnlPerShare: -0.12,
    },
  },
];

if (!['baseline', 'risk'].includes(STUDY)) {
  throw new Error(`unknown --study=${STUDY}; expected baseline or risk`);
}
const POLICY_TEMPLATES =
  STUDY === 'risk' ? RISK_POLICY_TEMPLATES : BASELINE_POLICY_TEMPLATES;

const EXECUTION_PROFILES = [
  {
    name: 'latency1',
    latencyTicks: 1,
    openConfirmationTicks: 1,
  },
  {
    name: 'latency3',
    latencyTicks: 3,
    openConfirmationTicks: 1,
  },
  {
    name: 'confirm2-latency1',
    latencyTicks: 1,
    openConfirmationTicks: 2,
  },
];

const SELECTED_EXECUTION_PROFILES =
  STUDY === 'risk'
    ? EXECUTION_PROFILES.filter((profile) => profile.name !== 'confirm2-latency1')
    : EXECUTION_PROFILES;

const VARIANTS = POLICY_TEMPLATES.flatMap((policy) =>
  SELECTED_EXECUTION_PROFILES.map((execution) => ({
    ...policy,
    ...execution,
    policyName: policy.name,
    executionName: execution.name,
    id: `${policy.name}-${execution.name}`,
    openShares: PRIMARY_SHARES,
    maxEventNotional: Math.max(16, PRIMARY_SHARES * 1.1),
    openAskLo: 0.52,
    openAskHi: 0.62,
    openTrigger: 0.55,
    openCap: 0.02,
    openBookSumMin: 0.95,
    openBookSumMax: 1.05,
    tauOpenMin: 40,
    tauOpenMax: 240,
    maxOpenAttempts: 3,
    maxSignalGapMs: 1250,
  })),
);

function levelList(prefix, field) {
  return Array.from(
    { length: 25 },
    (_, index) => `${prefix}_ask_${field}_${index + 1}`,
  ).join(', ');
}

function fee(price, shares) {
  const p = Math.min(0.99, Math.max(0.01, Number(price)));
  return FEE_RATE * p * (1 - p) * shares;
}

function levelsAt(tick, side) {
  const prices = side === 'UP' ? tick.upAskPrices : tick.downAskPrices;
  const sizes = side === 'UP' ? tick.upAskSizes : tick.downAskSizes;
  const levels = [];
  for (let level = 0; level < 25; level += 1) {
    const px = prices[level];
    const size = sizes[level];
    if (px != null && size != null && Number(size) > 0) {
      levels.push({ px: Number(px), size: Number(size) });
    }
  }
  levels.sort((a, b) => a.px - b.px);
  return levels;
}

function sweepBuy(tick, side, shares, limitPrice) {
  let remaining = shares;
  let notional = 0;
  let fees = 0;
  const fills = [];
  for (const level of levelsAt(tick, side)) {
    if (remaining <= 1e-9 || level.px > limitPrice + 1e-12) break;
    const taken = Math.min(remaining, level.size);
    if (taken <= 0) continue;
    const fillFee = fee(level.px, taken);
    fills.push({ px: level.px, shares: taken, fee: fillFee });
    remaining -= taken;
    notional += level.px * taken;
    fees += fillFee;
  }
  const filled = shares - remaining;
  return {
    requested: shares,
    filled,
    remaining,
    notional,
    fees,
    avgPrice: filled > 1e-9 ? notional / filled : null,
    fills,
  };
}

function emptyInventory() {
  return {
    UP: { shares: 0, cost: 0, fees: 0 },
    DOWN: { shares: 0, cost: 0, fees: 0 },
  };
}

function invested(state) {
  return state.inv.UP.cost + state.inv.DOWN.cost;
}

function totalFees(state) {
  return state.inv.UP.fees + state.inv.DOWN.fees;
}

function average(state, side) {
  const leg = state.inv[side];
  return leg.shares > 1e-9 ? leg.cost / leg.shares : null;
}

function averageSum(state) {
  const up = average(state, 'UP');
  const down = average(state, 'DOWN');
  return up != null && down != null ? up + down : null;
}

function residual(state) {
  return Math.abs(state.inv.UP.shares - state.inv.DOWN.shares);
}

function worstPnl(state) {
  const cost = invested(state) + totalFees(state);
  return Math.min(state.inv.UP.shares, state.inv.DOWN.shares) - cost;
}

function lockedPnlPerShareAfter(state, side, price, shares) {
  const feeAdd = fee(price, shares);
  const cost = invested(state) + totalFees(state) + price * shares + feeAdd;
  const up = state.inv.UP.shares + (side === 'UP' ? shares : 0);
  const down = state.inv.DOWN.shares + (side === 'DOWN' ? shares : 0);
  const balanced = Math.min(up, down);
  return balanced > 1e-9 ? (balanced - cost) / balanced : null;
}

function projectedAvgSum(state, side, price, shares) {
  const leg = state.inv[side];
  const other = side === 'UP' ? 'DOWN' : 'UP';
  const otherAvg = average(state, other);
  if (otherAvg == null || shares <= 0) return null;
  const nextAvg = (leg.cost + price * shares) / (leg.shares + shares);
  return nextAvg + otherAvg;
}

function buildPlan(levels, openShares) {
  if (!Array.isArray(levels) || !levels.length) return null;
  let allocated = 0;
  return levels.map((level, index) => {
    const target =
      index === levels.length - 1
        ? openShares - allocated
        : openShares * Number(level.frac);
    allocated += target;
    return { askMax: Number(level.askMax), target, filled: 0 };
  });
}

function addFill(state, side, result, kind, tick, extra = {}) {
  if (result.filled <= 1e-9) return;
  const leg = state.inv[side];
  leg.shares += result.filled;
  leg.cost += result.notional;
  leg.fees += result.fees;
  state.fills.push({
    side,
    kind,
    shares: result.filled,
    avgPrice: result.avgPrice,
    notional: result.notional,
    fees: result.fees,
    tau: tick.tau,
    tsMs: tick.tsMs,
    partial: result.filled + 1e-9 < result.requested,
    ...extra,
  });
  if (result.filled + 1e-9 < result.requested) state.partialOrders += 1;
}

function createState(params) {
  return {
    params,
    mode: 'idle',
    sideOpen: null,
    inv: emptyInventory(),
    plan: null,
    pending: null,
    openAttempts: 0,
    hedgeAttempts: 0,
    openConfirmKey: null,
    openConfirmCount: 0,
    fills: [],
    partialOrders: 0,
    depthMisses: 0,
    firstOpenTau: null,
    equalizedTau: null,
    recentTicks: [],
  };
}

function executePending(state, tick, tickIndex) {
  const order = state.pending;
  if (!order || tickIndex < order.executeAt) return;
  state.pending = null;
  const result = sweepBuy(tick, order.side, order.shares, order.limitPrice);
  if (result.filled <= 1e-9) {
    state.depthMisses += 1;
    return;
  }

  addFill(state, order.side, result, order.kind, tick, {
    signalTau: order.signalTau,
    signalPrice: order.limitPrice,
    latencyTicks: state.params.latencyTicks,
  });

  if (order.kind === 'open') {
    state.sideOpen = order.side;
    state.mode = 'opened';
    state.firstOpenTau = tick.tau;
    state.plan = buildPlan(state.params.hedgeLevels, result.filled);
    return;
  }

  if (order.clipIndex != null && state.plan?.[order.clipIndex]) {
    state.plan[order.clipIndex].filled += result.filled;
  } else if (
    (order.kind.startsWith('escape') || order.kind === 'loss_cut') &&
    state.plan
  ) {
    let left = result.filled;
    for (const clip of state.plan) {
      const need = clip.target - clip.filled;
      if (need <= 1e-9 || left <= 1e-9) continue;
      const taken = Math.min(need, left);
      clip.filled += taken;
      left -= taken;
    }
  }
  if (residual(state) <= 1e-6) {
    state.mode = 'done';
    state.equalizedTau = tick.tau;
  }
}

function scheduleOpen(state, tick, tickIndex) {
  const p = state.params;
  if (
    state.mode !== 'idle' ||
    state.pending ||
    state.openAttempts >= p.maxOpenAttempts ||
    tick.tau < p.tauOpenMin ||
    tick.tau > p.tauOpenMax
  ) {
    state.openConfirmKey = null;
    state.openConfirmCount = 0;
    return;
  }
  const side = tick.upAsk >= tick.downAsk ? 'UP' : 'DOWN';
  const ask = side === 'UP' ? tick.upAsk : tick.downAsk;
  const sum = tick.upAsk + tick.downAsk;
  const momentum = p.openMomentum;
  if (momentum) {
    const cutoff = tick.tsMs - momentum.lookbackMs;
    let reference = null;
    for (let index = state.recentTicks.length - 1; index >= 0; index -= 1) {
      if (state.recentTicks[index].tsMs <= cutoff) {
        reference = state.recentTicks[index];
        break;
      }
    }
    const referenceSide =
      reference == null
        ? null
        : reference.upAsk >= reference.downAsk
          ? 'UP'
          : 'DOWN';
    const referenceAsk =
      reference == null
        ? null
        : side === 'UP'
          ? reference.upAsk
          : reference.downAsk;
    if (
      reference == null ||
      referenceSide !== side ||
      ask - referenceAsk < momentum.minFavoriteAskRise - 1e-12
    ) {
      state.openConfirmKey = null;
      state.openConfirmCount = 0;
      return;
    }
  }
  const eligible =
    ask >= p.openAskLo - 1e-12 &&
    ask <= p.openAskHi + 1e-12 &&
    ask >= p.openTrigger - 1e-12 &&
    ask <= p.openTrigger + p.openCap + 1e-12 &&
    sum >= p.openBookSumMin - 1e-12 &&
    sum <= p.openBookSumMax + 1e-12;
  if (!eligible) {
    state.openConfirmKey = null;
    state.openConfirmCount = 0;
    return;
  }
  const key = `${side}:${ask.toFixed(4)}`;
  state.openConfirmCount =
    state.openConfirmKey === key ? state.openConfirmCount + 1 : 1;
  state.openConfirmKey = key;
  if (state.openConfirmCount < p.openConfirmationTicks) return;

  state.openAttempts += 1;
  state.pending = {
    kind: 'open',
    side,
    shares: p.openShares,
    limitPrice: ask,
    signalTau: tick.tau,
    executeAt: tickIndex + p.latencyTicks,
  };
  state.openConfirmKey = null;
  state.openConfirmCount = 0;
}

function nextClip(state) {
  if (!state.plan) return null;
  for (let index = 0; index < state.plan.length; index += 1) {
    const clip = state.plan[index];
    if (clip.filled + 1e-9 < clip.target) return { clip, index };
  }
  return null;
}

function scheduleHedge(state, tick, tickIndex) {
  const p = state.params;
  if (
    state.mode !== 'opened' ||
    state.pending ||
    state.hedgeAttempts >= p.maxHedgeAttempts
  ) {
    return;
  }
  const side = state.sideOpen === 'UP' ? 'DOWN' : 'UP';
  const ask = side === 'UP' ? tick.upAsk : tick.downAsk;
  const sharesNeeded = state.inv[state.sideOpen].shares - state.inv[side].shares;
  if (sharesNeeded <= 1e-9) {
    state.mode = 'done';
    state.equalizedTau = tick.tau;
    return;
  }

  const lossCut = p.lossCut;
  const currentOpenAsk =
    state.sideOpen === 'UP' ? tick.upAsk : tick.downAsk;
  const openAverage = average(state, state.sideOpen);
  if (
    lossCut &&
    openAverage != null &&
    currentOpenAsk <= openAverage - lossCut.favoriteAskDrop + 1e-12 &&
    ask <= lossCut.askMax + 1e-12
  ) {
    const lockedPerShare = lockedPnlPerShareAfter(
      state,
      side,
      ask,
      sharesNeeded,
    );
    if (
      lockedPerShare != null &&
      lockedPerShare >= lossCut.minLockedPnlPerShare - 1e-12 &&
      invested(state) + ask * sharesNeeded <= p.maxEventNotional + 1e-9
    ) {
      state.hedgeAttempts += 1;
      state.pending = {
        kind: 'loss_cut',
        side,
        shares: sharesNeeded,
        limitPrice: ask,
        signalTau: tick.tau,
        executeAt: tickIndex + p.latencyTicks,
      };
      return;
    }
  }

  if (!state.plan) {
    if (ask <= p.hedgeAskMax + 1e-12) {
      const projected = projectedAvgSum(state, side, ask, sharesNeeded);
      if (
        projected != null &&
        projected <= p.avgSumMax + 1e-12 &&
        invested(state) + ask * sharesNeeded <= p.maxEventNotional + 1e-9
      ) {
        state.hedgeAttempts += 1;
        state.pending = {
          kind: 'hedge',
          side,
          shares: sharesNeeded,
          limitPrice: ask,
          signalTau: tick.tau,
          executeAt: tickIndex + p.latencyTicks,
        };
      }
    }
    return;
  }

  const next = nextClip(state);
  if (next && ask <= next.clip.askMax + 1e-12) {
    const target = Math.min(next.clip.target - next.clip.filled, sharesNeeded);
    const projected = projectedAvgSum(state, side, ask, target);
    if (
      projected != null &&
      projected <= p.avgSumMax + 1e-12 &&
      invested(state) + ask * target <= p.maxEventNotional + 1e-9
    ) {
      state.hedgeAttempts += 1;
      state.pending = {
        kind: 'clip',
        clipIndex: next.index,
        side,
        shares: target,
        limitPrice: ask,
        signalTau: tick.tau,
        executeAt: tickIndex + p.latencyTicks,
      };
      return;
    }
  }

  const eligibleEscapes = p.escapes
    .filter((stage) => tick.tau <= stage.tauMax + 1e-12)
    .sort((a, b) => a.tauMax - b.tauMax);
  for (const stage of eligibleEscapes) {
    if (ask > stage.askMax + 1e-12) continue;
    const projected = projectedAvgSum(state, side, ask, sharesNeeded);
    const lockedPerShare = lockedPnlPerShareAfter(
      state,
      side,
      ask,
      sharesNeeded,
    );
    if (
      projected == null ||
      projected > stage.avgSumMax + 1e-12 ||
      lockedPerShare == null ||
      lockedPerShare < stage.minLockedPnlPerShare - 1e-12 ||
      invested(state) + ask * sharesNeeded > p.maxEventNotional + 1e-9
    ) {
      continue;
    }
    state.hedgeAttempts += 1;
    state.pending = {
      kind: stage.name,
      side,
      shares: sharesNeeded,
      limitPrice: ask,
      signalTau: tick.tau,
      executeAt: tickIndex + p.latencyTicks,
    };
    return;
  }
}

function runEvent(ticks, params, eventKey) {
  const state = createState(params);
  let previousTs = null;
  for (let index = 0; index < ticks.length; index += 1) {
    const tick = ticks[index];
    if (
      previousTs != null &&
      tick.tsMs - previousTs > params.maxSignalGapMs
    ) {
      state.openConfirmKey = null;
      state.openConfirmCount = 0;
    }
    previousTs = tick.tsMs;
    executePending(state, tick, index);
    if (state.mode === 'done') break;
    scheduleOpen(state, tick, index);
    scheduleHedge(state, tick, index);
    state.recentTicks.push({
      tsMs: tick.tsMs,
      upAsk: tick.upAsk,
      downAsk: tick.downAsk,
    });
    const maxLookbackMs = state.params.openMomentum?.lookbackMs ?? 0;
    const historyCutoff = tick.tsMs - Math.max(30_000, maxLookbackMs + 5_000);
    while (
      state.recentTicks.length &&
      state.recentTicks[0].tsMs < historyCutoff
    ) {
      state.recentTicks.shift();
    }
  }
  const balanced = Math.min(state.inv.UP.shares, state.inv.DOWN.shares);
  const avgSum = averageSum(state);
  const worst = worstPnl(state);
  const buffer = balanced * OPERATIONAL_BUFFER_PER_PAIR;
  const last = ticks[ticks.length - 1];
  const spotWinner =
    last.underlyingPrice > last.priceToBeat
      ? 'UP'
      : last.underlyingPrice < last.priceToBeat
        ? 'DOWN'
        : null;
  const bookWinner =
    last.upAsk > last.downAsk
      ? 'UP'
      : last.downAsk > last.upAsk
        ? 'DOWN'
        : null;
  const winner =
    spotWinner != null && spotWinner === bookWinner ? spotWinner : null;
  const realizedPnl =
    winner != null
      ? state.inv[winner].shares - invested(state) - totalFees(state)
      : null;
  return {
    eventKey,
    mode: state.mode,
    opened: state.fills.some((fill) => fill.kind === 'open'),
    equalized: residual(state) <= 1e-6 && balanced > 0,
    residual: residual(state),
    balancedShares: balanced,
    invested: invested(state),
    fees: totalFees(state),
    avgSum,
    netPairCost:
      balanced > 1e-9
        ? (invested(state) + totalFees(state)) / balanced
        : null,
    worstPnl: worst,
    guardedWorstPnl: worst - buffer,
    winner,
    spotWinner,
    bookWinner,
    realizedPnl,
    guardedRealizedPnl:
      realizedPnl != null ? realizedPnl - buffer : null,
    fills: state.fills.length,
    hedgeFills: state.fills.filter((fill) => fill.kind !== 'open').length,
    partialOrders: state.partialOrders,
    depthMisses: state.depthMisses,
    firstOpenTau: state.firstOpenTau,
    equalizedTau: state.equalizedTau,
    hedgeSeconds:
      state.firstOpenTau != null && state.equalizedTau != null
        ? state.firstOpenTau - state.equalizedTau
        : null,
    fillKinds: state.fills.map((fill) => fill.kind),
  };
}

function numberOrNull(value) {
  return value == null ? null : Number(value);
}

function normalizeTick(row) {
  return {
    tsMs: Number(row.ts_epoch) * 1000,
    tau: Number(row.tau),
    upAsk: Number(row.up_best_ask),
    downAsk: Number(row.down_best_ask),
    underlyingPrice: Number(row.underlying_price),
    priceToBeat: Number(row.price_to_beat),
    upAskPrices: row.up_ask_prices.map(numberOrNull),
    upAskSizes: row.up_ask_sizes.map(numberOrNull),
    downAskPrices: row.down_ask_prices.map(numberOrNull),
    downAskSizes: row.down_ask_sizes.map(numberOrNull),
  };
}

function quantile(values, fraction) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = Math.min(
    clean.length - 1,
    Math.max(0, Math.floor((clean.length - 1) * fraction)),
  );
  return clean[index];
}

function summarize(rows) {
  const opened = rows.filter((row) => row.opened);
  const equalized = opened.filter((row) => row.equalized);
  const residualRows = opened.filter((row) => !row.equalized);
  const investedSum = opened.reduce((sum, row) => sum + row.invested, 0);
  const guardedWorstSum = opened.reduce(
    (sum, row) => sum + row.guardedWorstPnl,
    0,
  );
  const resolved = opened.filter((row) => row.guardedRealizedPnl != null);
  const realizedSum = resolved.reduce(
    (sum, row) => sum + row.guardedRealizedPnl,
    0,
  );
  const residualResolved = resolved.filter((row) => !row.equalized);
  const residualRealizedSum = residualResolved.reduce(
    (sum, row) => sum + row.guardedRealizedPnl,
    0,
  );
  const realizedWins = resolved
    .map((row) => row.guardedRealizedPnl)
    .filter((pnl) => pnl > 0);
  const realizedLosses = resolved
    .map((row) => row.guardedRealizedPnl)
    .filter((pnl) => pnl < 0);
  const grossProfit = realizedWins.reduce((sum, pnl) => sum + pnl, 0);
  const grossLoss = realizedLosses.reduce((sum, pnl) => sum + Math.abs(pnl), 0);
  return {
    events: rows.length,
    opened: opened.length,
    equalized: equalized.length,
    residual: residualRows.length,
    equalizeRatePct: opened.length
      ? Math.round((equalized.length / opened.length) * 10000) / 100
      : null,
    guardedWorstPnl: Math.round(guardedWorstSum * 1000) / 1000,
    guardedWorstPerOpen:
      opened.length > 0
        ? Math.round((guardedWorstSum / opened.length) * 10000) / 10000
        : null,
    rocWorstPct:
      investedSum > 0
        ? Math.round((guardedWorstSum / investedSum) * 10000) / 100
        : null,
    worstEvent: opened.length
      ? Math.round(Math.min(...opened.map((row) => row.guardedWorstPnl)) * 1000) /
        1000
      : null,
    resolved: resolved.length,
    guardedRealizedPnl: Math.round(realizedSum * 1000) / 1000,
    realizedPerOpen:
      resolved.length > 0
        ? Math.round((realizedSum / resolved.length) * 10000) / 10000
        : null,
    realizedProfitFactor:
      grossLoss > 0
        ? Math.round((grossProfit / grossLoss) * 1000) / 1000
        : grossProfit > 0
          ? 'Infinity'
          : 0,
    residualResolved: residualResolved.length,
    residualRealizedPnl: Math.round(residualRealizedSum * 1000) / 1000,
    residualMax: residualRows.length
      ? Math.round(Math.max(...residualRows.map((row) => row.residual)) * 1000) /
        1000
      : 0,
    invested: Math.round(investedSum * 100) / 100,
    fees: Math.round(opened.reduce((sum, row) => sum + row.fees, 0) * 1000) /
      1000,
    avgSumP50: quantile(equalized.map((row) => row.avgSum), 0.5),
    netPairCostP50: quantile(
      equalized.map((row) => row.netPairCost),
      0.5,
    ),
    hedgeSecondsP50: quantile(
      equalized.map((row) => row.hedgeSeconds),
      0.5,
    ),
    partialOrders: opened.reduce(
      (sum, row) => sum + row.partialOrders,
      0,
    ),
    depthMisses: rows.reduce((sum, row) => sum + row.depthMisses, 0),
    lossCutFills: opened.reduce(
      (sum, row) =>
        sum + row.fillKinds.filter((kind) => kind === 'loss_cut').length,
      0,
    ),
  };
}

function monthOf(day) {
  return day.slice(0, 7);
}

function listDays() {
  return fs
    .readdirSync(LAKE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('dt='))
    .map((entry) => entry.name.slice(3))
    .filter((day) => day >= FROM && day <= TO)
    .sort();
}

async function main() {
  const days = listDays();
  if (!days.length) throw new Error(`no lake days in ${FROM}..${TO}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('=== Pair/Clip-Path depth-25 lake replay ===');
  console.log(
    `study=${STUDY} days=${days.length} window=${FROM}..${TO} shares=${PRIMARY_SHARES} variants=${VARIANTS.length}`,
  );
  console.log(
    'model=walk ask25 + taker fee + partial + sequential latency; maker/EQ disabled',
  );

  const db = await DuckDBInstance.create(':memory:');
  const connection = await db.connect();
  await connection.run('SET threads TO 6');

  const results = new Map(VARIANTS.map((variant) => [variant.id, []]));
  let eligibleEvents = 0;
  let skippedCoverage = 0;

  for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
    const day = days[dayIndex];
    const dayDir = path.join(LAKE, `dt=${day}`);
    const files = fs
      .readdirSync(dayDir)
      .filter((name) => name.endsWith('.parquet'))
      .map((name) => path.join(dayDir, name));
    if (!files.length) continue;
    const parquet = `[${files.map((file) => quotedString(file)).join(',')}]`;
    const query = `
      SELECT
        epoch(try_cast(event_start AS TIMESTAMPTZ))::BIGINT AS event_epoch,
        epoch(try_cast(ts AS TIMESTAMPTZ))::DOUBLE AS ts_epoch,
        extract(epoch FROM (
          try_cast(event_end AS TIMESTAMPTZ) - try_cast(ts AS TIMESTAMPTZ)
        ))::DOUBLE AS tau,
        up_best_ask,
        down_best_ask,
        underlying_price,
        price_to_beat,
        list_value(${levelList('up', 'px')}) AS up_ask_prices,
        list_value(${levelList('up', 'sz')}) AS up_ask_sizes,
        list_value(${levelList('down', 'px')}) AS down_ask_prices,
        list_value(${levelList('down', 'sz')}) AS down_ask_sizes
      FROM read_parquet(${parquet})
      WHERE coverage >= 0.99
        AND coalesce(degraded, false) = false
        AND up_best_ask IS NOT NULL
        AND down_best_ask IS NOT NULL
        AND underlying_price IS NOT NULL
        AND price_to_beat IS NOT NULL
      QUALIFY row_number() OVER (
        PARTITION BY event_start, ts
        ORDER BY coverage DESC
      ) = 1
      ORDER BY event_start, ts
    `;
    const rows = (await connection.runAndReadAll(query)).getRowObjectsJS();
    let eventKey = null;
    let buffer = [];
    const flush = () => {
      if (!buffer.length) return;
      const maxTau = Math.max(...buffer.map((tick) => tick.tau));
      const minTau = Math.min(...buffer.map((tick) => tick.tau));
      if (maxTau < 240 || minTau > 15) {
        skippedCoverage += 1;
        return;
      }
      eligibleEvents += 1;
      for (const variant of VARIANTS) {
        results
          .get(variant.id)
          .push({ day, ...runEvent(buffer, variant, eventKey) });
      }
    };
    for (const row of rows) {
      const key = String(row.event_epoch);
      if (eventKey != null && key !== eventKey) {
        flush();
        buffer = [];
      }
      eventKey = key;
      buffer.push(normalizeTick(row));
    }
    flush();
    if (
      dayIndex === 0 ||
      dayIndex === days.length - 1 ||
      (dayIndex + 1) % 10 === 0
    ) {
      console.log(
        `[${dayIndex + 1}/${days.length}] ${day} eligible=${eligibleEvents}`,
      );
    }
  }

  const variants = VARIANTS.map((variant) => {
    const rows = results.get(variant.id);
    const monthly = {};
    for (const month of [...new Set(rows.map((row) => monthOf(row.day)))]) {
      monthly[month] = summarize(
        rows.filter((row) => monthOf(row.day) === month),
      );
    }
    const residualWorst = rows
      .filter((row) => row.opened && !row.equalized)
      .sort((a, b) => a.guardedWorstPnl - b.guardedWorstPnl)
      .slice(0, 20);
    return {
      id: variant.id,
      policy: variant.policyName,
      execution: variant.executionName,
      notes: variant.notes,
      params: {
        openShares: variant.openShares,
        latencyTicks: variant.latencyTicks,
        openConfirmationTicks: variant.openConfirmationTicks,
        hedgeLevels: variant.hedgeLevels,
        avgSumMax: variant.avgSumMax,
        escapes: variant.escapes,
        openMomentum: variant.openMomentum ?? null,
        lossCut: variant.lossCut ?? null,
      },
      summary: summarize(rows),
      monthly,
      residualWorst,
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    window: { from: FROM, to: TO, days: days.length },
    study: STUDY,
    dataset: 'backtest_ticks BTC 5m depth25',
    feeRate: FEE_RATE,
    operationalBufferPerPair: OPERATIONAL_BUFFER_PER_PAIR,
    executionModel: {
      book: 'walk_ask_depth25',
      liquidity: 'all_taker',
      partialFills: true,
      makerInference: false,
      offlineEq: false,
      orders: 'one_at_a_time',
      latency: 'future lake ticks',
    },
    eligibleEvents,
    skippedCoverage,
    variants,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify(report, null, 2),
  );

  console.log('');
  for (const variant of variants) {
    const summary = variant.summary;
    console.log(
      `${variant.id.padEnd(30)} open=${summary.opened}/${summary.events}` +
        ` eq=${summary.equalized} residual=${summary.residual}` +
        ` eqRate=${summary.equalizeRatePct}% guardedWorst=${summary.guardedWorstPnl}` +
        ` realized=${summary.guardedRealizedPnl} PF=${summary.realizedProfitFactor}` +
        ` worst=${summary.worstEvent} rocWorst=${summary.rocWorstPct}%` +
        ` pairCostP50=${summary.netPairCostP50}`,
    );
  }
  console.log('');
  console.log('saved', path.join(OUT_DIR, 'report.json'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
