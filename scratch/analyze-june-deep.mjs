import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const db = new DatabaseSync('state/data-backtest.db', { readOnly: true });

const RUNS = { midas: 176, apex: 158, tfc: 138 };

function parseSummary(row) {
  try {
    return JSON.parse(row.summary_json || '{}');
  } catch {
    return {};
  }
}

// Deep dive: negative expiry_win = reverse then settlement win on wrong residual?
for (const [name, runId] of Object.entries(RUNS)) {
  const rows = db
    .prepare(
      `SELECT event_start, result, reason, final_pnl, summary_json
       FROM backtest_event_traces
       WHERE run_id=? AND event_start>='2026-06-01' AND event_start<'2026-06-07'
         AND result='loss'`,
    )
    .all(runId);

  const buckets = {
    pure_expiry_loss: [],
    expiry_win_with_fees_or_reverse: [],
    closed_loss: [],
    other: [],
  };

  let reverseCount = 0;
  let exitCount = 0;
  let highAskTier = 0;
  let distBins = { '0-20': 0, '20-30': 0, '30-40': 0, '40+': 0 };
  let askBins = { '<0.7': 0, '0.7-0.82': 0, '0.82-0.94': 0, '>=0.94': 0 };
  let tauBins = { '5-10': 0, '10-20': 0, '20-30': 0 };

  for (const row of rows) {
    const s = parseSummary(row);
    const reversals = Array.isArray(s.reversals) ? s.reversals.length : s.reversals || 0;
    const exits = Array.isArray(s.exits) ? s.exits.length : 0;
    if (reversals > 0) reverseCount++;
    if (exits > 0) exitCount++;

    const dist = Math.abs(Number(s.entryDistanceToPtb) || 0);
    const ask = Number(s.avgEntryPrice) || 0;
    const tau = Number(s.entryTimeRemaining) || 0;
    const qty = Number(s.quantity) || 0;

    if (dist < 20) distBins['0-20']++;
    else if (dist < 30) distBins['20-30']++;
    else if (dist < 40) distBins['30-40']++;
    else distBins['40+']++;

    if (ask < 0.7) askBins['<0.7']++;
    else if (ask < 0.82) askBins['0.7-0.82']++;
    else if (ask < 0.94) askBins['0.82-0.94']++;
    else askBins['>=0.94']++;

    if (tau < 10) tauBins['5-10']++;
    else if (tau < 20) tauBins['10-20']++;
    else tauBins['20-30']++;

    if (ask >= 0.82 || qty >= 20) highAskTier++;

    const item = {
      event_start: row.event_start,
      reason: row.reason,
      pnl: row.final_pnl,
      dist: +dist.toFixed(2),
      ask: +ask.toFixed(4),
      tau,
      qty,
      reversals,
      exits,
      winnerSide: s.winnerSide,
      positionType: s.positionType,
      fees: s.fees,
      expiryPnl: s.expiryPnl,
      finalPnlBeforeFees: s.finalPnlBeforeFees,
      diagnostics: s.diagnostics,
    };

    if (row.reason === 'expiry_loss') buckets.pure_expiry_loss.push(item);
    else if (row.reason === 'expiry_win') buckets.expiry_win_with_fees_or_reverse.push(item);
    else if (row.reason === 'closed') buckets.closed_loss.push(item);
    else buckets.other.push(item);
  }

  console.log(`\n======== ${name.toUpperCase()} LOSS ANATOMY ========`);
  console.log(`losses=${rows.length} with_reversal=${reverseCount} with_exit=${exitCount} highAskOrTierQty=${highAskTier}`);
  console.log('distBins', distBins);
  console.log('askBins', askBins);
  console.log('tauBins', tauBins);
  console.log(
    'bucket sizes',
    Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
  );

  // Sample expiry_win negatives
  console.log('sample expiry_win negatives:');
  for (const x of buckets.expiry_win_with_fees_or_reverse.slice(0, 5)) {
    console.log(
      `  ${x.event_start} pos=${x.positionType} win=${x.winnerSide} ask=${x.ask} dist=${x.dist} tau=${x.tau} rev=${x.reversals} exits=${x.exits} pnl=${x.pnl.toFixed(2)} beforeFees=${x.finalPnlBeforeFees} fees=${JSON.stringify(x.fees)}`,
    );
  }

  // Compare wins vs losses entry features
  const all = db
    .prepare(
      `SELECT result, summary_json, final_pnl FROM backtest_event_traces
       WHERE run_id=? AND event_start>='2026-06-01' AND event_start<'2026-06-07'
         AND result IN ('win','loss')`,
    )
    .all(runId);

  const agg = { win: { n: 0, dist: 0, ask: 0, tau: 0, qty: 0 }, loss: { n: 0, dist: 0, ask: 0, tau: 0, qty: 0 } };
  for (const row of all) {
    const s = parseSummary(row);
    const a = agg[row.result];
    a.n++;
    a.dist += Math.abs(Number(s.entryDistanceToPtb) || 0);
    a.ask += Number(s.avgEntryPrice) || 0;
    a.tau += Number(s.entryTimeRemaining) || 0;
    a.qty += Number(s.quantity) || 0;
  }
  for (const k of ['win', 'loss']) {
    const a = agg[k];
    console.log(
      `${k}: n=${a.n} avgDist=${(a.dist / a.n).toFixed(2)} avgAsk=${(a.ask / a.n).toFixed(3)} avgTau=${(a.tau / a.n).toFixed(1)} avgQty=${(a.qty / a.n).toFixed(1)}`,
    );
  }

  // June 2 specifically vs other days
  const byDay = {};
  for (const row of all) {
    const s = parseSummary(row);
    const dt = row.result; // wrong - need event date from... we don't have event_start here
  }
}

