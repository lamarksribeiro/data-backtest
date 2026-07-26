import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const all = JSON.parse(fs.readFileSync('.tmp/pair-ladder-re/doggy-activity-fresh.json', 'utf8'));
const trades = all.filter((r) => r.type === 'TRADE' && r.side === 'BUY' && /btc-updown-5m/i.test(r.slug || ''));
console.log('btc5m trades', trades.length);

const files = fs.readdirSync('lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-07-25')
  .filter((x) => x.endsWith('.parquet'))
  .map((x) => path.resolve('lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-07-25', x));
console.log('jul25 files', files.length);

const db = await DuckDBInstance.create(':memory:');
const c = await db.connect();
const pql = `[${files.map((f) => quotedString(f)).join(',')}]`;

const lakeRange = await c.runAndReadAll(`
  SELECT
    min(epoch(try_cast(ts AS TIMESTAMPTZ)))::BIGINT AS a,
    max(epoch(try_cast(ts AS TIMESTAMPTZ)))::BIGINT AS b
  FROM read_parquet(${pql})
`);
const { a: lakeA, b: lakeB } = lakeRange.getRowObjectsJS()[0];
console.log('lake', Number(lakeA), new Date(Number(lakeA) * 1000).toISOString(), '->', Number(lakeB), new Date(Number(lakeB) * 1000).toISOString());

const overlap = trades.filter((t) => t.timestamp >= Number(lakeA) - 2 && t.timestamp <= Number(lakeB) + 2);
console.log('overlap fills', overlap.length);

const csvPath = path.resolve('.tmp/pair-ladder-re/doggy-fills-jul25.csv');
const lines = ['timestamp,price,size,outcome,slug'];
for (const t of overlap) {
  lines.push([t.timestamp, t.price, t.size, JSON.stringify(t.outcome), t.slug].join(','));
}
fs.writeFileSync(csvPath, lines.join('\n'));

const sql = `
WITH fills AS (
  SELECT timestamp::BIGINT AS fill_ts, price::DOUBLE AS fill_px, size::DOUBLE AS size, outcome, slug
  FROM read_csv_auto(${quotedString(csvPath)}, header=true)
),
ticks AS (
  SELECT
    epoch(try_cast(ts AS TIMESTAMPTZ))::BIGINT AS ep,
    up_best_ask, up_best_bid, down_best_ask, down_best_bid
  FROM read_parquet(${pql})
  WHERE coverage >= 0.99
    AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
),
best AS (
  SELECT
    f.fill_ts, f.fill_px, f.size, f.outcome, f.slug,
    CASE WHEN f.outcome = 'Up' THEN t.up_best_ask ELSE t.down_best_ask END AS ask,
    CASE WHEN f.outcome = 'Up' THEN t.up_best_bid ELSE t.down_best_bid END AS bid,
    abs(t.ep - f.fill_ts) AS dsec
  FROM fills f
  JOIN ticks t ON abs(t.ep - f.fill_ts) <= 2
  QUALIFY row_number() OVER (
    PARTITION BY f.fill_ts, f.slug, f.outcome, f.size, f.fill_px
    ORDER BY abs(t.ep - f.fill_ts)
  ) = 1
)
SELECT
  count(*) AS n,
  round(avg(dsec),3) AS mean_dsec,
  round(avg(fill_px - ask),5) AS mean_vs_ask,
  round(avg(fill_px - bid),5) AS mean_vs_bid,
  round(avg(fill_px - (ask+bid)/2.0),5) AS mean_vs_mid,
  sum(CASE WHEN fill_px >= ask - 0.005 THEN 1 ELSE 0 END) AS near_ask,
  sum(CASE WHEN fill_px <= bid + 0.005 THEN 1 ELSE 0 END) AS near_bid,
  sum(CASE WHEN fill_px > bid + 0.005 AND fill_px < ask - 0.005 THEN 1 ELSE 0 END) AS between_spread,
  sum(CASE WHEN fill_px > ask + 0.005 THEN 1 ELSE 0 END) AS above_ask,
  sum(CASE WHEN fill_px < bid - 0.005 THEN 1 ELSE 0 END) AS below_bid,
  round(approx_quantile(fill_px - ask, 0.5),5) AS med_vs_ask,
  round(approx_quantile(fill_px - bid, 0.5),5) AS med_vs_bid
FROM best
WHERE ask IS NOT NULL AND bid IS NOT NULL
`;
const summary = (await c.runAndReadAll(sql)).getRowObjectsJS()[0];
console.log('SUMMARY', summary);

