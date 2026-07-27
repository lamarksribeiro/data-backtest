/**
 * Stress test da saída anti-flip:
 * - winner canônico da Gamma/Polymarket;
 * - sem filtro de concordância entre spot local e book final;
 * - atraso entre sinal e execução de 0 a 5 segundos.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = 'D:/Projetos/projeto-goldenlens/data-backtest';
const GAMMA_CSV = path.join(ROOT, 'scratch/gamma-outcomes.csv');
const OUT_JSON = path.join(ROOT, 'scratch/tick-exit-latency-canonical.json');
const OUT_CSV = path.join(ROOT, 'scratch/tick-exit-latency-canonical.csv');
const BASE = path.join(ROOT, 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25');
const BUDGET = 10;
const SETTLE = 0.995;
const DELAYS = [0, 0.5, 1, 2, 3, 5];
const THRESHOLDS = [0.45, 0.40];
const feePerShare = (price) => 0.07 * price * (1 - price);

function parseCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const header = lines.shift().split(',');
  return lines.filter(Boolean).map((line) => {
    const values = line.split(',');
    return Object.fromEntries(header.map((key, i) => [key, values[i] ?? '']));
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

const winnerByEvent = new Map(parseCsv(GAMMA_CSV).map((row) => [row.event_start, Number(row.winner)]));
const variants = [
  { name: 'hold', threshold: null, delay: null },
  ...THRESHOLDS.flatMap((threshold) => DELAYS.map((delay) => ({
    name: `lead_bid${Math.round(threshold * 100)}_delay${String(delay).replace('.', 'p')}`,
    threshold,
    delay,
  }))),
];
const trades = [];

function runEvent(ticks, day, eventStart) {
  const winner = winnerByEvent.get(eventStart);
  if (winner == null || ticks.length < 100) return;
  const last = ticks[ticks.length - 1];
  const ptb = last.ptb;
  if (!(ptb > 0)) return;
  const duration = last.t;
  const entryTarget = duration - 30;
  let entryIndex = -1;
  for (let i = ticks.length - 1; i >= 0; i -= 1) {
    if (ticks[i].t <= entryTarget) {
      entryIndex = i;
      break;
    }
  }
  if (entryIndex < 30) return;
  const entry = ticks[entryIndex];
  if ([entry.ub, entry.ua, entry.db, entry.da].some((value) => value == null)) return;
  const entryDistance = entry.spot - ptb;
  if (entryDistance === 0) return;
  const side = entryDistance > 0 ? 1 : -1;
  const ask = side === 1 ? entry.ua : entry.da;
  if (!(ask > 0.5 && ask <= 0.94)) return;

  const shares = BUDGET / ask;
  const entryFee = feePerShare(ask) * shares;
  const canonicalWin = side === winner;
  const holdPnl = canonicalWin ? shares * SETTLE - BUDGET - entryFee : -BUDGET - entryFee;
  const states = variants.map(() => ({
    signalT: null,
    signalSecsLeft: null,
    exited: false,
    exitT: null,
    exitSecsLeft: null,
    exitPx: null,
    missed: false,
  }));

  for (let i = entryIndex + 1; i < ticks.length; i += 1) {
    const tick = ticks[i];
    if ([tick.ub, tick.ua, tick.db, tick.da].some((value) => value == null)) continue;
    const secsLeft = duration - tick.t;
    const distance = tick.spot - ptb;
    const leader = distance > 0 ? 1 : distance < 0 ? -1 : side;
    const ourBid = side === 1 ? tick.ub : tick.db;
    for (let v = 1; v < variants.length; v += 1) {
      const variant = variants[v];
      const state = states[v];
      if (state.exited || state.missed) continue;
      if (state.signalT == null && leader !== side && ourBid < variant.threshold) {
        state.signalT = tick.t;
        state.signalSecsLeft = secsLeft;
      }
      if (state.signalT != null && tick.t >= state.signalT + variant.delay) {
        if (secsLeft < 2) {
          state.missed = true;
        } else {
          state.exited = true;
          state.exitT = tick.t;
          state.exitSecsLeft = secsLeft;
          state.exitPx = Math.max(0.01, Math.min(0.99, ourBid));
        }
      }
    }
  }

  const pnls = variants.map((variant, index) => {
    const state = states[index];
    if (!state.exited) return holdPnl;
    return shares * state.exitPx - BUDGET - entryFee - feePerShare(state.exitPx) * shares;
  });
  trades.push({
    day,
    eventStart,
    side,
    ask,
    canonicalWin: canonicalWin ? 1 : 0,
    pnls,
    states,
  });
}

const days = fs.readdirSync(BASE)
  .filter((name) => name.startsWith('dt='))
  .map((name) => name.slice(3))
  .sort();
const db = await DuckDBInstance.create(':memory:');
const conn = await db.connect();
await conn.run('SET threads TO 6');
await conn.run("SET memory_limit = '6GB'");

for (const day of days) {
  const glob = path.join(BASE, `dt=${day}`, '*.parquet').replace(/\\/g, '/');
  const result = await conn.runAndReadAll(`
    SELECT event_start,
      EXTRACT(EPOCH FROM (TRY_CAST(ts AS TIMESTAMP) - TRY_CAST(event_start AS TIMESTAMP))) AS t,
      underlying_price AS spot, price_to_beat AS ptb,
      up_best_bid AS ub, up_best_ask AS ua, down_best_bid AS db, down_best_ask AS da
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
    buffer.push({
      t: Number(row.t),
      spot: Number(row.spot),
      ptb: Number(row.ptb),
      ub: row.ub == null ? null : Number(row.ub),
      ua: row.ua == null ? null : Number(row.ua),
      db: row.db == null ? null : Number(row.db),
      da: row.da == null ? null : Number(row.da),
    });
  }
  flush();
  process.stderr.write(`[${day}] trades=${trades.length}\n`);
}

const csv = [
  [
    'day', 'event_start', 'side', 'ask', 'canonical_win',
    ...variants.map((variant) => `pnl_${variant.name}`),
    ...variants.slice(1).map((variant) => `signal_secs_${variant.name}`),
    ...variants.slice(1).map((variant) => `exit_secs_${variant.name}`),
  ].join(','),
  ...trades.map((trade) => [
    trade.day,
    trade.eventStart,
    trade.side,
    trade.ask.toFixed(3),
    trade.canonicalWin,
    ...trade.pnls.map((pnl) => pnl.toFixed(4)),
    ...trade.states.slice(1).map((state) => state.signalSecsLeft?.toFixed(1) ?? ''),
    ...trade.states.slice(1).map((state) => state.exitSecsLeft?.toFixed(1) ?? ''),
  ].join(',')),
];
fs.writeFileSync(OUT_CSV, `${csv.join('\n')}\n`);

const summary = variants.map((variant, index) => {
  const pnls = trades.map((trade) => trade.pnls[index]);
  const exits = trades.filter((trade) => trade.states[index].exited).length;
  const signals = trades.filter((trade) => trade.states[index].signalT != null).length;
  const missed = trades.filter((trade) => trade.states[index].missed).length;
  const split = {};
  for (const [name, predicate] of Object.entries({
    train: (day) => day < '2026-06-15',
    validation: (day) => day >= '2026-06-15' && day < '2026-07-01',
    holdout: (day) => day >= '2026-07-01',
  })) {
    const selected = trades.filter((trade) => predicate(trade.day));
    const splitPnls = selected.map((trade) => trade.pnls[index]);
    split[name] = {
      n: selected.length,
      pnl: splitPnls.reduce((a, b) => a + b, 0),
      maxDrawdown: maxDrawdown(splitPnls),
    };
  }
  return {
    variant: variant.name,
    threshold: variant.threshold,
    delaySeconds: variant.delay,
    n: trades.length,
    signals,
    exits,
    missed,
    pnl: pnls.reduce((a, b) => a + b, 0),
    maxDrawdown: maxDrawdown(pnls),
    split,
  };
});
const hold = summary[0];
for (const row of summary) {
  row.deltaVsHold = row.pnl - hold.pnl;
  row.drawdownDeltaVsHold = row.maxDrawdown - hold.maxDrawdown;
}
const report = {
  generatedAt: new Date().toISOString(),
  label: 'Gamma resolved outcome',
  finalBookConsensusFilter: false,
  eventRange: { first: days[0], last: days.at(-1) },
  canonicalEventsAvailable: winnerByEvent.size,
  trades: trades.length,
  summary,
};
fs.writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
