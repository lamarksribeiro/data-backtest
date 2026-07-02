import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('state/data-backtest.db', { readOnly: true });
const rows = db.prepare(`
  SELECT dt, status, rows, events_count, coverage_min, has_degraded, active_path
  FROM lake_manifest
  WHERE dataset='backtest_ticks' AND underlying='BTC' AND interval='5m' AND book_depth=25
  ORDER BY dt
`).all();
let usable = 0;
for (const r of rows) {
  const ok = r.status === 'valid' || r.status === 'accepted';
  if (ok) usable += 1;
  console.log(`${r.dt} ${r.status.padEnd(10)} rows=${String(r.rows).padStart(7)} events=${String(r.events_count).padStart(4)} covMin=${r.coverage_min} degr=${r.has_degraded}`);
}
console.log(`total=${rows.length} usable=${usable}`);
