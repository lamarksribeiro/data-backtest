import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath);

console.log('Checking strategy_definitions in state.db...');
const strats = db.prepare('SELECT id, slug, name, default_version_id FROM strategy_definitions').all();
console.table(strats);

for (const s of strats) {
  const versions = db.prepare('SELECT id, version, language, checksum FROM strategy_versions WHERE strategy_id = ?').all(s.id);
  console.log(`Versions for ${s.slug}:`, versions);
}

closeStateDatabase(db);
