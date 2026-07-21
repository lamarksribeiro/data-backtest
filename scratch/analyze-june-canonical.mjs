import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const db = new DatabaseSync('state/data-backtest.db', { readOnly: true });

// Canonical latest completed runs for each validated strategy covering Jun 1-6
const CANON = {
  'midas-carry-v1': 176,
  'apex-triad-v1': 158, // june-focused
  tfc: 138, // best june lab-aligned
  'tfc-reversal-pro': null,
};

// Find tfc-reversal-pro runs
const revRuns = db
  .prepare(
    `SELECT r.id, r.from_ts, r.to_ts, r.status,
            json_extract(r.summary_json,'$.totalPnl') AS pnl,
            json_extract(r.summary_json,'$.winRate') AS wr,
            json_extract(r.summary_json,'$.entries') AS entries
     FROM backtest_runs r
     JOIN strategy_definitions s ON s.id = r.strategy_id
     WHERE s.slug = 'tfc-reversal-pro' AND r.status='completed'
     ORDER BY r.id DESC LIMIT 10`,
  )
  .all();
console.log('tfc-reversal-pro runs:', revRuns);
if (revRuns.length) CANON['tfc-reversal-pro'] = revRuns[0].id;

// Also pick best representative TFC run that has traces in window
for (const [slug, preferred] of Object.entries({ ...CANON })) {
  const check = preferred
    ? db
        .prepare(
          `SELECT COUNT(*) AS n FROM backtest_event_traces WHERE run_id=? AND event_start>='2026-06-01' AND event_start<'2026-06-07'`,
        )
        .get(preferred)
    : { n: 0 };
  console.log(`canon ${slug} run=${preferred} traces_in_window=${check.n}`);
}

const runIds = Object.values(CANON).filter(Boolean);
const placeholders = runIds.map(() => '?').join(',');

const daily = db
  .prepare(
    `SELECT s.slug,
            r.id AS run_id,
            date(t.event_start) AS dt,
            COUNT(*) AS events,
            SUM(CASE WHEN t.result='win' THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN t.result='loss' THEN 1 ELSE 0 END) AS losses,
            SUM(CASE WHEN t.result='no_entry' THEN 1 ELSE 0 END) AS skips,
            SUM(CASE WHEN t.result NOT IN ('no_entry') THEN 1 ELSE 0 END) AS entries,
            ROUND(SUM(t.final_pnl), 2) AS pnl,
            ROUND(AVG(CASE WHEN t.result!='no_entry' THEN t.final_pnl END), 4) AS avg_pnl,
            ROUND(MIN(t.final_pnl), 2) AS worst,
            ROUND(SUM(CASE WHEN t.final_pnl < 0 THEN t.final_pnl ELSE 0 END), 2) AS gross_loss,
            ROUND(SUM(CASE WHEN t.final_pnl > 0 THEN t.final_pnl ELSE 0 END), 2) AS gross_win
     FROM backtest_event_traces t
     JOIN backtest_runs r ON r.id = t.run_id
     JOIN strategy_definitions s ON s.id = r.strategy_id
     WHERE t.run_id IN (${placeholders})
       AND t.event_start >= '2026-06-01' AND t.event_start < '2026-06-07'
     GROUP BY s.slug, r.id, dt
     ORDER BY s.slug, dt`,
  )
  .all(...runIds);

console.log('\n=== DAILY CANONICAL ===');
for (const row of daily) {
  const wr = row.entries ? ((100 * row.wins) / row.entries).toFixed(1) : '—';
  console.log(
    `${row.dt} ${row.slug.padEnd(18)} pnl=${String(row.pnl).padStart(8)} W/L=${row.wins}/${row.losses} skip=${row.skips} wr=${wr}% worst=${row.worst} gl=${row.gross_loss}`,
  );
}

// Totals
const totals = db
  .prepare(
    `SELECT s.slug,
            ROUND(SUM(t.final_pnl), 2) AS pnl,
            SUM(CASE WHEN t.result='win' THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN t.result='loss' THEN 1 ELSE 0 END) AS losses,
            SUM(CASE WHEN t.result!='no_entry' THEN 1 ELSE 0 END) AS entries,
            ROUND(MIN(t.final_pnl), 2) AS worst
     FROM backtest_event_traces t
     JOIN backtest_runs r ON r.id = t.run_id
     JOIN strategy_definitions s ON s.id = r.strategy_id
     WHERE t.run_id IN (${placeholders})
       AND t.event_start >= '2026-06-01' AND t.event_start < '2026-06-07'
     GROUP BY s.slug
     ORDER BY pnl`,
  )
  .all(...runIds);
console.log('\n=== WINDOW TOTALS ===');
console.log(totals);

