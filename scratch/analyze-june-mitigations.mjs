import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { openSharedConnection } from '../src/query/duckdbPool.js';

const db = new DatabaseSync('state/data-backtest.db', { readOnly: true });

function parseSummary(row) {
  try {
    return JSON.parse(row.summary_json || '{}');
  } catch {
    return {};
  }
}

// Cost of late_flip_reverse for midas in window
const midas = db
  .prepare(
    `SELECT event_start, result, reason, final_pnl, summary_json
     FROM backtest_event_traces
     WHERE run_id=176 AND event_start>='2026-06-01' AND event_start<'2026-06-07'
       AND result IN ('win','loss')`,
  )
  .all();

let withReverse = { n: 0, pnl: 0, wins: 0, losses: 0 };
let withoutReverse = { n: 0, pnl: 0, wins: 0, losses: 0 };
let reverseThenWrong = { n: 0, pnl: 0 }; // reverse fired but original would have won / expiry_win loss
let reverseThenRight = { n: 0, pnl: 0 };

for (const row of midas) {
  const s = parseSummary(row);
  const fees = s.fees || {};
  const entries = fees.entries || [];
  const hadReverse = entries.some((e) => /reverse/i.test(e.source || ''));
  const bucket = hadReverse ? withReverse : withoutReverse;
  bucket.n++;
  bucket.pnl += row.final_pnl;
  if (row.result === 'win') bucket.wins++;
  else bucket.losses++;

  if (hadReverse && row.reason === 'expiry_win' && row.final_pnl < 0) {
    reverseThenWrong.n++;
    reverseThenWrong.pnl += row.final_pnl;
  }
  if (hadReverse && row.reason === 'expiry_loss') {
    // reverse happened but still expired loss? unusual
  }
  if (hadReverse && row.result === 'win') {
    reverseThenRight.n++;
    reverseThenRight.pnl += row.final_pnl;
  }
}

console.log('MIDAS reverse attribution:');
console.log('  with reverse', { ...withReverse, pnl: +withReverse.pnl.toFixed(2) });
console.log('  without reverse', { ...withoutReverse, pnl: +withoutReverse.pnl.toFixed(2) });
console.log('  reverse toxic (expiry_win loss)', { ...reverseThenWrong, pnl: +reverseThenWrong.pnl.toFixed(2) });
console.log('  reverse then win', { ...reverseThenRight, pnl: +reverseThenRight.pnl.toFixed(2) });

// Marginal favorite toxicity: ask<0.70 AND dist<15
function bandStats(predicate) {
  let n = 0, pnl = 0, wins = 0, losses = 0;
  for (const row of midas) {
    const s = parseSummary(row);
    const ask = Number(s.avgEntryPrice) || 0;
    const dist = Math.abs(Number(s.entryDistanceToPtb) || 0);
    if (!predicate(ask, dist, s, row)) continue;
    n++;
    pnl += row.final_pnl;
    if (row.result === 'win') wins++;
    else losses++;
  }
  return { n, wins, losses, wr: n ? +(100 * wins / n).toFixed(1) : 0, pnl: +pnl.toFixed(2) };
}

const bands = {
  marginal_ask_lt70_dist_lt15: bandStats((ask, dist) => ask < 0.7 && dist < 15),
  solid_ask_ge75_dist_ge15: bandStats((ask, dist) => ask >= 0.75 && dist >= 15),
  midas_extension_dist_gt20: bandStats((ask, dist) => dist > 20),
  midas_tier_ask_ge82: bandStats((ask) => ask >= 0.82),
  core_tfc_like: bandStats((ask, dist) => ask >= 0.55 && ask <= 0.82 && dist <= 20),
};
console.log('MIDAS bands Jun1-6:', bands);

// Same for TFC
const tfc = db
  .prepare(
    `SELECT result, final_pnl, summary_json FROM backtest_event_traces
     WHERE run_id=138 AND event_start>='2026-06-01' AND event_start<'2026-06-07'
       AND result IN ('win','loss')`,
  )
  .all();

function bandStatsRows(rows, predicate) {
  let n = 0, pnl = 0, wins = 0;
  for (const row of rows) {
    const s = parseSummary(row);
    const ask = Number(s.avgEntryPrice) || 0;
    const dist = Math.abs(Number(s.entryDistanceToPtb) || 0);
    if (!predicate(ask, dist)) continue;
    n++;
    pnl += row.final_pnl;
    if (row.result === 'win') wins++;
  }
  return { n, wr: n ? +(100 * wins / n).toFixed(1) : 0, pnl: +pnl.toFixed(2) };
}
console.log('TFC marginal:', bandStatsRows(tfc, (a, d) => a < 0.7 && d < 15));
console.log('TFC solid:', bandStatsRows(tfc, (a, d) => a >= 0.75 && d >= 10));

// Market regime via project DuckDB
const conn = await openSharedConnection();
try {
  const sql = `
    WITH ticks AS (
      SELECT
        CAST(event_start AS DATE) AS dt,
        event_start,
        underlying_price AS spot,
        price_to_beat AS ptb
      FROM read_parquet(
        'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-06-0*/**/*.parquet',
        hive_partitioning=true
      )
      WHERE dt BETWEEN '2026-06-01' AND '2026-06-06'
    ),
    per_event AS (
      SELECT
        dt,
        event_start,
        MAX(spot) - MIN(spot) AS range_spot,
        STDDEV_SAMP(spot) AS sigma_spot,
        AVG(ABS(spot - ptb)) AS avg_dist
      FROM ticks
      GROUP BY 1, 2
    )
    SELECT
      CAST(dt AS VARCHAR) AS dt,
      COUNT(*) AS events,
      ROUND(AVG(range_spot), 2) AS avg_range,
      ROUND(AVG(sigma_spot), 2) AS avg_sigma,
      ROUND(QUANTILE_CONT(range_spot, 0.9), 2) AS p90_range,
      ROUND(AVG(avg_dist), 2) AS avg_dist
    FROM per_event
    GROUP BY dt
    ORDER BY dt
  `;
  const result = await conn.runAndReadAll(sql);
  const rows = result.getRowObjectsJson();
  console.log('MARKET REGIME:', rows);
  fs.writeFileSync('scratch/june-regime.json', JSON.stringify(rows, null, 2));
} catch (e) {
  console.log('regime query error:', e.message);
  try {
    const day1 = fs.readdirSync('lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-06-01');
    console.log('day1 files sample', day1.slice(0, 8));
  } catch (e2) {
    console.log(e2.message);
  }
} finally {
  conn.closeSync?.();
}

fs.writeFileSync(
  'scratch/june-mitigations.json',
  JSON.stringify({ withReverse, withoutReverse, reverseThenWrong, bands }, null, 2),
);
