import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';

const db = openStateDatabase(loadConfig().stateDbPath);
const libs = db.prepare('SELECT slug FROM strategy_library_definitions').all().map((r) => r.slug);
const rows = db.prepare(`
  SELECT sd.slug, sv.version, length(sv.source_code) AS bytes,
         CASE WHEN sv.source_code LIKE '%function createLibrary%' THEN 1 ELSE 0 END AS has_models,
         CASE WHEN sv.source_code LIKE '%gammaLadderRunnerFactory%' THEN 1 ELSE 0 END AS has_gamma,
         CASE WHEN sv.source_code LIKE '%strategyLibrary%' THEN 1 ELSE 0 END AS has_deps
  FROM strategy_versions sv
  JOIN strategy_definitions sd ON sd.id = sv.strategy_id
  WHERE sv.language = 'strategy-js-v1'
  ORDER BY sd.slug, sv.version
`).all();
const withDeps = rows.filter((r) => r.has_deps).length;
console.log(JSON.stringify({ libs, versions: rows.length, withStrategyLibraryRefs: withDeps, strategies: rows }, null, 2));
closeStateDatabase(db);