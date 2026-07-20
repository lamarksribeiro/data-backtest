import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const BASE = path.resolve('lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25');

function collectFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(full));
    else if (entry.name.endsWith('.parquet')) files.push(full);
  }
  return files;
}

const files = collectFiles(BASE);
const fileList = files.map(f => quotedString(f)).join(', ');
console.error(`Files: ${files.length}`);

const instance = await DuckDBInstance.create(':memory:');
const conn = await instance.connect();

// Q1: What predicts LARGE token moves? 
// Find events where UP token moves >0.15 in price. What preceded these moves?
console.log('=== Q1: Predictors of Large UP Token Moves ===');
const q1 = `
WITH event_summary AS (
  SELECT 
    condition_id, event_start,
    MIN(up_price) as min_up,
    MAX(up_price) as max_up,
    MAX(up_price) - MIN(up_price) as up_range,
    COUNT(*) as tick_count
  FROM read_parquet([${fileList}])
  GROUP BY condition_id, event_start
),
big_moves AS (
  SELECT * FROM event_summary WHERE up_range > 0.15
),
all_events AS (
  SELECT * FROM event_summary
)
SELECT 
  'big_moves' as category,
  COUNT(*) as events,
  ROUND(AVG(up_range), 4) as avg_up_range,
  ROUND(AVG(tick_count), 0) as avg_ticks
FROM big_moves
UNION ALL
SELECT 
  'all_events' as category,
  COUNT(*) as events,
  ROUND(AVG(up_range), 4) as avg_up_range,
  ROUND(AVG(tick_count), 0) as avg_ticks
FROM all_events
`;
const r1 = await conn.runAndReadAll(q1);
console.table(r1.getRows());

// Q2: At the START of big-move events, what conditions exist?
console.log('\n=== Q2: Conditions at Event Start for Big Movers ===');
const q2 = `
WITH event_moves AS (
  SELECT 
    condition_id, event_start,
    MAX(up_price) - MIN(up_price) as up_range
  FROM read_parquet([${fileList}])
  GROUP BY condition_id, event_start
),
big_events AS (
  SELECT condition_id, event_start FROM event_moves WHERE up_range > 0.15
),
first_ticks AS (
  SELECT 
    t.condition_id, t.event_start,
    t.underlying_price, t.price_to_beat,
    t.up_best_ask, t.up_best_bid,
    t.down_best_ask, t.down_best_bid,
    ABS(t.underlying_price - t.price_to_beat) as dist_ptb,
    ROW_NUMBER() OVER (PARTITION BY t.condition_id, t.event_start ORDER BY t.ts) as rn
  FROM read_parquet([${fileList}]) t
  JOIN big_events b ON t.condition_id = b.condition_id AND t.event_start = b.event_start
)
SELECT 
  ROUND(AVG(dist_ptb), 1) as avg_initial_dist,
  ROUND(AVG(up_best_ask), 4) as avg_up_ask,
  ROUND(AVG(down_best_ask), 4) as avg_down_ask,
  ROUND(AVG(up_best_ask - up_best_bid), 6) as avg_up_spread,
  COUNT(*) as events
FROM first_ticks
WHERE rn <= 5
`;
const r2 = await conn.runAndReadAll(q2);
console.table(r2.getRows());

