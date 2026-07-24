import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';

const c = loadConfig();
const db = openStateDatabase(c.stateDbPath, { readOnly: true });
try {
  const row = db.prepare(`
    SELECT status, rows, quality_details_json
    FROM lake_manifest
    WHERE dataset='backtest_ticks' AND dt='2026-07-24' AND book_depth=25
  `).get();
  console.log('status', row?.status, 'rows', row?.rows);
  const qd = row?.quality_details_json ? JSON.parse(row.quality_details_json) : null;
  const idx = qd?.normalization?.events_index || [];
  const target = '0x146a2fba5a334afede478638aa55eba82f6d313fc87f6fa590ad60590bdce533';
  const hit = idx.find((e) => String(e.condition_id || e.conditionId || '').toLowerCase() === target);
  console.log('target_index_hit', JSON.stringify(hit, null, 2));
  const omitted = idx.filter((e) => e.action === 'omit' || e.omitted || e.status === 'omitted').slice(0, 20);
  console.log('omitted_sample', JSON.stringify(omitted, null, 2));
  console.log('normalization_summary', JSON.stringify({
    events_total: qd?.normalization?.events_total,
    events_exported: qd?.normalization?.events_exported,
    events_omitted: qd?.normalization?.events_omitted,
    ticks_removed: qd?.normalization?.ticks_removed,
    hours_affected: qd?.normalization?.hours_affected,
    samples: qd?.normalization?.samples,
  }, null, 2));
} finally {
  closeStateDatabase(db);
}
