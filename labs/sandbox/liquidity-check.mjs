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

// Q1: Liquidity profile in last seconds - what can we actually buy/sell?
console.log('=== Q1: Order Book Liquidity in Last 15 Seconds ===');
const q1 = `
WITH late_ticks AS (
  SELECT 
    condition_id, event_start,
    EXTRACT(EPOCH FROM (event_end::TIMESTAMP - ts::TIMESTAMP)) as secs_left,
    up_best_ask, up_best_bid, down_best_ask, down_best_bid,
    up_ask_sz_1, up_ask_sz_2, up_ask_sz_3, up_ask_sz_4, up_ask_sz_5,
    up_bid_sz_1, up_bid_sz_2, up_bid_sz_3, up_bid_sz_4, up_bid_sz_5,
    down_ask_sz_1, down_ask_sz_2, down_ask_sz_3, down_ask_sz_4, down_ask_sz_5,
    down_bid_sz_1, down_bid_sz_2, down_bid_sz_3, down_bid_sz_4, down_bid_sz_5
  FROM read_parquet([${fileList}])
  WHERE up_bid_sz_1 IS NOT NULL
)
SELECT 
  CASE 
    WHEN secs_left <= 1 THEN '0-1s'
    WHEN secs_left <= 3 THEN '1-3s'
    WHEN secs_left <= 5 THEN '3-5s'
    WHEN secs_left <= 8 THEN '5-8s'
    WHEN secs_left <= 10 THEN '8-10s'
    WHEN secs_left <= 15 THEN '10-15s'
    ELSE '15s+'
  END as bucket,
  COUNT(*) as ticks,
  ROUND(AVG(up_best_ask - up_best_bid), 6) as avg_up_spread,
  ROUND(AVG(down_best_ask - down_best_bid), 6) as avg_down_spread,
  ROUND(AVG(up_ask_sz_1 + up_ask_sz_2), 2) as avg_up_ask_depth_l2,
  ROUND(AVG(up_bid_sz_1 + up_bid_sz_2), 2) as avg_up_bid_depth_l2,
  ROUND(AVG(down_ask_sz_1 + down_ask_sz_2), 2) as avg_down_ask_depth_l2,
  ROUND(AVG(down_bid_sz_1 + down_bid_sz_2), 2) as avg_down_bid_depth_l2,
  -- Available notional at best ask: sum(size * price) for levels 1-5
  ROUND(AVG(
    up_ask_sz_1 * up_best_ask + 
    COALESCE(up_ask_sz_2 * (SELECT up_ask_sz_2 FROM (VALUES(1))), 0)
  ), 2) as up_notional_l1
FROM late_ticks
GROUP BY 1
ORDER BY 1
`;
const r1 = await conn.runAndReadAll(q1);
console.table(r1.getRows());

