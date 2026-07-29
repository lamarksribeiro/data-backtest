/**
 * A/B: open-only vs hedge-asap vs hedge on PTB approach.
 *
 * Hypothesis: after a directional open that moves favorably away from PTB,
 * delay hedging until price approaches PTB again — preserve jackpot when it
 * doesn't return; lock/limit damage when it threatens to flip.
 *
 * Usage:
 *   node labs/sandbox/pair-path-v0/ptb-protect-ab.mjs
 *   node labs/sandbox/pair-path-v0/ptb-protect-ab.mjs --from=2026-07-01 --to=2026-07-26 --shares=90
 *   node labs/sandbox/pair-path-v0/ptb-protect-ab.mjs --openLeaveUsd=30 --shares=90
 *   node labs/sandbox/pair-path-v0/ptb-protect-ab.mjs --grid=1   # openLeave ∈ {0,20,30,40}
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

const FROM = arg('from', '2026-07-01');
const TO = arg('to', '2026-07-26');
const PRIMARY_SHARES = Math.max(1, Number(arg('shares', '90')) || 90);
const PTB_LEAVE_USD = Math.max(0, Number(arg('ptbLeaveUsd', '40')) || 40);
const PTB_APPROACH_USD = Math.max(
  0,
  Number(arg('ptbApproachUsd', '25')) || 25,
);
const OPEN_LEAVE_USD = Math.max(0, Number(arg('openLeaveUsd', '0')) || 0);
const RUN_GRID = arg('grid', '0') === '1';
const LATENCY_TICKS = Math.max(0, Number(arg('latencyTicks', '1')) || 0);
const OPEN_CONFIRM = Math.max(
  1,
  Number(arg('openConfirm', '2')) || 2,
);

const OUT_DIR = path.join(
  ROOT,
  RUN_GRID
    ? '.tmp/ptb-protect-ab-grid'
    : OPEN_LEAVE_USD > 0
      ? `.tmp/ptb-protect-ab-openLeave${OPEN_LEAVE_USD}`
      : '.tmp/ptb-protect-ab',
);

const HEDGE_POLICIES = [
  {
    hedgeId: 'open-only',
    notes: '1 open; never hedge',
    hedgeMode: 'never',
  },
  {
    hedgeId: 'hedge-asap',
    notes: 'Pair-Path V0 style: hedge when opp ≤ hedgeAskMax + avgSum ok',
    hedgeMode: 'asap',
  },
  {
    hedgeId: 'hedge-ptb',
    notes:
      'Hedge only after favorable leave ≥ ptbLeaveUsd and dist ≤ approach',
    hedgeMode: 'ptb',
  },
];

function buildBaseParams(openLeaveUsd) {
  return {
    openShares: PRIMARY_SHARES,
    maxEventNotional: Math.max(60, PRIMARY_SHARES * 1.15),
    openAskLo: 0.52,
    openAskHi: 0.62,
    openTrigger: 0.55,
    openCap: 0.02,
    openBookSumMin: 0.95,
    openBookSumMax: 1.05,
    tauOpenMin: 40,
    tauOpenMax: 240,
    maxOpenAttempts: 3,
    maxHedgeAttempts: 8,
    maxSignalGapMs: 1250,
    latencyTicks: LATENCY_TICKS,
    openConfirmationTicks: OPEN_CONFIRM,
    hedgeAskMax: 0.42,
    avgSumMax: 0.96,
    hedgeLevels: null,
    escapes: [],
    ptbLeaveUsd: PTB_LEAVE_USD,
    ptbApproachUsd: PTB_APPROACH_USD,
    openLeaveUsd,
  };
}

const OPEN_LEAVE_LEVELS = RUN_GRID
  ? [0, 20, 30, 40]
  : [OPEN_LEAVE_USD];

const VARIANTS = OPEN_LEAVE_LEVELS.flatMap((openLeaveUsd) =>
  HEDGE_POLICIES.map((policy) => ({
    ...buildBaseParams(openLeaveUsd),
    ...policy,
    id:
      openLeaveUsd > 0
        ? `${policy.hedgeId}|leave${openLeaveUsd}`
        : policy.hedgeId,
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

function projectedAvgSum(state, side, price, shares) {
  const leg = state.inv[side];
  const other = side === 'UP' ? 'DOWN' : 'UP';
  const otherAvg = average(state, other);
  if (otherAvg == null || shares <= 0) return null;
  const nextAvg = (leg.cost + price * shares) / (leg.shares + shares);
  return nextAvg + otherAvg;
}

function signedFavorableDist(tick, sideOpen) {
  if (
    !Number.isFinite(tick.underlyingPrice) ||
    !Number.isFinite(tick.priceToBeat)
  ) {
    return null;
  }
  const raw = tick.underlyingPrice - tick.priceToBeat;
  return sideOpen === 'UP' ? raw : -raw;
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
    maxFavorableDist: 0,
    ptbArmed: false,
    ptbArmedTau: null,
    hedgeGateBlocked: 0,
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
    const dist = signedFavorableDist(tick, order.side);
    if (dist != null) state.maxFavorableDist = Math.max(0, dist);
    // Already far from PTB at fill → arm leave immediately for hedge-ptb.
    if (state.maxFavorableDist >= state.params.ptbLeaveUsd - 1e-9) {
      state.ptbArmed = true;
      state.ptbArmedTau = tick.tau;
    }
    return;
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
  const spotDist = signedFavorableDist(tick, side);
  const spotOk =
    (p.openLeaveUsd || 0) <= 0 ||
    (spotDist != null && spotDist >= p.openLeaveUsd - 1e-9);
  const eligible =
    spotOk &&
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

function updatePtbTracker(state, tick) {
  if (state.mode !== 'opened' || !state.sideOpen) return;
  const dist = signedFavorableDist(tick, state.sideOpen);
  if (dist == null) return;
  if (dist > state.maxFavorableDist) state.maxFavorableDist = dist;
  if (
    !state.ptbArmed &&
    state.maxFavorableDist >= state.params.ptbLeaveUsd - 1e-9
  ) {
    state.ptbArmed = true;
    state.ptbArmedTau = tick.tau;
  }
}

function hedgeAllowedByMode(state, tick) {
  const mode = state.params.hedgeMode;
  if (mode === 'never') return false;
  if (mode === 'asap') return true;
  // ptb: need leave arm + current distance back within approach band
  if (!state.ptbArmed) return false;
  const dist = signedFavorableDist(tick, state.sideOpen);
  if (dist == null) return false;
  return dist <= state.params.ptbApproachUsd + 1e-9;
}

function scheduleHedge(state, tick, tickIndex) {
  const p = state.params;
  if (
    state.mode !== 'opened' ||
    state.pending ||
    state.hedgeAttempts >= p.maxHedgeAttempts ||
    p.hedgeMode === 'never'
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

  if (!hedgeAllowedByMode(state, tick)) {
    // Still track when price gate would have fired but PTB gate blocked.
    if (
      p.hedgeMode === 'ptb' &&
      ask <= p.hedgeAskMax + 1e-12
    ) {
      state.hedgeGateBlocked += 1;
    }
    return;
  }

  if (ask > p.hedgeAskMax + 1e-12) return;
  const projected = projectedAvgSum(state, side, ask, sharesNeeded);
  if (
    projected == null ||
    projected > p.avgSumMax + 1e-12 ||
    invested(state) + ask * sharesNeeded > p.maxEventNotional + 1e-9
  ) {
    return;
  }

  state.hedgeAttempts += 1;
  state.pending = {
    kind: 'hedge',
    side,
    shares: sharesNeeded,
    limitPrice: ask,
    signalTau: tick.tau,
    executeAt: tickIndex + p.latencyTicks,
    ptbArmed: state.ptbArmed,
    maxFavorableDist: state.maxFavorableDist,
    distAtSignal: signedFavorableDist(tick, state.sideOpen),
  };
}

/**
 * Market path after open — walks the FULL tick series (ignore early equalize exit).
 * Uses leave/approach thresholds from CLI so arms share the same buckets.
 */
