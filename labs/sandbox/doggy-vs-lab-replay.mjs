/**
 * Compare lab runner vs Doggy ledger on overlapping events (structure, not tick-perfect).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';
import { applyPolymarketFeesToBacktestResult } from '../../src/backtest/fees.js';

const code = fs.readFileSync('labs/legacy/strategy-runners/portable/pair-ladder-complete-set-runner.js', 'utf8');
const exp = new Function(`${code}\nreturn __pairLadderCompleteSetExports;`)();
const doggy = JSON.parse(fs.readFileSync('.tmp/pair-ladder-re/doggy-events-ledger.json', 'utf8'));
const bySlug = new Map(doggy.map((e) => [e.slug, e]));

const day = process.argv[2] || '2026-07-25';
const dir = path.resolve(`lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=${day}`);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.parquet')).map((f) => path.resolve(dir, f));
const db = await DuckDBInstance.create(':memory:');
const c = await db.connect();
const pql = `[${files.map((f) => quotedString(f)).join(',')}]`;
const rows = (await c.runAndReadAll(`
  SELECT ts, event_start, event_end, condition_id, underlying_price, price_to_beat, coverage,
         up_best_ask, up_best_bid, down_best_ask, down_best_bid
  FROM read_parquet(${pql}) WHERE coverage >= 0.99 ORDER BY ts
`)).getRowObjectsJS();

const toIso = (v) => (v instanceof Date ? v.toISOString() : String(v));
const params = {
  slippageCents: -1,
  forbidOverweight: true,
  softLockAllowVacuum: true,
  seedHedgeSameTick: false,
  maxEventNotional: 800,
  maxResidualShares: 150,
  maxFillsPerEvent: 20,
};
const runner = exp.createBacktestRunner(params);
for (const t of rows) {
  runner.processTick({
    ts: toIso(t.ts),
    event_start: toIso(t.event_start),
    event_end: toIso(t.event_end),
    condition_id: t.condition_id,
    btc_price: Number(t.underlying_price),
    price_to_beat: Number(t.price_to_beat),
    coverage: Number(t.coverage),
    degraded: false,
    up_best_ask: Number(t.up_best_ask),
    up_best_bid: Number(t.up_best_bid),
    down_best_ask: Number(t.down_best_ask),
    down_best_bid: Number(t.down_best_bid),
  });
}
const res = runner.finish();
applyPolymarketFeesToBacktestResult(res, { category: 'crypto', takerRebateRate: 0.44 });

const comps = [];
for (const e of res.events) {
  if (e.reason === 'no_entry') continue;
  const start = e.eventStart ? Math.floor(Date.parse(e.eventStart) / 1000) : null;
  const slug = start != null ? `btc-updown-5m-${start}` : null;
  const d = slug ? bySlug.get(slug) : null;
  if (!d || d.pnl == null) continue;
  comps.push({
    slug,
    doggyAvg: d.avgSum,
    labAvg: e.avgSum,
    doggyPnl: d.pnl,
    labPnl: e.finalPnl,
    doggyFills: d.nFills,
    labFills: e.fillCount,
    doggyRes: d.residual,
    labRes: e.residual,
  });
}

function q(arr, p) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor((a.length - 1) * p)];
}

const avgDelta = comps.map((c) => (c.labAvg ?? 0) - (c.doggyAvg ?? 0));
const pnlDelta = comps.map((c) => c.labPnl - c.doggyPnl);
const out = {
  day,
  overlap: comps.length,
  doggyPnl: comps.reduce((s, c) => s + c.doggyPnl, 0),
  labPnl: comps.reduce((s, c) => s + c.labPnl, 0),
  medAvgDelta: q(avgDelta, 0.5),
  medPnlDelta: q(pnlDelta, 0.5),
  labSummary: {
    totalPnl: res.summary.totalPnl,
    winRate: res.summary.winRate,
    fees: res.summary.totalFees,
    rebate: res.summary.takerRebate,
  },
  sample: comps.slice(0, 5),
};
fs.mkdirSync('.tmp/pair-ladder-re', { recursive: true });
fs.writeFileSync(`.tmp/pair-ladder-re/doggy-vs-lab-${day}.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