// Re-query with event_start for day comparison midas
console.log('\n======== MIDAS WIN vs LOSS BY DAY (entry features) ========');
const midasAll = db
  .prepare(
    `SELECT date(event_start) AS dt, result, final_pnl, summary_json
     FROM backtest_event_traces
     WHERE run_id=176 AND event_start>='2026-06-01' AND event_start<'2026-06-07'
       AND result IN ('win','loss')`,
  )
  .all();

const dayStats = {};
for (const row of midasAll) {
  const s = parseSummary(row);
  const key = `${row.dt}|${row.result}`;
  if (!dayStats[key]) dayStats[key] = { n: 0, pnl: 0, dist: 0, ask: 0, tau: 0, qty: 0, rev: 0 };
  const a = dayStats[key];
  a.n++;
  a.pnl += row.final_pnl;
  a.dist += Math.abs(Number(s.entryDistanceToPtb) || 0);
  a.ask += Number(s.avgEntryPrice) || 0;
  a.tau += Number(s.entryTimeRemaining) || 0;
  a.qty += Number(s.quantity) || 0;
  a.rev += Array.isArray(s.reversals) ? s.reversals.length : 0;
}
for (const dt of ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06']) {
  for (const res of ['win', 'loss']) {
    const a = dayStats[`${dt}|${res}`];
    if (!a) continue;
    console.log(
      `${dt} ${res}: n=${a.n} pnl=${a.pnl.toFixed(1)} avgDist=${(a.dist / a.n).toFixed(1)} avgAsk=${(a.ask / a.n).toFixed(3)} avgTau=${(a.tau / a.n).toFixed(1)} avgQty=${(a.qty / a.n).toFixed(1)} revRate=${((100 * a.rev) / a.n).toFixed(0)}%`,
    );
  }
}

// Shared failure: favorite flipped — entry side != winner
console.log('\n======== FLIP RATE (entry side != winner) among entries ========');
for (const [name, runId] of Object.entries(RUNS)) {
  const rows = db
    .prepare(
      `SELECT date(event_start) AS dt, summary_json, result, final_pnl
       FROM backtest_event_traces
       WHERE run_id=? AND event_start>='2026-06-01' AND event_start<'2026-06-07'
         AND result IN ('win','loss')`,
    )
    .all(runId);
  const byDt = {};
  for (const row of rows) {
    const s = parseSummary(row);
    const flipped = s.positionType && s.winnerSide && s.positionType !== s.winnerSide;
    if (!byDt[row.dt]) byDt[row.dt] = { n: 0, flip: 0, flipPnl: 0, holdLoss: 0 };
    byDt[row.dt].n++;
    if (flipped) {
      byDt[row.dt].flip++;
      byDt[row.dt].flipPnl += row.final_pnl;
    }
  }
  console.log(name);
  for (const [dt, a] of Object.entries(byDt).sort()) {
    console.log(
      `  ${dt}: entries=${a.n} flipRate=${((100 * a.flip) / a.n).toFixed(1)}% flipPnl=${a.flipPnl.toFixed(1)}`,
    );
  }
}

