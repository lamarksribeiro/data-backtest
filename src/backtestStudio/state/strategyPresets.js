function toApiPreset(row) {
  return {
    id: Number(row.id),
    strategy_id: Number(row.strategy_id),
    strategy_version_id: Number(row.strategy_version_id),
    name: row.name,
    params: JSON.parse(row.params_json || '{}'),
    tags: JSON.parse(row.tags_json || '[]'),
    created_at: row.created_at,
  };
}

export function listStrategyPresets(db, strategyId, { strategyVersionId = null } = {}) {
  if (strategyVersionId != null) {
    return db.prepare(`
      SELECT * FROM strategy_presets
      WHERE strategy_id = ? AND strategy_version_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(strategyId, strategyVersionId).map(toApiPreset);
  }
  return db.prepare(`
    SELECT * FROM strategy_presets
    WHERE strategy_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(strategyId).map(toApiPreset);
}

export function getStrategyPreset(db, strategyId, presetId) {
  const row = db.prepare(`
    SELECT * FROM strategy_presets
    WHERE strategy_id = ? AND id = ?
  `).get(strategyId, presetId);
  return row ? toApiPreset(row) : null;
}

export function createStrategyPreset(db, strategyId, {
  strategy_version_id: strategyVersionId,
  name,
  params = {},
  tags = [],
}) {
  const versionId = Number(strategyVersionId);
  if (!Number.isFinite(versionId) || versionId <= 0) {
    throw new Error('strategy_version_id is required');
  }
  const version = db.prepare(`
    SELECT id FROM strategy_versions
    WHERE strategy_id = ? AND id = ?
  `).get(strategyId, versionId);
  if (!version) throw new Error('strategy_version_id not found for strategy');

  const presetName = String(name || '').trim();
  if (!presetName) throw new Error('name is required');
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('params must be an object');
  }

  const result = db.prepare(`
    INSERT INTO strategy_presets (strategy_id, strategy_version_id, name, params_json, tags_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    strategyId,
    versionId,
    presetName,
    JSON.stringify(params),
    JSON.stringify(Array.isArray(tags) ? tags : []),
  );

  return getStrategyPreset(db, strategyId, result.lastInsertRowid);
}

export function updateStrategyPreset(db, strategyId, presetId, patch = {}) {
  const current = getStrategyPreset(db, strategyId, presetId);
  if (!current) return null;

  const next = {
    name: patch.name != null ? String(patch.name).trim() : current.name,
    params: patch.params != null ? patch.params : current.params,
    tags: patch.tags != null ? patch.tags : current.tags,
    strategy_version_id: patch.strategy_version_id != null
      ? Number(patch.strategy_version_id)
      : current.strategy_version_id,
  };

  if (!next.name) throw new Error('name is required');
  if (!next.params || typeof next.params !== 'object' || Array.isArray(next.params)) {
    throw new Error('params must be an object');
  }

  if (next.strategy_version_id !== current.strategy_version_id) {
    const version = db.prepare(`
      SELECT id FROM strategy_versions
      WHERE strategy_id = ? AND id = ?
    `).get(strategyId, next.strategy_version_id);
    if (!version) throw new Error('strategy_version_id not found for strategy');
  }

  db.prepare(`
    UPDATE strategy_presets
    SET name = ?, params_json = ?, tags_json = ?, strategy_version_id = ?
    WHERE strategy_id = ? AND id = ?
  `).run(
    next.name,
    JSON.stringify(next.params),
    JSON.stringify(Array.isArray(next.tags) ? next.tags : []),
    next.strategy_version_id,
    strategyId,
    presetId,
  );

  return getStrategyPreset(db, strategyId, presetId);
}

export function deleteStrategyPreset(db, strategyId, presetId) {
  const current = getStrategyPreset(db, strategyId, presetId);
  if (!current) return null;
  db.prepare('DELETE FROM strategy_presets WHERE strategy_id = ? AND id = ?').run(strategyId, presetId);
  return current;
}

export function mergePresetParams(defaults = {}, presetParams = {}, overrides = {}) {
  return {
    ...(defaults && typeof defaults === 'object' ? defaults : {}),
    ...(presetParams && typeof presetParams === 'object' ? presetParams : {}),
    ...(overrides && typeof overrides === 'object' ? overrides : {}),
  };
}

export function extractDefaultParamsFromSchema(paramsSchema = {}) {
  const defaults = {};
  for (const [key, def] of Object.entries(paramsSchema)) {
    if (def && Object.prototype.hasOwnProperty.call(def, 'default')) {
      defaults[key] = def.default;
    }
  }
  return defaults;
}