#!/usr/bin/env node
/**
 * TSC -> flatten / conservative hybrid protection lab.
 *
 * Research only:
 * - no network;
 * - no credentials;
 * - no order endpoints;
 * - all signals execute on later recorded snapshots;
 * - 5-share FAK execution walks recorded ask/bid depth;
 * - partial fills and misses are retained.
 *
 * Windows:
 * - discovery: 2026-04-23..2026-06-30
 * - temporal validation: 2026-07-01..2026-07-28 (NOT clean)
 * - requested day: 2026-07-29 (reported separately, never used to rank)
 */
import crypto from 'node:crypto';
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
const WINNER_CSV = path.join(ROOT, 'scratch/canonical-outcomes-v1.csv');
const FEE_RATE = 0.07;
const SIZE = 5;
const MIN_ORDER_SHARES = 5;
const DEPTH_LEVELS = 5;
const OTHER = { UP: 'DOWN', DOWN: 'UP' };

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const OUTPUT_TAG = String(arg('tag', 'tsc-flatten-protection')).replace(
  /[^a-zA-Z0-9._-]/g,
  '_',
);
const OUT_DIR = path.join(ROOT, '.tmp', OUTPUT_TAG);
const FROM = arg('from', '2026-04-23');
const TO = arg('to', '2026-07-29');
const DISCOVERY_FROM = arg('discoveryFrom', '2026-04-23');
const DISCOVERY_TO = arg('discoveryTo', '2026-06-30');
const VALIDATION_FROM = arg('validationFrom', '2026-07-01');
const VALIDATION_TO = arg('validationTo', '2026-07-28');
const REQUESTED_DAY = arg('requestedDay', '2026-07-29');
const BOOTSTRAP_SAMPLES = Math.max(100, Number(arg('bootstrapSamples', 2000)));

const r4 = (value) =>
  Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : null;
const r2 = (value) =>
  Number.isFinite(value) ? Math.round(value * 100) / 100 : null;

export function takerFee(price, shares = 1) {
  const p = Math.min(0.99, Math.max(0.01, Number(price)));
  return FEE_RATE * p * (1 - p) * Number(shares);
}

function normalizedLevels(levels, direction) {
  return (levels ?? [])
    .map((level) => ({ px: Number(level?.px), size: Number(level?.size) }))
    .filter((level) => level.px > 0 && level.size > 0)
    .sort((left, right) =>
      direction === 'buy' ? left.px - right.px : right.px - left.px,
    );
}

/**
 * FAK book walk. For BUY, prices must be <= limit. For SELL, prices must be
 * >= limit. Any partial quantity is final and retained.
 */
export function walkBook(levels, requestedQty, limitPrice, direction) {
  let remaining = Math.max(0, Number(requestedQty));
  let notional = 0;
  const fills = [];
  for (const level of normalizedLevels(levels, direction)) {
    if (!(remaining > 1e-12)) break;
    const marketable =
      direction === 'buy'
        ? level.px <= Number(limitPrice) + 1e-12
        : level.px + 1e-12 >= Number(limitPrice);
    if (!marketable) break;
    const qty = Math.min(remaining, level.size);
    fills.push({ px: level.px, qty });
    notional += level.px * qty;
    remaining -= qty;
  }
  const filledQty = Math.max(0, Number(requestedQty) - remaining);
  return {
    direction,
    requestedQty: Number(requestedQty),
    filledQty,
    remaining,
    notional,
    vwap: filledQty > 0 ? notional / filledQty : null,
    full: remaining <= 1e-12,
    fills,
  };
}

export function walkAsk(levels, requestedQty, limitPrice) {
  return walkBook(levels, requestedQty, limitPrice, 'buy');
}

export function walkBid(levels, requestedQty, limitPrice) {
  return walkBook(levels, requestedQty, limitPrice, 'sell');
}

function loadWinners() {
  const lines = fs.readFileSync(WINNER_CSV, 'utf8').trim().split(/\r?\n/);
  const header = lines.shift().split(',');
  const conditionIndex = header.indexOf('condition_id');
  const winnerIndex = header.indexOf('winner');
  return new Map(
    lines.filter(Boolean).map((line) => {
      const cells = line.split(',');
      return [cells[conditionIndex], cells[winnerIndex]];
    }),
  );
}

function listDays() {
  return fs
    .readdirSync(LAKE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('dt='))
    .map((entry) => entry.name.slice(3))
    .filter((day) => day >= FROM && day <= TO)
    .sort();
}

function levelsFromRow(row, side, book) {
  const prefix = side === 'UP' ? 'up' : 'down';
  const levels = [];
  for (let level = 1; level <= DEPTH_LEVELS; level += 1) {
    levels.push({
      px: Number(row[`${prefix}_${book}_px_${level}`]),
      size: Number(row[`${prefix}_${book}_sz_${level}`]),
    });
  }
  return levels;
}

