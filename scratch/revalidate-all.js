import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { validateStrategySource } from '../src/backtestStudio/state/strategies.js';

async function main() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  try {
    const versions = db.prepare('SELECT id, strategy_id, version, source_code, validation_json FROM strategy_versions').all();
    console.log(`Encontradas ${versions.length} versões de estratégia no banco.`);
    let updatedCount = 0;
    
    for (const v of versions) {
      const validation = validateStrategySource({ language: 'gls-v1', source_code: v.source_code });
      const currentVal = JSON.stringify(validation);
      
      let wasOk = false;
      try {
        wasOk = JSON.parse(v.validation_json || '{}').ok;
      } catch {}
      
      if (v.validation_json !== currentVal) {
        db.prepare('UPDATE strategy_versions SET validation_json = ?, params_schema_json = ? WHERE id = ?')
          .run(currentVal, JSON.stringify(validation.params_schema || {}), v.id);
        
        console.log(`Versão ID ${v.id} (Estratégia ${v.strategy_id}, v${v.version}) atualizada. Status anterior ok: ${wasOk} -> Novo status ok: ${validation.ok}`);
        updatedCount++;
      }
    }
    console.log(`Revalidação concluída. ${updatedCount} versões atualizadas no banco.`);
  } finally {
    closeStateDatabase(db);
  }
}

main().catch(console.error);
