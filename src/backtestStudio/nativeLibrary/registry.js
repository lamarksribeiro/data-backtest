import os from 'node:os';
import path from 'node:path';

import { openStateDatabase } from '../../state/sqlite.js';
import { loadStrategyLibraryFactory } from '../strategyLibrary/loadFactory.js';
import { loadEdgeSniperModelsSource } from '../strategyJs/inlineModelLibrary.js';
import { loadTerminalConvexityModelsSource } from './bundled/terminalConvexityModels.js';

const BUNDLED_NATIVE_MODELS = new Map([
  ['edge-sniper-models:1', () => loadEdgeSniperModelsSource()],
  ['terminal-convexity-models:1', () => loadTerminalConvexityModelsSource()],
]);
const bundledFactoryCache = new Map();

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

function resolveBundledNativeModelsFactory(slug, version = 1) {
  const loader = BUNDLED_NATIVE_MODELS.get(`${slug}:${version}`);
  if (!loader) return null;

  const cacheKey = `${slug}:${version}`;
  if (!bundledFactoryCache.has(cacheKey)) {
    const source = loader();
    const compiled = new Function(
      'lib',
      `"use strict";\n${source}\nreturn typeof createLibrary === "function" ? createLibrary(lib) : null;`,
    );
    bundledFactoryCache.set(cacheKey, compiled);
  }

  return bundledFactoryCache.get(cacheKey);
}

export function resolveNativeModels(lib, slug = 'edge-sniper-models', version = 1) {
  const factory = getNativeLibraryFactory(slug, version);
  if (factory) return factory(lib);

  const bundled = resolveBundledNativeModelsFactory(slug, version);
  if (!bundled) return null;
  const models = bundled(lib);
  if (!models || typeof models !== 'object') {
    throw new Error(`bundled native models ${slug}@${version} must return an object from createLibrary(lib)`);
  }
  return models;
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