function enrichTicks(ticks, volLookback = 90) {
  const normalizedVariance = [];
  for (let index = 1; index < ticks.length; index += 1) {
    const dt = ticks[index].ts - ticks[index - 1].ts;
    if (!(dt > 0) || !(ticks[index].spot > 0) || !(ticks[index - 1].spot > 0)) {
      continue;
    }
    const logReturn = Math.log(ticks[index].spot / ticks[index - 1].spot);
    normalizedVariance.push({
      ts: ticks[index].ts,
      value: (logReturn * logReturn) / dt,
    });
  }
  let varianceIndex = 0;
  let sum = 0;
  let count = 0;
  const window = [];
  return ticks.map((tick) => {
    while (
      varianceIndex < normalizedVariance.length &&
      normalizedVariance[varianceIndex].ts <= tick.ts
    ) {
      const item = normalizedVariance[varianceIndex];
      window.push(item);
      sum += item.value;
      count += 1;
      varianceIndex += 1;
    }
    while (window.length && window[0].ts < tick.ts - volLookback) {
      sum -= window[0].value;
      count -= 1;
      window.shift();
    }
    const sigmaMove =
      count >= 20 && tick.tau > 0
        ? tick.spot * Math.sqrt(sum / count) * Math.sqrt(tick.tau)
        : null;
    const raw = tick.spot - tick.ptb;
    return {
      ...tick,
      sigmaMove,
      zUp: sigmaMove > 0 ? raw / sigmaMove : null,
      zDown: sigmaMove > 0 ? -raw / sigmaMove : null,
    };
  });
}

const ENTRY_CONFIGS = [
  {
    id: 'tsc-a70-lat1-slip1',
    tauLo: 3,
    tauHi: 12,
    zMin: 2,
    askLo: 0.7,
    askHi: 0.925,
    latencyTicks: 1,
    slipCents: 1,
  },
  {
    id: 'tsc-a80-lat1-slip1',
    tauLo: 3,
    tauHi: 12,
    zMin: 2,
    askLo: 0.8,
    askHi: 0.925,
    latencyTicks: 1,
    slipCents: 1,
  },
  {
    id: 'tsc-z1-a80-lat1-slip1',
    tauLo: 5,
    tauHi: 15,
    zMin: 1,
    askLo: 0.8,
    askHi: 0.925,
    latencyTicks: 1,
    slipCents: 1,
  },
];

const ACTION_MODES = ['flatten', 'pair', 'hybrid'];
const TRIGGERS = [
  { id: 'always', kind: 'always', mtmCeilingPerShare: null },
  { id: 'spot-z-lt1', kind: 'spot_z_lt_1', mtmCeilingPerShare: null },
  { id: 'spot-z-lt0', kind: 'spot_z_lt_0', mtmCeilingPerShare: null },
  { id: 'book-flip', kind: 'book_flip', mtmCeilingPerShare: null },
  { id: 'spot-or-book', kind: 'spot_or_book', mtmCeilingPerShare: null },
  { id: 'mtm-le0', kind: 'mtm', mtmCeilingPerShare: 0 },
  { id: 'mtm-le-m03', kind: 'mtm', mtmCeilingPerShare: -0.03 },
  { id: 'risk-any-m03', kind: 'risk_any', mtmCeilingPerShare: -0.03 },
];
const ACTION_FLOORS = [0, -0.02, -0.05, -0.08, -0.1, -0.15, -0.2];
const PROTECTION_LATENCIES = [1, 2];

function floorId(value) {
  return value === 0 ? '0' : `m${Math.round(Math.abs(value) * 100)}`;
}

function variants() {
  const rows = [];
  for (const entry of ENTRY_CONFIGS) {
    rows.push({
      id: `${entry.id}|unprotected`,
      entry,
      protection: null,
    });
    for (const actionMode of ACTION_MODES) {
      for (const trigger of TRIGGERS) {
        for (const actionFloorPerShare of ACTION_FLOORS) {
          for (const latencyTicks of PROTECTION_LATENCIES) {
            rows.push({
              id:
                `${entry.id}|${actionMode}|${trigger.id}` +
                `|floor-${floorId(actionFloorPerShare)}|lat${latencyTicks}`,
              entry,
              protection: {
                actionMode,
                trigger,
                actionFloorPerShare,
                latencyTicks,
                slipCents: 1,
                maxAttempts: 2,
              },
            });
          }
        }
      }
    }
  }
  return rows;
}

export function findEntry(ticks, config) {
  for (let index = 0; index < ticks.length; index += 1) {
    const tick = ticks[index];
    if (tick.tau > config.tauHi || tick.tau < config.tauLo) continue;
    const side = tick.upAsk >= tick.downAsk ? 'UP' : 'DOWN';
    const ask = side === 'UP' ? tick.upAsk : tick.downAsk;
    const z = side === 'UP' ? tick.zUp : tick.zDown;
    if (!(ask >= config.askLo && ask < config.askHi) || !(z >= config.zMin)) {
      continue;
    }
    const executionIndex = index + Math.max(1, config.latencyTicks);
    if (executionIndex >= ticks.length) {
      return { status: 'miss', reason: 'event_ended', signalIndex: index };
    }
    const execution = ticks[executionIndex];
    const limit = ask + config.slipCents / 100;
    const fill = walkAsk(execution.books[side].asks, SIZE, limit);
    if (!(fill.filledQty > 0)) {
      return { status: 'miss', reason: 'fak_no_fill', signalIndex: index };
    }
    return {
      status: 'fill',
      side,
      signalIndex: index,
      executionIndex,
      signalAsk: ask,
      signalZ: z,
      limit,
      fill,
    };
  }
  return { status: 'none' };
}

