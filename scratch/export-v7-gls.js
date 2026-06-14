import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import fs from 'node:fs';

async function main() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  try {
    const row = db.prepare('SELECT source_code FROM strategy_versions WHERE strategy_id = 3 AND version = 10').get();
    if (!row) {
      console.error("Versão 10 não encontrada.");
      return;
    }
    fs.writeFileSync('src/backtestStudio/gls/strategies/edgeSniperV3_v2.gls', row.source_code);
    console.log("Código GLS da versão 10 exportado para src/backtestStudio/gls/strategies/edgeSniperV3_v2.gls");
  } finally {
    closeStateDatabase(db);
  }
}

main().catch(console.error);
