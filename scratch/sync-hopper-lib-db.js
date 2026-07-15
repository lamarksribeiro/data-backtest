import 'dotenv/config';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath, { readOnly: false });

const source = fs.readFileSync('labs/legacy/strategy-runners/portable/hopper-3-runner.js', 'utf8');
const checksum = createHash('sha256').update(source).digest('hex');

const lib = db.prepare(`SELECT id FROM strategy_library_definitions WHERE slug = ?`).get('hopper-3-runner');
if (!lib) throw new Error('hopper-3-runner definition missing');

const ver = db.prepare(`
  SELECT id, version, length(source_code) AS len, instr(source_code, 'resting_maker') AS has_resting
  FROM strategy_library_versions
  WHERE library_id = ? AND version = 1
`).get(lib.id);

console.log('before', ver);

db.prepare(`
  UPDATE strategy_library_versions
  SET source_code = ?, checksum = ?, validation_json = ?
  WHERE id = ?
`).run(source, checksum, JSON.stringify({ ok: true, kind: 'runner' }), ver.id);

const after = db.prepare(`
  SELECT id, version, length(source_code) AS len, instr(source_code, 'resting_maker') AS has_resting
  FROM strategy_library_versions
  WHERE id = ?
`).get(ver.id);
console.log('after', after);

closeStateDatabase(db);