function entryEconomics(entry) {
  const qty = entry.fill.filledQty;
  const cost = entry.fill.notional;
  const fees = takerFee(entry.fill.vwap, qty);
  return { qty, cost, fees };
}

/**
 * Score one action using only the protection signal snapshot.
 * A candidate is admissible only if five shares can be fully walked at signal.
 */
export function estimateAction(tick, entry, action, slipCents = 1) {
  const economics = entryEconomics(entry);
  if (economics.qty < MIN_ORDER_SHARES - 1e-12) {
    return { action, admissible: false, reason: 'below_min_order' };
  }
  if (action === 'flatten') {
    const signalBid = tick.books[entry.side].bestBid;
    if (!(signalBid > 0)) {
      return { action, admissible: false, reason: 'missing_bid' };
    }
    const limit = Math.max(0.01, signalBid - slipCents / 100);
    const fill = walkBid(tick.books[entry.side].bids, economics.qty, limit);
    if (!fill.full) {
      return {
        action,
        admissible: false,
        reason: 'insufficient_signal_bid_depth',
        signalFilledQty: fill.filledQty,
      };
    }
    const exitFee = takerFee(fill.vwap, fill.filledQty);
    const worstCasePnl = fill.notional - exitFee - economics.cost - economics.fees;
    return {
      action,
      admissible: true,
      side: entry.side,
      direction: 'sell',
      signalPrice: signalBid,
      limit,
      signalFill: fill,
      estimatedWorstCasePnl: worstCasePnl,
      estimatedWorstCasePerShare: worstCasePnl / economics.qty,
    };
  }
  if (action === 'pair') {
    const opposite = OTHER[entry.side];
    const signalAsk = tick.books[opposite].bestAsk;
    if (!(signalAsk > 0)) {
      return { action, admissible: false, reason: 'missing_opposite_ask' };
    }
    const limit = Math.min(0.99, signalAsk + slipCents / 100);
    const fill = walkAsk(tick.books[opposite].asks, economics.qty, limit);
    if (!fill.full) {
      return {
        action,
        admissible: false,
        reason: 'insufficient_signal_ask_depth',
        signalFilledQty: fill.filledQty,
      };
    }
    const hedgeFee = takerFee(fill.vwap, fill.filledQty);
    const netCashOut = economics.cost + economics.fees + fill.notional + hedgeFee;
    const worstCasePnl = Math.min(economics.qty, fill.filledQty) - netCashOut;
    return {
      action,
      admissible: true,
      side: opposite,
      direction: 'buy',
      signalPrice: signalAsk,
      limit,
      signalFill: fill,
      estimatedWorstCasePnl: worstCasePnl,
      estimatedWorstCasePerShare: worstCasePnl / economics.qty,
    };
  }
  throw new Error(`Unknown protection action: ${action}`);
}

/**
 * Conservative selection maximizes the signal-snapshot worst-case floor.
 * Equal scores prefer flatten because it removes inventory and settlement risk.
 */
export function chooseConservativeAction(tick, entry, protection) {
  const actions =
    protection.actionMode === 'hybrid'
      ? ['flatten', 'pair']
      : [protection.actionMode];
  const candidates = actions
    .map((action) => estimateAction(tick, entry, action, protection.slipCents))
    .filter(
      (candidate) =>
        candidate.admissible &&
        candidate.estimatedWorstCasePerShare + 1e-12 >=
          protection.actionFloorPerShare,
    )
    .sort((left, right) => {
      const score =
        right.estimatedWorstCasePerShare - left.estimatedWorstCasePerShare;
      if (Math.abs(score) > 1e-12) return score;
      return left.action === 'flatten' ? -1 : 1;
    });
  return candidates[0] ?? null;
}

function triggerSatisfied(tick, entry, trigger, flattenEstimate) {
  const sideZ = entry.side === 'UP' ? tick.zUp : tick.zDown;
  const bookFavourite = tick.upAsk >= tick.downAsk ? 'UP' : 'DOWN';
  const spotLt0 = Number.isFinite(sideZ) && sideZ < 0;
  const bookFlip = bookFavourite !== entry.side;
  const mtmBelow =
    flattenEstimate?.admissible &&
    Number.isFinite(trigger.mtmCeilingPerShare) &&
    flattenEstimate.estimatedWorstCasePerShare <=
      trigger.mtmCeilingPerShare + 1e-12;
  if (trigger.kind === 'always') return true;
  if (trigger.kind === 'spot_z_lt_1') return Number.isFinite(sideZ) && sideZ < 1;
  if (trigger.kind === 'spot_z_lt_0') return spotLt0;
  if (trigger.kind === 'book_flip') return bookFlip;
  if (trigger.kind === 'spot_or_book') return spotLt0 || bookFlip;
  if (trigger.kind === 'mtm') return mtmBelow;
  if (trigger.kind === 'risk_any') return spotLt0 || bookFlip || mtmBelow;
  return false;
}

