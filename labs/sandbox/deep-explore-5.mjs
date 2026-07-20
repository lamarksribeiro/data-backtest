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

// Pre-compute OBI helper as a macro-like expression
const UP_OBI_L2 = `(up_bid_sz_1 + up_bid_sz_2 - up_ask_sz_1 - up_ask_sz_2) / NULLIF(up_bid_sz_1 + up_bid_sz_2 + up_ask_sz_1 + up_ask_sz_2, 0)`;
const DOWN_OBI_L2 = `(down_bid_sz_1 + down_bid_sz_2 - down_ask_sz_1 - down_ask_sz_2) / NULLIF(down_bid_sz_1 + down_bid_sz_2 + down_ask_sz_1 + down_ask_sz_2, 0)`;

// =============================================================================
// Q1: Pre-Large-Move Signatures
// For top 1000 events with largest UP token range, at the tick where UP token
// is at its MINIMUM (before the big up move), what are the average market
// conditions? Compare with all events at their minimum tick.
// =============================================================================
console.log('\n=== Q1: Pre-Large-Move Signatures ===');

const q1 = `
WITH event_stats AS (
  SELECT
    condition_id,
    event_start,
    MIN(up_price) as min_up,
    MAX(up_price) as max_up,
    MAX(up_price) - MIN(up_price) as up_range,
    COUNT(*) as tick_count
  FROM read_parquet([${fileList}])
  GROUP BY condition_id, event_start
),
big_events AS (
  SELECT condition_id, event_start, min_up, up_range
  FROM event_stats
  ORDER BY up_range DESC
  LIMIT 1000
),
-- For big events: find the FIRST tick where up_price equals the event's minimum
big_min_ticks AS (
  SELECT
    t.condition_id,
    t.event_start,
    t.ts,
    t.underlying_price,
    t.price_to_beat,
    t.up_best_ask,
    t.up_best_bid,
    t.down_best_ask,
    t.down_best_bid,
    t.up_price,
    ABS(t.underlying_price - t.price_to_beat) as ptb_dist,
    (t.up_best_ask - t.up_best_bid) as up_spread,
    ${UP_OBI_L2} as up_obi,
    ${DOWN_OBI_L2} as down_obi,
    EXTRACT(EPOCH FROM (event_end::TIMESTAMP - t.ts::TIMESTAMP)) as secs_left,
    ROW_NUMBER() OVER (PARTITION BY t.condition_id, t.event_start ORDER BY t.ts) as rn
  FROM read_parquet([${fileList}]) t
  JOIN big_events b ON t.condition_id = b.condition_id AND t.event_start = b.event_start
  WHERE t.up_price = b.min_up
    AND t.up_bid_sz_1 IS NOT NULL
),
-- Only the FIRST minimum tick per event (the one before the big move up)
big_min_first AS (
  SELECT * FROM big_min_ticks WHERE rn = 1
),
-- For ALL events: find the first tick where up_price equals the event minimum
all_min_ticks AS (
  SELECT
    t.condition_id,
    t.event_start,
    t.ts,
    t.underlying_price,
    t.price_to_beat,
    t.up_best_ask,
    t.up_best_bid,
    t.down_best_ask,
    t.down_best_bid,
    ABS(t.underlying_price - t.price_to_beat) as ptb_dist,
    (t.up_best_ask - t.up_best_bid) as up_spread,
    ${UP_OBI_L2} as up_obi,
    ${DOWN_OBI_L2} as down_obi,
    EXTRACT(EPOCH FROM (event_end::TIMESTAMP - t.ts::TIMESTAMP)) as secs_left,
    ROW_NUMBER() OVER (PARTITION BY t.condition_id, t.event_start ORDER BY t.ts) as rn
  FROM read_parquet([${fileList}]) t
  JOIN event_stats e ON t.condition_id = e.condition_id AND t.event_start = e.event_start
  WHERE t.up_price = e.min_up
    AND t.up_bid_sz_1 IS NOT NULL
),
all_min_first AS (
  SELECT * FROM all_min_ticks WHERE rn = 1
)
SELECT 'BIG_1000' as cohort,
  COUNT(*) as events,
  ROUND(AVG(up_best_ask), 4) as avg_up_ask,
  ROUND(AVG(down_best_ask), 4) as avg_down_ask,
  ROUND(AVG(up_obi), 4) as avg_up_obi,
  ROUND(AVG(down_obi), 4) as avg_down_obi,
  ROUND(AVG(ptb_dist), 2) as avg_ptb_dist,
  ROUND(AVG(up_spread), 6) as avg_up_spread,
  ROUND(AVG(secs_left), 0) as avg_secs_left
FROM big_min_first
UNION ALL
SELECT 'ALL_EVENTS' as cohort,
  COUNT(*) as events,
  ROUND(AVG(up_best_ask), 4) as avg_up_ask,
  ROUND(AVG(down_best_ask), 4) as avg_down_ask,
  ROUND(AVG(up_obi), 4) as avg_up_obi,
  ROUND(AVG(down_obi), 4) as avg_down_obi,
  ROUND(AVG(ptb_dist), 2) as avg_ptb_dist,
  ROUND(AVG(up_spread), 6) as avg_up_spread,
  ROUND(AVG(secs_left), 0) as avg_secs_left
FROM all_min_first
`;
const r1 = await conn.runAndReadAll(q1);
console.log('Pre-Large-Move Signatures:');
console.table(r1.getRows());

