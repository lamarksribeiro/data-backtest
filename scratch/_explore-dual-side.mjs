/**
 * Exploratory dual-side market analysis on local lake (BTC 5m).
 * From 2026-05-04T15:00:00Z to max available.
 */
import { DuckDBInstance } from '@duckdb/node-api';

const GLOB = 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=*/*.parquet';
const FROM = '2026-05-04 15:00:00';
const FEE = 0.07;

function feePerShare(p) {
  return FEE * p * (1 - p);
}

async function q(conn, sql) {
  const r = await conn.runAndReadAll(sql);
  return r.getRowObjectsJson().map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])),
  );
}

const db = await DuckDBInstance.create(':memory:');
const conn = await db.connect();

console.log('=== COVERAGE ===');
const coverage = await q(conn, `
  SELECT
    count(*) AS ticks,
    count(DISTINCT condition_id) AS events,
    min(ts)::VARCHAR AS first_ts,
    max(ts)::VARCHAR AS last_ts,
    count(*) FILTER (WHERE up_ask_px_1 IS NOT NULL AND up_ask_px_1 > 0) AS ticks_up_ask,
    count(*) FILTER (WHERE down_ask_px_1 IS NOT NULL AND down_ask_px_1 > 0) AS ticks_down_ask,
    count(*) FILTER (
      WHERE up_ask_px_1 > 0 AND down_ask_px_1 > 0
        AND up_bid_px_1 > 0 AND down_bid_px_1 > 0
    ) AS ticks_both_books,
    count(*) FILTER (WHERE COALESCE(degraded, false) = false AND coverage >= 0.99) AS ticks_good_cov
  FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
  WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
`);
console.log(JSON.stringify(coverage[0], null, 2));

console.log('\n=== DAILY COVERAGE ===');
const daily = await q(conn, `
  SELECT
    CAST(ts AS DATE)::VARCHAR AS day,
    count(*) AS ticks,
    count(DISTINCT condition_id) AS events
  FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
  WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
  GROUP BY 1
  ORDER BY 1
`);
console.log(JSON.stringify(daily, null, 2));

console.log('\n=== ASK/BID SUM DISTRIBUTIONS (good ticks) ===');
const sums = await q(conn, `
  WITH base AS (
    SELECT
      up_ask_px_1 AS ua,
      down_ask_px_1 AS da,
      up_bid_px_1 AS ub,
      down_bid_px_1 AS db,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau
    FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
      AND COALESCE(degraded, false) = false
      AND coverage >= 0.99
      AND up_ask_px_1 BETWEEN 0.01 AND 0.99
      AND down_ask_px_1 BETWEEN 0.01 AND 0.99
      AND up_bid_px_1 BETWEEN 0.01 AND 0.99
      AND down_bid_px_1 BETWEEN 0.01 AND 0.99
  )
  SELECT
    count(*) AS n,
    avg(ua + da) AS avg_ask_sum,
    median(ua + da) AS med_ask_sum,
    quantile_cont(ua + da, 0.05) AS p05_ask_sum,
    quantile_cont(ua + da, 0.10) AS p10_ask_sum,
    quantile_cont(ua + da, 0.25) AS p25_ask_sum,
    quantile_cont(ua + da, 0.50) AS p50_ask_sum,
    quantile_cont(ua + da, 0.75) AS p75_ask_sum,
    quantile_cont(ua + da, 0.90) AS p90_ask_sum,
    min(ua + da) AS min_ask_sum,
    max(ua + da) AS max_ask_sum,
    avg(ub + db) AS avg_bid_sum,
    median(ub + db) AS med_bid_sum,
    quantile_cont(ub + db, 0.90) AS p90_bid_sum,
    quantile_cont(ub + db, 0.95) AS p95_bid_sum,
    max(ub + db) AS max_bid_sum,
    count(*) FILTER (WHERE ua + da < 1.0) AS ask_sum_lt_1,
    count(*) FILTER (WHERE ua + da < 0.98) AS ask_sum_lt_098,
    count(*) FILTER (WHERE ua + da < 0.95) AS ask_sum_lt_095,
    count(*) FILTER (WHERE ub + db > 1.0) AS bid_sum_gt_1,
    count(*) FILTER (WHERE ub + db > 1.02) AS bid_sum_gt_102
  FROM base
`);
console.log(JSON.stringify(sums[0], null, 2));

console.log('\n=== NET EDGE AFTER FEES (top-of-book, theoretical) ===');
const edges = await q(conn, `
  WITH base AS (
    SELECT
      condition_id,
      up_ask_px_1 AS ua,
      down_ask_px_1 AS da,
      up_bid_px_1 AS ub,
      down_bid_px_1 AS db,
      up_ask_sz_1 AS uas,
      down_ask_sz_1 AS das,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau,
      abs(underlying_price - price_to_beat) AS dist
    FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
      AND COALESCE(degraded, false) = false
      AND coverage >= 0.99
      AND up_ask_px_1 BETWEEN 0.01 AND 0.99
      AND down_ask_px_1 BETWEEN 0.01 AND 0.99
      AND up_bid_px_1 BETWEEN 0.01 AND 0.99
      AND down_bid_px_1 BETWEEN 0.01 AND 0.99
      AND up_ask_sz_1 > 0 AND down_ask_sz_1 > 0
      AND epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) BETWEEN 5 AND 290
  ),
  scored AS (
    SELECT *,
      1 - ua - da
        - ${FEE} * ua * (1 - ua)
        - ${FEE} * da * (1 - da) AS buy_net,
      ub + db - 1
        - ${FEE} * ub * (1 - ub)
        - ${FEE} * db * (1 - db) AS sell_net,
      ua + da AS ask_sum,
      least(uas, das) AS pair_size
    FROM base
  )
  SELECT
    count(*) AS n_ticks,
    count(DISTINCT condition_id) AS n_events,
    count(*) FILTER (WHERE buy_net > 0) AS ticks_arb_gross_after_fee,
    count(DISTINCT condition_id) FILTER (WHERE buy_net > 0) AS events_arb_after_fee,
    count(*) FILTER (WHERE buy_net >= 0.005) AS ticks_arb_5bp,
    count(DISTINCT condition_id) FILTER (WHERE buy_net >= 0.005) AS events_arb_5bp,
    count(*) FILTER (WHERE buy_net >= 0.01) AS ticks_arb_1c,
    count(DISTINCT condition_id) FILTER (WHERE buy_net >= 0.01) AS events_arb_1c,
    count(*) FILTER (WHERE sell_net > 0) AS ticks_sell_arb,
    count(DISTINCT condition_id) FILTER (WHERE sell_net > 0) AS events_sell_arb,
    max(buy_net) AS best_buy_net,
    max(sell_net) AS best_sell_net,
    avg(buy_net) AS avg_buy_net,
    quantile_cont(buy_net, 0.99) AS p99_buy_net,
    quantile_cont(buy_net, 0.999) AS p999_buy_net
  FROM scored
`);
console.log(JSON.stringify(edges[0], null, 2));

console.log('\n=== BUY NET BY TAU BUCKETS ===');
const byTau = await q(conn, `
  WITH base AS (
    SELECT
      condition_id,
      up_ask_px_1 AS ua,
      down_ask_px_1 AS da,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau
    FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
      AND COALESCE(degraded, false) = false
      AND coverage >= 0.99
      AND up_ask_px_1 BETWEEN 0.01 AND 0.99
      AND down_ask_px_1 BETWEEN 0.01 AND 0.99
      AND up_ask_sz_1 > 0 AND down_ask_sz_1 > 0
  ),
  scored AS (
    SELECT *,
      1 - ua - da
        - ${FEE} * ua * (1 - ua)
        - ${FEE} * da * (1 - da) AS buy_net,
      CASE
        WHEN tau > 240 THEN '240-300'
        WHEN tau > 180 THEN '180-240'
        WHEN tau > 120 THEN '120-180'
        WHEN tau > 60 THEN '60-120'
        WHEN tau > 30 THEN '30-60'
        WHEN tau > 15 THEN '15-30'
        WHEN tau > 5 THEN '5-15'
        ELSE '0-5'
      END AS tau_bucket
    FROM base
  )
  SELECT
    tau_bucket,
    count(*) AS ticks,
    count(*) FILTER (WHERE buy_net > 0) AS arb_ticks,
    count(DISTINCT condition_id) FILTER (WHERE buy_net > 0) AS arb_events,
    max(buy_net) AS best,
    avg(buy_net) AS avg_net,
    avg(ua + da) AS avg_ask_sum
  FROM scored
  GROUP BY 1
  ORDER BY 1
`);
console.log(JSON.stringify(byTau, null, 2));

console.log('\n=== CHEAP STRADDLE: ask_sum buckets + equal qty settlement floor ===');
// floor_if_equal = min(q,q)*1 - cost = q*(1 - avg_up - avg_down) roughly q*(1-ask_sum) for TOB
const straddle = await q(conn, `
  WITH base AS (
    SELECT
      condition_id,
      up_ask_px_1 AS ua,
      down_ask_px_1 AS da,
      abs(underlying_price - price_to_beat) AS dist,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau
    FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
      AND COALESCE(degraded, false) = false
      AND coverage >= 0.99
      AND up_ask_px_1 BETWEEN 0.05 AND 0.95
      AND down_ask_px_1 BETWEEN 0.05 AND 0.95
      AND up_ask_sz_1 >= 5 AND down_ask_sz_1 >= 5
      AND epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) BETWEEN 20 AND 280
  ),
  scored AS (
    SELECT *,
      ua + da AS ask_sum,
      1 - ua - da
        - ${FEE} * ua * (1 - ua)
        - ${FEE} * da * (1 - da) AS floor_net
    FROM base
  )
  SELECT
    CASE
      WHEN ask_sum < 0.95 THEN 'lt_0.95'
      WHEN ask_sum < 0.98 THEN '0.95-0.98'
      WHEN ask_sum < 1.00 THEN '0.98-1.00'
      WHEN ask_sum < 1.02 THEN '1.00-1.02'
      WHEN ask_sum < 1.05 THEN '1.02-1.05'
      WHEN ask_sum < 1.10 THEN '1.05-1.10'
      ELSE 'ge_1.10'
    END AS sum_bucket,
    count(*) AS ticks,
    count(DISTINCT condition_id) AS events,
    avg(floor_net) AS avg_floor_net,
    avg(dist) AS avg_dist,
    avg(tau) AS avg_tau
  FROM scored
  GROUP BY 1
  ORDER BY 1
`);
console.log(JSON.stringify(straddle, null, 2));

console.log('\n=== QUASI-ARB: worst-case near zero windows ===');
// After fees, floor_net in [-0.03, 0] is "controlled worst case" if hold to settlement with equal shares
const quasi = await q(conn, `
  WITH base AS (
    SELECT
      condition_id,
      up_ask_px_1 AS ua,
      down_ask_px_1 AS da,
      up_ask_sz_1 AS uas,
      down_ask_sz_1 AS das,
      abs(underlying_price - price_to_beat) AS dist,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau
    FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
      AND COALESCE(degraded, false) = false
      AND coverage >= 0.99
      AND up_ask_px_1 BETWEEN 0.10 AND 0.90
      AND down_ask_px_1 BETWEEN 0.10 AND 0.90
      AND up_ask_sz_1 >= 10 AND down_ask_sz_1 >= 10
      AND epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) BETWEEN 30 AND 240
  ),
  scored AS (
    SELECT *,
      1 - ua - da
        - ${FEE} * ua * (1 - ua)
        - ${FEE} * da * (1 - da) AS floor_net
    FROM base
  )
  SELECT
    count(DISTINCT condition_id) FILTER (WHERE floor_net >= 0) AS events_true_arb,
    count(DISTINCT condition_id) FILTER (WHERE floor_net >= -0.01 AND floor_net < 0) AS events_wc_1c,
    count(DISTINCT condition_id) FILTER (WHERE floor_net >= -0.02 AND floor_net < -0.01) AS events_wc_2c,
    count(DISTINCT condition_id) FILTER (WHERE floor_net >= -0.03 AND floor_net < -0.02) AS events_wc_3c,
    count(DISTINCT condition_id) FILTER (WHERE floor_net >= -0.05 AND floor_net < -0.03) AS events_wc_5c,
    avg(floor_net) AS avg_floor,
    quantile_cont(floor_net, 0.01) AS p01,
    quantile_cont(floor_net, 0.05) AS p05,
    quantile_cont(floor_net, 0.10) AS p10,
    quantile_cont(floor_net, 0.25) AS p25,
    max(floor_net) AS best
  FROM scored
`);
console.log(JSON.stringify(quasi[0], null, 2));

console.log('\n=== TEMPORAL FREE-ROLL SIGNAL: one cheap side + expansion potential ===');
// Moments where both sides mid-range, one ask is relatively cheap vs other,
// and later one bid can finance total cost (approx proxy via same-tick analysis first)
const freeroll = await q(conn, `
  WITH base AS (
    SELECT
      condition_id,
      ts,
      up_ask_px_1 AS ua,
      down_ask_px_1 AS da,
      up_bid_px_1 AS ub,
      down_bid_px_1 AS db,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau
    FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
      AND COALESCE(degraded, false) = false
      AND coverage >= 0.99
      AND up_ask_px_1 BETWEEN 0.15 AND 0.75
      AND down_ask_px_1 BETWEEN 0.15 AND 0.75
      AND up_bid_px_1 > 0 AND down_bid_px_1 > 0
  ),
  scored AS (
    SELECT *,
      ua + da AS ask_sum,
      greatest(ub, db) AS best_bid,
      -- if we bought equal qty at asks, can best single bid recover combined cost?
      greatest(ub, db) - (ua + da)
        - ${FEE} * ua * (1 - ua)
        - ${FEE} * da * (1 - da)
        - ${FEE} * greatest(ub, db) * (1 - greatest(ub, db)) AS same_tick_partial_recovery
    FROM base
  )
  SELECT
    count(*) FILTER (WHERE ask_sum < 1.02 AND tau BETWEEN 60 AND 200) AS cheapish_straddle_ticks,
    count(DISTINCT condition_id) FILTER (WHERE ask_sum < 1.02 AND tau BETWEEN 60 AND 200) AS cheapish_events,
    count(*) FILTER (WHERE same_tick_partial_recovery > -0.15 AND ask_sum < 1.05) AS near_recovery_ticks,
    avg(same_tick_partial_recovery) AS avg_same_tick_recovery_gap,
    quantile_cont(same_tick_partial_recovery, 0.90) AS p90_recovery_gap,
    quantile_cont(same_tick_partial_recovery, 0.99) AS p99_recovery_gap
  FROM scored
`);
console.log(JSON.stringify(freeroll[0], null, 2));

console.log('\n=== GAPS (largest inter-tick gaps) ===');
const gaps = await q(conn, `
  WITH ordered AS (
    SELECT
      condition_id,
      TRY_CAST(ts AS TIMESTAMP) AS ts,
      lag(TRY_CAST(ts AS TIMESTAMP)) OVER (PARTITION BY condition_id ORDER BY ts) AS prev_ts
    FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
  )
  SELECT
    max(epoch(ts) - epoch(prev_ts)) AS max_gap_s,
    quantile_cont(epoch(ts) - epoch(prev_ts), 0.99) AS p99_gap_s,
    quantile_cont(epoch(ts) - epoch(prev_ts), 0.999) AS p999_gap_s,
    avg(epoch(ts) - epoch(prev_ts)) AS avg_gap_s
  FROM ordered
  WHERE prev_ts IS NOT NULL
`);
console.log(JSON.stringify(gaps[0], null, 2));

console.log('\nDONE');
conn.closeSync();