function executeCandidate(tick, candidate, qty) {
  if (candidate.action === 'flatten') {
    return walkBid(tick.books[candidate.side].bids, qty, candidate.limit);
  }
  return walkAsk(tick.books[candidate.side].asks, qty, candidate.limit);
}

/**
 * Protection signal is strictly after entry execution. Protection execution is
 * strictly after its signal. A zero-fill FAK may re-signal once; partial fills
 * are retained and terminate the path because the remainder is below size 5.
 */
export function applyProtection(ticks, entry, protection) {
  if (!protection || entry.status !== 'fill') {
    return { attempted: false, attempts: [], fill: null, reason: 'unprotected' };
  }
  if (entry.fill.filledQty < MIN_ORDER_SHARES - 1e-12) {
    return {
      attempted: false,
      attempts: [],
      fill: null,
      reason: 'entry_partial_below_min_order',
    };
  }
  const attempts = [];
  let scanFrom = entry.executionIndex + 1;
  while (attempts.length < protection.maxAttempts) {
    let signalled = false;
    for (let signalIndex = scanFrom; signalIndex < ticks.length; signalIndex += 1) {
      const signalTick = ticks[signalIndex];
      const flattenEstimate = estimateAction(
        signalTick,
        entry,
        'flatten',
        protection.slipCents,
      );
      if (!triggerSatisfied(signalTick, entry, protection.trigger, flattenEstimate)) {
        continue;
      }
      const candidate = chooseConservativeAction(signalTick, entry, protection);
      if (!candidate) continue;
      signalled = true;
      const executionIndex =
        signalIndex + Math.max(1, Number(protection.latencyTicks));
      if (executionIndex >= ticks.length) {
        attempts.push({
          signalIndex,
          executionIndex,
          action: candidate.action,
          candidate,
          fill: null,
          reason: 'event_ended',
        });
        return {
          attempted: true,
          attempts,
          action: candidate.action,
          fill: null,
          reason: 'event_ended',
        };
      }
      const fill = executeCandidate(
        ticks[executionIndex],
        candidate,
        entry.fill.filledQty,
      );
      const attempt = {
        signalIndex,
        executionIndex,
        action: candidate.action,
        candidate,
        fill: fill.filledQty > 0 ? fill : null,
        reason:
          fill.filledQty <= 0
            ? 'fak_no_fill'
            : fill.full
              ? 'filled'
              : 'partial_fill',
      };
      attempts.push(attempt);
      if (fill.filledQty > 0) {
        return {
          attempted: true,
          attempts,
          action: candidate.action,
          signalIndex,
          executionIndex,
          candidate,
          fill,
          reason: fill.full ? 'filled' : 'partial_fill',
        };
      }
      scanFrom = executionIndex + 1;
      break;
    }
    if (!signalled) {
      return {
        attempted: attempts.length > 0,
        attempts,
        fill: null,
        reason: attempts.length ? 'retry_no_qualifying_signal' : 'no_qualifying_signal',
      };
    }
  }
  return {
    attempted: attempts.length > 0,
    attempts,
    fill: null,
    reason: 'attempts_exhausted',
  };
}

export function settlePath(entry, protectionResult, winner) {
  const economics = entryEconomics(entry);
  const action = protectionResult?.fill ? protectionResult.action : null;
  const protectionFill = protectionResult?.fill;
  let payoutIfEntryWins = economics.qty;
  let payoutIfOppositeWins = 0;
  let netCashOut = economics.cost + economics.fees;
  let protectionFees = 0;
  let residualQty = economics.qty;
  let flattenedQty = 0;
  let pairedQty = 0;

  if (action === 'flatten') {
    flattenedQty = protectionFill.filledQty;
    protectionFees = takerFee(protectionFill.vwap, flattenedQty);
    netCashOut -= protectionFill.notional - protectionFees;
    payoutIfEntryWins = Math.max(0, economics.qty - flattenedQty);
    payoutIfOppositeWins = 0;
    residualQty = payoutIfEntryWins;
  } else if (action === 'pair') {
    pairedQty = protectionFill.filledQty;
    protectionFees = takerFee(protectionFill.vwap, pairedQty);
    netCashOut += protectionFill.notional + protectionFees;
    payoutIfEntryWins = economics.qty;
    payoutIfOppositeWins = pairedQty;
    residualQty = Math.abs(economics.qty - pairedQty);
  }

  const payout =
    winner === entry.side ? payoutIfEntryWins : payoutIfOppositeWins;
  const pnl = payout - netCashOut;
  return {
    pnl,
    action,
    entryQty: economics.qty,
    entryVwap: entry.fill.vwap,
    protectionQty: protectionFill?.filledQty ?? 0,
    protectionVwap: protectionFill?.vwap ?? null,
    flattenedQty,
    pairedQty,
    netCashOut,
    fees: economics.fees + protectionFees,
    residualQty,
    worstCasePnl: Math.min(payoutIfEntryWins, payoutIfOppositeWins) - netCashOut,
    fullEntry: entry.fill.full,
    fullProtection: protectionFill ? protectionFill.full : false,
  };
}

