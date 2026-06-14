import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';

async function main() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  try {
    const versions = db.prepare('SELECT id, strategy_id, version, notes, created_at FROM strategy_versions WHERE strategy_id = 18 ORDER BY version DESC').all();
    console.log("Versions for Strategy 18 (V3):", JSON.stringify(versions, null, 2));
  } finally {
    closeStateDatabase(db);
  }
}

main().catch(console.error);
