import { DuckDBInstance } from '@duckdb/node-api';

const GLOB = 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-06-15/*.parquet';
const FEE = 0.07;
function feeOn(p, q) { return q * FEE * p * (1 - p); }
function fin(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

const db = await DuckDBInstance.create(':memory:');
const conn = await db.connect();
const reader = await conn.runAndReadAll(`
  SELECT
    condition_id,
    epoch_ms(TRY_CAST(ts AS TIMESTAMP)) AS ts_ms,
    epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau,
    up_ask_px_1 AS ua, down_ask_px_1 AS da,
    up_bid_px_1 AS ub, down_bid_px_1 AS db,
    COALESCE(up_ask_sz_1, 0) AS uas, COALESCE(down_ask_sz_1, 0) AS das,
    underlying_price AS btc, price_to_beat AS ptb
  FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
  WHERE COALESCE(degraded, false) = false AND coverage >= 0.99
    AND up_ask_px_1 BETWEEN 0.01 AND 0.99 AND down_ask_px_1 BETWEEN 0.01 AND 0.99
    AND underlying_price IS NOT NULL AND price_to_beat IS NOT NULL
    AND epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) BETWEEN 3 AND 295
  ORDER BY condition_id, ts_ms
`);
const rows = reader.getRowObjectsJson().map((r) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])),
);
const map = new Map();
for (const r of rows) {
  const id = String(r.condition_id);
  if (!map.has(id)) map.set(id, []);
  map.get(id).push(r);
}
console.log('events', map.size, 'rows', rows.length);

const v = {
  budget: 10, fillsFrac: 1, minQty: 1, maxSpread: 0.05,
  minOpenTau: 60, maxOpenTau: 200, minOpenAsk: 0.15, maxOpenAsk: 0.45,
  minOtherAsk: 0.45, maxOtherAsk: 0.75, minSum: 0.95, maxSum: 1.08,
  minLockEdge: 0.01, maxCompleteAsk: 0.65, minCompleteTau: 10,
  dump: true, dumpTau: 18, hopelessAsk: 0.78, hopelessDumpTau: 35, minDumpBid: 0.04,
  minDist: 0, maxDist: 100, mode: 'cheaper',
};

let stats = { ticks: 0, passBook: 0, passTau: 0, passSum: 0, passAsk: 0, passOther: 0, open: 0 };
const ticks = map.values().next().value;
for (const t of ticks) {
  stats.ticks++;
  const ua = fin(t.ua), da = fin(t.da), ub = fin(t.ub), db = fin(t.db);
  const tau = fin(t.tau), btc = fin(t.btc), ptb = fin(t.ptb);
  if (ua == null || da == null || ub == null || db == null || tau == null) continue;
  if (ub > ua + 1e-12 || db > da + 1e-12) continue;
  if (ua - ub > v.maxSpread || da - db > v.maxSpread) continue;
  stats.passBook++;
  if (tau < v.minOpenTau || tau > v.maxOpenTau) continue;
  stats.passTau++;
  const sum = ua + da;
  if (sum < v.minSum || sum > v.maxSum) continue;
  stats.passSum++;
  let side, ask, other;
  if (ua <= da) { side = 'UP'; ask = ua; other = da; }
  else { side = 'DOWN'; ask = da; other = ua; }
  if (ask < v.minOpenAsk || ask > v.maxOpenAsk) continue;
  stats.passAsk++;
  if (other < v.minOtherAsk || other > v.maxOtherAsk) continue;
  stats.passOther++;
  stats.open++;
  break;
}
console.log('one event', stats);

// scan all events for any open
let opens = 0;
for (const [, arr] of map) {
  for (const t of arr) {
    const ua = fin(t.ua), da = fin(t.da), ub = fin(t.ub), db = fin(t.db);
    const tau = fin(t.tau), btc = fin(t.btc), ptb = fin(t.ptb);
    if (ua == null || da == null || ub == null || db == null || tau == null) continue;
    if (ub > ua + 1e-12 || db > da + 1e-12) continue;
    if (ua - ub > v.maxSpread || da - db > v.maxSpread) continue;
    if (tau < v.minOpenTau || tau > v.maxOpenTau) continue;
    const sum = ua + da;
    if (sum < v.minSum || sum > v.maxSum) continue;
    const ask = Math.min(ua, da), other = Math.max(ua, da);
    if (ask < v.minOpenAsk || ask > v.maxOpenAsk) continue;
    if (other < v.minOtherAsk || other > v.maxOtherAsk) continue;
    const dist = Math.abs(btc - ptb);
    if (dist < v.minDist || dist > v.maxDist) continue;
    opens++;
    break;
  }
}
console.log('events with open opportunity', opens, 'of', map.size);
conn.closeSync();
