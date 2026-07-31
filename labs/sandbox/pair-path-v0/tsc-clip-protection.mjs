#!/usr/bin/env node
/**
 * TSC -> Clip-Path protection lab.
 *
 * Research only. It never calls an order endpoint.
 *
 * Entry:
 *   - causal TSC signal;
 *   - execution on a later snapshot;
 *   - 5-share FAK limit, walking recorded depth and retaining partial fills.
 *
 * Protection:
 *   - at most one opposite-leg FAK attempt on a later snapshot;
 *   - optional spot/book risk trigger;
 *   - only attempts when the contemporaneous fee-adjusted complete-set PnL is
 *     above a configured floor;
 *   - execution again happens on a later snapshot and walks recorded depth.
 *
 * Windows:
 *   discovery: 2026-04-23..2026-06-30
 *   temporal validation (not a clean holdout): 2026-07-01..2026-07-28
 *   requested day: 2026-07-29
 *
 * Usage:
 *   node labs/sandbox/pair-path-v0/tsc-clip-protection.mjs
 *   node labs/sandbox/pair-path-v0/tsc-clip-protection.mjs --from=2026-07-29 --to=2026-07-29
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
const WINNER_CSV = path.join(ROOT, 'scratch/canonical-outcomes-v1.csv');
const FEE_RATE = 0.07;
const SIZE = 5;
const DEPTH_LEVELS = 5;
const OTHER = { UP: 'DOWN', DOWN: 'UP' };

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const OUTPUT_TAG = String(arg('tag', 'tsc-clip-protection')).replace(
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

const r4 = (value) =>
  Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : null;
const r2 = (value) =>
  Number.isFinite(value) ? Math.round(value * 100) / 100 : null;

export function takerFee(price, shares = 1) {
  const p = Math.min(0.99, Math.max(0.01, Number(price)));
  return FEE_RATE * p * (1 - p) * shares;
}

/**
 * Walk recorded asks up to a FAK limit. Partial quantity is retained.
 */
