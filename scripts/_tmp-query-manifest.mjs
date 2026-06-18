import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('state/data-backtest.db', { readOnly: true });
const rows = db.prepare(`
  SELECT underlying, interval, book_depth, MIN(dt) as min_dt, MAX(dt) as max_dt, COUNT(*) as partitions
  FROM lake_manifest
  WHERE dataset = 'backtest_ticks' AND status IN ('valid', 'accepted') AND active_path IS NOT NULL
    AND book_depth = 25
  GROUP BY underlying, interval, book_depth
  ORDER BY underlying
`).all();
console.log(JSON.stringify(rows, null, 2));
db.close();
