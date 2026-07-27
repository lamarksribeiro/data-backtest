/**
 * Validação severa da hipótese nova do HANDOFF:
 *   lead_bid40 -> vende lado velho e, se o ask oposto ainda estiver barato,
 *   compra o novo líder.
 *
 * Diferenças do harness exploratório:
 * - outcome resolvido Gamma/Polymarket;
 * - nenhum filtro retrospectivo de consenso do book final;
 * - entrada, saída e reversão varrem depth 25;
 * - atraso configurável entre sinal e execução.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = 'D:/Projetos/projeto-goldenlens/data-backtest';
const BASE = path.join(ROOT, 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25');
const GAMMA_CSV = path.join(ROOT, 'scratch/gamma-outcomes.csv');
const OUT_CSV = path.join(ROOT, 'scratch/reverse-latency-canonical.csv');
const OUT_JSON = path.join(ROOT, 'scratch/reverse-latency-canonical.json');
const BUDGET = 10;
const SETTLE = 0.995;
const DELAYS = [0, 0.5, 1, 2];
const MAX_ASKS = [0.65, 0.68, 0.70, 0.72, 0.78, 1.01];
const feePerShare = (price) => 0.07 * price * (1 - price);

function parseCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const header = lines.shift().split(',');
  return lines.filter(Boolean).map((line) => {
    const values = line.split(',');
    return Object.fromEntries(header.map((key, index) => [key, values[index] ?? '']));
  });
}

function maxDrawdown(pnls) {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

function levelsAt(tick, side, kind) {
  const prefix = side === 1 ? 'up' : 'down';
  const levels = [];
  for (let level = 1; level <= 25; level += 1) {
    const price = tick[`${prefix}_${kind}_px_${level}`];
    const size = tick[`${prefix}_${kind}_sz_${level}`];
    if (price != null && size != null && size > 0) {
      levels.push({ price: Number(price), size: Number(size) });
    }
  }
  levels.sort((a, b) => kind === 'bid' ? b.price - a.price : a.price - b.price);
  return levels;
}

function sweep(levels, targetShares) {
  let remaining = targetShares;
  let notional = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const taken = Math.min(remaining, level.size);
    notional += taken * level.price;
    remaining -= taken;
  }
  const filled = targetShares - remaining;
  return {
    filled,
    average: filled > 0 ? notional / filled : 0,
  };
}

const winnerByEvent = new Map(
  parseCsv(GAMMA_CSV).map((row) => [new Date(row.event_start).toISOString(), Number(row.winner)]),
);
const variants = [
  { name: 'hold', delay: null, maxAsk: null },
  ...DELAYS.flatMap((delay) => [
    { name: `exit_delay${String(delay).replace('.', 'p')}`, delay, maxAsk: null },
    ...MAX_ASKS.map((maxAsk) => ({
      name: `reverse${Math.round(maxAsk * 100)}_delay${String(delay).replace('.', 'p')}`,
      delay,
      maxAsk,
    })),
  ]),
];
const trades = [];

function runEvent(ticks, day, eventStart) {
  const winner = winnerByEvent.get(eventStart);
  if (winner == null || ticks.length < 100) return;
  const last = ticks.at(-1);
  const ptb = last.ptb;
  if (!(ptb > 0)) return;
  const duration = last.t;
  const entryTarget = duration - 30;
  let entryIndex = -1;
  for (let index = ticks.length - 1; index >= 0; index -= 1) {
    if (ticks[index].t <= entryTarget) {
      entryIndex = index;
      break;
    }
  }
  if (entryIndex < 30) return;
  const entryTick = ticks[entryIndex];
  if ([entryTick.ub, entryTick.ua, entryTick.db, entryTick.da].some((value) => value == null)) return;
  const entryDistance = entryTick.spot - ptb;
  if (entryDistance === 0) return;
  const side = entryDistance > 0 ? 1 : -1;
  const bestAsk = side === 1 ? entryTick.ua : entryTick.da;
  if (!(bestAsk > 0.5 && bestAsk <= 0.94)) return;

  const entry = sweep(levelsAt(entryTick, side, 'ask'), BUDGET / bestAsk);
  if (!(entry.filled > 0)) return;
  const entryCost = entry.filled * entry.average;
  const entryFee = feePerShare(entry.average) * entry.filled;
  const holdPnl = (side === winner ? entry.filled * SETTLE : 0) - entryCost - entryFee;

  let signalIndex = null;
  let signalSecondsLeft = null;
  for (let index = entryIndex + 1; index < ticks.length; index += 1) {
    const tick = ticks[index];
    if ([tick.ub, tick.ua, tick.db, tick.da].some((value) => value == null)) continue;
    const secondsLeft = duration - tick.t;
    if (secondsLeft < 2) break;
    const distance = tick.spot - ptb;
    const leader = distance > 0 ? 1 : distance < 0 ? -1 : side;
    const ownBid = side === 1 ? tick.ub : tick.db;
    if (leader !== side && ownBid < 0.40) {
      signalIndex = index;
      signalSecondsLeft = secondsLeft;
      break;
    }
  }

  const pnls = [holdPnl];
  const reversed = [false];
  const executionSecondsLeft = [null];
  const executionOppAsk = [null];

  for (const variant of variants.slice(1)) {
    if (signalIndex == null) {
      pnls.push(holdPnl);
      reversed.push(false);
      executionSecondsLeft.push(null);
      executionOppAsk.push(null);
      continue;
    }
    const signalTime = ticks[signalIndex].t;
    let executionTick = null;
    let secondsLeft = null;
    for (let index = signalIndex; index < ticks.length; index += 1) {
      if (ticks[index].t >= signalTime + variant.delay) {
        secondsLeft = duration - ticks[index].t;
        if (secondsLeft >= 2) executionTick = ticks[index];
        break;
      }
    }
    if (!executionTick) {
      pnls.push(holdPnl);
      reversed.push(false);
      executionSecondsLeft.push(secondsLeft);
      executionOppAsk.push(null);
      continue;
    }

    const sold = sweep(levelsAt(executionTick, side, 'bid'), entry.filled);
    const oldRemaining = entry.filled - sold.filled;
    const saleProceeds = sold.filled * sold.average;
    const exitFee = sold.filled > 0 ? feePerShare(sold.average) * sold.filled : 0;
    const oldPayout = side === winner ? oldRemaining * SETTLE : 0;
    const exitOnlyPnl = saleProceeds + oldPayout - entryCost - entryFee - exitFee;

    if (variant.maxAsk == null || !(saleProceeds > 0.5)) {
      pnls.push(exitOnlyPnl);
      reversed.push(false);
      executionSecondsLeft.push(secondsLeft);
      executionOppAsk.push(null);
      continue;
    }

    const opposite = -side;
    const oppositeAsk = opposite === 1 ? executionTick.ua : executionTick.da;
    if (!(oppositeAsk > 0.01 && oppositeAsk < variant.maxAsk)) {
      pnls.push(exitOnlyPnl);
      reversed.push(false);
      executionSecondsLeft.push(secondsLeft);
      executionOppAsk.push(oppositeAsk);
      continue;
    }
    const reverseBudget = Math.min(BUDGET, saleProceeds);
    const bought = sweep(levelsAt(executionTick, opposite, 'ask'), reverseBudget / oppositeAsk);
    if (!(bought.filled > 0)) {
      pnls.push(exitOnlyPnl);
      reversed.push(false);
      executionSecondsLeft.push(secondsLeft);
      executionOppAsk.push(oppositeAsk);
      continue;
    }
    const reverseCost = bought.filled * bought.average;
    const reverseFee = feePerShare(bought.average) * bought.filled;
    const reversePayout = opposite === winner ? bought.filled * SETTLE : 0;
    pnls.push(exitOnlyPnl + reversePayout - reverseCost - reverseFee);
    reversed.push(true);
    executionSecondsLeft.push(secondsLeft);
    executionOppAsk.push(oppositeAsk);
  }

  trades.push({
    day,
    eventStart,
    side,
    entryAsk: entry.average,
    canonicalWin: side === winner ? 1 : 0,
    signalSecondsLeft,
    pnls,
    reversed,
    executionSecondsLeft,
    executionOppAsk,
  });
}

const bidAskColumns = [];
for (let level = 1; level <= 25; level += 1) {
  for (const side of ['up', 'down']) {
    for (const kind of ['bid', 'ask']) {
      bidAskColumns.push(`${side}_${kind}_px_${level}`, `${side}_${kind}_sz_${level}`);
    }
  }
}
const days = fs.readdirSync(BASE)
  .filter((name) => name.startsWith('dt='))
  .map((name) => name.slice(3))
  .sort();
const db = await DuckDBInstance.create(':memory:');
const connection = await db.connect();
await connection.run('SET threads TO 6');
await connection.run("SET memory_limit = '8GB'");

for (const day of days) {
  const glob = path.join(BASE, `dt=${day}`, '*.parquet').replace(/\\/g, '/');
  const result = await connection.runAndReadAll(`
    SELECT event_start,
      EXTRACT(EPOCH FROM (TRY_CAST(ts AS TIMESTAMP) - TRY_CAST(event_start AS TIMESTAMP))) AS t,
      underlying_price AS spot, price_to_beat AS ptb,
      up_best_bid AS ub, up_best_ask AS ua, down_best_bid AS db, down_best_ask AS da,
      ${bidAskColumns.join(', ')}
    FROM read_parquet('${glob}')
    WHERE underlying_price IS NOT NULL
      AND price_to_beat IS NOT NULL
      AND price_to_beat > 0
      AND coverage >= 0.9
    ORDER BY event_start, ts`);
  const rows = result.getRowObjectsJson();
  let current = null;
  let buffer = [];
  const flush = () => {
    if (buffer.length) runEvent(buffer, day, current);
  };
  for (const row of rows) {
    const eventStart = new Date(String(row.event_start)).toISOString();
    if (eventStart !== current) {
      flush();
      current = eventStart;
      buffer = [];
    }
    const tick = {
      t: Number(row.t),
      spot: Number(row.spot),
      ptb: Number(row.ptb),
      ub: row.ub == null ? null : Number(row.ub),
      ua: row.ua == null ? null : Number(row.ua),
      db: row.db == null ? null : Number(row.db),
      da: row.da == null ? null : Number(row.da),
    };
    for (const column of bidAskColumns) tick[column] = row[column] == null ? null : Number(row[column]);
    buffer.push(tick);
  }
  flush();
  process.stderr.write(`[${day}] trades=${trades.length}\n`);
}

const csvLines = [
  [
    'day', 'event_start', 'side', 'entry_ask', 'canonical_win', 'signal_seconds_left',
    ...variants.map((variant) => `pnl_${variant.name}`),
    ...variants.map((variant) => `reversed_${variant.name}`),
  ].join(','),
  ...trades.map((trade) => [
    trade.day,
    trade.eventStart,
    trade.side,
    trade.entryAsk.toFixed(4),
    trade.canonicalWin,
    trade.signalSecondsLeft?.toFixed(1) ?? '',
    ...trade.pnls.map((pnl) => pnl.toFixed(4)),
    ...trade.reversed.map((value) => value ? 1 : 0),
  ].join(',')),
];
fs.writeFileSync(OUT_CSV, `${csvLines.join('\n')}\n`);

const summary = variants.map((variant, index) => {
  const pnls = trades.map((trade) => trade.pnls[index]);
  const reverseCount = trades.filter((trade) => trade.reversed[index]).length;
  const split = {};
  for (const [name, predicate] of Object.entries({
    train: (day) => day < '2026-06-15',
    validation: (day) => day >= '2026-06-15' && day < '2026-07-01',
    holdout: (day) => day >= '2026-07-01',
  })) {
    const selected = trades.filter((trade) => predicate(trade.day));
    const selectedPnls = selected.map((trade) => trade.pnls[index]);
    split[name] = {
      n: selected.length,
      pnl: selectedPnls.reduce((a, b) => a + b, 0),
      maxDrawdown: maxDrawdown(selectedPnls),
    };
  }
  return {
    variant: variant.name,
    delaySeconds: variant.delay,
    maxOppositeAsk: variant.maxAsk,
    n: trades.length,
    reversals: reverseCount,
    pnl: pnls.reduce((a, b) => a + b, 0),
    maxDrawdown: maxDrawdown(pnls),
    split,
  };
});

for (const delay of DELAYS) {
  const exitRow = summary.find((row) => row.variant === `exit_delay${String(delay).replace('.', 'p')}`);
  for (const row of summary.filter((candidate) => candidate.delaySeconds === delay)) {
    row.deltaVsExit = row.pnl - exitRow.pnl;
  }
}
const hold = summary[0];
for (const row of summary) row.deltaVsHold = row.pnl - hold.pnl;

const report = {
  generatedAt: new Date().toISOString(),
  label: 'Gamma resolved outcome',
  finalBookConsensusFilter: false,
  execution: 'depth 25 at first tick after configured delay',
  canonicalEventsAvailable: winnerByEvent.size,
  trades: trades.length,
  summary,
};
fs.writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
