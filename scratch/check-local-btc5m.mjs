import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath);

const latest = db.prepare(`
  SELECT dt, status, active_path
  FROM lake_manifest
  WHERE underlying = 'BTC' AND interval = '5m' AND book_depth = 25 AND dataset = 'backtest_ticks'
  ORDER BY dt DESC
  LIMIT 10
`).all();

const july = db.prepare(`
  SELECT dt, status
  FROM lake_manifest
  WHERE underlying = 'BTC' AND interval = '5m' AND book_depth = 25 AND dataset = 'backtest_ticks'
    AND dt >= '2026-07-01' AND dt <= '2026-07-09'
  ORDER BY dt
`).all();

const counts = db.prepare(`
  SELECT status, COUNT(*) as n
  FROM lake_manifest
  WHERE underlying = 'BTC' AND interval = '5m' AND book_depth = 25 AND dataset = 'backtest_ticks'
  GROUP BY status
`).all();

console.log('Latest 10:', JSON.stringify(latest, null, 2));
console.log('July 2026:', JSON.stringify(july, null, 2));
console.log('Status counts:', JSON.stringify(counts, null, 2));

closeStateDatabase(db);