function emptyAccumulator() {
  return {
    events: 0,
    signals: 0,
    entryMisses: 0,
    filledEvents: 0,
    partialEntries: 0,
    entryQty: 0,
    protectionAttempts: 0,
    protectionAttemptMisses: 0,
    protectedEvents: 0,
    partialProtections: 0,
    fullProtections: 0,
    flattenEvents: 0,
    pairEvents: 0,
    unprotectedReasons: new Map(),
    actionChoices: new Map(),
    residualEvents: 0,
    residualQty: 0,
    maxResidualQty: 0,
    riskBreaches: 0,
    pnl: [],
    worstCase: [],
    byDay: new Map(),
  };
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function record(accumulator, day, entry, path) {
  accumulator.events += 1;
  if (entry.status === 'none') return;
  accumulator.signals += 1;
  if (entry.status === 'miss') {
    accumulator.entryMisses += 1;
    return;
  }
  accumulator.filledEvents += 1;
  accumulator.entryQty += path.settlement.entryQty;
  if (!path.settlement.fullEntry) accumulator.partialEntries += 1;
  accumulator.protectionAttempts += path.protection.attempts?.length ?? 0;
  accumulator.protectionAttemptMisses +=
    path.protection.attempts?.filter((attempt) => !attempt.fill).length ?? 0;
  for (const attempt of path.protection.attempts ?? []) {
    increment(accumulator.actionChoices, attempt.action);
  }
  if (path.settlement.protectionQty > 0) {
    accumulator.protectedEvents += 1;
    if (path.settlement.fullProtection) accumulator.fullProtections += 1;
    else accumulator.partialProtections += 1;
    if (path.settlement.action === 'flatten') accumulator.flattenEvents += 1;
    if (path.settlement.action === 'pair') accumulator.pairEvents += 1;
  } else {
    increment(accumulator.unprotectedReasons, path.protection.reason ?? 'none');
  }
  if (path.settlement.residualQty > 1e-12) {
    accumulator.residualEvents += 1;
    accumulator.residualQty += path.settlement.residualQty;
    accumulator.maxResidualQty = Math.max(
      accumulator.maxResidualQty,
      path.settlement.residualQty,
    );
  }
  if (path.settlement.worstCasePnl < -0.5 - 1e-12) {
    accumulator.riskBreaches += 1;
  }
  accumulator.pnl.push(path.settlement.pnl);
  accumulator.worstCase.push(path.settlement.worstCasePnl);
  if (!accumulator.byDay.has(day)) accumulator.byDay.set(day, []);
  accumulator.byDay.get(day).push(path.settlement.pnl);
}

function seededRandom(seedText) {
  let state = 2166136261;
  for (const char of seedText) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state = Math.imul(state, 1664525) + 1013904223;
    return (state >>> 0) / 4294967296;
  };
}

function bootstrapDays(byDay, seedText, samples = BOOTSTRAP_SAMPLES) {
  const dayTotals = [...byDay.values()].map((values) =>
    values.reduce((sum, value) => sum + value, 0),
  );
  if (!dayTotals.length) return { samples, p05: null, p50: null, p95: null };
  const random = seededRandom(seedText);
  const totals = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let draw = 0; draw < dayTotals.length; draw += 1) {
      total += dayTotals[Math.floor(random() * dayTotals.length)];
    }
    totals.push(total);
  }
  totals.sort((a, b) => a - b);
  return {
    samples,
    p05: r4(totals[Math.floor(samples * 0.05)]),
    p50: r4(totals[Math.floor(samples * 0.5)]),
    p95: r4(totals[Math.floor(samples * 0.95)]),
  };
}