// Q3: What's the relationship between initial PTB distance and final outcome?
console.log('\n=== Q3: Distance vs Outcome (full event) ===');
const q3 = `
WITH event_outcomes AS (
  SELECT 
    condition_id, event_start,
    FIRST_VALUE(underlying_price) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as first_spot,
    FIRST_VALUE(price_to_beat) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as first_ptb,
    FIRST_VALUE(up_price) OVER (PARTITION BY condition_id, event_start ORDER BY ts DESC) as final_up,
    FIRST_VALUE(down_price) OVER (PARTITION BY condition_id, event_start ORDER BY ts DESC) as final_down,
    ROW_NUMBER() OVER (PARTITION BY condition_id, event_start ORDER BY ts) as rn
  FROM read_parquet([${fileList}])
)
SELECT 
  CASE 
    WHEN ABS(first_spot - first_ptb) < 10 THEN '0-10'
    WHEN ABS(first_spot - first_ptb) < 20 THEN '10-20'
    WHEN ABS(first_spot - first_ptb) < 30 THEN '20-30'
    WHEN ABS(first_spot - first_ptb) < 50 THEN '30-50'
    WHEN ABS(first_spot - first_ptb) < 80 THEN '50-80'
    ELSE '80+'
  END as dist_bucket,
  COUNT(*) as events,
  ROUND(AVG(final_up), 4) as avg_final_up,
  ROUND(AVG(final_down), 4) as avg_final_down,
  ROUND(AVG(CASE WHEN final_up > final_down THEN 1.0 ELSE 0.0 END) * 100, 1) as up_win_pct
FROM event_outcomes
WHERE rn = 1
GROUP BY 1
ORDER BY 1
`;
const r3 = await conn.runAndReadAll(q3);
console.table(r3.getRows());

// Q4: Tick-level: What's the best predictor of UP price over next N ticks?
// Compare: OBI, spread direction, momentum, PTB distance change
console.log('\n=== Q4: Multi-factor Prediction of UP token change ===');
const q4 = `
WITH predictors AS (
  SELECT 
    underlying_price, price_to_beat, up_price, down_price,
    up_best_ask, up_best_bid, down_best_ask, down_best_bid,
    LEAD(up_price, 30) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as up_30,
    LEAD(down_price, 30) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as down_30,
    LAG(up_price, 10) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as up_lag10,
    LAG(underlying_price, 10) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as spot_lag10,
    (up_bid_sz_1 + up_bid_sz_2 - up_ask_sz_1 - up_ask_sz_2) / 
    NULLIF(up_bid_sz_1 + up_bid_sz_2 + up_ask_sz_1 + up_ask_sz_2, 0) as up_obi,
    EXTRACT(EPOCH FROM (event_end::TIMESTAMP - ts::TIMESTAMP)) as secs_left
  FROM read_parquet([${fileList}])
  WHERE up_bid_sz_1 IS NOT NULL
)
SELECT 
  ROUND(CORR(up_obi, up_30 - up_price), 4) as obi_up_corr,
  ROUND(CORR(up_price - up_lag10, up_30 - up_price), 4) as mom_up_corr,
  ROUND(CORR(underlying_price - spot_lag10, up_30 - up_price), 4) as spot_mom_up_corr,
  ROUND(CORR(underlying_price - price_to_beat, up_30 - up_price), 4) as ptb_dist_up_corr
FROM predictors
WHERE up_30 IS NOT NULL AND up_lag10 IS NOT NULL
`;
const r4 = await conn.runAndReadAll(q4);
console.table(r4.getRows());

// Q5: When does the UP token CROSS the DOWN token? These are big events.
console.log('\n=== Q5: Token Crossover Analysis ===');
const q5 = `
WITH cross_events AS (
  SELECT 
    condition_id, event_start,
    COUNT(*) FILTER (WHERE up_price > down_price) as up_leading,
    COUNT(*) FILTER (WHERE down_price > up_price) as down_leading,
    COUNT(*) as total_ticks
  FROM read_parquet([${fileList}])
  GROUP BY condition_id, event_start
)
SELECT 
  CASE 
    WHEN up_leading > down_leading * 1.5 THEN 'UP_dominant'
    WHEN down_leading > up_leading * 1.5 THEN 'DOWN_dominant'
    ELSE 'mixed'
  END as dominance,
  COUNT(*) as events,
  ROUND(AVG(total_ticks), 0) as avg_ticks
FROM cross_events
GROUP BY 1
`;
const r5 = await conn.runAndReadAll(q5);
console.table(r5.getRows());

await conn.close();
console.error('\nDone.');
