#!/usr/bin/env node
import 'dotenv/config';

import { loadConfig } from '../../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../../src/state/sqlite.js';
import { seedEdgeSniperV2Presets } from '../../src/backtestStudio/gls/seedEdgeSniperV2Presets.js';

async function main() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  try {
    const seeded = seedEdgeSniperV2Presets(db);
    console.log(JSON.stringify({ ok: true, count: seeded.length, presets: seeded }, null, 2));
  } finally {
    closeStateDatabase(db);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
