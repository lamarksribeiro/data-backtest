import { createHash } from 'node:crypto';

import { listRegisteredNativeLibraries } from '../nativeLibrary/registry.js';

function checksum(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function toApiDefinition(row, versions = []) {
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    versions: versions.map(toApiVersion),
    latest_version: versions[0]?.version ?? null,
  };
}

function toApiVersion(row) {
  return {
    id: Number(row.id),
    library_id: Number(row.library_id),
    version: Number(row.version),
    language: row.language,
    source_code: row.source_code,
    validation: JSON.parse(row.validation_json || '{}'),
    compiled: row.compiled_json ? JSON.parse(row.compiled_json) : null,
    checksum: row.checksum,
    created_at: row.created_at,
  };
}

export function listStrategyLibraries(db) {
  const rows = db.prepare(`
    SELECT * FROM strategy_library_definitions
    ORDER BY slug ASC
  `).all();

  return rows.map((row) => {
    const versions = db.prepare(`
      SELECT * FROM strategy_library_versions
      WHERE library_id = ?
      ORDER BY version DESC, id DESC
    `).all(row.id);
    return toApiDefinition(row, versions);
  });
}

export function getStrategyLibraryBySlug(db, slug) {
  const row = db.prepare('SELECT * FROM strategy_library_definitions WHERE slug = ?').get(slug);
  if (!row) return null;
  const versions = db.prepare(`
    SELECT * FROM strategy_library_versions
    WHERE library_id = ?
    ORDER BY version DESC, id DESC
  `).all(row.id);
  return toApiDefinition(row, versions);
}

export function getStrategyLibraryVersion(db, slug, version) {
  const lib = getStrategyLibraryBySlug(db, slug);
  if (!lib) return null;
  const match = lib.versions.find((v) => v.version === Number(version));
  return match ? { library: lib, version: match } : null;
}

export function upsertStrategyLibraryDefinition(db, { slug, name, description = null, status = 'validated' }) {
  const existing = db.prepare('SELECT id FROM strategy_library_definitions WHERE slug = ?').get(slug);
  if (existing) {
    db.prepare(`
      UPDATE strategy_library_definitions
      SET name = ?, description = ?, status = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(name, description, status, existing.id);
    return Number(existing.id);
  }
  const result = db.prepare(`
    INSERT INTO strategy_library_definitions (slug, name, description, status)
    VALUES (?, ?, ?, ?)
  `).run(slug, name, description, status);
  return Number(result.lastInsertRowid);
}

export function createStrategyLibraryVersion(db, libraryId, {
  version,
  language = 'native-bundled',
  source_code: sourceCode,
  validation = {},
  compiled = null,
}) {
  const checksumValue = checksum(sourceCode);
  const existing = db.prepare(`
    SELECT id FROM strategy_library_versions
    WHERE library_id = ? AND version = ?
  `).get(libraryId, version);

  if (existing) {
    db.prepare(`
      UPDATE strategy_library_versions
      SET language = ?, source_code = ?, validation_json = ?, compiled_json = ?, checksum = ?
      WHERE id = ?
    `).run(
      language,
      sourceCode,
      JSON.stringify(validation),
      compiled ? JSON.stringify(compiled) : null,
      checksumValue,
      existing.id,
    );
    return Number(existing.id);
  }

  const result = db.prepare(`
    INSERT INTO strategy_library_versions (
      library_id, version, language, source_code, validation_json, compiled_json, checksum
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    libraryId,
    version,
    language,
    sourceCode,
    JSON.stringify(validation),
    compiled ? JSON.stringify(compiled) : null,
    checksumValue,
  );
  return Number(result.lastInsertRowid);
}

export function listBundledNativeLibraryCatalog() {
  return listRegisteredNativeLibraries().map((entry) => ({
    slug: entry.slug,
    version: entry.version,
    kind: 'native-bundled',
  }));
}