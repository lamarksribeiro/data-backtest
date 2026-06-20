#!/usr/bin/env node
/**
 * Embute bibliotecas de estratégia no SQLite (fonte de verdade).
 * Fonte: data/strategy-libraries/*.json (não código no runtime do repo).
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';

import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import {
  createStrategyLibraryVersion,
  upsertStrategyLibraryDefinition,
} from '../src/backtestStudio/state/strategyLibrary.js';
import { loadBootstrapLibraryEntries } from '../src/backtestStudio/strategyLibrary/bootstrapEntries.js';

function checksum(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function upsertLibrary(db, entry) {
  const libraryId = upsertStrategyLibraryDefinition(db, {
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    status: 'validated',
  });
  createStrategyLibraryVersion(db, libraryId, {
    version: entry.version,
    language: 'strategy-library-js',
    source_code: entry.source_code,
    validation: entry.validation,
    compiled: entry.compiled ?? null,
  });
  return entry.slug;
}

function main() {
  const libraries = loadBootstrapLibraryEntries();
  if (!libraries.length) {
    throw new Error('No strategy library bootstrap files found in data/strategy-libraries/*.json');
  }

  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  const embedded = [];
  for (const entry of libraries) {
    db.prepare('DELETE FROM strategy_library_versions WHERE library_id = (SELECT id FROM strategy_library_definitions WHERE slug = ?) AND version = ?')
      .run(entry.slug, entry.version);
    embedded.push(upsertLibrary(db, entry));
  }

  console.log(JSON.stringify({
    ok: true,
    embedded,
    checksums: libraries.map((l) => ({ slug: l.slug, checksum: checksum(l.source_code) })),
  }, null, 2));
  closeStateDatabase(db);
}

main();