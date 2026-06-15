import { createHash } from 'node:crypto';
import { validate as validateGls } from '../gls/validator.js';
import { invalidateStrategyStatsCache } from './strategyStats.js';

const ALLOWED_STATUS = new Set(['draft', 'validated', 'failed', 'archived']);

export function listStrategies(db, { trashed = false } = {}) {
  const clause = trashed ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL';
  const rows = db.prepare(`
    SELECT * FROM strategy_definitions
    WHERE ${clause}
    ORDER BY pinned DESC, updated_at DESC, id DESC
  `).all();
  return rows.map((row) => toApiStrategy(db, row));
}

export function listTrashedStrategies(db) {
  return listStrategies(db, { trashed: true });
}

export function getStrategy(db, id, { includeTrashed = false } = {}) {
  const clause = includeTrashed ? '' : ' AND deleted_at IS NULL';
  const row = db.prepare(`SELECT * FROM strategy_definitions WHERE id = ?${clause}`).get(id);
  return row ? toApiStrategy(db, row) : null;
}

export function getStrategyBySlug(db, slug) {
  const row = db.prepare('SELECT * FROM strategy_definitions WHERE slug = ?').get(slug);
  return row ? toApiStrategy(db, row) : null;
}

export function createStrategy(db, { slug, name, description = null, tags = [] }) {
  const normalizedSlug = normalizeSlug(slug);
  const normalizedName = normalizeName(name);
  const result = db.prepare(`
    INSERT INTO strategy_definitions (slug, name, description, tags_json)
    VALUES (?, ?, ?, ?)
  `).run(normalizedSlug, normalizedName, description, JSON.stringify(normalizeTags(tags)));
  invalidateStrategyStatsCache();
  return getStrategy(db, result.lastInsertRowid);
}

