#!/usr/bin/env node
import 'dotenv/config';

import { loadConfig } from '../../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../../src/state/sqlite.js';
import { seedEdgeSniperV2Presets } from '../../src/backtestStudio/gls/seedEdgeSniperV2Presets.js';
import { seedImpulseElasticityPresets } from '../../src/backtestStudio/gls/seedImpulseElasticityPresets.js';

async function main() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  try {
    const seededEdge = seedEdgeSniperV2Presets(db);
    const seededImpulse = seedImpulseElasticityPresets(db);
    console.log(JSON.stringify({ 
      ok: true, 
      edge: { count: seededEdge.length, presets: seededEdge },
      impulse: { count: seededImpulse.length, presets: seededImpulse }
    }, null, 2));
  } finally {
    closeStateDatabase(db);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