// =============================================================================
// Q2: Token Acceleration
// Find ticks where UP token price change over 5 ticks is >3x the average
// 5-tick change per event. What happens in next 30 ticks?
// =============================================================================
console.log('\n=== Q2: Token Acceleration ===');

const q2 = `
WITH tick_data AS (
  SELECT
    condition_id,
    event_start,
    ts,
    up_price,
    down_price,
    LAG(up_price, 5) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as up_lag5,
    LEAD(up_price, 30) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as up_lead30,
    LEAD(down_price, 30) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as down_lead30
  FROM read_parquet([${fileList}])
),
tick_changes AS (
  SELECT *,
    up_price - up_lag5 as up_change_5t
  FROM tick_data
  WHERE up_lag5 IS NOT NULL
),
event_avg AS (
  SELECT
    condition_id,
    event_start,
    AVG(ABS(up_change_5t)) as avg_abs_5t_change
  FROM tick_changes
  GROUP BY condition_id, event_start
),
acceleration_ticks AS (
  SELECT
    t.*,
    t.up_change_5t,
    e.avg_abs_5t_change
  FROM tick_changes t
  JOIN event_avg e ON t.condition_id = e.condition_id AND t.event_start = e.event_start
  WHERE ABS(t.up_change_5t) > 3.0 * e.avg_abs_5t_change
    AND e.avg_abs_5t_change > 0
)
SELECT
  COUNT(*) as signal_count,
  ROUND(AVG(up_lead30 - up_price), 6) as avg_up_change_30t,
  ROUND(AVG(down_lead30 - down_price), 6) as avg_down_change_30t,
  ROUND(AVG(ABS(up_lead30 - up_price)), 6) as avg_abs_up_change_30t,
  ROUND(AVG(CASE WHEN (up_lead30 - up_price) > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as up_win_pct,
  ROUND(AVG(CASE WHEN (down_lead30 - down_price) > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as down_win_pct,
  ROUND(AVG(CASE WHEN up_change_5t > 0 AND (up_lead30 - up_price) > 0 THEN 1.0
                 WHEN up_change_5t < 0 AND (up_lead30 - up_price) < 0 THEN 1.0
                 ELSE 0.0 END) * 100, 1) as momentum_continue_pct,
  ROUND(AVG(CASE WHEN up_change_5t > 0 AND (up_lead30 - up_price) < 0 THEN 1.0
                 WHEN up_change_5t < 0 AND (up_lead30 - up_price) > 0 THEN 1.0
                 ELSE 0.0 END) * 100, 1) as momentum_reverse_pct
FROM acceleration_ticks
WHERE up_lead30 IS NOT NULL
`;
const r2 = await conn.runAndReadAll(q2);
console.log('Token Acceleration Signals:');
console.table(r2.getRows());

