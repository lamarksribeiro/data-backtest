#!/usr/bin/env node
import 'dotenv/config';

import { loadConfig } from '../src/config.js';
import { seedEdgeSniperV2Strategy } from '../src/backtestStudio/gls/seedStrategies.js';
import { manifestStats } from '../src/state/manifest.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath);

seedEdgeSniperV2Strategy(db);

const strategy = db.prepare(`
  SELECT sd.id, sv.id AS version_id
  FROM strategy_definitions sd
  JOIN strategy_versions sv ON sv.strategy_id = sd.id
  WHERE sd.slug = ?
  ORDER BY sv.id DESC
  LIMIT 1
`).get('edge-sniper-v2-gls');

const btc = db.prepare(`
  SELECT COUNT(*) AS n, MIN(dt) AS from_dt, MAX(dt) AS to_dt
  FROM lake_manifest
  WHERE dataset = 'backtest_ticks'
    AND underlying = 'BTC'
    AND interval = '5m'
    AND status IN ('valid', 'accepted')
`).get();

console.log(JSON.stringify({
  lake_root: config.lakeRoot,
  state_db: config.stateDbPath,
  strategy,
  manifest: manifestStats(db),
  btc_partitions: btc,
}, null, 2));

closeStateDatabase(db);
