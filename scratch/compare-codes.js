import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';

async function main() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  try {
    const versions = db.prepare('SELECT id, version, source_code, validation_json FROM strategy_versions WHERE strategy_id = 3 AND version IN (5, 6, 7, 8, 9, 10) ORDER BY version ASC').all();
    for (const v of versions) {
      console.log(`=== Versão ${v.version} (ID ${v.id}) ===`);
      let validation = {};
      try {
        validation = JSON.parse(v.validation_json);
      } catch {}
      console.log("Validation keys:", Object.keys(validation));
      console.log("Validation parameters schema keys:", Object.keys(validation.params_schema || {}));
      
      // Vamos tentar extrair os parâmetros padrão do código fonte
      // Geralmente, o código GLS tem parâmetros declarados
      // Vamos imprimir as primeiras 15 linhas do código fonte
      const lines = v.source_code.split('\n');
      console.log("Source head (15 lines):");
      console.log(lines.slice(0, 20).join('\n'));
      console.log("\n");
    }
  } finally {
    closeStateDatabase(db);
  }
}

main().catch(console.error);