// Bonus: directional breakdown
const q2b = `
WITH tick_data AS (
  SELECT
    condition_id, event_start, ts, up_price, down_price,
    LAG(up_price, 5) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as up_lag5,
    LEAD(up_price, 30) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as up_lead30,
    LEAD(down_price, 30) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as down_lead30
  FROM read_parquet([${fileList}])
),
tick_changes AS (
  SELECT *, up_price - up_lag5 as up_change_5t
  FROM tick_data WHERE up_lag5 IS NOT NULL
),
event_avg AS (
  SELECT condition_id, event_start, AVG(ABS(up_change_5t)) as avg_abs_5t_change
  FROM tick_changes GROUP BY condition_id, event_start
),
accel AS (
  SELECT t.*, CASE WHEN t.up_change_5t > 0 THEN 'ACCEL_UP' ELSE 'ACCEL_DOWN' END as direction
  FROM tick_changes t
  JOIN event_avg e ON t.condition_id = e.condition_id AND t.event_start = e.event_start
  WHERE ABS(t.up_change_5t) > 3.0 * e.avg_abs_5t_change AND e.avg_abs_5t_change > 0
)
SELECT
  direction,
  COUNT(*) as ticks,
  ROUND(AVG(up_lead30 - up_price), 6) as avg_up_change_30t,
  ROUND(AVG(down_lead30 - down_price), 6) as avg_down_change_30t,
  ROUND(AVG(CASE WHEN (up_lead30 - up_price) > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as up_win_pct
FROM accel WHERE up_lead30 IS NOT NULL
GROUP BY direction
ORDER BY direction
`;
const r2b = await conn.runAndReadAll(q2b);
console.log('Directional Breakdown:');
console.table(r2b.getRows());

// =============================================================================
// Q3: Spread Explosion
// Find ticks where spread (up_best_ask - up_best_bid) increases by >50%
// vs 30-tick rolling average. What happens to token prices in next 60 ticks?
// =============================================================================
console.log('\n=== Q3: Spread Explosion ===');

const q3 = `
WITH tick_spreads AS (
  SELECT
    condition_id, event_start, ts, up_price, down_price,
    (up_best_ask - up_best_bid) as up_spread,
    LAG(up_spread, 0) OVER spread_win as cur_spread_val
  FROM read_parquet([${fileList}])
  WHERE up_best_ask IS NOT NULL AND up_best_bid IS NOT NULL
  WINDOW spread_win AS (PARTITION BY condition_id, event_start ORDER BY ts)
),
spread_with_rolling AS (
  SELECT *,
    AVG(up_spread) OVER (PARTITION BY condition_id, event_start ORDER BY ts ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) as rolling_avg_spread,
    LEAD(up_price, 60) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as up_lead60,
    LEAD(down_price, 60) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as down_lead60,
    LEAD(up_spread, 60) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as spread_lead60
  FROM tick_spreads
),
spread_explosions AS (
  SELECT *
  FROM spread_with_rolling
  WHERE rolling_avg_spread IS NOT NULL
    AND rolling_avg_spread > 0
    AND up_spread > 1.5 * rolling_avg_spread
)
SELECT
  COUNT(*) as explosion_count,
  ROUND(AVG(up_spread), 6) as avg_spread_at_signal,
  ROUND(AVG(rolling_avg_spread), 6) as avg_rolling_spread,
  ROUND(AVG(up_spread / rolling_avg_spread), 2) as avg_spread_ratio,
  ROUND(AVG(up_lead60 - up_price), 6) as avg_up_change_60t,
  ROUND(AVG(down_lead60 - down_price), 6) as avg_down_change_60t,
  ROUND(AVG(CASE WHEN (up_lead60 - up_price) > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as up_win_pct,
  ROUND(AVG(CASE WHEN (down_lead60 - down_price) > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as down_win_pct,
  ROUND(AVG(spread_lead60 - up_spread), 6) as avg_spread_change_60t
FROM spread_explosions
WHERE up_lead60 IS NOT NULL
`;
const r3 = await conn.runAndReadAll(q3);
console.log('Spread Explosion Signals:');
console.table(r3.getRows());

