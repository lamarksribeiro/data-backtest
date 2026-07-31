/**
 * Path-dependent dual-side opportunity probes.
 * 1) Inspect true arb candidates for data quality
 * 2) Temporal free-roll: dual entry then later bid recovery
 * 3) Sequential lock completion rates
 */
import { DuckDBInstance } from '@duckdb/node-api';

const GLOB = 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=*/*.parquet';
const FROM = '2026-05-04 15:00:00';
const FEE = 0.07;

async function q(conn, sql) {
  const r = await conn.runAndReadAll(sql);
  return r.getRowObjectsJson().map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])),
  );
}

const db = await DuckDBInstance.create(':memory:');
const conn = await db.connect();

console.log('=== TRUE ARB CANDIDATES (inspect quality) ===');
const arbs = await q(conn, `
  WITH base AS (
    SELECT
      condition_id,
      ts::VARCHAR AS ts,
      up_ask_px_1 AS ua, down_ask_px_1 AS da,
      up_bid_px_1 AS ub, down_bid_px_1 AS db,
      up_ask_sz_1 AS uas, down_ask_sz_1 AS das,
      up_ask_px_1 - up_bid_px_1 AS usp,
      down_ask_px_1 - down_bid_px_1 AS dsp,
      abs(underlying_price - price_to_beat) AS dist,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau,
      1 - up_ask_px_1 - down_ask_px_1
        - ${FEE}*up_ask_px_1*(1-up_ask_px_1)
        - ${FEE}*down_ask_px_1*(1-down_ask_px_1) AS buy_net
    FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
      AND COALESCE(degraded, false) = false
      AND coverage >= 0.99
      AND up_ask_px_1 BETWEEN 0.01 AND 0.99
      AND down_ask_px_1 BETWEEN 0.01 AND 0.99
      AND up_ask_sz_1 > 0 AND down_ask_sz_1 > 0
  )
  SELECT *
  FROM base
  WHERE buy_net >= 0.005
  ORDER BY buy_net DESC
  LIMIT 40
`);
console.log(JSON.stringify(arbs, null, 2));

console.log('\n=== PATH FREE-ROLL: dual buy then later max recovery ===');
const freeroll2 = await q(conn, `
  WITH ticks AS (
    SELECT
      condition_id,
      TRY_CAST(ts AS TIMESTAMP) AS ts,
      up_ask_px_1 AS ua,
      down_ask_px_1 AS da,
      up_bid_px_1 AS ub,
      down_bid_px_1 AS db,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau,
      abs(underlying_price - price_to_beat) AS dist
    FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
      AND COALESCE(degraded, false) = false
      AND coverage >= 0.99
      AND up_ask_px_1 BETWEEN 0.05 AND 0.95
      AND down_ask_px_1 BETWEEN 0.05 AND 0.95
      AND up_bid_px_1 > 0 AND down_bid_px_1 > 0
      AND up_ask_sz_1 >= 5 AND down_ask_sz_1 >= 5
      AND up_ask_px_1 - up_bid_px_1 <= 0.06
      AND down_ask_px_1 - down_bid_px_1 <= 0.06
      AND epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) BETWEEN 20 AND 250
  ),
  scored AS (
    SELECT *,
      ua + da AS ask_sum,
      ua + ${FEE}*ua*(1-ua) + da + ${FEE}*da*(1-da) AS all_in_cost
    FROM ticks
  ),
  entries AS (
    SELECT *
    FROM (
      SELECT
        *,
        row_number() OVER (PARTITION BY condition_id ORDER BY ts) AS rn
      FROM scored
      WHERE ask_sum <= 1.015
        AND ua BETWEEN 0.30 AND 0.68
        AND da BETWEEN 0.30 AND 0.68
        AND tau BETWEEN 50 AND 180
    ) x
    WHERE rn = 1
  ),
  futures AS (
    SELECT
      e.condition_id,
      e.ts AS entry_ts,
      e.tau AS entry_tau,
      e.ua AS entry_ua,
      e.da AS entry_da,
      e.ask_sum,
      e.all_in_cost,
      e.dist AS entry_dist,
      max(t.ub) AS max_ub_after,
      max(t.db) AS max_db_after,
      max(greatest(t.ub, t.db)) AS max_best_bid_after,
      max(t.ub + t.db) AS max_bid_sum_after,
      max(
        CASE WHEN t.ts > e.ts THEN t.ub ELSE NULL END
      ) AS max_ub_strict,
      max(
        CASE WHEN t.ts > e.ts THEN t.db ELSE NULL END
      ) AS max_db_strict
    FROM entries e
    JOIN ticks t ON t.condition_id = e.condition_id AND t.ts >= e.ts
    GROUP BY 1,2,3,4,5,6,7,8
  )
  SELECT
    count(*) AS events_entered,
    avg(all_in_cost) AS avg_all_in_cost,
    avg(ask_sum) AS avg_ask_sum,
    -- free-roll if one leg bid alone recovers all-in cost of BOTH legs (per share pair)
    count(*) FILTER (WHERE max_best_bid_after >= all_in_cost) AS freeroll_one_leg,
    count(*) FILTER (WHERE max_best_bid_after >= all_in_cost + 0.02) AS freeroll_plus2c,
    -- lock if selling BOTH bids recovers cost
    count(*) FILTER (
      WHERE max_bid_sum_after
        - ${FEE}*0.5*(1-0.5)*2  -- rough exit fee proxy at mid
        >= all_in_cost
    ) AS dual_bid_lock_rough,
    count(*) FILTER (WHERE max_ub_strict >= all_in_cost OR max_db_strict >= all_in_cost) AS freeroll_strict_after,
    avg(max_best_bid_after - all_in_cost) AS avg_best_bid_minus_cost,
    quantile_cont(max_best_bid_after - all_in_cost, 0.5) AS med_best_bid_minus_cost,
    quantile_cont(max_best_bid_after - all_in_cost, 0.9) AS p90_best_bid_minus_cost,
    avg(max_bid_sum_after - all_in_cost) AS avg_bid_sum_minus_cost,
    -- settlement floor if hold equal
    avg(1.0 - all_in_cost) AS avg_settlement_floor
  FROM futures
`);
console.log(JSON.stringify(freeroll2[0], null, 2));

console.log('\n=== FREE-ROLL BY ASK_SUM THRESHOLD ===');
const byThresh = await q(conn, `
  WITH ticks AS (
    SELECT
      condition_id,
      TRY_CAST(ts AS TIMESTAMP) AS ts,
      up_ask_px_1 AS ua,
      down_ask_px_1 AS da,
      up_bid_px_1 AS ub,
      down_bid_px_1 AS db,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau
    FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
      AND COALESCE(degraded, false) = false
      AND coverage >= 0.99
      AND up_ask_px_1 BETWEEN 0.20 AND 0.80
      AND down_ask_px_1 BETWEEN 0.20 AND 0.80
      AND up_bid_px_1 > 0 AND down_bid_px_1 > 0
      AND up_ask_sz_1 >= 5 AND down_ask_sz_1 >= 5
      AND up_ask_px_1 - up_bid_px_1 <= 0.05
      AND down_ask_px_1 - down_bid_px_1 <= 0.05
      AND epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) BETWEEN 30 AND 220
  ),
  scored AS (
    SELECT *,
      ua + da AS ask_sum,
      ua + ${FEE}*ua*(1-ua) + da + ${FEE}*da*(1-da) AS all_in_cost
    FROM ticks
  ),
  thresholds AS (
    SELECT * FROM (VALUES (1.005), (1.010), (1.015), (1.020), (1.025), (1.030)) AS t(max_sum)
  ),
  entries AS (
    SELECT s.*, th.max_sum,
      row_number() OVER (PARTITION BY s.condition_id, th.max_sum ORDER BY s.ts) AS rn
    FROM scored s
    CROSS JOIN thresholds th
    WHERE s.ask_sum <= th.max_sum
      AND s.ua BETWEEN 0.28 AND 0.70
      AND s.da BETWEEN 0.28 AND 0.70
      AND s.tau BETWEEN 50 AND 180
  ),
  first_entries AS (
    SELECT * FROM entries WHERE rn = 1
  ),
  futures AS (
    SELECT
      e.max_sum,
      e.condition_id,
      e.all_in_cost,
      e.ask_sum,
      max(CASE WHEN t.ts > e.ts THEN greatest(t.ub, t.db) END) AS max_best_bid_after,
      max(CASE WHEN t.ts > e.ts THEN t.ub + t.db END) AS max_bid_sum_after
    FROM first_entries e
    JOIN ticks t ON t.condition_id = e.condition_id AND t.ts >= e.ts
    GROUP BY 1,2,3,4
  )
  SELECT
    max_sum,
    count(*) AS events,
    avg(all_in_cost) AS avg_cost,
    avg(1 - all_in_cost) AS avg_hold_floor,
    count(*) FILTER (WHERE max_best_bid_after >= all_in_cost) AS freeroll_n,
    round(100.0 * count(*) FILTER (WHERE max_best_bid_after >= all_in_cost) / count(*), 2) AS freeroll_pct,
    count(*) FILTER (WHERE max_bid_sum_after >= all_in_cost + 0.02) AS dual_lock_n,
    round(100.0 * count(*) FILTER (WHERE max_bid_sum_after >= all_in_cost + 0.02) / count(*), 2) AS dual_lock_pct,
    avg(max_best_bid_after - all_in_cost) AS avg_leg_gap,
    avg(max_bid_sum_after - all_in_cost) AS avg_dual_gap
  FROM futures
  GROUP BY 1
  ORDER BY 1
`);
console.log(JSON.stringify(byThresh, null, 2));

console.log('\n=== SEQUENTIAL LOCK: open cheap first, complete on pullback ===');
// For each event: open when min(ua,da) <= 0.45 and other in [0.50, 0.75], tau 60-200
// then complete if other ask drops so that avg_sum + fees leave floor_net >= minEdge
const seq = await q(conn, `
  WITH ticks AS (
    SELECT
      condition_id,
      TRY_CAST(ts AS TIMESTAMP) AS ts,
      up_ask_px_1 AS ua,
      down_ask_px_1 AS da,
      up_bid_px_1 AS ub,
      down_bid_px_1 AS db,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau
    FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
      AND COALESCE(degraded, false) = false
      AND coverage >= 0.99
      AND up_ask_px_1 BETWEEN 0.05 AND 0.95
      AND down_ask_px_1 BETWEEN 0.05 AND 0.95
      AND up_ask_sz_1 >= 5 AND down_ask_sz_1 >= 5
      AND epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) BETWEEN 10 AND 280
  ),
  opens AS (
    SELECT *
    FROM (
      SELECT
        condition_id, ts, ua, da, ub, db, tau,
        CASE WHEN ua <= da THEN 'UP' ELSE 'DOWN' END AS open_side,
        least(ua, da) AS open_ask,
        greatest(ua, da) AS other_ask,
        row_number() OVER (PARTITION BY condition_id ORDER BY ts) AS rn
      FROM ticks
      WHERE least(ua, da) <= 0.48
        AND greatest(ua, da) BETWEEN 0.48 AND 0.72
        AND tau BETWEEN 70 AND 200
        AND ua + da BETWEEN 0.95 AND 1.08
    ) x
    WHERE rn = 1
  ),
  completes AS (
    SELECT
      o.condition_id,
      o.open_side,
      o.open_ask,
      o.other_ask AS other_at_open,
      o.tau AS open_tau,
      o.ts AS open_ts,
      min(
        CASE
          WHEN t.ts > o.ts AND (
            CASE WHEN o.open_side = 'UP' THEN t.da ELSE t.ua END
          ) > 0 THEN
            1 - o.open_ask - (CASE WHEN o.open_side = 'UP' THEN t.da ELSE t.ua END)
              - ${FEE}*o.open_ask*(1-o.open_ask)
              - ${FEE}*(CASE WHEN o.open_side = 'UP' THEN t.da ELSE t.ua END)
                *(1-(CASE WHEN o.open_side = 'UP' THEN t.da ELSE t.ua END))
          ELSE NULL
        END
      ) AS best_lock_net_after, -- actually want MAX lock net
      max(
        CASE
          WHEN t.ts > o.ts THEN
            1 - o.open_ask - (CASE WHEN o.open_side = 'UP' THEN t.da ELSE t.ua END)
              - ${FEE}*o.open_ask*(1-o.open_ask)
              - ${FEE}*(CASE WHEN o.open_side = 'UP' THEN t.da ELSE t.ua END)
                *(1-(CASE WHEN o.open_side = 'UP' THEN t.da ELSE t.ua END))
          ELSE NULL
        END
      ) AS best_lock_net,
      min(
        CASE WHEN t.ts > o.ts THEN (CASE WHEN o.open_side = 'UP' THEN t.da ELSE t.ua END) END
      ) AS min_other_ask_after,
      max(
        CASE WHEN t.ts > o.ts AND t.tau >= 15 THEN
          CASE WHEN o.open_side = 'UP' THEN t.ub ELSE t.db END
        END
      ) AS max_open_side_bid
    FROM opens o
    JOIN ticks t ON t.condition_id = o.condition_id AND t.ts >= o.ts
    GROUP BY 1,2,3,4,5,6
  )
  SELECT
    count(*) AS events_opened,
    count(*) FILTER (WHERE best_lock_net >= 0.0) AS lock_ge_0,
    count(*) FILTER (WHERE best_lock_net >= 0.005) AS lock_ge_5bp,
    count(*) FILTER (WHERE best_lock_net >= 0.01) AS lock_ge_1c,
    round(100.0 * count(*) FILTER (WHERE best_lock_net >= 0.005) / count(*), 2) AS lock_5bp_pct,
    avg(best_lock_net) AS avg_best_lock,
    quantile_cont(best_lock_net, 0.5) AS med_best_lock,
    quantile_cont(best_lock_net, 0.9) AS p90_best_lock,
    avg(min_other_ask_after) AS avg_min_other,
    -- residual dump salvage: open side bid recovers open cost
    count(*) FILTER (WHERE max_open_side_bid >= open_ask) AS open_side_salvageable,
    avg(max_open_side_bid - open_ask) AS avg_open_bid_minus_cost
  FROM completes
`);
console.log(JSON.stringify(seq[0], null, 2));

console.log('\n=== VOL-STRADDLE: near PTB + dual buy + later dual lock rate ===');
const vol = await q(conn, `
  WITH ticks AS (
    SELECT
      condition_id,
      TRY_CAST(ts AS TIMESTAMP) AS ts,
      up_ask_px_1 AS ua,
      down_ask_px_1 AS da,
      up_bid_px_1 AS ub,
      down_bid_px_1 AS db,
      abs(underlying_price - price_to_beat) AS dist,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau
    FROM read_parquet('${GLOB}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${FROM}'
      AND COALESCE(degraded, false) = false
      AND coverage >= 0.99
      AND up_ask_px_1 BETWEEN 0.25 AND 0.70
      AND down_ask_px_1 BETWEEN 0.25 AND 0.70
      AND up_bid_px_1 > 0 AND down_bid_px_1 > 0
      AND up_ask_sz_1 >= 8 AND down_ask_sz_1 >= 8
      AND epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) BETWEEN 40 AND 200
  ),
  entries AS (
    SELECT *
    FROM (
      SELECT
        *,
        ua + da AS ask_sum,
        ua + ${FEE}*ua*(1-ua) + da + ${FEE}*da*(1-da) AS all_in_cost,
        row_number() OVER (PARTITION BY condition_id ORDER BY ts) AS rn
      FROM ticks
      WHERE dist <= 15
        AND ua + da <= 1.025
        AND abs(ua - da) <= 0.20
        AND tau BETWEEN 60 AND 180
    ) x WHERE rn = 1
  ),
  futures AS (
    SELECT
      e.condition_id,
      e.all_in_cost,
      e.ask_sum,
      e.dist,
      e.tau,
      max(CASE WHEN t.ts > e.ts THEN t.ub + t.db END) AS max_bid_sum,
      max(CASE WHEN t.ts > e.ts THEN greatest(t.ub, t.db) END) AS max_best_bid,
      max(CASE WHEN t.ts > e.ts AND t.tau <= 20 THEN greatest(t.ub, t.db) END) AS late_best_bid
    FROM entries e
    JOIN ticks t ON t.condition_id = e.condition_id AND t.ts >= e.ts
    GROUP BY 1,2,3,4,5
  )
  SELECT
    count(*) AS events,
    avg(all_in_cost) AS avg_cost,
    avg(1-all_in_cost) AS hold_floor,
    count(*) FILTER (WHERE max_bid_sum >= all_in_cost + 0.01) AS dual_lock_1c,
    round(100.0*count(*) FILTER (WHERE max_bid_sum >= all_in_cost + 0.01)/count(*),2) AS dual_lock_pct,
    count(*) FILTER (WHERE max_best_bid >= all_in_cost) AS freeroll,
    round(100.0*count(*) FILTER (WHERE max_best_bid >= all_in_cost)/count(*),2) AS freeroll_pct,
    avg(max_bid_sum - all_in_cost) AS avg_dual_gap,
    avg(max_best_bid - all_in_cost) AS avg_leg_gap
  FROM futures
`);
console.log(JSON.stringify(vol[0], null, 2));

console.log('\nDONE');
conn.closeSync();