// Probe lake with duckdb for June 2 volatility / flip intensity if duckdb CLI or node available
console.log('\n======== MARKET REGIME VIA DUCKDB (if available) ========');
const duckScript = `
INSTALL parquet; LOAD parquet;
WITH ticks AS (
  SELECT
    CAST(ts AS TIMESTAMP) AS ts,
    event_start,
    underlying_price AS spot,
    price_to_beat AS ptb,
    ABS(underlying_price - price_to_beat) AS dist,
    up_ask, down_ask,
    CASE WHEN underlying_price >= price_to_beat THEN 'UP' ELSE 'DOWN' END AS fav
  FROM read_parquet('lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-06-*/**/*.parquet', hive_partitioning=true)
  WHERE dt BETWEEN '2026-06-01' AND '2026-06-06'
)
, per_event AS (
  SELECT
    CAST(event_start AS DATE) AS dt,
    event_start,
    MAX(spot) - MIN(spot) AS range_spot,
    STDDEV_SAMP(spot) AS sigma_spot,
    -- approximate flips: count fav changes via lag
    COUNT(*) AS n_ticks
  FROM ticks
  GROUP BY 1,2
)
SELECT dt,
       COUNT(*) AS events,
       ROUND(AVG(range_spot),2) AS avg_range,
       ROUND(AVG(sigma_spot),2) AS avg_sigma,
       ROUND(QUANTILE_CONT(range_spot, 0.9),2) AS p90_range
FROM per_event
GROUP BY dt
ORDER BY dt;
`;

fs.writeFileSync('scratch/june-regime.sql', duckScript);
const tryDuck = spawnSync('npx', ['--yes', 'duckdb', '-c', duckScript], {
  encoding: 'utf8',
  timeout: 120000,
  shell: true,
});
if (tryDuck.status === 0) {
  console.log(tryDuck.stdout);
} else {
  console.log('duckdb failed/skipped:', tryDuck.stderr?.slice(0, 500) || tryDuck.error);
  // fallback: use node duckdb from package if present
  try {
    const duckdb = await import('duckdb');
    console.log('duckdb module keys', Object.keys(duckdb));
  } catch (e) {
    console.log('no duckdb module:', e.message);
  }
}

// Inspect one shared triple-loss event in detail across strategies
const EVENT = '2026-06-02T08:30:00.000Z';
console.log(`\n======== SHARED EVENT DETAIL ${EVENT} ========`);
for (const [name, runId] of Object.entries(RUNS)) {
  const row = db
    .prepare(
      `SELECT result, reason, final_pnl, summary_json FROM backtest_event_traces
       WHERE run_id=? AND event_start=?`,
    )
    .get(runId, EVENT);
  if (!row) {
    console.log(name, 'NO ENTRY / missing');
    continue;
  }
  const s = parseSummary(row);
  console.log(
    `${name}: ${row.result}/${row.reason} pnl=${row.final_pnl.toFixed(2)} side=${s.positionType}→winner=${s.winnerSide} ask=${s.avgEntryPrice} dist=${s.entryDistanceToPtb?.toFixed?.(2)} tau=${s.entryTimeRemaining} qty=${s.quantity} rev=${JSON.stringify(s.reversals)?.slice(0,120)} exits=${JSON.stringify(s.exits)?.slice(0,120)}`,
  );
}

// Count how many midas losses had dist>20 (outside TFC envelope)
const midasLossDist = db
  .prepare(
    `SELECT
       SUM(CASE WHEN ABS(json_extract(summary_json,'$.entryDistanceToPtb')) > 20 THEN 1 ELSE 0 END) AS dist_gt20,
       SUM(CASE WHEN ABS(json_extract(summary_json,'$.entryDistanceToPtb')) <= 20 THEN 1 ELSE 0 END) AS dist_le20,
       SUM(CASE WHEN json_extract(summary_json,'$.avgEntryPrice') >= 0.82 THEN 1 ELSE 0 END) AS ask_ge82,
       SUM(CASE WHEN json_extract(summary_json,'$.avgEntryPrice') < 0.82 THEN 1 ELSE 0 END) AS ask_lt82,
       ROUND(SUM(CASE WHEN ABS(json_extract(summary_json,'$.entryDistanceToPtb')) > 20 THEN final_pnl ELSE 0 END),2) AS pnl_dist_gt20,
       ROUND(SUM(CASE WHEN ABS(json_extract(summary_json,'$.entryDistanceToPtb')) <= 20 THEN final_pnl ELSE 0 END),2) AS pnl_dist_le20,
       ROUND(SUM(CASE WHEN json_extract(summary_json,'$.avgEntryPrice') >= 0.82 THEN final_pnl ELSE 0 END),2) AS pnl_ask_ge82,
       ROUND(SUM(CASE WHEN json_extract(summary_json,'$.avgEntryPrice') < 0.82 THEN final_pnl ELSE 0 END),2) AS pnl_ask_lt82
     FROM backtest_event_traces
     WHERE run_id=176 AND event_start>='2026-06-01' AND event_start<'2026-06-07'
       AND result='loss'`,
  )
  .get();