const samples = (await c.runAndReadAll(`
WITH fills AS (
  SELECT timestamp::BIGINT AS fill_ts, price::DOUBLE AS fill_px, size::DOUBLE AS size, outcome, slug
  FROM read_csv_auto(${quotedString(csvPath)}, header=true)
),
ticks AS (
  SELECT
    epoch(try_cast(ts AS TIMESTAMPTZ))::BIGINT AS ep,
    up_best_ask, up_best_bid, down_best_ask, down_best_bid
  FROM read_parquet(${pql})
  WHERE coverage >= 0.99 AND up_best_ask IS NOT NULL
),
best AS (
  SELECT
    f.fill_ts, f.fill_px, f.size, f.outcome,
    CASE WHEN f.outcome = 'Up' THEN t.up_best_ask ELSE t.down_best_ask END AS ask,
    CASE WHEN f.outcome = 'Up' THEN t.up_best_bid ELSE t.down_best_bid END AS bid,
    abs(t.ep - f.fill_ts) AS dsec
  FROM fills f
  JOIN ticks t ON abs(t.ep - f.fill_ts) <= 2
  QUALIFY row_number() OVER (
    PARTITION BY f.fill_ts, f.slug, f.outcome, f.size, f.fill_px
    ORDER BY abs(t.ep - f.fill_ts)
  ) = 1
)
SELECT fill_ts, outcome, size, round(fill_px,4) fill_px, round(ask,4) ask, round(bid,4) bid,
  round(fill_px-ask,4) vs_ask, round(fill_px-bid,4) vs_bid,
  CASE
    WHEN fill_px >= ask - 0.005 THEN 'TAKER_LIKE'
    WHEN fill_px <= bid + 0.005 THEN 'MAKER_LIKE'
    ELSE 'BETWEEN'
  END AS class
FROM best WHERE ask IS NOT NULL
ORDER BY random()
LIMIT 25
`)).getRowObjectsJS();
console.log('RANDOM SAMPLES');
for (const row of samples) console.log(row);

// class counts
const classes = (await c.runAndReadAll(`
WITH fills AS (
  SELECT timestamp::BIGINT AS fill_ts, price::DOUBLE AS fill_px, size::DOUBLE AS size, outcome, slug
  FROM read_csv_auto(${quotedString(csvPath)}, header=true)
),
ticks AS (
  SELECT epoch(try_cast(ts AS TIMESTAMPTZ))::BIGINT AS ep,
    up_best_ask, up_best_bid, down_best_ask, down_best_bid
  FROM read_parquet(${pql})
  WHERE coverage >= 0.99 AND up_best_ask IS NOT NULL
),
best AS (
  SELECT f.fill_px,
    CASE WHEN f.outcome = 'Up' THEN t.up_best_ask ELSE t.down_best_ask END AS ask,
    CASE WHEN f.outcome = 'Up' THEN t.up_best_bid ELSE t.down_best_bid END AS bid
  FROM fills f
  JOIN ticks t ON abs(t.ep - f.fill_ts) <= 2
  QUALIFY row_number() OVER (
    PARTITION BY f.fill_ts, f.slug, f.outcome, f.size, f.fill_px
    ORDER BY abs(t.ep - f.fill_ts)
  ) = 1
)
SELECT
  CASE
    WHEN fill_px >= ask - 0.005 THEN 'TAKER_LIKE'
    WHEN fill_px <= bid + 0.005 THEN 'MAKER_LIKE'
    ELSE 'BETWEEN'
  END AS class,
  count(*) AS n,
  round(100.0*count(*)/sum(count(*)) OVER (),1) AS pct
FROM best WHERE ask IS NOT NULL AND bid IS NOT NULL
GROUP BY 1 ORDER BY n DESC
`)).getRowObjectsJS();
console.log('CLASSES', classes);

fs.writeFileSync('.tmp/pair-ladder-re/doggy-vs-book-jul25.json', JSON.stringify({ summary, classes, samples }, null, 2));

// Also probe CLOB public trades for one tx
const sampleTx = overlap[0]?.transactionHash;
if (sampleTx) {
  try {
    const url = `https://data-api.polymarket.com/trades?limit=5`;
    console.log('probe trades api skipped detailed; sample tx', sampleTx);
  } catch {}
}
