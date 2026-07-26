import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const days = ['2026-07-24', '2026-07-25'];
const files = [];
for (const day of days) {
  const dir = path.resolve(`lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=${day}`);
  for (const n of fs.readdirSync(dir).filter((f) => f.endsWith('.parquet'))) files.push(path.join(dir, n));
}
const csv = path.resolve('.tmp/pair-ladder-re/doggy-below-bid-fills.csv');
const db = await DuckDBInstance.create(':memory:');
const c = await db.connect();
const pql = `[${files.map((f) => quotedString(f)).join(',')}]`;

const q1 = await c.runAndReadAll(`
WITH ticks AS (
  SELECT ep FROM (
    SELECT epoch(try_cast(ts AS TIMESTAMPTZ))::BIGINT AS ep,
           row_number() OVER (PARTITION BY epoch(try_cast(ts AS TIMESTAMPTZ)) ORDER BY ts) AS rn
    FROM read_parquet(${pql})
    WHERE coverage >= 0.99 AND up_best_ask IS NOT NULL
  ) WHERE rn = 1
)
SELECT count(*)::BIGINT AS n_ticks, count(DISTINCT ep)::BIGINT AS n_distinct FROM ticks
`);
console.log('ticks', q1.getRowObjectsJS());

const q2 = await c.runAndReadAll(`
WITH fills AS (
  SELECT try_cast(fill_ts AS BIGINT) AS fill_ts FROM read_csv_auto(${quotedString(csv)}, header=true)
),
ticks AS (
  SELECT ep, up_best_ask, down_best_ask FROM (
    SELECT epoch(try_cast(ts AS TIMESTAMPTZ))::BIGINT AS ep,
           up_best_ask::DOUBLE AS up_best_ask,
           down_best_ask::DOUBLE AS down_best_ask,
           row_number() OVER (PARTITION BY epoch(try_cast(ts AS TIMESTAMPTZ)) ORDER BY ts) AS rn
    FROM read_parquet(${pql})
    WHERE coverage >= 0.99 AND up_best_ask IS NOT NULL
  ) WHERE rn = 1
)
SELECT
  (SELECT count(*) FROM fills)::BIGINT AS n_fills,
  (SELECT count(*) FROM fills f INNER JOIN ticks t ON t.ep = f.fill_ts)::BIGINT AS n_join,
  (SELECT count(*) FROM (
     SELECT f.fill_ts, count(*) c FROM fills f INNER JOIN ticks t ON t.ep = f.fill_ts GROUP BY f.fill_ts HAVING count(*)>1
  ))::BIGINT AS n_dup_fill_ts
`);
console.log('join', q2.getRowObjectsJS());
