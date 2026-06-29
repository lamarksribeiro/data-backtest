#!/usr/bin/env node
import 'dotenv/config';

import { loadConfig } from '../src/config.js';
import { seedPromotedStrategies } from '../src/backtestStudio/gls/seedPromotedStrategies.js';
import { manifestStats } from '../src/state/manifest.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath);

seedPromotedStrategies(db);

const strategy = db.prepare(`
  SELECT sd.id, sv.id AS version_id, sv.version
  FROM strategy_definitions sd
  JOIN strategy_versions sv ON sv.strategy_id = sd.id
  WHERE sd.slug = ?
  ORDER BY sv.version ASC
`).all('edge-snipper');

const btc = db.prepare(`
  SELECT COUNT(*) AS n, MIN(dt) AS from_dt, MAX(dt) AS to_dt
  FROM lake_manifest
  WHERE dataset = 'backtest_ticks'
    AND underlying = 'BTC'
    AND interval = '5m'
    AND status IN ('valid', 'accepted')
`).get();

const eth = db.prepare(`
  SELECT COUNT(*) AS n, MIN(dt) AS from_dt, MAX(dt) AS to_dt
  FROM lake_manifest
  WHERE dataset = 'backtest_ticks'
    AND underlying = 'ETH'
    AND interval = '5m'
    AND status IN ('valid', 'accepted')
`).get();

console.log(JSON.stringify({
  lake_root: config.lakeRoot,
  state_db: config.stateDbPath,
  strategy_versions: strategy,
  manifest: manifestStats(db),
  btc_partitions: btc,
  eth_partitions: eth,
}, null, 2));

closeStateDatabase(db);
