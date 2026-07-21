import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const db = new DatabaseSync('state/data-backtest.db', { readOnly: true });

const strategies = db
  .prepare(
    `SELECT id, slug, name, status, origin, lab_package_id, created_at, updated_at
     FROM strategy_definitions
     WHERE deleted_at IS NULL
     ORDER BY status, name`,
  )
  .all();

console.log('=== STRATEGIES BY STATUS ===');
const byStatus = {};
for (const s of strategies) {
  byStatus[s.status] = byStatus[s.status] || [];
  byStatus[s.status].push(`${s.id} | ${s.slug} | ${s.name}`);
}
for (const [st, list] of Object.entries(byStatus)) {
  console.log(`\n[${st}] (${list.length})`);
  for (const line of list) console.log(' ', line);
}

const validated = strategies.filter((s) => s.status === 'validated');
const midasLike = strategies.filter(
  (s) => /midas|midás|tfc|terminal|carry|apex|edge|hopper|whipsaw|convex/i.test(`${s.name} ${s.slug}`),
);
console.log('\n=== MIDAS / TERMINAL-LIKE ===');
for (const s of midasLike) console.log(` ${s.status} | ${s.id} | ${s.slug} | ${s.name}`);

// Find runs that cover June 1-6
const runs = db
  .prepare(
    `SELECT r.id, r.strategy, r.strategy_id, r.status, r.from_ts, r.to_ts, r.created_at,
            r.underlying, r.interval, r.book_depth,
            s.slug AS strat_slug, s.name AS strat_name, s.status AS strat_status,
            r.summary_json
     FROM backtest_runs r
     LEFT JOIN strategy_definitions s ON s.id = r.strategy_id
     WHERE r.from_ts <= '2026-06-07T00:00:00.000Z'
       AND r.to_ts >= '2026-06-01T00:00:00.000Z'
       AND r.status = 'completed'
     ORDER BY r.id DESC
     LIMIT 80`,
  )
  .all();

console.log(`\n=== COMPLETED RUNS overlapping Jun1-6: ${runs.length} ===`);
for (const r of runs.slice(0, 40)) {
  let sum = {};
  try {
    sum = JSON.parse(r.summary_json || '{}');
  } catch {}
  console.log(
    `#${r.id} ${r.strat_slug || r.strategy} [${r.strat_status || '?'}] ${r.from_ts?.slice(0, 10)}→${r.to_ts?.slice(0, 10)} pnl=${sum.totalPnl ?? sum.netPnl ?? '?'} wr=${sum.winRate ?? '?'} entries=${sum.entries ?? sum.trades ?? '?'}`,
  );
}

// Per-run daily PnL for Jun 1-6 from event traces
const focusIds = runs
  .filter((r) => {
    const slug = `${r.strat_slug || ''} ${r.strategy || ''} ${r.strat_name || ''}`.toLowerCase();
    return (
      r.strat_status === 'validated' ||
      /midas|tfc|apex|terminal|carry|hopper|edge|whipsaw|convex/i.test(slug)
    );
  })
  .map((r) => r.id);

console.log(`\nFocus run ids: ${focusIds.slice(0, 30).join(', ')} (n=${focusIds.length})`);

