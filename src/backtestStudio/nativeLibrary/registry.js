import os from 'node:os';
import path from 'node:path';

import { openStateDatabase } from '../../state/sqlite.js';
import { loadStrategyLibraryFactory } from '../strategyLibrary/loadFactory.js';

let activeDb = null;
let bootstrapDb = null;
const BOOTSTRAP_DB_PATH = path.join(os.tmpdir(), 'goldenlens-strategy-library-bootstrap.db');

export function bindStrategyLibraryDatabase(db) {
  activeDb = db || null;
}

export function resetStrategyLibraryDatabase() {
  activeDb = null;
}

export function ensureStrategyLibraryDatabase(db = null) {
  if (db) {
    bindStrategyLibraryDatabase(db);
    return db;
  }
  if (activeDb) return activeDb;
  if (!bootstrapDb) {
    bootstrapDb = openStateDatabase(BOOTSTRAP_DB_PATH);
  }
  bindStrategyLibraryDatabase(bootstrapDb);
  return bootstrapDb;
}

export function getNativeLibraryFactory(slug, version = 1) {
  if (!activeDb) return null;
  return loadStrategyLibraryFactory(activeDb, slug, version);
}

export function resolveNativeModels(lib, slug = 'edge-sniper-models', version = 1) {
  const factory = getNativeLibraryFactory(slug, version);
  if (!factory) return null;
  return factory(lib);
}

export function listRegisteredNativeLibraries() {
  if (!activeDb) return [];
  const rows = activeDb.prepare(`
    SELECT sld.slug, slv.version
    FROM strategy_library_definitions sld
    JOIN strategy_library_versions slv ON slv.library_id = sld.id
    ORDER BY sld.slug, slv.version
  `).all();
  return rows.map((row) => ({ slug: row.slug, version: Number(row.version) }));
}