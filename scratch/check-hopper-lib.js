import 'dotenv/config';
import { loadConfig } from './src/config.js';
import { openStateDatabase, closeStateDatabase } from './src/state/sqlite.js';

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath, { readOnly: true });
const row = db.prepare(`
  SELECT sld.slug, slv.version, length(slv.source_code) AS len,
         instr(slv.source_code, 'resting_maker') AS has_resting,
         instr(slv.source_code, 'executionMode') AS has_exec
  FROM strategy_library_versions slv
  JOIN strategy_library_defs sld ON sld.id = slv.library_id
  WHERE sld.slug = 'hopper-3-runner'
  ORDER BY slv.version DESC
  LIMIT 1
`).get();
console.log(row);
closeStateDatabase(db);