export function updateStrategy(db, id, patch = {}) {
  const current = getStrategy(db, id);
  if (!current) return null;

  const next = {
    name: patch.name != null ? normalizeName(patch.name) : current.name,
    description: patch.description !== undefined ? patch.description : current.description,
    status: patch.status != null ? normalizeStatus(patch.status) : current.status,
    tags: patch.tags != null ? normalizeTags(patch.tags) : current.tags,
    pinned: patch.pinned != null ? (patch.pinned ? 1 : 0) : (current.pinned ? 1 : 0),
    default_version_id: current.default_version_id ?? null,
  };

  if (patch.default_version_id !== undefined) {
    if (patch.default_version_id == null || patch.default_version_id === '') {
      next.default_version_id = null;
    } else {
      const versionId = Number(patch.default_version_id);
      if (!Number.isFinite(versionId) || versionId <= 0) {
        throw new Error('default_version_id must be a positive integer or null');
      }
      const version = getStrategyVersion(db, id, versionId);
      if (!version) throw new Error('default_version_id not found for strategy');
      next.default_version_id = versionId;
    }
  }

  db.prepare(`
    UPDATE strategy_definitions
    SET name = ?, description = ?, status = ?, tags_json = ?, pinned = ?, default_version_id = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(
    next.name,
    next.description,
    next.status,
    JSON.stringify(next.tags),
    next.pinned,
    next.default_version_id,
    id,
  );

  invalidateStrategyStatsCache();
  return getStrategy(db, id);
}

export function trashStrategy(db, id) {
  const row = db.prepare('SELECT * FROM strategy_definitions WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return null;

  db.prepare(`
    UPDATE strategy_definitions
    SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(id);
  invalidateStrategyStatsCache();
  return getStrategy(db, id, { includeTrashed: true });
}

export function restoreStrategy(db, id) {
  const row = db.prepare('SELECT * FROM strategy_definitions WHERE id = ? AND deleted_at IS NOT NULL').get(id);
  if (!row) return null;

  db.prepare(`
    UPDATE strategy_definitions
    SET deleted_at = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(id);
  invalidateStrategyStatsCache();
  return getStrategy(db, id);
}

export function permanentlyDeleteStrategy(db, id, { deleteRuns = false } = {}) {
  const row = db.prepare('SELECT * FROM strategy_definitions WHERE id = ? AND deleted_at IS NOT NULL').get(id);
  if (!row) return null;

  const snapshot = toApiStrategy(db, row);
  db.exec('BEGIN');
  try {
    if (deleteRuns) {
      const runIds = db.prepare('SELECT id FROM backtest_runs WHERE strategy_id = ?').all(id);
      for (const { id: runId } of runIds) {
        db.prepare('DELETE FROM backtest_event_traces WHERE run_id = ?').run(runId);
      }
      db.prepare('DELETE FROM backtest_runs WHERE strategy_id = ?').run(id);
    }
    db.prepare('DELETE FROM strategy_versions WHERE strategy_id = ?').run(id);
    db.prepare('DELETE FROM strategy_definitions WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  invalidateStrategyStatsCache();
  return snapshot;
}

/** @deprecated Use trashStrategy — mantido para compatibilidade interna. */
export function deleteStrategy(db, id) {
  return trashStrategy(db, id);
}

export function listStrategyVersions(db, strategyId) {
  return db.prepare(`
    SELECT * FROM strategy_versions
    WHERE strategy_id = ?
    ORDER BY version DESC, id DESC
  `).all(strategyId).map(toApiVersion);
}

/** Uma query para o picker do Estúdio (evita N+1 de /versions por estratégia). */
export function listStrategiesForPicker(db) {
  const rows = db.prepare(`
    SELECT
      sd.id AS strategy_id,
      sd.slug,
      sd.name,
      sd.status,
      sd.pinned,
      sd.default_version_id,
      sv.id AS version_id,
      sv.version,
      sv.notes
    FROM strategy_definitions sd
    JOIN strategy_versions sv ON sv.strategy_id = sd.id
    WHERE sd.deleted_at IS NULL
    ORDER BY sd.pinned DESC, sd.updated_at DESC, sd.id DESC, sv.version DESC, sv.id DESC
  `).all();

  return rows.map((row) => ({
    strategy_id: Number(row.strategy_id),
    version_id: Number(row.version_id),
    version: Number(row.version),
    slug: row.slug,
    name: row.name,
    status: row.status,
    pinned: Boolean(row.pinned),
    default_version_id: row.default_version_id != null ? Number(row.default_version_id) : null,
    notes: row.notes || null,
  }));
}

export function getStrategyVersion(db, strategyId, versionId) {
  const row = db.prepare('SELECT * FROM strategy_versions WHERE strategy_id = ? AND id = ?').get(strategyId, versionId);
  return row ? toApiVersion(row) : null;
}

export function deleteStrategyVersion(db, strategyId, versionId, { deleteRuns = false } = {}) {
  if (!getStrategy(db, strategyId)) return null;
  const version = getStrategyVersion(db, strategyId, versionId);
  if (!version) return null;

  const total = db.prepare('SELECT COUNT(*) AS count FROM strategy_versions WHERE strategy_id = ?').get(strategyId);
  if (Number(total?.count || 0) <= 1) throw new Error('Cannot delete the last strategy version');

  const runs = db.prepare('SELECT COUNT(*) AS count FROM backtest_runs WHERE strategy_version_id = ?').get(versionId);
  const runsCount = Number(runs?.count || 0);
  if (runsCount > 0 && !deleteRuns) {
    throw new Error('Cannot delete a version used by backtest runs');
  }

  db.exec('BEGIN');
  try {
    if (deleteRuns && runsCount > 0) {
      const runIds = db.prepare('SELECT id FROM backtest_runs WHERE strategy_version_id = ?').all(versionId);
      for (const { id: runId } of runIds) {
        db.prepare('DELETE FROM backtest_event_traces WHERE run_id = ?').run(runId);
      }
      db.prepare('DELETE FROM backtest_runs WHERE strategy_version_id = ?').run(versionId);
    }
    db.prepare('DELETE FROM strategy_versions WHERE strategy_id = ? AND id = ?').run(strategyId, versionId);
    db.prepare(`
      UPDATE strategy_definitions
      SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(strategyId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  invalidateStrategyStatsCache();
  return version;
}

export function forkStrategy(db, strategyId, { versionId = null, name = null } = {}) {
  const source = getStrategy(db, strategyId);
  if (!source) return null;
  const versions = listStrategyVersions(db, strategyId);
  const fromVersion = versionId
    ? versions.find((v) => v.id === Number(versionId))
    : versions[0];
  if (!fromVersion) throw new Error('No version to fork from');

  let forkIndex = 1;
  let slug = `${source.slug}-fork`;
  while (db.prepare('SELECT id FROM strategy_definitions WHERE slug = ?').get(slug)) {
    slug = `${source.slug}-fork-${forkIndex++}`;
  }

  const forked = createStrategy(db, {
    slug,
    name: name || `${source.name} (fork)`,
    description: source.description,
    tags: source.tags,
  });
  updateStrategy(db, forked.id, { status: 'draft' });

  const result = db.prepare(`
    INSERT INTO strategy_versions (
      strategy_id, version, language, source_code, params_schema_json, validation_json, checksum, notes
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)
  `).run(
    forked.id,
    fromVersion.language,
    fromVersion.source_code,
    JSON.stringify(fromVersion.params_schema || {}),
    JSON.stringify(fromVersion.validation || {}),
    checksumSource(fromVersion.source_code),
    `Fork de ${source.slug} v${fromVersion.version}`,
  );

  invalidateStrategyStatsCache();
  return getStrategy(db, forked.id);
}

export function createStrategyVersion(db, strategyId, { language = 'gls-v1', source_code: sourceCode, notes = null }) {
  const strategy = getStrategy(db, strategyId);
  if (!strategy) return null;
  const code = String(sourceCode || '').trim();
  if (!code) throw new Error('source_code is required');

  const latestRow = db.prepare(`
    SELECT version, source_code
    FROM strategy_versions
    WHERE strategy_id = ?
    ORDER BY version DESC, id DESC
    LIMIT 1
  `).get(strategyId);
  if (latestRow && normalizeSource(latestRow.source_code) === normalizeSource(code)) {
    throw new Error('source_code is unchanged from the latest version');
  }
  const version = Number(latestRow?.version || 0) + 1;
  const validation = validateStrategySource({ language, source_code: code });
  const result = db.prepare(`
    INSERT INTO strategy_versions (
      strategy_id, version, language, source_code, params_schema_json, validation_json, checksum, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    strategyId,
    version,
    String(language || 'gls-v1'),
    code,
    JSON.stringify(validation.params_schema || {}),
    JSON.stringify(validation),
    checksumSource(code),
    notes != null ? String(notes).trim() || null : null,
  );

  db.prepare(`
    UPDATE strategy_definitions
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(strategyId);

  invalidateStrategyStatsCache();
  return getStrategyVersion(db, strategyId, result.lastInsertRowid);
}

export function validateStrategySource({ language = 'gls-v1', source_code: sourceCode }) {
  const result = validateGls(sourceCode, { language });
  const { ast, ...publicResult } = result;
  return publicResult;
}

function toApiStrategy(db, row) {
  const latest = db.prepare(`
    SELECT id, version
    FROM strategy_versions
    WHERE strategy_id = ?
    ORDER BY version DESC, id DESC
    LIMIT 1
  `).get(row.id);
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    tags: JSON.parse(row.tags_json),
    pinned: Boolean(row.pinned),
    default_version_id: row.default_version_id != null ? Number(row.default_version_id) : null,
    deleted_at: row.deleted_at ?? null,
    latest_version: latest?.version != null ? Number(latest.version) : null,
    latest_version_id: latest?.id != null ? Number(latest.id) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeSource(source) {
  return String(source || '').replace(/\r\n/g, '\n').trim();
}

function toApiVersion(row) {
  const validation = JSON.parse(row.validation_json);
  return {
    id: Number(row.id),
    strategy_id: Number(row.strategy_id),
    version: row.version,
    language: row.language,
    source_code: row.source_code,
    params_schema: JSON.parse(row.params_schema_json),
    validation,
    checksum: row.checksum,
    notes: row.notes || null,
    created_at: row.created_at,
  };
}

function normalizeSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!slug) throw new Error('slug is required');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('slug must be lowercase alphanumeric with hyphens');
  return slug;
}

function normalizeName(value) {
  const name = String(value || '').trim();
  if (!name) throw new Error('name is required');
  return name;
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (!ALLOWED_STATUS.has(status)) throw new Error(`status must be one of: ${[...ALLOWED_STATUS].join(', ')}`);
  return status;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) throw new Error('tags must be an array');
  return value.map((tag) => String(tag).trim()).filter(Boolean);
}

function checksumSource(sourceCode) {
  return createHash('sha256').update(String(sourceCode)).digest('hex');
}
