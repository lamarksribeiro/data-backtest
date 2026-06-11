export function getRunAnalysis(db, runId) {
  const byReason = db.prepare(`
    SELECT reason, COUNT(*) AS count, SUM(final_pnl) AS total_pnl
    FROM backtest_event_traces
    WHERE run_id = ? AND result = 'loss'
    GROUP BY reason
    ORDER BY total_pnl ASC
  `).all(runId);

  const worst = db.prepare(`
    SELECT id, condition_id, event_start, final_pnl, result, reason
    FROM backtest_event_traces
    WHERE run_id = ?
    ORDER BY final_pnl ASC
    LIMIT 20
  `).all(runId);

  const byHour = db.prepare(`
    SELECT CAST(strftime('%H', event_start) AS INTEGER) AS hour,
           COUNT(*) AS count,
           SUM(final_pnl) AS total_pnl
    FROM backtest_event_traces
    WHERE run_id = ?
    GROUP BY hour
    ORDER BY hour
  `).all(runId);

  const histogram = db.prepare(`
    SELECT
      CASE
        WHEN final_pnl < -50 THEN 'lt_-50'
        WHEN final_pnl < -20 THEN '-50_-20'
        WHEN final_pnl < 0 THEN '-20_0'
        WHEN final_pnl = 0 THEN '0'
        WHEN final_pnl <= 20 THEN '0_20'
        ELSE 'gt_20'
      END AS bucket,
      COUNT(*) AS count
    FROM backtest_event_traces
    WHERE run_id = ?
    GROUP BY bucket
  `).all(runId);

  return { by_reason: byReason, worst_events: worst, pnl_by_hour: byHour, histogram };
}

export function compareBacktestRuns(db, ids) {
  const runs = ids.map((id) => db.prepare('SELECT * FROM backtest_runs WHERE id = ?').get(id)).filter(Boolean);
  const summaries = runs.map((row) => ({
    id: Number(row.id),
    strategy: row.strategy,
    summary: JSON.parse(row.summary_json || '{}'),
    equity: JSON.parse(row.result_json || '{}').equity || [],
    from: row.from_ts,
    to: row.to_ts,
  }));

  const delta = db.prepare(`
    SELECT a.condition_id, a.event_start,
           a.final_pnl AS pnl_a, b.final_pnl AS pnl_b,
           (b.final_pnl - a.final_pnl) AS delta
    FROM backtest_event_traces a
    JOIN backtest_event_traces b
      ON a.condition_id = b.condition_id AND a.event_start = b.event_start
    WHERE a.run_id = ? AND b.run_id = ?
      AND ABS(b.final_pnl - a.final_pnl) > 0.001
    ORDER BY ABS(delta) DESC
    LIMIT 200
  `).all(ids[0], ids[1]);

  return { runs: summaries, delta_events: delta };
}
