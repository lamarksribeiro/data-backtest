import { DuckDBInstance } from '@duckdb/node-api';
const db = await DuckDBInstance.create(':memory:');
const c = await db.connect();
const r = await c.runAndReadAll(`
  SELECT * FROM read_parquet(
    'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-07-01/*.parquet',
    hive_partitioning=true, union_by_name=true
  ) LIMIT 1
`);
const row = r.getRowObjectsJson()[0];
console.log(Object.keys(row).sort().join('\n'));
console.log('sample', {
  underlying_price: row.underlying_price,
  price_to_beat: row.price_to_beat,
  btc_price: row.btc_price,
  up_ask_px_1: row.up_ask_px_1,
  up_ask_sz_1: row.up_ask_sz_1,
  event_end: row.event_end,
});
c.closeSync();
