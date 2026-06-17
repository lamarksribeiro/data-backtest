#!/usr/bin/env node
import 'dotenv/config';

import { loadConfig } from '../../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../../src/state/sqlite.js';
import { seedPromotedStrategies } from '../../src/backtestStudio/gls/seedPromotedStrategies.js';
import { listPromotedStrategies } from '../../labs/shared/discoverStrategies.js';

async function main() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  try {
    const promoted = listPromotedStrategies();
    const results = seedPromotedStrategies(db);
    console.log(JSON.stringify({
      ok: true,
      promoted: promoted.map((item) => ({ id: item.id, slug: item.studioSlug })),
      seeded: results.map((row) => ({
        slug: row.slug,
        strategyId: row.strategy?.id ?? null,
        skipped: row.skipped ?? null,
      })),
    }, null, 2));
  } finally {
    closeStateDatabase(db);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