// Loss reasons
const reasons = db
  .prepare(
    `SELECT s.slug, COALESCE(t.reason,'(null)') AS reason, COUNT(*) AS n,
            ROUND(SUM(t.final_pnl),2) AS pnl, ROUND(AVG(t.final_pnl),3) AS avg
     FROM backtest_event_traces t
     JOIN backtest_runs r ON r.id=t.run_id
     JOIN strategy_definitions s ON s.id=r.strategy_id
     WHERE t.run_id IN (${placeholders})
       AND t.event_start >= '2026-06-01' AND t.event_start < '2026-06-07'
       AND t.result='loss'
     GROUP BY s.slug, reason
     ORDER BY s.slug, pnl`,
  )
  .all(...runIds);
console.log('\n=== LOSS REASONS ===');
for (const r of reasons) console.log(`${r.slug} | ${r.reason} | n=${r.n} pnl=${r.pnl} avg=${r.avg}`);

// Hour pockets across validated
const hours = db
  .prepare(
    `SELECT s.slug,
            date(t.event_start) AS dt,
            CAST(strftime('%H', t.event_start) AS INT) AS hour_utc,
            COUNT(*) AS n,
            SUM(CASE WHEN t.result='loss' THEN 1 ELSE 0 END) AS losses,
            ROUND(SUM(t.final_pnl),2) AS pnl
     FROM backtest_event_traces t
     JOIN backtest_runs r ON r.id=t.run_id
     JOIN strategy_definitions s ON s.id=r.strategy_id
     WHERE t.run_id IN (${placeholders})
       AND t.event_start >= '2026-06-01' AND t.event_start < '2026-06-07'
       AND t.result != 'no_entry'
     GROUP BY s.slug, dt, hour_utc
     HAVING pnl < -15
     ORDER BY pnl ASC
     LIMIT 50`,
  )
  .all(...runIds);
console.log('\n=== WORST HOUR POCKETS (pnl<-15) ===');
for (const r of hours) {
  console.log(`${r.dt} H${String(r.hour_utc).padStart(2,'0')} ${r.slug} n=${r.n} L=${r.losses} pnl=${r.pnl}`);
}

// Correlate losses: same event losing across strategies?
const multiLoss = db
  .prepare(
    `WITH entries AS (
       SELECT t.event_start, s.slug, t.final_pnl, t.result, t.reason, t.side
       FROM backtest_event_traces t
       JOIN backtest_runs r ON r.id=t.run_id
       JOIN strategy_definitions s ON s.id=r.strategy_id
       WHERE t.run_id IN (${placeholders})
         AND t.event_start >= '2026-06-01' AND t.event_start < '2026-06-07'
         AND t.result = 'loss'
     )
     SELECT event_start,
            COUNT(DISTINCT slug) AS n_strats,
            GROUP_CONCAT(DISTINCT slug) AS strats,
            ROUND(SUM(final_pnl),2) AS total_pnl
     FROM entries
     GROUP BY event_start
     HAVING n_strats >= 2
     ORDER BY n_strats DESC, total_pnl ASC
     LIMIT 40`,
  )
  .all(...runIds);
console.log('\n=== EVENTS LOSING ON 2+ APPROVED STRATS ===');
for (const r of multiLoss) {
  console.log(`${r.event_start} n=${r.n_strats} [${r.strats}] pnl=${r.total_pnl}`);
}

// Sample marks/summaries from worst midas losses
const midasRun = CANON['midas-carry-v1'];
const midasWorst = db
  .prepare(
    `SELECT event_start, side, reason, final_pnl, summary_json, marks_json, metrics_json
     FROM backtest_event_traces
     WHERE run_id = ? AND event_start >= '2026-06-01' AND event_start < '2026-06-07'
       AND final_pnl < -5
     ORDER BY final_pnl ASC
     LIMIT 15`,
  )
  .all(midasRun);

console.log('\n=== MIDAS WORST LOSSES DETAIL ===');
const midasDetails = [];
for (const row of midasWorst) {
  let summary = {};
  let marks = [];
  let metrics = {};
  try { summary = JSON.parse(row.summary_json || '{}'); } catch {}
  try { marks = JSON.parse(row.marks_json || '[]'); } catch {}
  try { metrics = JSON.parse(row.metrics_json || '{}'); } catch {}
  const detail = {
    event_start: row.event_start,
    side: row.side,
    reason: row.reason,
    pnl: row.final_pnl,
    summary,
    marks: Array.isArray(marks) ? marks.slice(0, 8) : marks,
    metrics,
  };
  midasDetails.push(detail);
  console.log(
    `${row.event_start} ${row.side} ${row.reason} pnl=${row.final_pnl.toFixed?.(2) ?? row.final_pnl}`,
    JSON.stringify(summary).slice(0, 220),
  );
}

