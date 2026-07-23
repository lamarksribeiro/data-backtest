import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath);

const validPartitions = db.prepare(`
  SELECT dt, rows, events_count, active_path
  FROM lake_manifest
  WHERE dataset = 'backtest_ticks' AND status IN ('valid', 'accepted') AND active_path IS NOT NULL
  ORDER BY dt DESC
`).all();

console.log(`Found ${validPartitions.length} valid partitions in lake_manifest:`);
console.table(validPartitions.map(p => ({ dt: p.dt, rows: p.rows, events: p.events_count })));

closeStateDatabase(db);