// Q3b: Severity breakdown
const q3b = `
WITH tick_spreads AS (
  SELECT
    condition_id, event_start, ts, up_price, down_price,
    (up_best_ask - up_best_bid) as up_spread,
    LEAD(up_price, 60) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as up_lead60,
    LEAD(down_price, 60) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as down_lead60
  FROM read_parquet([${fileList}])
  WHERE up_best_ask IS NOT NULL AND up_best_bid IS NOT NULL
),
spread_with_rolling AS (
  SELECT *,
    AVG(up_spread) OVER (PARTITION BY condition_id, event_start ORDER BY ts ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) as rolling_avg_spread
  FROM tick_spreads
),
explosions AS (
  SELECT *,
    up_spread / NULLIF(rolling_avg_spread, 0) as ratio
  FROM spread_with_rolling
  WHERE rolling_avg_spread IS NOT NULL AND rolling_avg_spread > 0 AND up_spread > 1.5 * rolling_avg_spread
)
SELECT
  CASE
    WHEN ratio < 2.0 THEN '1.5x-2x'
    WHEN ratio < 3.0 THEN '2x-3x'
    WHEN ratio < 5.0 THEN '3x-5x'
    ELSE '5x+'
  END as severity,
  COUNT(*) as ticks,
  ROUND(AVG(up_lead60 - up_price), 6) as avg_up_change_60t,
  ROUND(AVG(CASE WHEN (up_lead60 - up_price) > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as up_win_pct
FROM explosions
WHERE up_lead60 IS NOT NULL
GROUP BY 1
ORDER BY 1
`;
const r3b = await conn.runAndReadAll(q3b);
console.log('Spread Explosion by Severity:');
console.table(r3b.getRows());

// =============================================================================
// Q4: PTB Convergence Speed
// Compute the RATE at which the underlying approaches PTB (spot - ptb over
// last 30 ticks). When rate > $10/30ticks, what happens to UP/DOWN tokens?
// =============================================================================
console.log('\n=== Q4: PTB Convergence Speed ===');

const q4 = `
WITH ptb_data AS (
  SELECT
    condition_id, event_start, ts, up_price, down_price,
    underlying_price, price_to_beat,
    (underlying_price - price_to_beat) as ptb_diff,
    LAG(underlying_price - price_to_beat, 30) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as ptb_diff_lag30,
    LEAD(up_price, 30) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as up_lead30,
    LEAD(down_price, 30) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as down_lead30
  FROM read_parquet([${fileList}])
),
with_rate AS (
  SELECT *,
    (ptb_diff_lag30 - ptb_diff) as approach_rate_30t
  FROM ptb_data
  WHERE ptb_diff_lag30 IS NOT NULL
)
SELECT
  CASE
    WHEN approach_rate_30t > 50 THEN '50+'
    WHEN approach_rate_30t > 20 THEN '20-50'
    WHEN approach_rate_30t > 10 THEN '10-20'
    WHEN approach_rate_30t > 0 THEN '0-10'
    WHEN approach_rate_30t > -10 THEN '-10-0'
    WHEN approach_rate_30t > -20 THEN '-20--10'
    ELSE '<-20'
  END as rate_bucket,
  COUNT(*) as ticks,
  ROUND(AVG(approach_rate_30t), 2) as avg_approach_rate,
  ROUND(AVG(up_lead30 - up_price), 6) as avg_up_change_30t,
  ROUND(AVG(down_lead30 - down_price), 6) as avg_down_change_30t,
  ROUND(AVG(CASE WHEN (up_lead30 - up_price) > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as up_win_pct,
  ROUND(AVG(CASE WHEN (down_lead30 - down_price) > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as down_win_pct
FROM with_rate
WHERE up_lead30 IS NOT NULL AND down_lead30 IS NOT NULL
GROUP BY 1
ORDER BY 1
`;
const r4 = await conn.runAndReadAll(q4);
console.log('PTB Convergence Speed:');
console.table(r4.getRows());