// Apex June 2 deep dive
const apexJun2 = db
  .prepare(
    `SELECT CAST(strftime('%H', event_start) AS INT) AS hour_utc,
            COUNT(*) AS n,
            SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
            ROUND(SUM(final_pnl),2) AS pnl,
            ROUND(MIN(final_pnl),2) AS worst
     FROM backtest_event_traces
     WHERE run_id = ? AND event_start >= '2026-06-02' AND event_start < '2026-06-03'
       AND result != 'no_entry'
     GROUP BY hour_utc
     ORDER BY pnl`,
  )
  .all(CANON['apex-triad-v1']);
console.log('\n=== APEX JUN2 BY HOUR ===');
for (const r of apexJun2) console.log(`H${String(r.hour_utc).padStart(2,'0')} n=${r.n} L=${r.losses} pnl=${r.pnl} worst=${r.worst}`);

// Market regime proxy from lake via DuckDB if available — else skip
// Analyze entry ask / dist from marks for midas losses vs wins
function extractEntryFeatures(runId) {
  const rows = db
    .prepare(
      `SELECT event_start, result, final_pnl, reason, marks_json, summary_json, metrics_json
       FROM backtest_event_traces
       WHERE run_id = ? AND event_start >= '2026-06-01' AND event_start < '2026-06-07'
         AND result IN ('win','loss')`,
    )
    .all(runId);

  const feats = [];
  for (const row of rows) {
    let marks = [];
    let summary = {};
    try { marks = JSON.parse(row.marks_json || '[]'); } catch {}
    try { summary = JSON.parse(row.summary_json || '{}'); } catch {}
    const entry =
      (Array.isArray(marks) && marks.find((m) => /entry|midas_entry|buy/i.test(m?.type || m?.label || ''))) ||
      null;
    feats.push({
      dt: row.event_start.slice(0, 10),
      result: row.result,
      pnl: row.final_pnl,
      reason: row.reason,
      ask: entry?.ask ?? entry?.price ?? summary.entryAsk ?? summary.ask ?? null,
      dist: entry?.dist ?? entry?.distAbs ?? summary.distAbs ?? summary.dist ?? null,
      tau: entry?.secondsLeft ?? entry?.tau ?? summary.secondsLeft ?? null,
      markTypes: Array.isArray(marks) ? [...new Set(marks.map((m) => m?.type || m?.label).filter(Boolean))] : [],
      summaryKeys: Object.keys(summary).slice(0, 20),
    });
  }
  return feats;
}

const midasFeats = extractEntryFeatures(midasRun);
console.log('\n=== MIDAS FEATURE SAMPLE (first loss with marks) ===');
const sampleLoss = midasFeats.find((f) => f.result === 'loss');
console.log(sampleLoss);
console.log('markTypes histogram:');
const typeHist = {};
for (const f of midasFeats) {
  for (const t of f.markTypes) typeHist[t] = (typeHist[t] || 0) + 1;
}
console.log(typeHist);
console.log('summaryKeys sample:', midasFeats[0]?.summaryKeys);

// Group midas by day + reason
const midasByDayReason = db
  .prepare(
    `SELECT date(event_start) AS dt, COALESCE(reason,'(null)') AS reason,
            COUNT(*) AS n, ROUND(SUM(final_pnl),2) AS pnl
     FROM backtest_event_traces
     WHERE run_id = ? AND event_start >= '2026-06-01' AND event_start < '2026-06-07'
       AND result='loss'
     GROUP BY dt, reason
     ORDER BY dt, pnl`,
  )
  .all(midasRun);
console.log('\n=== MIDAS LOSSES BY DAY×REASON ===');
for (const r of midasByDayReason) console.log(`${r.dt} ${r.reason} n=${r.n} pnl=${r.pnl}`);

// TFC same
const tfcByDayReason = db
  .prepare(
    `SELECT date(event_start) AS dt, COALESCE(reason,'(null)') AS reason,
            COUNT(*) AS n, ROUND(SUM(final_pnl),2) AS pnl
     FROM backtest_event_traces
     WHERE run_id = ? AND event_start >= '2026-06-01' AND event_start < '2026-06-07'
       AND result='loss'
     GROUP BY dt, reason
     ORDER BY dt, pnl`,
  )
  .all(CANON.tfc);
console.log('\n=== TFC LOSSES BY DAY×REASON ===');
for (const r of tfcByDayReason) console.log(`${r.dt} ${r.reason} n=${r.n} pnl=${r.pnl}`);

const out = {
  canon: CANON,
  daily,
  totals,
  reasons,
  hours,
  multiLoss,
  midasDetails,
  apexJun2,
  midasByDayReason,
  tfcByDayReason,
};
fs.writeFileSync('scratch/june1-6-analysis.json', JSON.stringify(out, null, 2));
console.log('\nWrote scratch/june1-6-analysis.json');