console.log('\n======== MIDAS LOSS ATTRIBUTION (envelope extension) ========');
console.log(midasLossDist);

const midasWinDist = db
  .prepare(
    `SELECT
       ROUND(SUM(CASE WHEN ABS(json_extract(summary_json,'$.entryDistanceToPtb')) > 20 THEN final_pnl ELSE 0 END),2) AS pnl_dist_gt20,
       ROUND(SUM(CASE WHEN ABS(json_extract(summary_json,'$.entryDistanceToPtb')) <= 20 THEN final_pnl ELSE 0 END),2) AS pnl_dist_le20,
       ROUND(SUM(CASE WHEN json_extract(summary_json,'$.avgEntryPrice') >= 0.82 THEN final_pnl ELSE 0 END),2) AS pnl_ask_ge82,
       ROUND(SUM(CASE WHEN json_extract(summary_json,'$.avgEntryPrice') < 0.82 THEN final_pnl ELSE 0 END),2) AS pnl_ask_lt82,
       SUM(CASE WHEN ABS(json_extract(summary_json,'$.entryDistanceToPtb')) > 20 THEN 1 ELSE 0 END) AS n_dist_gt20,
       SUM(CASE WHEN json_extract(summary_json,'$.avgEntryPrice') >= 0.82 THEN 1 ELSE 0 END) AS n_ask_ge82
     FROM backtest_event_traces
     WHERE run_id=176 AND event_start>='2026-06-01' AND event_start<'2026-06-07'
       AND result IN ('win','loss')`,
  )
  .get();
console.log('midas all entries pnl by envelope:', midasWinDist);

// Intraday equity drawdown pockets for midas on jun2
const jun2 = db
  .prepare(
    `SELECT event_start, final_pnl, result, reason,
            json_extract(summary_json,'$.avgEntryPrice') AS ask,
            json_extract(summary_json,'$.entryDistanceToPtb') AS dist,
            json_extract(summary_json,'$.positionType') AS side,
            json_extract(summary_json,'$.winnerSide') AS winner
     FROM backtest_event_traces
     WHERE run_id=176 AND event_start>='2026-06-02' AND event_start<'2026-06-03'
       AND result != 'no_entry'
     ORDER BY event_start`,
  )
  .all();
let eq = 0;
let peak = 0;
let maxDd = 0;
let maxDdAt = null;
const equity = [];
for (const row of jun2) {
  eq += row.final_pnl;
  if (eq > peak) peak = eq;
  const dd = peak - eq;
  if (dd > maxDd) {
    maxDd = dd;
    maxDdAt = row.event_start;
  }
  equity.push({ ts: row.event_start, pnl: row.final_pnl, eq: +eq.toFixed(2), dd: +dd.toFixed(2), result: row.result, reason: row.reason, ask: row.ask, dist: row.dist, side: row.side, winner: row.winner });
}
console.log(`\nMIDAS Jun2 endEq=${eq.toFixed(2)} maxDD=${maxDd.toFixed(2)} at ${maxDdAt}`);
const worstStreak = [];
let streak = [];
for (const e of equity) {
  if (e.pnl < 0) streak.push(e);
  else {
    if (streak.length > worstStreak.length) worstStreak.splice(0, worstStreak.length, ...streak);
    streak = [];
  }
}
if (streak.length > worstStreak.length) worstStreak.splice(0, worstStreak.length, ...streak);
console.log(
  'longest loss streak',
  worstStreak.length,
  'pnl',
  worstStreak.reduce((s, x) => s + x.pnl, 0).toFixed(2),
  'from',
  worstStreak[0]?.ts,
  'to',
  worstStreak.at(-1)?.ts,
);

fs.writeFileSync(
  'scratch/june-deep.json',
  JSON.stringify({ midasLossDist, midasWinDist, jun2Equity: equity, sharedEvent: EVENT }, null, 2),
);