export function walkAsk(levels, requestedQty, limitPrice) {
  let remaining = Math.max(0, Number(requestedQty));
  let cost = 0;
  const fills = [];
  for (const level of levels ?? []) {
    const px = Number(level?.px);
    const size = Number(level?.size);
    if (!(remaining > 1e-12)) break;
    if (!(px > 0) || !(size > 0)) continue;
    if (px > Number(limitPrice) + 1e-12) break;
    const qty = Math.min(remaining, size);
    fills.push({ px, qty });
    cost += px * qty;
    remaining -= qty;
  }
  const filledQty = Math.max(0, Number(requestedQty) - remaining);
  return {
    requestedQty: Number(requestedQty),
    filledQty,
    remaining,
    cost,
    vwap: filledQty > 0 ? cost / filledQty : null,
    full: remaining <= 1e-12,
    fills,
  };
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

function levelsFromRow(row, side) {
  const prefix = side === 'UP' ? 'up' : 'down';
  const levels = [];
  for (let level = 1; level <= DEPTH_LEVELS; level += 1) {
    levels.push({
      px: Number(row[`${prefix}_ask_px_${level}`]),
      size: Number(row[`${prefix}_ask_sz_${level}`]),
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

const TRIGGERS = ['always', 'spot_z_lt_1', 'spot_z_lt_0', 'book_flip', 'spot_or_book'];
const LOCK_FLOORS = [0, -0.01, -0.02, -0.03, -0.05, -0.08];
const HEDGE_LATENCIES = [1, 2];

function variants() {
  const rows = [];
  for (const entry of ENTRY_CONFIGS) {
    rows.push({
      id: `${entry.id}|unprotected`,
      entry,
      protection: null,
    });
    for (const trigger of TRIGGERS) {
      for (const floor of LOCK_FLOORS) {
        for (const latencyTicks of HEDGE_LATENCIES) {
          rows.push({
            id: `${entry.id}|${trigger}-floor${floor}-lat${latencyTicks}`,
            entry,
            protection: {
              trigger,
              lockFloorPerShare: floor,
              latencyTicks,
              slipCents: 1,
            },
          });
        }
      }
    }
  }
  return rows;
}

function findEntry(ticks, config) {
  for (let index = 0; index < ticks.length; index += 1) {
    const tick = ticks[index];
    if (tick.tau > config.tauHi || tick.tau < config.tauLo) continue;
    const side = tick.upAsk >= tick.downAsk ? 'UP' : 'DOWN';
    const ask = side === 'UP' ? tick.upAsk : tick.downAsk;
    const z = side === 'UP' ? tick.zUp : tick.zDown;
    if (!(ask >= config.askLo && ask < config.askHi) || !(z >= config.zMin)) {
      continue;
    }
    const executionIndex = index + config.latencyTicks;
    if (executionIndex >= ticks.length) {
      return { status: 'miss', reason: 'event_ended', signalIndex: index };
    }
    const execution = ticks[executionIndex];
    const limit = ask + config.slipCents / 100;
    const fill = walkAsk(execution.asks[side], SIZE, limit);
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

function triggerSatisfied(tick, entrySide, trigger) {
  const sideZ = entrySide === 'UP' ? tick.zUp : tick.zDown;
  const bookFavourite = tick.upAsk >= tick.downAsk ? 'UP' : 'DOWN';
  if (trigger === 'always') return true;
  if (trigger === 'spot_z_lt_1') return Number.isFinite(sideZ) && sideZ < 1;
  if (trigger === 'spot_z_lt_0') return Number.isFinite(sideZ) && sideZ < 0;
  if (trigger === 'book_flip') return bookFavourite !== entrySide;
  if (trigger === 'spot_or_book') {
    return (Number.isFinite(sideZ) && sideZ < 0) || bookFavourite !== entrySide;
  }
  return false;
}

/**
 * Apply at most one opposite-leg protection attempt.
 */
export function applyProtection(ticks, entry, protection) {
  if (!protection || entry.status !== 'fill') {
    return { attempted: false, fill: null };
  }
  // A partial below the observed five-share minimum cannot be hedged by a new
  // opposite order of the same size.
  if (entry.fill.filledQty < SIZE - 1e-12) {
    return { attempted: false, fill: null, reason: 'residual_below_minimum' };
  }
  const opposite = OTHER[entry.side];
  for (let index = entry.executionIndex + 1; index < ticks.length; index += 1) {
    const tick = ticks[index];
    if (!triggerSatisfied(tick, entry.side, protection.trigger)) continue;
    const signalAsk = opposite === 'UP' ? tick.upAsk : tick.downAsk;
    if (!(signalAsk > 0)) continue;
    const estimated = walkAsk(
      tick.asks[opposite],
      entry.fill.filledQty,
      signalAsk + protection.slipCents / 100,
    );
    if (!estimated.full) continue;
    const estimatedNetPerShare =
      1 -
      entry.fill.vwap -
      estimated.vwap -
      takerFee(entry.fill.vwap) -
      takerFee(estimated.vwap);
    if (estimatedNetPerShare + 1e-12 < protection.lockFloorPerShare) continue;

    const executionIndex = index + protection.latencyTicks;
    if (executionIndex >= ticks.length) {
      return {
        attempted: true,
        signalIndex: index,
        executionIndex,
        fill: null,
        reason: 'event_ended',
      };
    }
    const limit = signalAsk + protection.slipCents / 100;
    const fill = walkAsk(
      ticks[executionIndex].asks[opposite],
      entry.fill.filledQty,
      limit,
    );
    return {
      attempted: true,
      signalIndex: index,
      executionIndex,
      opposite,
      signalAsk,
      limit,
      estimatedNetPerShare,
      fill: fill.filledQty > 0 ? fill : null,
      reason: fill.filledQty > 0 ? null : 'fak_no_fill',
    };
  }
  return { attempted: false, fill: null, reason: 'no_qualifying_protection' };
}

export function settlePath(entry, protectionResult, winner) {
  const entryQty = entry.fill.filledQty;
  const entryCost = entry.fill.cost;
  const entryFees = takerFee(entry.fill.vwap, entryQty);
  const hedge = protectionResult?.fill;
  const hedgeQty = hedge?.filledQty ?? 0;
  const hedgeCost = hedge?.cost ?? 0;
  const hedgeFees = hedgeQty > 0 ? takerFee(hedge.vwap, hedgeQty) : 0;
  const opposite = OTHER[entry.side];
  const payout =
    (winner === entry.side ? entryQty : 0) +
    (winner === opposite ? hedgeQty : 0);
  const totalCost = entryCost + entryFees + hedgeCost + hedgeFees;
  const pnl = payout - totalCost;
  const payoutIfEntryWins = entryQty;
  const payoutIfOppositeWins = hedgeQty;
  return {
    pnl,
    entryQty,
    hedgeQty,
    entryVwap: entry.fill.vwap,
    hedgeVwap: hedge?.vwap ?? null,
    totalCost,
    fees: entryFees + hedgeFees,
    residualQty: Math.abs(entryQty - hedgeQty),
    worstCasePnl: Math.min(payoutIfEntryWins, payoutIfOppositeWins) - totalCost,
    fullEntry: entry.fill.full,
    fullHedge: hedge ? hedge.full : false,
  };
}

function emptyAccumulator() {
  return {
    events: 0,
    signals: 0,
    misses: 0,
    filledEvents: 0,
    partialEntries: 0,
    entryQty: 0,
    hedgeAttempts: 0,
    hedgedEvents: 0,
    partialHedges: 0,
    residualEvents: 0,
    protectionReasons: new Map(),
    pnl: [],
    worstCase: [],
    byDay: new Map(),
  };
}

function record(accumulator, day, entry, path) {
  accumulator.events += 1;
  if (entry.status === 'none') return;
  accumulator.signals += 1;
  if (entry.status === 'miss') {
    accumulator.misses += 1;
    return;
  }
  const protectionReason =
    path.protection.reason ??
    (path.protection.fill ? 'filled' : path.protection.attempted ? 'attempted' : 'none');
  accumulator.protectionReasons.set(
    protectionReason,
    (accumulator.protectionReasons.get(protectionReason) ?? 0) + 1,
  );
  accumulator.filledEvents += 1;
  accumulator.entryQty += path.settlement.entryQty;
  if (!path.settlement.fullEntry) accumulator.partialEntries += 1;
  if (path.protection.attempted) accumulator.hedgeAttempts += 1;
  if (path.settlement.hedgeQty > 0) accumulator.hedgedEvents += 1;
  if (path.settlement.hedgeQty > 0 && !path.settlement.fullHedge) {
    accumulator.partialHedges += 1;
  }
  if (path.settlement.residualQty > 1e-12) accumulator.residualEvents += 1;
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

function bootstrapDays(byDay, seedText, samples = 3000) {
  const days = [...byDay.keys()];
  if (!days.length) return { p05: null, p50: null, p95: null };
  const random = seededRandom(seedText);
  const totals = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let draw = 0; draw < days.length; draw += 1) {
      const values = byDay.get(days[Math.floor(random() * days.length)]);
      total += values.reduce((sum, value) => sum + value, 0);
    }
    totals.push(total);
  }
  totals.sort((a, b) => a - b);
  return {
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
    misses: accumulator.misses,
    filledEvents: accumulator.filledEvents,
    fillRatePct: r2(
      (100 * accumulator.filledEvents) /
        Math.max(1, accumulator.filledEvents + accumulator.misses),
    ),
    partialEntries: accumulator.partialEntries,
    entryQty: r4(accumulator.entryQty),
    hedgeAttempts: accumulator.hedgeAttempts,
    hedgedEvents: accumulator.hedgedEvents,
    partialHedges: accumulator.partialHedges,
    residualEvents: accumulator.residualEvents,
    residualPct: r2(
      (100 * accumulator.residualEvents) / Math.max(1, accumulator.filledEvents),
    ),
    protectionReasons: Object.fromEntries(
      [...accumulator.protectionReasons.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
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
  const rows = report.top
    .slice(0, 30)
    .map(
      (row) =>
        `| \`${row.id}\` | ${row.discovery.totalPnl} | ${row.discovery.profitFactor} | ` +
        `${row.discovery.worstCaseMin} | ${row.validation.totalPnl} | ` +
        `${row.validation.profitFactor} | ${row.validation.worstCaseMin} | ` +
        `${row.requestedDay.totalPnl} |`,
    )
    .join('\n');
  return `# TSC -> Clip-Path protection lab

Generated: ${report.generatedAt}

- Variants: ${report.variants}
- Discovery risk-gated: ${report.funnel.discoveryRiskGated}
- Positive in discovery and temporal validation: ${report.funnel.positiveBoth}
- Passed every research gate: ${report.funnel.survivors}

The July window is temporal validation, not a clean holdout: TSC and July were
already inspected before this hybrid was built.

| Variant | Disc PnL | Disc PF | Disc worst-case | Val PnL | Val PF | Val worst-case | Day 29 PnL |
|---|---:|---:|---:|---:|---:|---:|---:|
${rows || '| none | | | | | | | |'}

## Gates

- execution only on later snapshots;
- 5-share FAK with recorded depth walk and partial-fill accounting;
- discovery PnL > 0, PF > 1 and day-bootstrap p05 > 0;
- worst-case inventory PnL >= -0.50 per event;
- validation PnL > 0, PF > 1 and bootstrap p05 > 0;
- positive requested day;
- no live-order authorization.
`;
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
      Array.from({ length: DEPTH_LEVELS }, (_, index) => index + 1).flatMap(
        (level) => [
          `${side}_ask_px_${level}`,
          `${side}_ask_sz_${level}`,
        ],
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
          up_best_ask, down_best_ask, underlying_price, price_to_beat,
          ${depthSelect}
        FROM read_parquet(${parquet})
        WHERE coverage >= 0.99 AND coalesce(degraded, false) = false
          AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
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
          const protection = applyProtection(
            enriched,
            entry,
            policy.protection,
          );
          const path =
            entry.status === 'fill'
              ? {
                  protection,
                  settlement: settlePath(entry, protection, winner),
                }
              : null;
          record(
            accumulators.get(policy.id)[window],
            day,
            entry,
            path,
          );
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
      ticks.push({
        ts: Number(row.ts_epoch),
        tau: Number(row.tau),
        upAsk: Number(row.up_best_ask),
        downAsk: Number(row.down_best_ask),
        spot: Number(row.underlying_price),
        ptb: Number(row.price_to_beat),
        asks: {
          UP: levelsFromRow(row, 'UP'),
          DOWN: levelsFromRow(row, 'DOWN'),
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
      discovery.worstCaseMin >= -0.5;
    const positiveBoth =
      discovery.totalPnl > 0 &&
      Number(discovery.profitFactor) > 1 &&
      validation.totalPnl > 0 &&
      Number(validation.profitFactor) > 1;
    const passes =
      discoveryRiskGated &&
      validation.bootstrap.p05 > 0 &&
      requestedDay.totalPnl > 0;
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

  evaluations.sort((left, right) => {
    if (left.passes !== right.passes) return left.passes ? -1 : 1;
    if (left.positiveBoth !== right.positiveBoth) return left.positiveBoth ? -1 : 1;
    const leftScore =
      left.discovery.totalPnl +
      left.validation.totalPnl +
      left.requestedDay.totalPnl;
    const rightScore =
      right.discovery.totalPnl +
      right.validation.totalPnl +
      right.requestedDay.totalPnl;
    return rightScore - leftScore;
  });

  const report = {
    generatedAt: new Date().toISOString(),
    model: {
      size: SIZE,
      entry: 'TSC signal, later-snapshot FAK, recorded depth walk',
      protection:
        'at most one later-snapshot opposite FAK, recorded depth walk',
      outcomes:
        'Gamma-resolved research labels; not complete CLOB/on-chain finality',
      liveOrders: false,
    },
    windows: {
      discovery: { from: DISCOVERY_FROM, to: DISCOVERY_TO },
      validation: {
        from: VALIDATION_FROM,
        to: VALIDATION_TO,
        cleanHoldout: false,
      },
      requestedDay: REQUESTED_DAY,
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
