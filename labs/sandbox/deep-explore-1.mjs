/**
 * Deep exploratory data analysis — BTC 5m backtest ticks (Parquet).
 *
 * Usage: node --max-old-space-size=8192 labs/sandbox/deep-explore-1.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const LAKE_ROOT = path.resolve('lake');
const BASE = path.join(LAKE_ROOT, 'backtest_ticks', 'underlying=BTC', 'interval=5m');

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

async function runSql(conn, sql) {
  console.log(`\n--- SQL (trimmed) ---\n${sql.slice(0, 500)}${sql.length > 500 ? '\n...' : ''}\n`);
  const result = await conn.runAndReadAll(sql);
  const rows = result.getRowObjectsJS();
  if (rows.length === 0) {
    console.log('(no rows returned)');
    return { rows: [], columns: [] };
  }
  const columns = Object.keys(rows[0]);
  return { rows, columns };
}

async function main() {
  console.log('=== deep-explore-1: BTC 5m Backtest Ticks ===\n');

  // 1. Collect all parquet files
  const t0 = Date.now();
  const files = collectParquetFiles(BASE);
  console.log(`Found ${files.length} parquet file(s) under ${BASE}`);
  if (files.length === 0) {
    console.error('ERROR: No parquet files found. Aborting.');
    process.exit(1);
  }
  console.log(`First file: ${files[0]}`);
  console.log(`Last file:  ${files[files.length - 1]}`);

  // 2. Open DuckDB
  console.log('\nOpening DuckDB in-memory instance...');
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run(`SET threads TO 4`);

  const pql = parquetList(files);
  const pqlLimit = parquetList(files.slice(0, 10)); // limit for describe

  // 3. List all columns
  console.log('\n=== SCHEMA: Column listing ===');
  const schemaResult = await runSql(conn, `DESCRIBE SELECT * FROM read_parquet(${pqlLimit})`);
  if (schemaResult.rows.length) {
    const totalCols = schemaResult.rows.length;
    // Group columns for display
    const scalarCols = [];
    const bookCols = [];
    for (const row of schemaResult.rows) {
      const name = row.column_name;
      if (/_(px|sz)_\d+$/.test(name)) {
        bookCols.push(name);
      } else {
        scalarCols.push(name);
      }
    }
    console.log(`\nTotal columns: ${totalCols} (${scalarCols.length} scalars, ${bookCols.length} order-book levels)\n`);

    console.log('-- Scalar columns --');
    for (const row of schemaResult.rows) {
      const name = row.column_name;
      if (!/_(px|sz)_\d+$/.test(name)) {
        console.log(`  ${name.padEnd(30)}  ${String(row.column_type).padEnd(15)}  ${row.null === 'YES' ? 'nullable' : 'NOT NULL'}`);
      }
    }

    console.log('\n-- Order-book columns (sample first 4 levels per side) --');
    const sides = ['up_ask', 'up_bid', 'down_ask', 'down_bid'];
    const shown = new Set();
    for (const side of sides) {
      for (let i = 1; i <= 4; i += 1) {
        for (const col of bookCols) {
          if (col.startsWith(`${side}_`) && col.endsWith(`_${i}`)) {
            const info = schemaResult.rows.find((r) => r.column_name === col);
            console.log(`  ${col.padEnd(30)}  ${String(info?.column_type ?? '?').padEnd(15)}`);
            shown.add(col);
          }
        }
      }
    }
    console.log(`  ... (${bookCols.length - shown.size} more order-book columns up to max depth)`);
  }

  // 4. Show sample data
  console.log('\n=== SAMPLE: 10 rows (scalar columns only) ===');
  const sampleResult = await runSql(conn, `
    SELECT market_id, underlying, interval, condition_id, event_start, event_end, ts,
           underlying_price, price_to_beat, up_price, down_price,
           up_best_bid, up_best_ask, down_best_bid, down_best_ask,
           coverage, degraded, book_depth
    FROM read_parquet(${pqlLimit})
    ORDER BY ts ASC, condition_id ASC
    LIMIT 10
  `);

  if (sampleResult.rows.length) {
    const cols = sampleResult.columns;
    // Print header
    const widths = {};
    for (const col of cols) widths[col] = Math.max(col.length, 8);
    for (const row of sampleResult.rows) {
      for (const col of cols) {
        const val = String(row[col] ?? '');
        widths[col] = Math.min(Math.max(widths[col], val.length), 45);
      }
    }
    const header = cols.map((c) => c.padEnd(widths[c])).join(' | ');
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const row of sampleResult.rows) {
      const line = cols.map((c) => {
        let val = String(row[c] ?? '');
        if (val.length > 45) val = val.slice(0, 42) + '...';
        return val.padEnd(widths[c]);
      }).join(' | ');
      console.log(line);
    }
  }

  // 5. Show sample order-book data for one tick
  console.log('\n=== SAMPLE: 1 row with full order-book (first 5 levels each side) ===');
  const objCols = ['up_ask', 'up_bid', 'down_ask', 'down_bid'].flatMap((s) =>
    Array.from({ length: 5 }, (_, i) => [`${s}_px_${i + 1}`, `${s}_sz_${i + 1}`]).flat()
  );
  const obResult = await runSql(conn, `
    SELECT ts, condition_id, ${objCols.join(', ')}
    FROM read_parquet(${pqlLimit})
    ORDER BY ts ASC, condition_id ASC
    LIMIT 1
  `);
  if (obResult.rows.length) {
    const row = obResult.rows[0];
    console.log(`  ts: ${row.ts}  condition_id: ${row.condition_id}`);
    for (const side of ['up_ask', 'up_bid', 'down_ask', 'down_bid']) {
      console.log(`  ${side}:`);
      for (let i = 1; i <= 5; i += 1) {
        const px = row[`${side}_px_${i}`];
        const sz = row[`${side}_sz_${i}`];
        console.log(`    L${i}  px=${px ?? 'null'}  sz=${sz ?? 'null'}`);
      }
    }
  }

  // 6. Count total rows across the full dataset
  console.log('\n=== COUNTS: Total rows (full dataset) ===');
  const countResult = await runSql(conn, `
    SELECT count(*) AS total_rows FROM read_parquet(${pql})
  `);
  if (countResult.rows.length) {
    const total = Number(countResult.rows[0].total_rows).toLocaleString();
    console.log(`Total rows (ticks): ${total}`);
  }

  // Count distinct timestamps
  const tsCount = await runSql(conn, `
    SELECT count(DISTINCT ts) AS unique_ts FROM read_parquet(${pql})
  `);
  if (tsCount.rows.length) {
    console.log(`Unique timestamps:    ${Number(tsCount.rows[0].unique_ts).toLocaleString()}`);
  }

  // Count distinct conditions (events)
  const eventCount = await runSql(conn, `
    SELECT count(DISTINCT condition_id) AS unique_events FROM read_parquet(${pql})
  `);
  if (eventCount.rows.length) {
    console.log(`Unique events:        ${Number(eventCount.rows[0].unique_events).toLocaleString()}`);
  }

  // Date range
  console.log('\n=== DATE RANGE ===');
  const rangeResult = await runSql(conn, `
    SELECT MIN(try_cast(event_start AS DATE)) AS min_date,
           MAX(try_cast(event_start AS DATE)) AS max_date,
           MIN(try_cast(ts AS TIMESTAMP)) AS min_ts,
           MAX(try_cast(ts AS TIMESTAMP)) AS max_ts
    FROM read_parquet(${pql})
  `);
  if (rangeResult.rows.length) {
    const fd = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '?'));
    console.log(`  event_start:  ${fd(rangeResult.rows[0].min_date).slice(0, 10)}  →  ${fd(rangeResult.rows[0].max_date).slice(0, 10)}`);
    console.log(`  ts (ticks):   ${fd(rangeResult.rows[0].min_ts).slice(0, 19)}  →  ${fd(rangeResult.rows[0].max_ts).slice(0, 19)}`);
  }

  // Book depth distribution
  console.log('\n=== BOOK DEPTH DISTRIBUTION ===');
  const bdResult = await runSql(conn, `
    SELECT book_depth, count(*) AS cnt
    FROM read_parquet(${pql})
    GROUP BY book_depth
    ORDER BY book_depth
  `);
  if (bdResult.rows.length) {
    for (const r of bdResult.rows) {
      console.log(`  book_depth=${r.book_depth}  rows=${Number(r.cnt).toLocaleString()}`);
    }
  }

  // Degraded / coverage stats
  console.log('\n=== COVERAGE & DEGRADATION ===');
  const covResult = await runSql(conn, `
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE coverage IS NOT NULL) AS with_coverage,
      count(*) FILTER (WHERE degraded = true) AS degraded_true,
      round(avg(coverage), 2) AS avg_coverage,
      round(min(coverage), 2) AS min_coverage,
      round(max(coverage), 2) AS max_coverage
    FROM read_parquet(${pql})
  `);
  if (covResult.rows.length) {
    const r = covResult.rows[0];
    console.log(`  Total rows:       ${Number(r.total).toLocaleString()}`);
    console.log(`  With coverage:    ${Number(r.with_coverage).toLocaleString()}`);
    console.log(`  Degraded=true:    ${Number(r.degraded_true).toLocaleString()}`);
    console.log(`  Avg coverage:     ${r.avg_coverage}`);
    console.log(`  Min coverage:     ${r.min_coverage}`);
    console.log(`  Max coverage:     ${r.max_coverage}`);
  }

  // Price column stats
  console.log('\n=== PRICE COLUMN STATS ===');
  const pxResult = await runSql(conn, `
    SELECT
      count(*) FILTER (WHERE underlying_price IS NOT NULL) AS uprice_present,
      count(*) FILTER (WHERE price_to_beat IS NOT NULL) AS ptb_present,
      count(*) FILTER (WHERE up_price IS NOT NULL) AS up_present,
      count(*) FILTER (WHERE down_price IS NOT NULL) AS down_present,
      round(avg(underlying_price), 2) AS avg_uprice,
      round(min(underlying_price), 2) AS min_uprice,
      round(max(underlying_price), 2) AS max_uprice
    FROM read_parquet(${pql})
  `);
  if (pxResult.rows.length) {
    const r = pxResult.rows[0];
    console.log(`  underlying_price  present=${Number(r.uprice_present).toLocaleString()}  avg=$${r.avg_uprice}  min=$${r.min_uprice}  max=$${r.max_uprice}`);
    console.log(`  price_to_beat     present=${Number(r.ptb_present).toLocaleString()}`);
    console.log(`  up_price          present=${Number(r.up_present).toLocaleString()}`);
    console.log(`  down_price        present=${Number(r.down_present).toLocaleString()}`);
  }

  // Best bid/ask stats
  console.log('\n=== BID/ASK STATS ===');
  const baResult = await runSql(conn, `
    SELECT
      round(avg(up_best_bid), 2) AS avg_ubb,
      round(avg(up_best_ask), 2) AS avg_uba,
      round(avg(up_best_ask - up_best_bid), 6) AS avg_up_spread,
      round(avg(down_best_bid), 2) AS avg_dbb,
      round(avg(down_best_ask), 2) AS avg_dba,
      round(avg(down_best_ask - down_best_bid), 6) AS avg_down_spread
    FROM read_parquet(${pql})
    WHERE up_best_bid IS NOT NULL AND up_best_ask IS NOT NULL
      AND down_best_bid IS NOT NULL AND down_best_ask IS NOT NULL
  `);
  if (baResult.rows.length) {
    const r = baResult.rows[0];
    console.log(`  UP best bid:   avg=${r.avg_ubb}  best ask avg=${r.avg_uba}  spread avg=${r.avg_up_spread}`);
    console.log(`  DOWN best bid: avg=${r.avg_dbb}  best ask avg=${r.avg_dba}  spread avg=${r.avg_down_spread}`);
  }

  // Per-date row count (top 10 dates)
  console.log('\n=== TOP 10 DATES BY ROW COUNT ===');
  const dtResult = await runSql(conn, `
    SELECT try_cast(event_start AS DATE) AS dt, count(*) AS cnt
    FROM read_parquet(${pql})
    GROUP BY try_cast(event_start AS DATE)
    ORDER BY cnt DESC
    LIMIT 10
  `);
  if (dtResult.rows.length) {
    for (const r of dtResult.rows) {
      const d = r.dt instanceof Date ? r.dt.toISOString().slice(0, 10) : String(r.dt).slice(0, 10);
      console.log(`  ${d}  ${Number(r.cnt).toLocaleString()} rows`);
    }
  }

  // Close
  conn.closeSync();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== Done in ${elapsed}s ===`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