// Q2: At the exact moment of late flip (spot crosses PTB at 0-3s), what's the spread?
console.log('\n=== Q2: Spread at Exact Crossover Moments (Last 10s) ===');
const q2 = `
WITH crossover_ticks AS (
  SELECT 
    condition_id, event_start, ts,
    underlying_price, price_to_beat,
    ABS(underlying_price - price_to_beat) as dist_ptb,
    LAG(underlying_price) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as prev_spot,
    LAG(price_to_beat) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as prev_ptb,
    up_best_ask, up_best_bid, down_best_ask, down_best_bid,
    up_ask_sz_1, up_ask_sz_2, up_ask_sz_3,
    down_ask_sz_1, down_ask_sz_2, down_ask_sz_3,
    EXTRACT(EPOCH FROM (event_end::TIMESTAMP - ts::TIMESTAMP)) as secs_left
  FROM read_parquet([${fileList}])
  WHERE up_bid_sz_1 IS NOT NULL
),
cross_detected AS (
  SELECT *,
    CASE WHEN (prev_spot - prev_ptb) * (underlying_price - price_to_beat) < 0 THEN 1 ELSE 0 END as just_crossed
  FROM crossover_ticks
  WHERE prev_spot IS NOT NULL
)
SELECT 
  CASE 
    WHEN secs_left <= 1 THEN '0-1s'
    WHEN secs_left <= 3 THEN '1-3s'  
    WHEN secs_left <= 5 THEN '3-5s'
    WHEN secs_left <= 8 THEN '5-8s'
    WHEN secs_left <= 10 THEN '8-10s'
    ELSE '10s+'
  END as bucket,
  COUNT(*) as crosses,
  ROUND(AVG(up_best_ask - up_best_bid), 6) as avg_up_spread,
  ROUND(AVG(down_best_ask - down_best_bid), 6) as avg_down_spread,
  ROUND(AVG(up_ask_sz_1 + up_ask_sz_2 + up_ask_sz_3), 2) as up_ask_depth_l3,
  ROUND(AVG(down_ask_sz_1 + down_ask_sz_2 + down_ask_sz_3), 2) as down_ask_depth_l3
FROM cross_detected
WHERE just_crossed = 1 AND secs_left <= 10
GROUP BY 1
ORDER BY 1
`;
const r2 = await conn.runAndReadAll(q2);
console.table(r2.getRows());

// Q3: For a $10 order (the entry budget), what % would fill at the displayed price?
console.log('\n=== Q3: Fill Probability for $10 Order at Best Ask (Last 10s) ===');
const q3 = `
WITH order_sim AS (
  SELECT 
    EXTRACT(EPOCH FROM (event_end::TIMESTAMP - ts::TIMESTAMP)) as secs_left,
    up_best_ask, up_ask_sz_1, up_ask_sz_2, up_ask_sz_3, up_ask_sz_4, up_ask_sz_5,
    down_best_ask, down_ask_sz_1, down_ask_sz_2, down_ask_sz_3, down_ask_sz_4, down_ask_sz_5
  FROM read_parquet([${fileList}])
  WHERE up_bid_sz_1 IS NOT NULL AND up_best_ask > 0 AND down_best_ask > 0
),
up_sim AS (
  SELECT 
    secs_left,
    -- Shares needed for $10 at best ask
    10.0 / up_best_ask as needed_shares,
    -- Available shares at best ask levels
    up_ask_sz_1 + COALESCE(up_ask_sz_2, 0) + COALESCE(up_ask_sz_3, 0) + COALESCE(up_ask_sz_4, 0) + COALESCE(up_ask_sz_5, 0) as available_shares,
    -- Fill ratio capped at 1.0
    up_best_ask
  FROM order_sim
  WHERE up_best_ask BETWEEN 0.25 AND 0.95
),
down_sim AS (
  SELECT 
    secs_left,
    10.0 / down_best_ask as needed_shares,
    down_ask_sz_1 + COALESCE(down_ask_sz_2, 0) + COALESCE(down_ask_sz_3, 0) + COALESCE(down_ask_sz_4, 0) + COALESCE(down_ask_sz_5, 0) as available_shares
  FROM order_sim
  WHERE down_best_ask BETWEEN 0.25 AND 0.95
)
SELECT 
  'UP' as side,
  CASE 
    WHEN secs_left <= 1 THEN '0-1s'
    WHEN secs_left <= 3 THEN '1-3s'
    WHEN secs_left <= 5 THEN '3-5s'
    WHEN secs_left <= 10 THEN '5-10s'
    ELSE '10s+'
  END as bucket,
  COUNT(*) as samples,
  ROUND(AVG(CASE WHEN available_shares >= needed_shares THEN 1.0 ELSE 0.0 END) * 100, 1) as full_fill_pct,
  ROUND(AVG(CASE WHEN available_shares >= needed_shares * 0.5 THEN 1.0 ELSE 0.0 END) * 100, 1) as half_fill_pct,
  ROUND(AVG(CASE WHEN available_shares > 0 THEN needed_shares / NULLIF(available_shares, 0) ELSE 0 END) * 100, 1) as avg_fill_ratio_pct,
  ROUND(AVG(available_shares), 2) as avg_avail_shares,
  ROUND(AVG(needed_shares), 2) as avg_needed_shares
FROM up_sim
WHERE secs_left <= 10
GROUP BY 1, 2
UNION ALL
SELECT 
  'DOWN' as side,
  CASE 
    WHEN secs_left <= 1 THEN '0-1s'
    WHEN secs_left <= 3 THEN '1-3s'
    WHEN secs_left <= 5 THEN '3-5s'
    WHEN secs_left <= 10 THEN '5-10s'
    ELSE '10s+'
  END as bucket,
  COUNT(*) as samples,
  ROUND(AVG(CASE WHEN available_shares >= needed_shares THEN 1.0 ELSE 0.0 END) * 100, 1) as full_fill_pct,
  ROUND(AVG(CASE WHEN available_shares >= needed_shares * 0.5 THEN 1.0 ELSE 0.0 END) * 100, 1) as half_fill_pct,
  ROUND(AVG(CASE WHEN available_shares > 0 THEN needed_shares / NULLIF(available_shares, 0) ELSE 0 END) * 100, 1) as avg_fill_ratio_pct,
  ROUND(AVG(available_shares), 2) as avg_avail_shares,
  ROUND(AVG(needed_shares), 2) as avg_needed_shares
FROM down_sim
WHERE secs_left <= 10
GROUP BY 1, 2
ORDER BY side, bucket
`;
const r3 = await conn.runAndReadAll(q3);
console.table(r3.getRows());