if (focusIds.length) {
  const placeholders = focusIds.map(() => '?').join(',');
  const daily = db
    .prepare(
      `SELECT r.id AS run_id,
              COALESCE(s.slug, r.strategy) AS strat,
              s.status AS strat_status,
              date(t.event_start) AS dt,
              COUNT(*) AS n,
              SUM(CASE WHEN t.result='loss' THEN 1 ELSE 0 END) AS losses,
              SUM(CASE WHEN t.result='win' THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN t.result='no_entry' THEN 1 ELSE 0 END) AS no_entry,
              ROUND(SUM(t.final_pnl), 2) AS pnl,
              ROUND(AVG(CASE WHEN t.result!='no_entry' THEN t.final_pnl END), 4) AS avg_pnl,
              ROUND(MIN(t.final_pnl), 2) AS worst_trade
       FROM backtest_event_traces t
       JOIN backtest_runs r ON r.id = t.run_id
       LEFT JOIN strategy_definitions s ON s.id = r.strategy_id
       WHERE t.run_id IN (${placeholders})
         AND t.event_start >= '2026-06-01' AND t.event_start < '2026-06-07'
       GROUP BY r.id, dt
       ORDER BY strat, dt, r.id`,
    )
    .all(...focusIds);

  console.log('\n=== DAILY PnL Jun1-6 (focus runs) ===');
  for (const row of daily) {
    console.log(
      `${row.dt} run#${row.run_id} ${row.strat}[${row.strat_status}] n=${row.n} W/L=${row.wins}/${row.losses} skip=${row.no_entry} pnl=${row.pnl} avg=${row.avg_pnl} worst=${row.worst_trade}`,
    );
  }

  // Loss reasons for losing days / all losses in window
  const reasons = db
    .prepare(
      `SELECT COALESCE(s.slug, r.strategy) AS strat,
              t.reason,
              COUNT(*) AS n,
              ROUND(SUM(t.final_pnl), 2) AS pnl,
              ROUND(AVG(t.final_pnl), 4) AS avg_pnl
       FROM backtest_event_traces t
       JOIN backtest_runs r ON r.id = t.run_id
       LEFT JOIN strategy_definitions s ON s.id = r.strategy_id
       WHERE t.run_id IN (${placeholders})
         AND t.event_start >= '2026-06-01' AND t.event_start < '2026-06-07'
         AND t.result = 'loss'
       GROUP BY strat, t.reason
       ORDER BY strat, pnl ASC`,
    )
    .all(...focusIds);

  console.log('\n=== LOSS REASONS Jun1-6 ===');
  for (const row of reasons) {
    console.log(`${row.strat} | ${row.reason || '(null)'} | n=${row.n} pnl=${row.pnl} avg=${row.avg_pnl}`);
  }

  // Hour-of-day loss pockets
  const hours = db
    .prepare(
      `SELECT COALESCE(s.slug, r.strategy) AS strat,
              CAST(strftime('%H', t.event_start) AS INT) AS hour_utc,
              COUNT(*) AS n,
              SUM(CASE WHEN t.result='loss' THEN 1 ELSE 0 END) AS losses,
              ROUND(SUM(t.final_pnl), 2) AS pnl
       FROM backtest_event_traces t
       JOIN backtest_runs r ON r.id = t.run_id
       LEFT JOIN strategy_definitions s ON s.id = r.strategy_id
       WHERE t.run_id IN (${placeholders})
         AND t.event_start >= '2026-06-01' AND t.event_start < '2026-06-07'
         AND t.result != 'no_entry'
       GROUP BY strat, hour_utc
       HAVING pnl < 0
       ORDER BY pnl ASC
       LIMIT 40`,
    )
    .all(...focusIds);

  console.log('\n=== WORST HOUR UTC POCKETS (pnl<0) ===');
  for (const row of hours) {
    console.log(`${row.strat} H${String(row.hour_utc).padStart(2, '0')} n=${row.n} losses=${row.losses} pnl=${row.pnl}`);
  }

  // Worst individual losses
  const worst = db
    .prepare(
      `SELECT COALESCE(s.slug, r.strategy) AS strat,
              t.event_start, t.side, t.result, t.reason, t.final_pnl,
              substr(t.summary_json,1,300) AS summary_head
       FROM backtest_event_traces t
       JOIN backtest_runs r ON r.id = t.run_id
       LEFT JOIN strategy_definitions s ON s.id = r.strategy_id
       WHERE t.run_id IN (${placeholders})
         AND t.event_start >= '2026-06-01' AND t.event_start < '2026-06-07'
         AND t.final_pnl < -1
       ORDER BY t.final_pnl ASC
       LIMIT 25`,
    )
    .all(...focusIds);

  console.log('\n=== WORST TRADES Jun1-6 ===');
  for (const row of worst) {
    console.log(
      `${row.event_start} ${row.strat} ${row.side} ${row.reason} pnl=${row.final_pnl} | ${row.summary_head}`,
    );
  }
}

// Also: any run specifically for midas
const midasRuns = db
  .prepare(
    `SELECT r.id, r.from_ts, r.to_ts, r.created_at, s.slug, s.status, r.summary_json
     FROM backtest_runs r
     LEFT JOIN strategy_definitions s ON s.id = r.strategy_id
     WHERE lower(COALESCE(s.slug,'')) LIKE '%midas%'
        OR lower(COALESCE(s.name,'')) LIKE '%midas%'
        OR lower(COALESCE(r.strategy,'')) LIKE '%midas%'
     ORDER BY r.id DESC LIMIT 20`,
  )
  .all();
console.log('\n=== MIDAS RUNS ===');
for (const r of midasRuns) {
  let sum = {};
  try {
    sum = JSON.parse(r.summary_json || '{}');
  } catch {}
  console.log(
    `#${r.id} ${r.slug}[${r.status}] ${r.from_ts?.slice(0, 10)}→${r.to_ts?.slice(0, 10)} pnl=${sum.totalPnl ?? sum.netPnl ?? '?'}`,
  );
}

fs.writeFileSync(
  'scratch/june-strategies.json',
  JSON.stringify({ strategies, validated, midasLike, runCount: runs.length }, null, 2),
);
console.log('\nWrote scratch/june-strategies.json');
