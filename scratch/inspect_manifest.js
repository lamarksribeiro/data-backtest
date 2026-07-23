import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath);

const rows = db.prepare(`SELECT * FROM lake_manifest LIMIT 3`).all();
console.log('Sample rows from lake_manifest:', rows);

closeStateDatabase(db);
