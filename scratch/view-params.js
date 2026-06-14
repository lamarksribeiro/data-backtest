import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';

async function main() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  try {
    const v7 = db.prepare('SELECT source_code FROM strategy_versions WHERE strategy_id = 3 AND version = 7').get();
    const v10 = db.prepare('SELECT source_code FROM strategy_versions WHERE strategy_id = 3 AND version = 10').get();
    
    console.log("=== PARAMS DECLARATION IN V7 ===");
    const v7Params = v7.source_code.split('\n').filter(line => line.includes('param '));
    console.log(v7Params.join('\n'));
    
    console.log("\n=== PARAMS DECLARATION IN V10 ===");
    const v10Params = v10.source_code.split('\n').filter(line => line.includes('param '));
    console.log(v10Params.join('\n'));
    
  } finally {
    closeStateDatabase(db);
  }
}

main().catch(console.error);
