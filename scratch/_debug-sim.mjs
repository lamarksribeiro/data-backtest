import { DuckDBInstance } from '@duckdb/node-api';

const GLOB = 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-06-15/*.parquet';
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
    AND up_ask_px_1 BETWEEN 0.01 AND 0.99
  LIMIT 5
`);
const rows = reader.getRowObjectsJson();
console.log(rows[0]);
console.log('types', Object.fromEntries(Object.entries(rows[0]).map(([k,v]) => [k, typeof v])));
console.log('Number ua', Number(rows[0].ua), Number.isFinite(Number(rows[0].ua)));

// count how many pass open filters on one day
const r2 = await conn.runAndReadAll(`
  SELECT count(*) AS n
  FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
  WHERE COALESCE(degraded, false) = false AND coverage >= 0.99
    AND up_ask_px_1 BETWEEN 0.15 AND 0.45
    AND down_ask_px_1 BETWEEN 0.45 AND 0.75
    AND up_bid_px_1 > 0 AND down_bid_px_1 > 0
    AND up_bid_px_1 <= up_ask_px_1 AND down_bid_px_1 <= down_ask_px_1
    AND up_ask_px_1 - up_bid_px_1 <= 0.05
    AND down_ask_px_1 - down_bid_px_1 <= 0.05
    AND epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) BETWEEN 60 AND 200
`);
console.log('openish', r2.getRowObjectsJson());
conn.closeSync();
