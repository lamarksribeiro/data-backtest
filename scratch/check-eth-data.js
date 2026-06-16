import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath);

const eth = db.prepare(`
  SELECT COUNT(*) AS n, MIN(dt) AS from_dt, MAX(dt) AS to_dt
  FROM lake_manifest
  WHERE dataset = 'backtest_ticks'
    AND underlying = 'ETH'
    AND interval = '5m'
    AND status IN ('valid', 'accepted')
`).get();

console.log("ETH Partitions in State DB:", eth);

const allUnderlyings = db.prepare(`
  SELECT DISTINCT underlying
  FROM lake_manifest
  WHERE dataset = 'backtest_ticks'
`).all();

console.log("All Underlyings in State DB:", allUnderlyings);

closeStateDatabase(db);