function summarize(accumulator, seedText) {
  const grossProfit = accumulator.pnl
    .filter((value) => value > 0)
    .reduce((sum, value) => sum + value, 0);
  const grossLoss = accumulator.pnl
    .filter((value) => value < 0)
    .reduce((sum, value) => sum + Math.abs(value), 0);
  const totalPnl = accumulator.pnl.reduce((sum, value) => sum + value, 0);
  const byDayTotals = [...accumulator.byDay.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, values]) => ({
      day,
      pnl: r4(values.reduce((sum, value) => sum + value, 0)),
      fills: values.length,
    }));
  return {
    events: accumulator.events,
    signals: accumulator.signals,
    entryMisses: accumulator.entryMisses,
    filledEvents: accumulator.filledEvents,
    fillRatePct: r2(
      (100 * accumulator.filledEvents) /
        Math.max(1, accumulator.filledEvents + accumulator.entryMisses),
    ),
    partialEntries: accumulator.partialEntries,
    entryQty: r4(accumulator.entryQty),
    protectionAttempts: accumulator.protectionAttempts,
    protectionAttemptMisses: accumulator.protectionAttemptMisses,
    protectedEvents: accumulator.protectedEvents,
    fullProtections: accumulator.fullProtections,
    partialProtections: accumulator.partialProtections,
    flattenEvents: accumulator.flattenEvents,
    pairEvents: accumulator.pairEvents,
    actionChoices: Object.fromEntries(
      [...accumulator.actionChoices.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    unprotectedReasons: Object.fromEntries(
      [...accumulator.unprotectedReasons.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    residualEvents: accumulator.residualEvents,
    residualPct: r2(
      (100 * accumulator.residualEvents) / Math.max(1, accumulator.filledEvents),
    ),
    residualQty: r4(accumulator.residualQty),
    avgResidualQty: r4(
      accumulator.residualQty / Math.max(1, accumulator.residualEvents),
    ),
    maxResidualQty: r4(accumulator.maxResidualQty),
    riskBreaches: accumulator.riskBreaches,
    totalPnl: r4(totalPnl),
    pnlPerEvent: r4(totalPnl / Math.max(1, accumulator.events)),
    pnlPerFilledEvent: r4(totalPnl / Math.max(1, accumulator.filledEvents)),
    pnlPerEntryShare: r4(totalPnl / Math.max(1, accumulator.entryQty)),
    profitFactor: grossLoss > 0 ? r4(grossProfit / grossLoss) : 'Infinity',
    worstRealized: accumulator.pnl.length ? r4(Math.min(...accumulator.pnl)) : null,
    worstCaseMin: accumulator.worstCase.length
      ? r4(Math.min(...accumulator.worstCase))
      : null,
    positiveDays: byDayTotals.filter((row) => row.pnl > 0).length,
    activeDays: byDayTotals.length,
    bootstrap: bootstrapDays(accumulator.byDay, seedText),
    byDay: byDayTotals,
  };
}

function windowForDay(day) {
  if (day >= DISCOVERY_FROM && day <= DISCOVERY_TO) return 'discovery';
  if (day >= VALIDATION_FROM && day <= VALIDATION_TO) return 'validation';
  if (day === REQUESTED_DAY) return 'requestedDay';
  return null;
}

function renderMarkdown(report) {
  const topRows = report.top
    .slice(0, 30)
    .map(
      (row) =>
        `| \`${row.id}\` | ${row.discovery.totalPnl} | ${row.discovery.profitFactor} | ` +
        `${row.discovery.bootstrap.p05} | ${row.discovery.worstCaseMin} | ` +
        `${row.discovery.residualPct}% | ${row.validation.totalPnl} | ` +
        `${row.validation.profitFactor} | ${row.validation.bootstrap.p05} | ` +
        `${row.validation.worstCaseMin} | ${row.requestedDay.totalPnl} | ` +
        `${row.requestedDay.worstCaseMin} |`,
    )
    .join('\n');
  const byMode = Object.entries(report.bestDiscoveryByActionMode)
    .map(([mode, row]) =>
      row
        ? `- ${mode}: \`${row.id}\` — discovery PnL ${row.discovery.totalPnl}, PF ${row.discovery.profitFactor}, bootstrap p05 ${row.discovery.bootstrap.p05}, worst-case ${row.discovery.worstCaseMin}; validation PnL ${row.validation.totalPnl}; day29 ${row.requestedDay.totalPnl}.`
        : `- ${mode}: no filled variant.`,
    )
    .join('\n');
  return `# TSC flatten / conservative hybrid protection

Generated: ${report.generatedAt}

- Variants: ${report.variants}
- Discovery risk-gated: ${report.funnel.discoveryRiskGated}
- Positive in discovery and temporal validation: ${report.funnel.positiveBoth}
- Passed every research gate: ${report.funnel.survivors}
- Live authorization: **none**

July 1–28 is temporal validation but **not a clean holdout**. TSC, July, and the
prior TSC→Clip failure were inspected before this grid. Day 29 is isolated and
never used to rank variants.

## Execution contract

- entry signal snapshot → entry FAK on a later snapshot;
- protection signal strictly after entry execution;
- protection FAK on another later snapshot, latency >= 1 tick;
- BUY walks recorded asks; SELL/flatten walks recorded bids;
- size 5, 1-cent FAK limit, taker fee on entry and protection;
- partial fills retained, zero-fill misses retained;
- hybrid chooses the larger signal-snapshot worst-case floor; ties prefer flatten;
- at most two causal attempts, and only a zero-fill can retry.

Action floors per share: ${report.grid.actionFloors.join(', ')}.
MTM trigger ceilings per share: ${report.grid.mtmTriggerCeilings.join(', ')}.

## Best discovery-ranked variant by action mode

${byMode}

## Top discovery-ranked variants

| Variant | Disc PnL | Disc PF | Disc boot p05 | Disc worst | Disc residual | Val PnL | Val PF | Val boot p05 | Val worst | Day29 PnL | Day29 worst |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${topRows || '| none | | | | | | | | | | | |'}

## Research gates

- discovery filled events >= 100;
- discovery PnL > 0, PF > 1, day-bootstrap p05 > 0;
- discovery worst-case >= -$0.50 per event and zero risk breaches;
- discovery residual events <= 5%;
- temporal validation PnL > 0, PF > 1, bootstrap p05 > 0 and worst-case >= -$0.50;
- day 29 PnL > 0 and worst-case >= -$0.50;
- passing is research evidence only, never live authorization.
`;
}

function sourceHash() {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(fileURLToPath(import.meta.url)))
    .digest('hex');
}

async function main() {
  const winners = loadWinners();
  const days = listDays();
  const policies = variants();
  const grouped = new Map(
    ENTRY_CONFIGS.map((entry) => [
      entry.id,
      policies.filter((policy) => policy.entry.id === entry.id),
    ]),
  );
  const accumulators = new Map(
    policies.map((policy) => [
      policy.id,
      {
        discovery: emptyAccumulator(),
        validation: emptyAccumulator(),
        requestedDay: emptyAccumulator(),
      },
    ]),
  );
  const db = await DuckDBInstance.create(':memory:');
  const connection = await db.connect();
  await connection.run('SET threads TO 6');

  const depthSelect = ['up', 'down']
    .flatMap((side) =>
      ['ask', 'bid'].flatMap((book) =>
        Array.from({ length: DEPTH_LEVELS }, (_, index) => index + 1).flatMap(
          (level) => [
            `${side}_${book}_px_${level}`,
            `${side}_${book}_sz_${level}`,
          ],
        ),
      ),
    )
    .join(', ');
  let eligibleEvents = 0;

  for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
    const day = days[dayIndex];
    const window = windowForDay(day);
    if (!window) continue;
    const directory = path.join(LAKE, `dt=${day}`);
    const files = fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.parquet'))
      .map((name) => path.join(directory, name));
    if (!files.length) continue;
    const parquet = `[${files.map((file) => quotedString(file)).join(',')}]`;
    const rows = (
      await connection.runAndReadAll(`
        SELECT condition_id,
          epoch(try_cast(event_start AS TIMESTAMPTZ))::BIGINT AS ev,
          epoch(try_cast(ts AS TIMESTAMPTZ))::DOUBLE AS ts_epoch,
          extract(epoch FROM (
            try_cast(event_end AS TIMESTAMPTZ) - try_cast(ts AS TIMESTAMPTZ)
          ))::DOUBLE AS tau,
          up_best_bid, up_best_ask, down_best_bid, down_best_ask,
          underlying_price, price_to_beat,
          ${depthSelect}
        FROM read_parquet(${parquet})
        WHERE coverage >= 0.99 AND coalesce(degraded, false) = false
          AND up_best_bid IS NOT NULL AND up_best_ask IS NOT NULL
          AND down_best_bid IS NOT NULL AND down_best_ask IS NOT NULL
          AND underlying_price IS NOT NULL AND price_to_beat IS NOT NULL
        QUALIFY row_number() OVER (
          PARTITION BY condition_id, event_start, ts ORDER BY coverage DESC
        ) = 1
        ORDER BY condition_id, ev, tau DESC
      `)
    ).getRowObjectsJS();

    let key = null;
    let conditionId = null;
    let ticks = [];
    const flush = () => {
      if (!ticks.length || ticks[0].tau < 240) return;
      const winner = winners.get(conditionId);
      if (!winner) return;
      eligibleEvents += 1;
      const enriched = enrichTicks(ticks);
      for (const entryConfig of ENTRY_CONFIGS) {
        const entry = findEntry(enriched, entryConfig);
        for (const policy of grouped.get(entryConfig.id)) {
          const protection = applyProtection(enriched, entry, policy.protection);
          const path =
            entry.status === 'fill'
              ? {
                  protection,
                  settlement: settlePath(entry, protection, winner),
                }
              : null;
          record(accumulators.get(policy.id)[window], day, entry, path);
        }
      }
      ticks = [];
    };

    for (const row of rows) {
      const rowKey = `${row.condition_id}:${row.ev}`;
      if (key !== null && rowKey !== key) {
        flush();
        ticks = [];
      }
      key = rowKey;
      conditionId = row.condition_id;
      const makeBook = (side) => {
        const prefix = side === 'UP' ? 'up' : 'down';
        return {
          bestBid: Number(row[`${prefix}_best_bid`]),
          bestAsk: Number(row[`${prefix}_best_ask`]),
          bids: levelsFromRow(row, side, 'bid'),
          asks: levelsFromRow(row, side, 'ask'),
        };
      };
      ticks.push({
        ts: Number(row.ts_epoch),
        tau: Number(row.tau),
        upAsk: Number(row.up_best_ask),
        downAsk: Number(row.down_best_ask),
        spot: Number(row.underlying_price),
        ptb: Number(row.price_to_beat),
        books: {
          UP: makeBook('UP'),
          DOWN: makeBook('DOWN'),
        },
      });
    }
    flush();
    if ((dayIndex + 1) % 10 === 0 || dayIndex === days.length - 1) {
      console.log(`[${dayIndex + 1}/${days.length}] ${day} events=${eligibleEvents}`);
    }
  }

  const evaluations = policies.map((policy) => {
    const accumulator = accumulators.get(policy.id);
    const discovery = summarize(accumulator.discovery, `${policy.id}:discovery`);
    const validation = summarize(accumulator.validation, `${policy.id}:validation`);
    const requestedDay = summarize(
      accumulator.requestedDay,
      `${policy.id}:requested`,
    );
    const discoveryRiskGated =
      discovery.filledEvents >= 100 &&
      discovery.totalPnl > 0 &&
      Number(discovery.profitFactor) > 1 &&
      discovery.bootstrap.p05 > 0 &&
      discovery.worstCaseMin >= -0.5 &&
      discovery.riskBreaches === 0 &&
      discovery.residualPct <= 5;
    const positiveBoth =
      discovery.totalPnl > 0 &&
      Number(discovery.profitFactor) > 1 &&
      validation.totalPnl > 0 &&
      Number(validation.profitFactor) > 1;
    const passes =
      discoveryRiskGated &&
      validation.totalPnl > 0 &&
      Number(validation.profitFactor) > 1 &&
      validation.bootstrap.p05 > 0 &&
      validation.worstCaseMin >= -0.5 &&
      requestedDay.totalPnl > 0 &&
      requestedDay.worstCaseMin >= -0.5;
    return {
      id: policy.id,
      entry: policy.entry,
      protection: policy.protection,
      discovery,
      validation,
      requestedDay,
      discoveryRiskGated,
      positiveBoth,
      passes,
    };
  });

  // Selection/ranking uses discovery only. Validation and day 29 are displayed,
  // but never enter the ordering score.
  evaluations.sort((left, right) => {
    if (left.discoveryRiskGated !== right.discoveryRiskGated) {
      return left.discoveryRiskGated ? -1 : 1;
    }
    const leftPf = Number(left.discovery.profitFactor);
    const rightPf = Number(right.discovery.profitFactor);
    if (left.discovery.totalPnl !== right.discovery.totalPnl) {
      return right.discovery.totalPnl - left.discovery.totalPnl;
    }
    return rightPf - leftPf;
  });

  const bestDiscoveryByActionMode = {};
  for (const mode of ['unprotected', ...ACTION_MODES]) {
    bestDiscoveryByActionMode[mode] =
      evaluations.find((row) =>
        mode === 'unprotected'
          ? row.protection === null
          : row.protection?.actionMode === mode,
      ) ?? null;
  }
  const report = {
    generatedAt: new Date().toISOString(),
    sourceSha256: sourceHash(),
    model: {
      size: SIZE,
      minimumOrderShares: MIN_ORDER_SHARES,
      depthLevels: DEPTH_LEVELS,
      feeRate: FEE_RATE,
      orderType: 'FAK',
      entry: 'TSC signal then later-snapshot ask-depth execution',
      protection:
        'later signal chooses flatten SELL and/or opposite BUY by estimated worst-case; later FAK execution',
      retry: 'one re-signal allowed only after a zero-fill attempt',
      outcomes: 'Gamma-resolved research labels; not CLOB/on-chain finality',
      networkCalls: false,
      credentialsRead: false,
      liveOrders: false,
    },
    windows: {
      discovery: { from: DISCOVERY_FROM, to: DISCOVERY_TO },
      validation: {
        from: VALIDATION_FROM,
        to: VALIDATION_TO,
        cleanHoldout: false,
        note: 'TSC and July were inspected before this experiment.',
      },
      requestedDay: {
        day: REQUESTED_DAY,
        usedForRanking: false,
      },
    },
    selection: {
      rankingUses: 'discovery only',
      validationUse: 'temporal audit, not clean holdout',
      requestedDayUse: 'separate report only',
    },
    grid: {
      entryConfigs: ENTRY_CONFIGS,
      actionModes: ACTION_MODES,
      triggers: TRIGGERS,
      actionFloors: ACTION_FLOORS,
      mtmTriggerCeilings: TRIGGERS.map((trigger) => trigger.mtmCeilingPerShare)
        .filter(Number.isFinite)
        .filter((value, index, all) => all.indexOf(value) === index),
      protectionLatencies: PROTECTION_LATENCIES,
      bootstrapSamples: BOOTSTRAP_SAMPLES,
    },
    eligibleEvents,
    variants: evaluations.length,
    funnel: {
      discoveryRiskGated: evaluations.filter((row) => row.discoveryRiskGated)
        .length,
      positiveBoth: evaluations.filter((row) => row.positiveBoth).length,
      survivors: evaluations.filter((row) => row.passes).length,
    },
    survivors: evaluations.filter((row) => row.passes),
    bestDiscoveryByActionMode,
    top: evaluations.slice(0, 50),
    all: evaluations,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), renderMarkdown(report));
  console.log(JSON.stringify(report.funnel, null, 2));
  console.log('saved', path.join(OUT_DIR, 'report.json'));
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