// Q4: Simulate: if we add 1-tick slippage (buy at ask+0.01), how does it change PnL?
console.log('\n=== Q4: Slippage Impact - Buying at Ask+0.01 vs Ask ===');
const q4 = `
WITH event_pnl AS (
  SELECT 
    condition_id, event_start,
    EXTRACT(EPOCH FROM (event_end::TIMESTAMP - ts::TIMESTAMP)) as secs_left,
    ROW_NUMBER() OVER (PARTITION BY condition_id, event_start ORDER BY ts) as rn,
    -- Simulate: buy UP at ask, sell at end price
    up_best_ask,
    FIRST_VALUE(up_price) OVER (PARTITION BY condition_id, event_start ORDER BY ts DESC) as final_up_price,
    FIRST_VALUE(down_price) OVER (PARTITION BY condition_id, event_start ORDER BY ts DESC) as final_down_price
  FROM read_parquet([${fileList}])
  WHERE up_bid_sz_1 IS NOT NULL
)
SELECT 
  CASE 
    WHEN secs_left <= 1 THEN '0-1s'
    WHEN secs_left <= 3 THEN '1-3s'
    WHEN secs_left <= 5 THEN '3-5s'
    WHEN secs_left <= 10 THEN '5-10s'
    ELSE '10s+'
  END as bucket,
  COUNT(*) as trades,
  -- PnL buying at exact ask, selling at final
  ROUND(AVG((final_up_price - up_best_ask) / up_best_ask) * 100, 2) as pnl_pct_at_ask,
  -- PnL buying at ask+0.01 (1 cent slippage), selling at final
  ROUND(AVG((final_up_price - (up_best_ask + 0.01)) / up_best_ask) * 100, 2) as pnl_pct_at_slippage,
  -- PnL buying at ask+0.02 (2 cent slippage)
  ROUND(AVG((final_up_price - (up_best_ask + 0.02)) / up_best_ask) * 100, 2) as pnl_pct_at_slip2
FROM event_pnl
WHERE rn = 1 AND up_best_ask BETWEEN 0.25 AND 0.90 AND secs_left <= 10
GROUP BY 1
ORDER BY 1
`;
const r4 = await conn.runAndReadAll(q4);
console.table(r4.getRows());

await conn.close();
console.error('\nDone.');