// Q4b: High-rate only summary
const q4b = `
WITH ptb_data AS (
  SELECT
    condition_id, event_start, ts, up_price, down_price,
    underlying_price, price_to_beat,
    (underlying_price - price_to_beat) as ptb_diff,
    LAG(underlying_price - price_to_beat, 30) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as ptb_diff_lag30,
    LEAD(up_price, 30) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as up_lead30,
    LEAD(down_price, 30) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as down_lead30
  FROM read_parquet([${fileList}])
),
high_rate AS (
  SELECT *
  FROM ptb_data
  WHERE ptb_diff_lag30 IS NOT NULL
    AND (ptb_diff_lag30 - ptb_diff) > 10
)
SELECT
  COUNT(*) as high_rate_ticks,
  ROUND(AVG(ptb_diff_lag30 - ptb_diff), 2) as avg_approach_rate,
  ROUND(AVG(ptb_diff), 2) as avg_current_ptb_dist,
  ROUND(AVG(up_lead30 - up_price), 6) as avg_up_change_30t,
  ROUND(AVG(down_lead30 - down_price), 6) as avg_down_change_30t,
  ROUND(AVG(CASE WHEN ptb_diff > 0 AND (up_lead30 - up_price) > 0 THEN 1.0
                 WHEN ptb_diff < 0 AND (up_lead30 - up_price) < 0 THEN 1.0
                 ELSE 0.0 END) * 100, 1) as convergence_aligned_pct
FROM high_rate
WHERE up_lead30 IS NOT NULL
`;
const r4b = await conn.runAndReadAll(q4b);
console.log('High PTB Convergence (>$10/30t):');
console.table(r4b.getRows());

// =============================================================================
// Q5: Volatility Breakout
// Compute rolling 30-tick stddev of underlying. When current vol > 2x rolling
// vol, what happens to tokens?
// =============================================================================
console.log('\n=== Q5: Volatility Breakout ===');

const q5 = `
WITH vol_data AS (
  SELECT
    condition_id, event_start, ts, up_price, down_price, underlying_price,
    underlying_price - LAG(underlying_price, 1) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as spot_return,
    LEAD(up_price, 30) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as up_lead30,
    LEAD(down_price, 30) OVER (PARTITION BY condition_id, event_start ORDER BY ts) as down_lead30
  FROM read_parquet([${fileList}])
),
rolling_vol AS (
  SELECT *,
    STDDEV_SAMP(spot_return) OVER (PARTITION BY condition_id, event_start ORDER BY ts ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) as rolling_stddev
  FROM vol_data
  WHERE spot_return IS NOT NULL
),
breakouts AS (
  SELECT *,
    ABS(spot_return) / NULLIF(rolling_stddev, 0) as vol_ratio
  FROM rolling_vol
  WHERE rolling_stddev IS NOT NULL AND rolling_stddev > 0
)
SELECT
  CASE
    WHEN vol_ratio >= 5.0 THEN '5x+'
    WHEN vol_ratio >= 3.0 THEN '3x-5x'
    WHEN vol_ratio >= 2.0 THEN '2x-3x'
    WHEN vol_ratio >= 1.5 THEN '1.5x-2x'
    ELSE '1x-1.5x'
  END as vol_bucket,
  COUNT(*) as ticks,
  ROUND(AVG(ABS(spot_return)), 4) as avg_abs_return,
  ROUND(AVG(rolling_stddev), 4) as avg_rolling_stddev,
  ROUND(AVG(up_lead30 - up_price), 6) as avg_up_change_30t,
  ROUND(AVG(down_lead30 - down_price), 6) as avg_down_change_30t,
  ROUND(AVG(CASE WHEN (up_lead30 - up_price) > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as up_win_pct,
  ROUND(AVG(CASE WHEN (down_lead30 - down_price) > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as down_win_pct
FROM breakouts
WHERE up_lead30 IS NOT NULL
GROUP BY 1
ORDER BY 1
`;
const r5 = await conn.runAndReadAll(q5);
console.log('Volatility Breakout:');
console.table(r5.getRows());

