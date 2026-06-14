#!/usr/bin/env node
import 'dotenv/config';

import { loadConfig } from '../../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../../src/state/sqlite.js';
import { seedEdgeSniperV2Presets } from '../../src/backtestStudio/gls/seedEdgeSniperV2Presets.js';
import { seedImpulseElasticityPresets } from '../../src/backtestStudio/gls/seedImpulseElasticityPresets.js';
import { seedEdgeSniperV3Presets } from '../../src/backtestStudio/gls/seedEdgeSniperV3Presets.js';

async function main() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  try {
    const seededEdge = seedEdgeSniperV2Presets(db);
    const seededImpulse = seedImpulseElasticityPresets(db);
    seedEdgeSniperV3Presets(db);
    console.log(JSON.stringify({ 
      ok: true, 
      edge: { count: seededEdge ? seededEdge.length : 0, presets: seededEdge },
      impulse: { count: seededImpulse ? seededImpulse.length : 0, presets: seededImpulse }
    }, null, 2));
  } finally {
    closeStateDatabase(db);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
