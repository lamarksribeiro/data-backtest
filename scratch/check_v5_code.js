import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath);

const version5 = db.prepare('SELECT * FROM strategy_versions WHERE id = 123').get();
console.log('Version 5 source_code:\n', version5.source_code);
console.log('Version 5 validation_json:\n', version5.validation_json);

closeStateDatabase(db);