// Q5b: 2x+ breakout summary with directional detail
const q5b = `
WITH vol_data AS (
  SELECT
    condition_id, event_start, ts, up_price, down_price, underlying_price,
    underlying_price - LAG(underlying_price, 1) OVER w as spot_return,
    LEAD(up_price, 30) OVER w as up_lead30,
    LEAD(down_price, 30) OVER w as down_lead30
  FROM read_parquet([${fileList}])
  WINDOW w AS (PARTITION BY condition_id, event_start ORDER BY ts)
),
rolling_vol AS (
  SELECT *,
    STDDEV_SAMP(spot_return) OVER (PARTITION BY condition_id, event_start ORDER BY ts ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) as rolling_stddev
  FROM vol_data
  WHERE spot_return IS NOT NULL
),
breakouts AS (
  SELECT *,
    ABS(spot_return) / NULLIF(rolling_stddev, 0) as vol_ratio,
    CASE WHEN spot_return > 0 THEN 'UP' ELSE 'DOWN' END as direction
  FROM rolling_vol
  WHERE rolling_stddev IS NOT NULL AND rolling_stddev > 0 AND ABS(spot_return) / NULLIF(rolling_stddev, 0) >= 2.0
)
SELECT
  direction,
  COUNT(*) as ticks,
  ROUND(AVG(ABS(spot_return)), 4) as avg_shock_size,
  ROUND(AVG(rolling_stddev), 4) as avg_prior_vol,
  ROUND(AVG(up_lead30 - up_price), 6) as avg_up_change_30t,
  ROUND(AVG(down_lead30 - down_price), 6) as avg_down_change_30t,
  ROUND(AVG(CASE WHEN direction = 'UP' AND (up_lead30 - up_price) > 0 THEN 1.0
                 WHEN direction = 'DOWN' AND (down_lead30 - down_price) > 0 THEN 1.0
                 ELSE 0.0 END) * 100, 1) as aligned_win_pct
FROM breakouts
WHERE up_lead30 IS NOT NULL
GROUP BY direction
ORDER BY direction
`;
const r5b = await conn.runAndReadAll(q5b);
console.log('Vol Breakout (2x+) Directional:');
console.table(r5b.getRows());

// =============================================================================
// Q5c: Quick cross-validation: When vol breakout AND large PTB convergence
// happen together, what's the combined effect?
// =============================================================================
console.log('\n=== Q5c: Combined Signal: Vol Breakout + PTB Convergence ===');

const q5c = `
WITH combined AS (
  SELECT
    condition_id, event_start, ts, up_price, down_price, underlying_price, price_to_beat,
    underlying_price - LAG(underlying_price, 1) OVER w as spot_return,
    LAG(underlying_price - price_to_beat, 30) OVER w as ptb_diff_lag30,
    (underlying_price - price_to_beat) as ptb_diff,
    LEAD(up_price, 30) OVER w as up_lead30,
    LEAD(down_price, 30) OVER w as down_lead30
  FROM read_parquet([${fileList}])
  WINDOW w AS (PARTITION BY condition_id, event_start ORDER BY ts)
),
with_metrics AS (
  SELECT *,
    STDDEV_SAMP(spot_return) OVER (PARTITION BY condition_id, event_start ORDER BY ts ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) as rolling_stddev,
    (ptb_diff_lag30 - ptb_diff) as approach_rate
  FROM combined
  WHERE spot_return IS NOT NULL AND ptb_diff_lag30 IS NOT NULL
),
signals AS (
  SELECT *,
    CASE WHEN ABS(spot_return) / NULLIF(rolling_stddev, 0) >= 2.0 THEN 1 ELSE 0 END as vol_breakout,
    CASE WHEN (ptb_diff_lag30 - ptb_diff) > 10 THEN 1 ELSE 0 END as ptb_converging
  FROM with_metrics
  WHERE rolling_stddev IS NOT NULL AND rolling_stddev > 0
)
SELECT
  CASE
    WHEN vol_breakout = 1 AND ptb_converging = 1 THEN 'BOTH_SIGNALS'
    WHEN vol_breakout = 1 THEN 'VOL_ONLY'
    WHEN ptb_converging = 1 THEN 'PTB_CONV_ONLY'
    ELSE 'NEITHER'
  END as signal_combo,
  COUNT(*) as ticks,
  ROUND(AVG(up_lead30 - up_price), 6) as avg_up_change_30t,
  ROUND(AVG(down_lead30 - down_price), 6) as avg_down_change_30t,
  ROUND(AVG(CASE WHEN (up_lead30 - up_price) > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as up_win_pct,
  ROUND(AVG(CASE WHEN (down_lead30 - down_price) > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as down_win_pct
FROM signals
WHERE up_lead30 IS NOT NULL
GROUP BY 1
ORDER BY 1
`;
const r5c = await conn.runAndReadAll(q5c);
console.log('Combined Signals (Vol + PTB):');
console.table(r5c.getRows());

try { await conn.close(); } catch {}
console.error('\nDone.');
