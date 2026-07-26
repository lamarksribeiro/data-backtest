import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const code = fs.readFileSync('labs/legacy/strategy-runners/portable/pair-ladder-complete-set-runner.js', 'utf8');
const exp = new Function(`${code}\nreturn __pairLadderCompleteSetExports;`)();

const dir = path.resolve('lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25');
function walk(d, acc = []) {
  if (!fs.existsSync(d)) return acc;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f, acc);
    else if (e.name.endsWith('.parquet') && f.includes('dt=2026-07-20')) acc.push(f);
  }
  return acc;
}
const files = walk(dir);
console.log('files', files.length);

const instance = await DuckDBInstance.create(':memory:');
const conn = await instance.connect();
const pql = `[${files.map((f) => quotedString(f)).join(',')}]`;
const result = await conn.runAndReadAll(`
SELECT ts, event_start, event_end, condition_id, underlying_price, price_to_beat, coverage,
       up_best_ask, up_best_bid, down_best_ask, down_best_bid
FROM read_parquet(${pql})
WHERE coverage >= 0.99
ORDER BY ts
`);
const rows = result.getRowObjectsJS();
console.log('ticks', rows.length);

const byEv = new Map();
for (const r of rows) {
  const k = String(r.condition_id || r.event_start);
  if (!byEv.has(k)) byEv.set(k, []);
  byEv.get(k).push(r);
}
let chaseOpp = 0;
let snapOpp = 0;
for (const ticks of byEv.values()) {
  let hasChase = false;
  let hasSnap = false;
  for (const t of ticks) {
    const u = Number(t.up_best_ask);
    const d = Number(t.down_best_ask);
    if (u <= 0.40 || d <= 0.40) hasChase = true;
    if (Number.isFinite(u) && Number.isFinite(d) && u + d <= 0.97) hasSnap = true;
  }
  if (hasChase) chaseOpp += 1;
  if (hasSnap) snapOpp += 1;
}
console.log('events', byEv.size, 'chase<=0.40', chaseOpp, 'snap<=0.97', snapOpp);

function toIso(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e12) return new Date(n).toISOString();
  if (Number.isFinite(n) && n > 1e9) return new Date(n * 1000).toISOString();
  return String(v);
}

function run(params) {
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
  return runner.finish();
}

const variants = {
  current: {},
  mild_reb: { rebalanceMaxAsk: 0.60, blockAvgSum: 1.08, buildMaxAvgSum: 1.05, chaseMaxAsk: 0.45 },
  chase_only: {
    rebalanceMaxAsk: 0.01,
    chaseMaxAsk: 0.45,
    buildOnlyImprove: true,
    buildMaxAvgSum: 1.0,
    blockAvgSum: 1.05,
  },
  seed_only: {
    rebalanceMaxAsk: 0.01,
    chaseMaxAsk: 0.01,
    lateMaxAsk: 0.01,
    pairSnapMax: 0.5,
    maxFillsPerEvent: 2,
  },
};

for (const [name, params] of Object.entries(variants)) {
  const res = run({ spreadCents: 1, slippageCents: 0, ...params });
  const entered = res.events.filter((e) => e.reason !== 'no_entry');
  const avg = entered.map((e) => e.avgSum).filter((x) => x != null).sort((a, b) => a - b);
  const q = (p) => avg[Math.floor((avg.length - 1) * p)];
  const pnl = entered.reduce((s, e) => s + e.finalPnl, 0);
  const locked = entered.filter((e) => e.avgSum != null && e.avgSum < 1 && e.balance >= 0.95);
  const lockedPnl = locked.reduce((s, e) => s + e.finalPnl, 0);
  console.log(
    name,
    'n', entered.length,
    'pnl', pnl.toFixed(1),
    'avgSum p50/p90', q(0.5)?.toFixed(3), q(0.9)?.toFixed(3),
    'lt1', avg.filter((x) => x < 1).length,
    'locked', locked.length,
    'lockedPnl', lockedPnl.toFixed(1),
    'meanFills', (entered.reduce((s, e) => s + e.fillCount, 0) / Math.max(1, entered.length)).toFixed(1),
    'meanBal', (entered.reduce((s, e) => s + (e.balance || 0), 0) / Math.max(1, entered.length)).toFixed(2),
  );
}
