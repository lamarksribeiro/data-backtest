/**
 * Deep explore 2 — BTC 5m order book microstructure analysis.
 *
 * Usage: node --max-old-space-size=8192 labs/sandbox/deep-explore-2.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const LAKE_ROOT = path.resolve('lake');
const BASE = path.join(LAKE_ROOT, 'backtest_ticks', 'underlying=BTC', 'interval=5m', 'book_depth=25');

function collectParquetFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectParquetFiles(full));
    } else if (entry.name.endsWith('.parquet')) {
      files.push(full);
    }
  }
  return files;
}

function parquetList(files) {
  return `[${files.map((f) => quotedString(f)).join(', ')}]`;
}

async function runSql(conn, sql, label) {
  const t0 = Date.now();
  console.log(`\n${'='.repeat(70)}`);
  console.log(`QUERY: ${label}`);
  console.log(`${'='.repeat(70)}`);
  // Print first 400 chars of SQL
  const preview = sql.replace(/\s+/g, ' ').trim();
  console.log(`${preview.slice(0, 500)}${preview.length > 500 ? '...' : ''}`);
  const result = await conn.runAndReadAll(sql);
  const rows = result.getRowObjectsJS();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (rows.length === 0) {
    console.log(`(no rows) — ${elapsed}s`);
    return { rows: [], columns: [] };
  }
  const columns = Object.keys(rows[0]);
  console.log(`Returned ${rows.length} row(s), ${columns.length} column(s) — ${elapsed}s\n`);
  return { rows, columns };
}

function printTable(rows, columns) {
  if (!rows.length) return;
  const widths = {};
  for (const col of columns) widths[col] = Math.max(col.length, 8);
  for (const row of rows) {
    for (const col of columns) {
      const val = row[col];
      const s = val == null ? 'null' : (typeof val === 'number' ? (Number.isInteger(val) ? String(val) : val.toFixed(6)) : String(val));
      widths[col] = Math.min(Math.max(widths[col], s.length), 60);
    }
  }
  const header = columns.map((c) => c.padEnd(widths[c])).join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const row of rows) {
    const line = columns.map((c) => {
      const val = row[c];
      let s = val == null ? 'null' : (typeof val === 'number' ? (Number.isInteger(val) ? String(val) : val.toFixed(6)) : String(val));
      if (s.length > 60) s = s.slice(0, 57) + '...';
      return s.padEnd(widths[c]);
    }).join(' | ');
    console.log(line);
  }
  console.log();
}

function fmt(n) {
  if (n == null) return 'null';
  if (typeof n === 'bigint') return Number(n).toLocaleString();
  if (typeof n === 'number') return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return String(n);
}

async function main() {
  console.log('=== deep-explore-2: BTC 5m Order Book Microstructure ===\n');

  const tStart = Date.now();

  // 1. Collect files
  const files = collectParquetFiles(BASE);
  console.log(`Found ${files.length} parquet files (${(files.length / 88 * 100).toFixed(0)}% of 88)`);
  if (files.length === 0) {
    console.error('ERROR: No parquet files found. Aborting.');
    process.exit(1);
  }
  console.log(`Date range: ${path.basename(path.dirname(files[0]))} to ${path.basename(path.dirname(files[files.length - 1]))}`);

  // Use last ~20 days for heavy window-function queries, full set for aggregates
  const recentFiles = files.slice(-20);
  const pqlFull = parquetList(files);
  const pqlRecent = parquetList(recentFiles);
  console.log(`Full set: ${files.length} files | Recent set: ${recentFiles.length} files (for window queries)\n`);

  // 2. Open DuckDB
  console.log('Opening DuckDB in-memory...');
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run(`SET threads TO 4`);
  await conn.run(`SET memory_limit = '7GB'`);

  // ═══════════════════════════════════════════════════════════════
  // QUERY 1: Book Imbalance Distribution
  // ═══════════════════════════════════════════════════════════════
  const q1 = await runSql(conn, `
    WITH obi_data AS (
      SELECT
        ts, condition_id, underlying_price,
        (up_bid_sz_1 + up_bid_sz_2 + up_bid_sz_3 + up_bid_sz_4 + up_bid_sz_5
         - up_ask_sz_1 - up_ask_sz_2 - up_ask_sz_3 - up_ask_sz_4 - up_ask_sz_5)
        / NULLIF(up_bid_sz_1 + up_bid_sz_2 + up_bid_sz_3 + up_bid_sz_4 + up_bid_sz_5
                 + up_ask_sz_1 + up_ask_sz_2 + up_ask_sz_3 + up_ask_sz_4 + up_ask_sz_5, 0.0) AS obi
      FROM read_parquet(${pqlFull})
      WHERE up_bid_sz_1 IS NOT NULL
        AND up_ask_sz_1 IS NOT NULL
    )
    SELECT
      COUNT(*)                                                AS total_rows,
      ROUND(AVG(obi), 6)                                      AS mean_obi,
      ROUND(STDDEV(obi), 6)                                   AS stddev_obi,
      ROUND(PERCENTILE_CONT(0.01) WITHIN GROUP (ORDER BY obi), 6) AS p01,
      ROUND(PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY obi), 6) AS p05,
      ROUND(PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY obi), 6) AS p10,
      ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY obi), 6) AS p25,
      ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY obi), 6) AS p50,
      ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY obi), 6) AS p75,
      ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY obi), 6) AS p90,
      ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY obi), 6) AS p95,
      ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY obi), 6) AS p99,
      ROUND(MIN(obi), 6)                                      AS min_obi,
      ROUND(MAX(obi), 6)                                      AS max_obi
    FROM obi_data
    WHERE obi IS NOT NULL
  `, '1A - Book Imbalance (OBI) Distribution — UP side, levels 1-5');

  if (q1.rows.length) {
    const r = q1.rows[0];
    console.log(`OBI Distribution (UP side, levels 1-5):`);
    console.log(`  Total ticks:         ${fmt(r.total_rows)}`);
    console.log(`  Mean:                ${r.mean_obi}`);
    console.log(`  StdDev:              ${r.stddev_obi}`);
    console.log(`  Min / Max:           ${r.min_obi} / ${r.max_obi}`);
    console.log(`  P01 / P05 / P10:     ${r.p01} / ${r.p05} / ${r.p10}`);
    console.log(`  P25 / P50 / P75:     ${r.p25} / ${r.p50} / ${r.p75}`);
    console.log(`  P90 / P95 / P99:     ${r.p90} / ${r.p95} / ${r.p99}`);
    console.log(`  Interpretation: OBI > 0 = bid-heavy (buy pressure), OBI < 0 = ask-heavy (sell pressure)`);
    console.log(`  OBI zero = perfectly balanced. Mean near ${r.mean_obi} suggests ${r.mean_obi > 0 ? 'slight bid' : 'slight ask'} bias.`);
  }

  // 1B: OBI correlation with future price moves (using lead within same condition)
  const q1b = await runSql(conn, `
    WITH tick_obi AS (
      SELECT
        ts, condition_id, underlying_price,
        (up_bid_sz_1 + up_bid_sz_2 + up_bid_sz_3 + up_bid_sz_4 + up_bid_sz_5
         - up_ask_sz_1 - up_ask_sz_2 - up_ask_sz_3 - up_ask_sz_4 - up_ask_sz_5)
        / NULLIF(up_bid_sz_1 + up_bid_sz_2 + up_bid_sz_3 + up_bid_sz_4 + up_bid_sz_5
                 + up_ask_sz_1 + up_ask_sz_2 + up_ask_sz_3 + up_ask_sz_4 + up_ask_sz_5, 0.0) AS obi
      FROM read_parquet(${pqlRecent})
      WHERE up_bid_sz_1 IS NOT NULL AND up_ask_sz_1 IS NOT NULL
    ),
    obi_buckets AS (
      SELECT
        *,
        CASE
          WHEN obi <= -0.5 THEN 'heavy_ask'
          WHEN obi <= -0.2 THEN 'moderate_ask'
          WHEN obi <= -0.05 THEN 'slight_ask'
          WHEN obi < 0.05 THEN 'balanced'
          WHEN obi < 0.2 THEN 'slight_bid'
          WHEN obi < 0.5 THEN 'moderate_bid'
          ELSE 'heavy_bid'
        END AS obi_regime
      FROM tick_obi
      WHERE obi IS NOT NULL
    ),
    price_forward AS (
      SELECT
        condition_id, ts, underlying_price, obi_regime,
        FIRST_VALUE(underlying_price IGNORE NULLS) OVER (
          PARTITION BY condition_id
          ORDER BY epoch(try_cast(ts AS TIMESTAMP))
          ROWS BETWEEN 10 FOLLOWING AND 10 FOLLOWING
        ) AS price_10s_later,
        FIRST_VALUE(underlying_price IGNORE NULLS) OVER (
          PARTITION BY condition_id
          ORDER BY epoch(try_cast(ts AS TIMESTAMP))
          ROWS BETWEEN 30 FOLLOWING AND 30 FOLLOWING
        ) AS price_30s_later,
        FIRST_VALUE(underlying_price IGNORE NULLS) OVER (
          PARTITION BY condition_id
          ORDER BY epoch(try_cast(ts AS TIMESTAMP))
          ROWS BETWEEN 60 FOLLOWING AND 60 FOLLOWING
        ) AS price_60s_later
      FROM obi_buckets
    )
    SELECT
      '10s_fwd' AS horizon,
      obi_regime,
      COUNT(*) AS n,
      ROUND(AVG(price_10s_later - underlying_price), 6) AS avg_price_change,
      ROUND(STDDEV(price_10s_later - underlying_price), 6) AS std_price_change,
      ROUND(AVG(CASE WHEN price_10s_later > underlying_price THEN 1.0 ELSE 0.0 END), 4) AS pct_up
    FROM price_forward
    WHERE price_10s_later IS NOT NULL
    GROUP BY obi_regime
    UNION ALL
    SELECT
      '30s_fwd' AS horizon,
      obi_regime,
      COUNT(*) AS n,
      ROUND(AVG(price_30s_later - underlying_price), 6) AS avg_price_change,
      ROUND(STDDEV(price_30s_later - underlying_price), 6) AS std_price_change,
      ROUND(AVG(CASE WHEN price_30s_later > underlying_price THEN 1.0 ELSE 0.0 END), 4) AS pct_up
    FROM price_forward
    WHERE price_30s_later IS NOT NULL
    GROUP BY obi_regime
    UNION ALL
    SELECT
      '60s_fwd' AS horizon,
      obi_regime,
      COUNT(*) AS n,
      ROUND(AVG(price_60s_later - underlying_price), 6) AS avg_price_change,
      ROUND(STDDEV(price_60s_later - underlying_price), 6) AS std_price_change,
      ROUND(AVG(CASE WHEN price_60s_later > underlying_price THEN 1.0 ELSE 0.0 END), 4) AS pct_up
    FROM price_forward
    WHERE price_60s_later IS NOT NULL
    GROUP BY obi_regime
    ORDER BY horizon, obi_regime
  `, '1B - OBI vs Future Price Movement (10s/30s/60s forward) — recent 20 days');

  if (q1b.rows.length) {
    printTable(q1b.rows, q1b.columns);
    console.log(`  Interpretation: "pct_up" = probability of price rise at each horizon.`);
    console.log(`  Higher avg_price_change for bid-heavy regimes (heavy_bid) would confirm OBI predictive power.\n`);
  }

  // ═══════════════════════════════════════════════════════════════
  // QUERY 2: Wall Detection
  // ═══════════════════════════════════════════════════════════════
  const q2a = await runSql(conn, `
    WITH walls AS (
      SELECT
        ts, condition_id, underlying_price,
        up_bid_sz_1, up_bid_sz_2, up_bid_sz_3, up_bid_sz_4, up_bid_sz_5,
        up_bid_px_1, up_bid_px_2, up_bid_px_3, up_bid_px_4, up_bid_px_5,
        up_ask_sz_1, up_ask_sz_2, up_ask_sz_3, up_ask_sz_4, up_ask_sz_5,
        up_ask_px_1, up_ask_px_2, up_ask_px_3, up_ask_px_4, up_ask_px_5,
        -- Bid wall detection: level N size > 2x level N-1 AND > 2x level N+1
        CASE WHEN up_bid_sz_2 > 0 AND up_bid_sz_2 IS NOT NULL
             AND NULLIF(up_bid_sz_1, 0) IS NOT NULL AND up_bid_sz_2 > 2 * up_bid_sz_1
             AND (up_bid_sz_3 IS NULL OR up_bid_sz_2 > 2 * NULLIF(up_bid_sz_3, 0))
             THEN 2 END AS bid_wall_l2,
        CASE WHEN up_bid_sz_3 > 0 AND up_bid_sz_3 IS NOT NULL
             AND NULLIF(up_bid_sz_2, 0) IS NOT NULL AND up_bid_sz_3 > 2 * up_bid_sz_2
             AND (up_bid_sz_4 IS NULL OR up_bid_sz_3 > 2 * NULLIF(up_bid_sz_4, 0))
             THEN 3 END AS bid_wall_l3,
        CASE WHEN up_bid_sz_4 > 0 AND up_bid_sz_4 IS NOT NULL
             AND NULLIF(up_bid_sz_3, 0) IS NOT NULL AND up_bid_sz_4 > 2 * up_bid_sz_3
             AND (up_bid_sz_5 IS NULL OR up_bid_sz_4 > 2 * NULLIF(up_bid_sz_5, 0))
             THEN 4 END AS bid_wall_l4,
        -- Ask wall detection: level N size > 2x level N-1 AND > 2x level N+1
        CASE WHEN up_ask_sz_2 > 0 AND up_ask_sz_2 IS NOT NULL
             AND NULLIF(up_ask_sz_1, 0) IS NOT NULL AND up_ask_sz_2 > 2 * up_ask_sz_1
             AND (up_ask_sz_3 IS NULL OR up_ask_sz_2 > 2 * NULLIF(up_ask_sz_3, 0))
             THEN 2 END AS ask_wall_l2,
        CASE WHEN up_ask_sz_3 > 0 AND up_ask_sz_3 IS NOT NULL
             AND NULLIF(up_ask_sz_2, 0) IS NOT NULL AND up_ask_sz_3 > 2 * up_ask_sz_2
             AND (up_ask_sz_4 IS NULL OR up_ask_sz_3 > 2 * NULLIF(up_ask_sz_4, 0))
             THEN 3 END AS ask_wall_l3,
        CASE WHEN up_ask_sz_4 > 0 AND up_ask_sz_4 IS NOT NULL
             AND NULLIF(up_ask_sz_3, 0) IS NOT NULL AND up_ask_sz_4 > 2 * up_ask_sz_3
             AND (up_ask_sz_5 IS NULL OR up_ask_sz_4 > 2 * NULLIF(up_ask_sz_5, 0))
             THEN 4 END AS ask_wall_l4
      FROM read_parquet(${pqlRecent})
      WHERE up_bid_sz_1 IS NOT NULL AND up_ask_sz_1 IS NOT NULL
    ),
    wall_events AS (
      SELECT
        ts, condition_id, underlying_price,
        COALESCE(bid_wall_l2, bid_wall_l3, bid_wall_l4) AS has_bid_wall_level,
        COALESCE(ask_wall_l2, ask_wall_l3, ask_wall_l4) AS has_ask_wall_level,
        CASE WHEN bid_wall_l2 IS NOT NULL OR bid_wall_l3 IS NOT NULL OR bid_wall_l4 IS NOT NULL THEN 'bid_wall'
             WHEN ask_wall_l2 IS NOT NULL OR ask_wall_l3 IS NOT NULL OR ask_wall_l4 IS NOT NULL THEN 'ask_wall'
             ELSE 'no_wall'
        END AS wall_type
      FROM walls
    )
    SELECT
      wall_type,
      COUNT(*) AS occurrences,
      ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) AS pct_total
    FROM wall_events
    GROUP BY wall_type
    ORDER BY occurrences DESC
  `, '2A - Wall Detection: Frequency by type');

  if (q2a.rows.length) {
    printTable(q2a.rows, q2a.columns);
  }

  // 2B: What happens to price 5-10s after a wall appears?
  const q2b = await runSql(conn, `
    WITH raw_data AS (
      SELECT
        ts, condition_id, underlying_price,
        up_bid_sz_1, up_bid_sz_2, up_bid_sz_3, up_bid_sz_4, up_bid_sz_5,
        up_ask_sz_1, up_ask_sz_2, up_ask_sz_3, up_ask_sz_4, up_ask_sz_5,
        epoch(try_cast(ts AS TIMESTAMP)) AS ts_epoch
      FROM read_parquet(${pqlRecent})
      WHERE up_bid_sz_1 IS NOT NULL AND up_ask_sz_1 IS NOT NULL
    ),
    walls AS (
      SELECT *,
        CASE
          WHEN up_bid_sz_2 > 0 AND up_bid_sz_2 IS NOT NULL
               AND NULLIF(up_bid_sz_1, 0) IS NOT NULL AND up_bid_sz_2 > 2 * up_bid_sz_1
               AND (up_bid_sz_3 IS NULL OR up_bid_sz_3 = 0 OR up_bid_sz_2 > 2 * up_bid_sz_3)
            THEN 1 ELSE 0
        END AS is_bid_wall,
        CASE
          WHEN up_ask_sz_2 > 0 AND up_ask_sz_2 IS NOT NULL
               AND NULLIF(up_ask_sz_1, 0) IS NOT NULL AND up_ask_sz_2 > 2 * up_ask_sz_1
               AND (up_ask_sz_3 IS NULL OR up_ask_sz_3 = 0 OR up_ask_sz_2 > 2 * up_ask_sz_3)
            THEN 1 ELSE 0
        END AS is_ask_wall
      FROM raw_data
    ),
    wall_with_fwd AS (
      SELECT
        condition_id, ts, ts_epoch, underlying_price, is_bid_wall, is_ask_wall,
        FIRST_VALUE(underlying_price IGNORE NULLS) OVER (
          PARTITION BY condition_id
          ORDER BY ts_epoch
          ROWS BETWEEN 5 FOLLOWING AND 10 FOLLOWING
        ) AS price_5_10s
      FROM walls
      WHERE is_bid_wall = 1 OR is_ask_wall = 1
    )
    SELECT
      CASE WHEN is_bid_wall = 1 AND is_ask_wall = 1 THEN 'both'
           WHEN is_bid_wall = 1 THEN 'bid_wall'
           ELSE 'ask_wall'
      END AS wall_type,
      COUNT(*) AS n_walls,
      ROUND(AVG(price_5_10s - underlying_price), 6) AS avg_price_change_5_10s,
      ROUND(STDDEV(price_5_10s - underlying_price), 6) AS std_price_change,
      ROUND(AVG(CASE WHEN price_5_10s > underlying_price THEN 1.0 ELSE 0.0 END), 4) AS pct_up_5_10s,
      ROUND(MIN(price_5_10s - underlying_price), 6) AS min_change,
      ROUND(MAX(price_5_10s - underlying_price), 6) AS max_change
    FROM wall_with_fwd
    WHERE price_5_10s IS NOT NULL
    GROUP BY 1
    ORDER BY n_walls DESC
  `, '2B - Wall Detection: Price behavior 5-10s after wall appears');

  if (q2b.rows.length) {
    printTable(q2b.rows, q2b.columns);
    console.log(`  Interpretation: bid_wall = large bid at level 2+, suggests support — expect price to hold or rise.\n`);
    console.log(`  ask_wall = large ask at level 2+, suggests resistance — expect price to stall or drop.\n`);
  }

  // ═══════════════════════════════════════════════════════════════
  // QUERY 3: Spread Compression Events
  // ═══════════════════════════════════════════════════════════════
  const q3a = await runSql(conn, `
    WITH spreads AS (
      SELECT
        ts, condition_id, underlying_price,
        up_ask_px_1 - up_bid_px_1 AS up_spread,
        epoch(try_cast(ts AS TIMESTAMP)) AS ts_epoch
      FROM read_parquet(${pqlRecent})
      WHERE up_bid_px_1 IS NOT NULL AND up_ask_px_1 IS NOT NULL
        AND up_ask_px_1 > up_bid_px_1
    ),
    spread_with_avg AS (
      SELECT
        ts, condition_id, underlying_price, up_spread, ts_epoch,
        AVG(up_spread) OVER (
          PARTITION BY condition_id
          ORDER BY ts_epoch
          RANGE BETWEEN 5 PRECEDING AND 1 PRECEDING
        ) AS avg_spread_5s
      FROM spreads
    ),
    compression_events AS (
      SELECT
        ts, condition_id, underlying_price, up_spread, avg_spread_5s,
        CASE
          WHEN avg_spread_5s IS NOT NULL AND avg_spread_5s > 0
               AND up_spread < 0.7 * avg_spread_5s THEN 1 ELSE 0
        END AS is_compression
      FROM spread_with_avg
    )
    SELECT
      COUNT(*) AS total_ticks,
      COUNT(*) FILTER (WHERE is_compression = 1) AS compression_events,
      ROUND(COUNT(*) FILTER (WHERE is_compression = 1) * 100.0 / NULLIF(COUNT(*), 0), 2) AS pct_compression
    FROM compression_events
  `, '3A - Spread Compression Events: Frequency');

  if (q3a.rows.length) {
    const r = q3a.rows[0];
    console.log(`  Total ticks with spread data: ${fmt(r.total_ticks)}`);
    console.log(`  Compression events:           ${fmt(r.compression_events)}`);
    console.log(`  % of total:                   ${r.pct_compression}%`);
  }

  // 3B: Directional move after compression
  const q3b = await runSql(conn, `
    WITH spreads AS (
      SELECT
        ts, condition_id, underlying_price,
        up_ask_px_1 - up_bid_px_1 AS up_spread,
        epoch(try_cast(ts AS TIMESTAMP)) AS ts_epoch
      FROM read_parquet(${pqlRecent})
      WHERE up_bid_px_1 IS NOT NULL AND up_ask_px_1 IS NOT NULL
        AND up_ask_px_1 > up_bid_px_1
    ),
    spread_with_avg AS (
      SELECT
        *, 
        AVG(up_spread) OVER (
          PARTITION BY condition_id
          ORDER BY ts_epoch
          RANGE BETWEEN 5 PRECEDING AND 1 PRECEDING
        ) AS avg_spread_5s
      FROM spreads
    ),
    compression AS (
      SELECT *,
        CASE WHEN avg_spread_5s IS NOT NULL AND avg_spread_5s > 0
             AND up_spread < 0.7 * avg_spread_5s THEN 1 ELSE 0 END AS is_compression,
        FIRST_VALUE(underlying_price IGNORE NULLS) OVER (
          PARTITION BY condition_id
          ORDER BY ts_epoch
          ROWS BETWEEN 10 FOLLOWING AND 30 FOLLOWING
        ) AS price_10_30s,
        FIRST_VALUE(up_spread IGNORE NULLS) OVER (
          PARTITION BY condition_id
          ORDER BY ts_epoch
          ROWS BETWEEN 10 FOLLOWING AND 30 FOLLOWING
        ) AS spread_10_30s
      FROM spread_with_avg
    )
    SELECT
      is_compression,
      COUNT(*) AS n,
      ROUND(AVG(price_10_30s - underlying_price), 6) AS avg_price_change,
      ROUND(STDDEV(price_10_30s - underlying_price), 6) AS std_price_change,
      ROUND(AVG(CASE WHEN price_10_30s > underlying_price THEN 1.0 ELSE 0.0 END), 4) AS pct_up,
      ROUND(AVG(CASE WHEN price_10_30s < underlying_price THEN 1.0 ELSE 0.0 END), 4) AS pct_down,
      ROUND(AVG(CASE WHEN price_10_30s = underlying_price THEN 1.0 ELSE 0.0 END), 4) AS pct_flat
    FROM compression
    WHERE price_10_30s IS NOT NULL
    GROUP BY is_compression
    ORDER BY is_compression
  `, '3B - Spread Compression: Directional move in next 10-30s');

  if (q3b.rows.length) {
    printTable(q3b.rows, q3b.columns);
    console.log(`  Interpretation: is_compression=1 shows what happens after spread narrows >30%.\n`);
    console.log(`  If pct_up >> pct_down after compression, spread squeeze = bullish signal. If opposite, bearish.\n`);
  }

  // ═══════════════════════════════════════════════════════════════
  // QUERY 4: Time-Decay Patterns
  // ═══════════════════════════════════════════════════════════════
  const q4 = await runSql(conn, `
    WITH ticks_with_time AS (
      SELECT
        ts, condition_id, event_start, event_end,
        underlying_price, up_price, down_price, price_to_beat,
        up_best_bid, up_best_ask, down_best_bid, down_best_ask,
        up_ask_px_1, up_bid_px_1,
        epoch(try_cast(event_end AS TIMESTAMP)) - epoch(try_cast(ts AS TIMESTAMP)) AS seconds_left,
        epoch(try_cast(ts AS TIMESTAMP)) AS ts_epoch
      FROM read_parquet(${pqlFull})
      WHERE up_best_bid IS NOT NULL AND up_best_ask IS NOT NULL
        AND down_best_bid IS NOT NULL AND down_best_ask IS NOT NULL
        AND underlying_price IS NOT NULL
    ),
    time_buckets AS (
      SELECT *,
        CASE
          WHEN seconds_left >= 200 THEN '300-200s'
          WHEN seconds_left >= 100 THEN '200-100s'
          WHEN seconds_left >= 50  THEN '100-50s'
          WHEN seconds_left >= 30  THEN '50-30s'
          WHEN seconds_left >= 10  THEN '30-10s'
          WHEN seconds_left >= 0   THEN '10-0s'
          ELSE 'expired'
        END AS time_bucket
      FROM ticks_with_time
      WHERE seconds_left IS NOT NULL AND seconds_left BETWEEN 0 AND 300
    ),
    fwd_price AS (
      SELECT *,
        FIRST_VALUE(underlying_price IGNORE NULLS) OVER (
          PARTITION BY condition_id
          ORDER BY ts_epoch
          ROWS BETWEEN 10 FOLLOWING AND 10 FOLLOWING
        ) AS price_10s_later
      FROM time_buckets
    )
    SELECT
      time_bucket,
      COUNT(*) AS n_ticks,
      ROUND(AVG(up_best_ask - up_best_bid), 6)    AS avg_up_spread,
      ROUND(AVG(down_best_ask - down_best_bid), 6)  AS avg_down_spread,
      ROUND(AVG(price_10s_later - underlying_price), 6) AS avg_price_change_10s,
      ROUND(AVG(CASE WHEN price_10s_later > underlying_price THEN 1.0 ELSE 0.0 END), 4) AS pct_up_10s,
      ROUND(AVG(up_price - price_to_beat), 6)      AS avg_up_dist_from_ptb,
      ROUND(AVG(down_price - price_to_beat), 6)    AS avg_down_dist_from_ptb
    FROM fwd_price
    WHERE price_10s_later IS NOT NULL
    GROUP BY time_bucket
    ORDER BY time_bucket
  `, '4A - Time-Decay Patterns: Bucket analysis');

  if (q4.rows.length) {
    printTable(q4.rows, q4.columns);
    console.log(`  Interpretation:`);
    console.log(`    avg_up_spread / avg_down_spread: how spread evolves as time decays`);
    console.log(`    avg_price_change_10s: expected 10s forward price change per bucket`);
    console.log(`    pct_up_10s: probability price rises in next 10s`);
    console.log(`    avg_up_dist_from_ptb: how far UP price is from Price To Beat (favoritism) per bucket\n`);
  }

  // 4B: Win rate if entering favorite at each bucket and holding to expiry
  const q4b = await runSql(conn, `
    WITH ticks_with_time AS (
      SELECT
        ts, condition_id, event_start AS evt_start, event_end,
        underlying_price, up_price, down_price, price_to_beat,
        epoch(try_cast(event_end AS TIMESTAMP)) - epoch(try_cast(ts AS TIMESTAMP)) AS seconds_left,
        epoch(try_cast(ts AS TIMESTAMP)) AS ts_epoch
      FROM read_parquet(${pqlFull})
      WHERE up_price IS NOT NULL AND down_price IS NOT NULL
        AND price_to_beat IS NOT NULL AND underlying_price IS NOT NULL
    ),
    time_buckets AS (
      SELECT *,
        CASE
          WHEN seconds_left >= 200 THEN '300-200s'
          WHEN seconds_left >= 100 THEN '200-100s'
          WHEN seconds_left >= 50  THEN '100-50s'
          WHEN seconds_left >= 30  THEN '50-30s'
          WHEN seconds_left >= 10  THEN '30-10s'
          WHEN seconds_left >= 0   THEN '10-0s'
          ELSE 'expired'
        END AS time_bucket
      FROM ticks_with_time
      WHERE seconds_left IS NOT NULL AND seconds_left BETWEEN 1 AND 310
    ),
    final_price AS (
      SELECT *,
        LAST_VALUE(underlying_price IGNORE NULLS) OVER (
          PARTITION BY condition_id
          ORDER BY ts_epoch
          RANGE BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
        ) AS expiry_price
      FROM time_buckets
    )
    SELECT
      time_bucket,
      COUNT(*) AS n_ticks,
      -- Enter on favorite: if underlying_price < price_to_beat, UP is favorite; else DOWN is favorite
      ROUND(AVG(CASE
        WHEN underlying_price < price_to_beat AND expiry_price > price_to_beat THEN 1.0
        WHEN underlying_price > price_to_beat AND expiry_price < price_to_beat THEN 1.0
        ELSE 0.0
      END), 4) AS favorite_win_rate,
      -- UP win rate (entering UP regardless)
      ROUND(AVG(CASE WHEN expiry_price > price_to_beat THEN 1.0 ELSE 0.0 END), 4) AS up_win_rate,
      -- DOWN win rate (entering DOWN regardless)
      ROUND(AVG(CASE WHEN expiry_price < price_to_beat THEN 1.0 ELSE 0.0 END), 4) AS down_win_rate
    FROM final_price
    WHERE expiry_price IS NOT NULL
    GROUP BY time_bucket
    ORDER BY time_bucket
  `, '4B - Win Rate: Enter favorite at each time bucket, hold to expiry');

  if (q4b.rows.length) {
    printTable(q4b.rows, q4b.columns);
    console.log(`  Interpretation:`);
    console.log(`    favorite_win_rate: probability of winning if you pick the side closer to underlying`);
    console.log(`    up_win_rate: unconditionally entering UP`);
    console.log(`    down_win_rate: unconditionally entering DOWN\n`);
  }

  // ═══════════════════════════════════════════════════════════════
  // QUERY 5: Cross-Side Pressure
  // ═══════════════════════════════════════════════════════════════
  const q5a = await runSql(conn, `
    WITH book_snaps AS (
      SELECT
        ts, condition_id, underlying_price, up_price, down_price,
        up_best_bid, up_best_ask, down_best_bid, down_best_ask,
        up_ask_sz_1 + up_ask_sz_2 + up_ask_sz_3 AS up_ask_sum,
        up_bid_sz_1 + up_bid_sz_2 + up_bid_sz_3 AS up_bid_sum,
        down_ask_sz_1 + down_ask_sz_2 + down_ask_sz_3 AS down_ask_sum,
        down_bid_sz_1 + down_bid_sz_2 + down_bid_sz_3 AS down_bid_sum,
        epoch(try_cast(ts AS TIMESTAMP)) AS ts_epoch
      FROM read_parquet(${pqlRecent})
      WHERE up_ask_sz_1 IS NOT NULL AND down_ask_sz_1 IS NOT NULL
        AND up_bid_sz_1 IS NOT NULL AND down_bid_sz_1 IS NOT NULL
    ),
    rolling_avg AS (
      SELECT *,
        AVG(up_ask_sum) OVER (
          PARTITION BY condition_id ORDER BY ts_epoch
          RANGE BETWEEN 5 PRECEDING AND 1 PRECEDING
        ) AS up_ask_avg,
        AVG(down_ask_sum) OVER (
          PARTITION BY condition_id ORDER BY ts_epoch
          RANGE BETWEEN 5 PRECEDING AND 1 PRECEDING
        ) AS down_ask_avg
      FROM book_snaps
    ),
    cross_pressure AS (
      SELECT *,
        CASE
          WHEN up_ask_avg IS NOT NULL AND down_ask_avg IS NOT NULL
               AND up_ask_avg > 0 AND down_ask_avg > 0 THEN
            -- UP ask shrinking (less selling pressure) AND DOWN ask expanding (more selling pressure)
            CASE
              WHEN up_ask_sum < 0.7 * up_ask_avg AND down_ask_sum > 1.3 * down_ask_avg
                THEN 'converge_up'
              -- DOWN ask shrinking AND UP ask expanding
              WHEN down_ask_sum < 0.7 * down_ask_avg AND up_ask_sum > 1.3 * up_ask_avg
                THEN 'converge_down'
              ELSE 'neutral'
            END
          ELSE 'neutral'
        END AS pressure_regime
      FROM rolling_avg
    ),
    fwd AS (
      SELECT *,
        FIRST_VALUE(underlying_price IGNORE NULLS) OVER (
          PARTITION BY condition_id
          ORDER BY ts_epoch
          ROWS BETWEEN 10 FOLLOWING AND 30 FOLLOWING
        ) AS price_10_30s,
        FIRST_VALUE(underlying_price IGNORE NULLS) OVER (
          PARTITION BY condition_id
          ORDER BY ts_epoch
          ROWS BETWEEN 5 FOLLOWING AND 10 FOLLOWING
        ) AS price_5_10s
      FROM cross_pressure
    )
    SELECT
      pressure_regime,
      COUNT(*) AS n,
      ROUND(AVG(price_5_10s - underlying_price), 6) AS avg_price_change_5_10s,
      ROUND(AVG(price_10_30s - underlying_price), 6) AS avg_price_change_10_30s,
      ROUND(AVG(CASE WHEN price_10_30s > underlying_price THEN 1.0 ELSE 0.0 END), 4) AS pct_up_10_30s,
      ROUND(AVG(CASE WHEN price_5_10s > underlying_price THEN 1.0 ELSE 0.0 END), 4) AS pct_up_5_10s
    FROM fwd
    WHERE pressure_regime != 'neutral' AND price_10_30s IS NOT NULL
    GROUP BY pressure_regime
    ORDER BY pressure_regime
  `, '5A - Cross-Side Pressure: UP ask shrinks vs DOWN ask expands');

  if (q5a.rows.length) {
    printTable(q5a.rows, q5a.columns);
    console.log(`  Interpretation:`);
    console.log(`    converge_up: UP ask shrinking (less UP selling) + DOWN ask expanding (more DOWN selling)`);
    console.log(`      → Expect underlying to move TOWARD up (away from down) = price should rise`);
    console.log(`    converge_down: DOWN ask shrinking + UP ask expanding`);
    console.log(`      → Expect underlying to move TOWARD down = price should fall\n`);
  }

  // 5B: Symmetric — bid side cross pressure
  const q5b = await runSql(conn, `
    WITH book_snaps AS (
      SELECT
        ts, condition_id, underlying_price, up_price, down_price,
        up_bid_sz_1 + up_bid_sz_2 + up_bid_sz_3 AS up_bid_sum,
        down_bid_sz_1 + down_bid_sz_2 + down_bid_sz_3 AS down_bid_sum,
        epoch(try_cast(ts AS TIMESTAMP)) AS ts_epoch
      FROM read_parquet(${pqlRecent})
      WHERE up_bid_sz_1 IS NOT NULL AND down_bid_sz_1 IS NOT NULL
    ),
    rolling_avg AS (
      SELECT *,
        AVG(up_bid_sum) OVER (
          PARTITION BY condition_id ORDER BY ts_epoch
          RANGE BETWEEN 5 PRECEDING AND 1 PRECEDING
        ) AS up_bid_avg,
        AVG(down_bid_sum) OVER (
          PARTITION BY condition_id ORDER BY ts_epoch
          RANGE BETWEEN 5 PRECEDING AND 1 PRECEDING
        ) AS down_bid_avg
      FROM book_snaps
    ),
    cross_pressure AS (
      SELECT *,
        CASE
          WHEN up_bid_avg IS NOT NULL AND down_bid_avg IS NOT NULL
               AND up_bid_avg > 0 AND down_bid_avg > 0 THEN
            CASE
              WHEN up_bid_sum < 0.7 * up_bid_avg AND down_bid_sum > 1.3 * down_bid_avg
                THEN 'converge_down'
              WHEN down_bid_sum < 0.7 * down_bid_avg AND up_bid_sum > 1.3 * up_bid_avg
                THEN 'converge_up'
              ELSE 'neutral'
            END
          ELSE 'neutral'
        END AS pressure_regime
      FROM rolling_avg
    ),
    fwd AS (
      SELECT *,
        FIRST_VALUE(underlying_price IGNORE NULLS) OVER (
          PARTITION BY condition_id
          ORDER BY ts_epoch
          ROWS BETWEEN 10 FOLLOWING AND 30 FOLLOWING
        ) AS price_10_30s,
        FIRST_VALUE(underlying_price IGNORE NULLS) OVER (
          PARTITION BY condition_id
          ORDER BY ts_epoch
          ROWS BETWEEN 5 FOLLOWING AND 10 FOLLOWING
        ) AS price_5_10s
      FROM cross_pressure
    )
    SELECT
      pressure_regime,
      COUNT(*) AS n,
      ROUND(AVG(price_5_10s - underlying_price), 6) AS avg_price_change_5_10s,
      ROUND(AVG(price_10_30s - underlying_price), 6) AS avg_price_change_10_30s,
      ROUND(AVG(CASE WHEN price_10_30s > underlying_price THEN 1.0 ELSE 0.0 END), 4) AS pct_up_10_30s,
      ROUND(AVG(CASE WHEN price_5_10s > underlying_price THEN 1.0 ELSE 0.0 END), 4) AS pct_up_5_10s
    FROM fwd
    WHERE pressure_regime != 'neutral' AND price_10_30s IS NOT NULL
    GROUP BY pressure_regime
    ORDER BY pressure_regime
  `, '5B - Cross-Side Pressure: UP bid shrinks vs DOWN bid expands');

  if (q5b.rows.length) {
    printTable(q5b.rows, q5b.columns);
    console.log(`  Interpretation:`);
    console.log(`    converge_up: DOWN bid expanding + UP bid shrinking = buyers moving to UP → price should rise`);
    console.log(`    converge_down: UP bid expanding + DOWN bid shrinking = buyers moving to DOWN → price should fall\n`);
  }

  // 5C: Most powerful combination — both ask AND bid cross-pressure aligned
  const q5c = await runSql(conn, `
    WITH book_snaps AS (
      SELECT
        ts, condition_id, underlying_price,
        up_ask_sz_1 + up_ask_sz_2 + up_ask_sz_3 AS up_ask_sum,
        up_bid_sz_1 + up_bid_sz_2 + up_bid_sz_3 AS up_bid_sum,
        down_ask_sz_1 + down_ask_sz_2 + down_ask_sz_3 AS down_ask_sum,
        down_bid_sz_1 + down_bid_sz_2 + down_bid_sz_3 AS down_bid_sum,
        epoch(try_cast(ts AS TIMESTAMP)) AS ts_epoch
      FROM read_parquet(${pqlRecent})
      WHERE up_ask_sz_1 IS NOT NULL AND down_ask_sz_1 IS NOT NULL
        AND up_bid_sz_1 IS NOT NULL AND down_bid_sz_1 IS NOT NULL
    ),
    rolling AS (
      SELECT *,
        AVG(up_ask_sum) OVER w5 AS up_ask_avg,
        AVG(down_ask_sum) OVER w5 AS down_ask_avg,
        AVG(up_bid_sum) OVER w5 AS up_bid_avg,
        AVG(down_bid_sum) OVER w5 AS down_bid_avg
      FROM book_snaps
      WINDOW w5 AS (PARTITION BY condition_id ORDER BY ts_epoch RANGE BETWEEN 5 PRECEDING AND 1 PRECEDING)
    ),
    signals AS (
      SELECT *,
        CASE
          WHEN up_ask_avg > 0 AND down_ask_avg > 0 AND up_bid_avg > 0 AND down_bid_avg > 0 THEN
            CASE
              -- All signals point UP: UP ask shrinks + DOWN ask expands + UP bid expands + DOWN bid shrinks
              WHEN up_ask_sum < 0.7 * up_ask_avg AND down_ask_sum > 1.3 * down_ask_avg
               AND up_bid_sum > 1.3 * up_bid_avg AND down_bid_sum < 0.7 * down_bid_avg
                THEN 'strong_up'
              -- All signals point DOWN
              WHEN down_ask_sum < 0.7 * down_ask_avg AND up_ask_sum > 1.3 * up_ask_avg
               AND down_bid_sum > 1.3 * down_bid_avg AND up_bid_sum < 0.7 * up_bid_avg
                THEN 'strong_down'
              ELSE 'neutral'
            END
          ELSE 'neutral'
        END AS conviction_signal
      FROM rolling
    ),
    fwd AS (
      SELECT *,
        FIRST_VALUE(underlying_price IGNORE NULLS) OVER (
          PARTITION BY condition_id ORDER BY ts_epoch
          ROWS BETWEEN 10 FOLLOWING AND 30 FOLLOWING
        ) AS price_10_30s,
        FIRST_VALUE(underlying_price IGNORE NULLS) OVER (
          PARTITION BY condition_id ORDER BY ts_epoch
          ROWS BETWEEN 30 FOLLOWING AND 60 FOLLOWING
        ) AS price_30_60s
      FROM signals
    )
    SELECT
      conviction_signal,
      COUNT(*) AS n,
      ROUND(AVG(price_10_30s - underlying_price), 6) AS avg_price_change_10_30s,
      ROUND(AVG(price_30_60s - underlying_price), 6) AS avg_price_change_30_60s,
      ROUND(AVG(CASE WHEN price_10_30s > underlying_price THEN 1.0 ELSE 0.0 END), 4) AS pct_up_10_30s,
      ROUND(AVG(CASE WHEN price_30_60s > underlying_price THEN 1.0 ELSE 0.0 END), 4) AS pct_up_30_60s
    FROM fwd
    WHERE conviction_signal != 'neutral' AND price_10_30s IS NOT NULL
    GROUP BY conviction_signal
    ORDER BY conviction_signal
  `, '5C - Cross-Side Pressure: Aligned ask + bid signals (strong conviction)');

  if (q5c.rows.length) {
    printTable(q5c.rows, q5c.columns);
    console.log(`  Interpretation: strong_up = all 4 cross-pressure signals align bullish.`);
    console.log(`  strong_down = all 4 cross-pressure signals align bearish.`);
    console.log(`  These should be the highest-conviction directional signals.\n`);
  }

  // ═══════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════
  conn.closeSync();
  const totalElapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`All queries complete in ${totalElapsed}s`);
  console.log(`${'='.repeat(70)}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