function classifyPath(ticks, sideOpen, openTau) {
  if (!sideOpen) {
    return {
      leftFar: false,
      approached: false,
      flippedVsOpen: false,
      maxFavorableDistMarket: 0,
      pathClass: 'no_open',
    };
  }
  let maxFav = 0;
  let minFavorableAfterLeave = Infinity;
  let sawLeave = false;
  for (const tick of ticks) {
    if (openTau != null && tick.tau > openTau + 1e-9) continue; // only post-open (tau decreases)
    const dist = signedFavorableDist(tick, sideOpen);
    if (dist == null) continue;
    if (dist > maxFav) maxFav = dist;
    if (dist >= PTB_LEAVE_USD - 1e-9) sawLeave = true;
    if (sawLeave && dist < minFavorableAfterLeave) {
      minFavorableAfterLeave = dist;
    }
  }
  const leftFar = maxFav >= PTB_LEAVE_USD - 1e-9;
  const approached =
    leftFar &&
    Number.isFinite(minFavorableAfterLeave) &&
    minFavorableAfterLeave <= PTB_APPROACH_USD + 1e-9;
  const last = ticks[ticks.length - 1];
  const finalDist = signedFavorableDist(last, sideOpen);
  const flippedVsOpen = finalDist != null ? finalDist < 0 : false;
  let pathClass = 'other';
  if (leftFar && !approached) pathClass = 'no_return';
  else if (approached && flippedVsOpen) pathClass = 'return_flip';
  else if (approached && !flippedVsOpen) pathClass = 'return_hold';
  else if (!leftFar) pathClass = 'never_left';
  return {
    leftFar,
    approached,
    flippedVsOpen,
    maxFavorableDistMarket: maxFav,
    minFavorableAfterLeave: Number.isFinite(minFavorableAfterLeave)
      ? minFavorableAfterLeave
      : null,
    pathClass,
  };
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
    updatePtbTracker(state, tick);
    scheduleHedge(state, tick, index);
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
  const path = classifyPath(ticks, state.sideOpen, state.firstOpenTau);
  const openSideWon =
    state.sideOpen != null && winner != null
      ? state.sideOpen === winner
      : null;

  return {
    eventKey,
    mode: state.mode,
    sideOpen: state.sideOpen,
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
    openSideWon,
    realizedPnl,
    guardedRealizedPnl:
      realizedPnl != null ? realizedPnl - buffer : null,
    fills: state.fills.length,
    hedgeFills: state.fills.filter((fill) => fill.kind === 'hedge').length,
    partialOrders: state.partialOrders,
    depthMisses: state.depthMisses,
    firstOpenTau: state.firstOpenTau,
    equalizedTau: state.equalizedTau,
    hedgeSeconds:
      state.firstOpenTau != null && state.equalizedTau != null
        ? state.firstOpenTau - state.equalizedTau
        : null,
    maxFavorableDist: state.maxFavorableDist,
    ptbArmed: state.ptbArmed,
    ptbArmedTau: state.ptbArmedTau,
    hedgeGateBlocked: state.hedgeGateBlocked,
    ...path,
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

function sumPnl(rows) {
  return rows.reduce(
    (sum, row) =>
      sum + (row.guardedRealizedPnl != null ? row.guardedRealizedPnl : 0),
    0,
  );
}

function summarize(rows) {
  const opened = rows.filter((row) => row.opened);
  const equalized = opened.filter((row) => row.equalized);
  const residualRows = opened.filter((row) => !row.equalized);
  const resolved = opened.filter((row) => row.guardedRealizedPnl != null);
  const realizedPnls = resolved.map((row) => row.guardedRealizedPnl);
  const losses = realizedPnls.filter((pnl) => pnl < 0);
  const wins = realizedPnls.filter((pnl) => pnl > 0);
  const grossProfit = wins.reduce((sum, pnl) => sum + pnl, 0);
  const grossLoss = losses.reduce((sum, pnl) => sum + Math.abs(pnl), 0);

  const byClass = {};
  for (const cls of [
    'never_left',
    'no_return',
    'return_hold',
    'return_flip',
    'other',
  ]) {
    const subset = opened.filter((row) => row.pathClass === cls);
    const subsetResolved = subset.filter(
      (row) => row.guardedRealizedPnl != null,
    );
    byClass[cls] = {
      opened: subset.length,
      equalized: subset.filter((row) => row.equalized).length,
      resolved: subsetResolved.length,
      realizedPnl: Math.round(sumPnl(subsetResolved) * 1000) / 1000,
      worst:
        subsetResolved.length > 0
          ? Math.round(
              Math.min(...subsetResolved.map((r) => r.guardedRealizedPnl)) *
                1000,
            ) / 1000
          : null,
    };
  }

  return {
    events: rows.length,
    opened: opened.length,
    equalized: equalized.length,
    residual: residualRows.length,
    equalizeRatePct: opened.length
      ? Math.round((equalized.length / opened.length) * 10000) / 100
      : null,
    resolved: resolved.length,
    guardedRealizedPnl: Math.round(sumPnl(resolved) * 1000) / 1000,
    realizedPerOpen:
      resolved.length > 0
        ? Math.round((sumPnl(resolved) / resolved.length) * 10000) / 10000
        : null,
    worstRealized: realizedPnls.length
      ? Math.round(Math.min(...realizedPnls) * 1000) / 1000
      : null,
    p5Loss:
      losses.length > 0
        ? Math.round(quantile(losses, 0.05) * 1000) / 1000
        : null,
    realizedProfitFactor:
      grossLoss > 0
        ? Math.round((grossProfit / grossLoss) * 1000) / 1000
        : grossProfit > 0
          ? 'Infinity'
          : 0,
    avgSumP50: quantile(
      equalized.map((row) => row.avgSum).filter(Number.isFinite),
      0.5,
    ),
    netPairCostP50: quantile(
      equalized.map((row) => row.netPairCost).filter(Number.isFinite),
      0.5,
    ),
    hedgeSecondsP50: quantile(
      equalized.map((row) => row.hedgeSeconds).filter(Number.isFinite),
      0.5,
    ),
    ptbArmedOpens: opened.filter((row) => row.ptbArmed).length,
    hedgeGateBlockedTicks: opened.reduce(
      (sum, row) => sum + (row.hedgeGateBlocked || 0),
      0,
    ),
    invested: Math.round(opened.reduce((s, r) => s + r.invested, 0) * 100) / 100,
    fees: Math.round(opened.reduce((s, r) => s + r.fees, 0) * 1000) / 1000,
    byPathClass: byClass,
  };
}

function listDays() {
  return fs
    .readdirSync(LAKE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('dt='))
    .map((entry) => entry.name.slice(3))
    .filter((day) => day >= FROM && day <= TO)
    .sort();
}

function pad(s, n) {
  return String(s).padEnd(n);
}

function fmt(n, digits = 2) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toFixed(digits);
}

async function main() {
  const days = listDays();
  if (!days.length) {
    throw new Error(
      `no lake days in ${FROM}..${TO} under ${LAKE}. Run: npm run lake:update-btc-5m`,
    );
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const variants = VARIANTS;

  console.log('=== PTB-protect A/B (depth-25 lake) ===');
  console.log(
    `window=${FROM}..${TO} days=${days.length} shares=${PRIMARY_SHARES}` +
      ` armLeave=$${PTB_LEAVE_USD} approach=$${PTB_APPROACH_USD}` +
      ` openLeave=[${OPEN_LEAVE_LEVELS.join(',')}]` +
      ` hedgeAskMax=0.42 avgSumMax=0.96 variants=${variants.length}`,
  );
  console.log(
    'arms=open-only | hedge-asap | hedge-ptb · fee=0.07 · no maker/EQ/escape',
  );

  const db = await DuckDBInstance.create(':memory:');
  const connection = await db.connect();
  await connection.run('SET threads TO 6');

  const results = new Map(variants.map((v) => [v.id, []]));
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
      for (const variant of variants) {
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
      (dayIndex + 1) % 5 === 0
    ) {
      console.log(
        `[${dayIndex + 1}/${days.length}] ${day} eligible=${eligibleEvents}`,
      );
    }
  }

  const reportVariants = variants.map((variant) => {
    const rows = results.get(variant.id);
    return {
      id: variant.id,
      hedgeId: variant.hedgeId,
      notes: variant.notes,
      hedgeMode: variant.hedgeMode,
      params: {
        openShares: variant.openShares,
        openLeaveUsd: variant.openLeaveUsd,
        hedgeAskMax: variant.hedgeAskMax,
        avgSumMax: variant.avgSumMax,
        ptbLeaveUsd: variant.ptbLeaveUsd,
        ptbApproachUsd: variant.ptbApproachUsd,
        latencyTicks: variant.latencyTicks,
        openConfirmationTicks: variant.openConfirmationTicks,
      },
      summary: summarize(rows),
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    window: { from: FROM, to: TO, days: days.length },
    dataset: 'backtest_ticks BTC 5m depth25',
    feeRate: FEE_RATE,
    operationalBufferPerPair: OPERATIONAL_BUFFER_PER_PAIR,
    eligibleEvents,
    skippedCoverage,
    openLeaveLevels: OPEN_LEAVE_LEVELS,
    hypothesis:
      'Open only when already away from PTB; delay hedge until approach; cut flip damage without killing jackpots',
    variants: reportVariants,
  };

  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify(report, null, 2),
  );

  console.log('');
  console.log(
    pad('arm', 22) +
      pad('open', 12) +
      pad('eq%', 8) +
      pad('realized', 12) +
      pad('worst', 10) +
      pad('PF', 8) +
      pad('avgSumP50', 10),
  );
  for (const v of reportVariants) {
    const s = v.summary;
    console.log(
      pad(v.id, 22) +
        pad(`${s.opened}/${s.events}`, 12) +
        pad(fmt(s.equalizeRatePct, 1), 8) +
        pad(fmt(s.guardedRealizedPnl, 2), 12) +
        pad(fmt(s.worstRealized, 2), 10) +
        pad(String(s.realizedProfitFactor), 8) +
        pad(fmt(s.avgSumP50, 3), 10),
    );
  }

  console.log('');
  console.log(
    'by pathClass (realized PnL) — only / ptb / asap per openLeave:',
  );
  for (const openLeave of OPEN_LEAVE_LEVELS) {
    const suffix = openLeave > 0 ? `|leave${openLeave}` : '';
    const only = reportVariants.find((v) => v.id === `open-only${suffix}`);
    const ptbV = reportVariants.find((v) => v.id === `hedge-ptb${suffix}`);
    const asapV = reportVariants.find((v) => v.id === `hedge-asap${suffix}`);
    if (!only || !ptbV || !asapV) continue;
    console.log(`  openLeave=$${openLeave}`);
    for (const cls of [
      'return_flip',
      'no_return',
      'return_hold',
      'never_left',
    ]) {
      const o = only.summary.byPathClass[cls];
      const p = ptbV.summary.byPathClass[cls];
      const a = asapV.summary.byPathClass[cls];
      console.log(
        `    ${cls}: only=${fmt(o.realizedPnl, 2)}(n=${o.opened})` +
          ` | ptb=${fmt(p.realizedPnl, 2)}(eq=${p.equalized})` +
          ` | asap=${fmt(a.realizedPnl, 2)}(eq=${a.equalized})`,
      );
    }
  }

  for (const openLeave of OPEN_LEAVE_LEVELS) {
    const suffix = openLeave > 0 ? `|leave${openLeave}` : '';
    const openOnlyRows = results.get(`open-only${suffix}`);
    const asapRows = results.get(`hedge-asap${suffix}`);
    const ptbRows = results.get(`hedge-ptb${suffix}`);
    if (!openOnlyRows || !asapRows || !ptbRows) continue;
    const aligned = [];
    for (let i = 0; i < openOnlyRows.length; i += 1) {
      const a = openOnlyRows[i];
      const b = asapRows[i];
      const c = ptbRows[i];
      if (!a.opened) continue;
      aligned.push({
        day: a.day,
        eventKey: a.eventKey,
        pathClass: a.pathClass,
        openOnly: a.guardedRealizedPnl,
        asap: b.guardedRealizedPnl,
        ptb: c.guardedRealizedPnl,
        equalized: {
          openOnly: a.equalized,
          asap: b.equalized,
          ptb: c.equalized,
        },
      });
    }
    const name =
      openLeave > 0
        ? `aligned-opens-leave${openLeave}.json`
        : 'aligned-opens.json';
    fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(aligned, null, 2));
  }

  console.log('');
  console.log('saved', path.join(OUT_DIR, 'report.json'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
