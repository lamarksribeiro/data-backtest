import {
  createStrategyLibraryVersion,
  upsertStrategyLibraryDefinition,
} from '../state/strategyLibrary.js';
import { loadBootstrapLibraryEntries } from '../strategyLibrary/bootstrapEntries.js';

function upsert(db, entry) {
  const libraryId = upsertStrategyLibraryDefinition(db, {
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    status: 'validated',
  });
  const existing = db.prepare(`
    SELECT id FROM strategy_library_versions
    WHERE library_id = ? AND version = ?
  `).get(libraryId, entry.version);
  if (existing) return { slug: entry.slug, action: 'exists' };

  createStrategyLibraryVersion(db, libraryId, {
    version: entry.version,
    language: 'strategy-library-js',
    source_code: entry.source_code,
    validation: entry.validation,
    compiled: null,
  });
  return { slug: entry.slug, action: 'seeded' };
}

export function seedNativeLibraryIfEmpty(db) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM strategy_library_definitions').get()?.c ?? 0;
  if (count > 0) return { seeded: false, libraries: [] };

  const entries = loadBootstrapLibraryEntries();
  const results = [];
  for (const entry of entries) {
    const r = upsert(db, entry);
    results.push(r);
    console.log(`[seed] strategy library ${r.slug} v${entry.version} ${r.action}.`);
  }

  return { seeded: results.length > 0, libraries: results };
}