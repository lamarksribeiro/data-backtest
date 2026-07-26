#!/usr/bin/env node
import { DuckDBInstance } from '@duckdb/node-api';

const DEFAULT_GLOB = 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=*/*.parquet';
const FEE_RATE = 0.07;
const MIN_NET_EDGE = 0.005;
const OPERATIONAL_BUFFER = 0.002;
const MAX_SIGNAL_GAP_MS = 750;

function normalizeRows(rows) {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]),
  ));
}

async function main() {
  const parquetGlob = process.argv[2] || DEFAULT_GLOB;
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const sourceSql = `
      SELECT
        condition_id,
        TRY_CAST(ts AS TIMESTAMP) AS ts,
        TRY_CAST(event_end AS TIMESTAMP) AS event_end,
        up_ask_px_1 AS up_ask,
        down_ask_px_1 AS down_ask,
        up_bid_px_1 AS up_bid,
        down_bid_px_1 AS down_bid,
        up_ask_sz_1 AS up_size,
        down_ask_sz_1 AS down_size,
        (
          1
          - up_ask_px_1
          - down_ask_px_1
          - ${FEE_RATE} * up_ask_px_1 * (1 - up_ask_px_1)
          - ${FEE_RATE} * down_ask_px_1 * (1 - down_ask_px_1)
        ) AS net_edge,
        (
          up_bid_px_1
          + down_bid_px_1
          - 1
          - ${FEE_RATE} * up_bid_px_1 * (1 - up_bid_px_1)
          - ${FEE_RATE} * down_bid_px_1 * (1 - down_bid_px_1)
        ) AS sell_net_edge
      FROM read_parquet('${parquetGlob}', hive_partitioning=true)
      WHERE condition_id IS NOT NULL
        AND COALESCE(degraded, false) = false
        AND coverage >= 0.99
        AND TRY_CAST(ts AS TIMESTAMP) IS NOT NULL
        AND TRY_CAST(event_end AS TIMESTAMP) IS NOT NULL
        AND epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) BETWEEN 15 AND 285
        AND up_ask_px_1 BETWEEN 0.001 AND 0.999
        AND down_ask_px_1 BETWEEN 0.001 AND 0.999
        AND up_bid_px_1 BETWEEN 0.001 AND 0.999
        AND down_bid_px_1 BETWEEN 0.001 AND 0.999
        AND up_bid_px_1 <= up_ask_px_1
        AND down_bid_px_1 <= down_ask_px_1
        AND up_ask_px_1 - up_bid_px_1 <= 0.03
        AND down_ask_px_1 - down_bid_px_1 <= 0.03
        AND up_ask_sz_1 > 0
        AND down_ask_sz_1 > 0
    `;
    const threshold = MIN_NET_EDGE + OPERATIONAL_BUFFER;
    const summarySql = `
      WITH base AS (${sourceSql}),
      seq AS (
        SELECT
          *,
          LAG(ts) OVER (PARTITION BY condition_id ORDER BY ts) AS prev_ts,
          LAG(net_edge) OVER (PARTITION BY condition_id ORDER BY ts) AS prev_edge,
          LAG(sell_net_edge) OVER (PARTITION BY condition_id ORDER BY ts) AS prev_sell_edge,
          LEAD(ts) OVER (PARTITION BY condition_id ORDER BY ts) AS next_ts,
          LEAD(net_edge) OVER (PARTITION BY condition_id ORDER BY ts) AS next_edge,
          LEAD(sell_net_edge) OVER (PARTITION BY condition_id ORDER BY ts) AS next_sell_edge
        FROM base
      )
      SELECT
        COUNT(*) AS valid_ticks,
        COUNT(DISTINCT condition_id) AS valid_events,
        COUNT(*) FILTER (WHERE net_edge >= ${threshold}) AS qualifying_ticks,
        COUNT(DISTINCT condition_id) FILTER (WHERE net_edge >= ${threshold}) AS qualifying_events,
        COUNT(*) FILTER (
          WHERE net_edge >= ${threshold}
            AND prev_edge >= ${threshold}
            AND next_edge >= ${threshold}
            AND (epoch(ts) - epoch(prev_ts)) * 1000 <= ${MAX_SIGNAL_GAP_MS}
            AND (epoch(next_ts) - epoch(ts)) * 1000 <= ${MAX_SIGNAL_GAP_MS}
        ) AS confirmed_plus_latency_ticks,
        COUNT(DISTINCT condition_id) FILTER (
          WHERE net_edge >= ${threshold}
            AND prev_edge >= ${threshold}
            AND next_edge >= ${threshold}
            AND (epoch(ts) - epoch(prev_ts)) * 1000 <= ${MAX_SIGNAL_GAP_MS}
            AND (epoch(next_ts) - epoch(ts)) * 1000 <= ${MAX_SIGNAL_GAP_MS}
        ) AS confirmed_plus_latency_events,
        COUNT(*) FILTER (WHERE sell_net_edge >= ${threshold}) AS sell_qualifying_ticks,
        COUNT(DISTINCT condition_id) FILTER (WHERE sell_net_edge >= ${threshold}) AS sell_qualifying_events,
        COUNT(*) FILTER (
          WHERE sell_net_edge >= ${threshold}
            AND prev_sell_edge >= ${threshold}
            AND next_sell_edge >= ${threshold}
            AND (epoch(ts) - epoch(prev_ts)) * 1000 <= ${MAX_SIGNAL_GAP_MS}
            AND (epoch(next_ts) - epoch(ts)) * 1000 <= ${MAX_SIGNAL_GAP_MS}
        ) AS sell_confirmed_plus_latency_ticks,
        COUNT(DISTINCT condition_id) FILTER (
          WHERE sell_net_edge >= ${threshold}
            AND prev_sell_edge >= ${threshold}
            AND next_sell_edge >= ${threshold}
            AND (epoch(ts) - epoch(prev_ts)) * 1000 <= ${MAX_SIGNAL_GAP_MS}
            AND (epoch(next_ts) - epoch(ts)) * 1000 <= ${MAX_SIGNAL_GAP_MS}
        ) AS sell_confirmed_plus_latency_events,
        MAX(net_edge) AS best_single_tick_edge,
        MAX(sell_net_edge) AS best_single_tick_sell_edge
      FROM seq
    `;
    const candidateSql = `
      WITH base AS (${sourceSql}),
      seq AS (
        SELECT
          *,
          LAG(ts) OVER (PARTITION BY condition_id ORDER BY ts) AS prev_ts,
          LAG(net_edge) OVER (PARTITION BY condition_id ORDER BY ts) AS prev_edge,
          LEAD(ts) OVER (PARTITION BY condition_id ORDER BY ts) AS next_ts,
          LEAD(net_edge) OVER (PARTITION BY condition_id ORDER BY ts) AS next_edge
        FROM base
      )
      SELECT
        condition_id,
        ts,
        ROUND(epoch(event_end) - epoch(ts), 3) AS seconds_left,
        up_ask,
        down_ask,
        up_size,
        down_size,
        ROUND(net_edge, 6) AS net_edge,
        ROUND(prev_edge, 6) AS prev_edge,
        ROUND(next_edge, 6) AS next_edge,
        ROUND((epoch(ts) - epoch(prev_ts)) * 1000, 1) AS prev_gap_ms,
        ROUND((epoch(next_ts) - epoch(ts)) * 1000, 1) AS next_gap_ms
      FROM seq
      WHERE net_edge >= ${threshold}
      ORDER BY net_edge DESC, ts
      LIMIT 50
    `;
    const summaryResult = await connection.runAndReadAll(summarySql);
    const candidatesResult = await connection.runAndReadAll(candidateSql);
    console.log(JSON.stringify({
      assumptions: {
        parquetGlob,
        feeRate: FEE_RATE,
        minNetEdgePerShare: MIN_NET_EDGE,
        operationalBufferPerShare: OPERATIONAL_BUFFER,
        qualifyingRawNetEdge: threshold,
        confirmationTicks: 2,
        executionLatencyTicks: 1,
        maxSignalGapMs: MAX_SIGNAL_GAP_MS,
        note: 'Top-of-book discovery for buy-and-merge and pre-split sell-pair directions. The runner implements the only persistent direction (buy) and also walks 25 levels.',
      },
      summary: normalizeRows(summaryResult.getRowObjectsJS())[0],
      candidates: normalizeRows(candidatesResult.getRowObjectsJS()),
    }, null, 2));
  } finally {
    connection.closeSync();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
