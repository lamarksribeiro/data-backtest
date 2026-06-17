import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { listPromotedStrategies } from '../../../labs/shared/discoverStrategies.js';
import { listPresets, resolvePresetParams } from '../../../labs/shared/presets.js';
import { renderPresetGls } from '../../../labs/shared/renderPresetGls.js';
import {
  createStrategy,
  getStrategy,
  getStrategyBySlug,
  validateStrategySource,
} from '../state/strategies.js';

function checksumSource(sourceCode) {
  return createHash('sha256').update(String(sourceCode)).digest('hex');
}

function readGlsSource(relPath) {
  return readFileSync(path.resolve(relPath), 'utf8');
}

function resolveStudioSlug(manifest) {
  return manifest.studioSlug || `${manifest.strategyId}-gls`;
}

function resolveStudioTags(manifest) {
  const studio = manifest.studio || {};
  if (Array.isArray(studio.tags) && studio.tags.length > 0) return studio.tags;
  const tags = new Set([manifest.strategyId, 'lab-strategy']);
  for (const asset of manifest.assets || []) tags.add(String(asset).toLowerCase());
  return [...tags];
}

function resolveStudioDescription(manifest) {
  const studio = manifest.studio || {};
  return studio.description || manifest.notes || manifest.name || manifest.strategyId;
}

function resolvePresetVersion(preset) {
  if (preset.studioVersion != null) {
    const version = Number(preset.studioVersion);
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`Preset ${preset.id} tem studioVersion inválido: ${preset.studioVersion}`);
    }
    return version;
  }
  const legacy = parseInt(String(preset.id).replace(/\D/g, ''), 10);
  if (legacy >= 1) return legacy;
  throw new Error(`Preset ${preset.id} precisa de studioVersion ou id numérico (ex: v1)`);
}

function resolvePresetGlsSource(manifest, preset) {
  const studio = manifest.studio || {};
  const glsSources = studio.glsSources || {};
  const variant = preset.glsSource || studio.defaultGlsSource;
  if (variant && glsSources[variant]) {
    return readGlsSource(glsSources[variant]);
  }
  if (manifest.source?.type === 'file' && manifest.source.path) {
    return readGlsSource(manifest.source.path);
  }
  throw new Error(`Não foi possível resolver fonte GLS para preset ${preset.id} em ${manifest.strategyId}`);
}

function resolveDisplayName(manifest, preset) {
  if (preset.studioName) return preset.studioName;
  return `${manifest.name} · ${preset.name || preset.id}`;
}

function resolveVersionNotes(preset) {
  return preset.name || preset.id;
}

function upsertStrategyVersion(db, {
  strategyId,
  versionNum,
  sourceCode,
  validation,
  checksum,
  notes,
  existingVersions,
}) {
  const existingVersion = existingVersions.find((row) => row.version === versionNum);
  if (!existingVersion) {
    db.prepare(`
      INSERT INTO strategy_versions (
        strategy_id, version, language, source_code, params_schema_json, validation_json, checksum, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      strategyId,
      versionNum,
      'gls-v1',
      sourceCode,
      JSON.stringify(validation.params_schema || {}),
      JSON.stringify(validation),
      checksum,
      notes,
    );
    return 'seeded';
  }

  db.prepare(`
    UPDATE strategy_versions
    SET source_code = ?, params_schema_json = ?, validation_json = ?, checksum = ?, notes = ?
    WHERE id = ?
  `).run(
    sourceCode,
    JSON.stringify(validation.params_schema || {}),
    JSON.stringify(validation),
    checksum,
    notes,
    existingVersion.id,
  );
  return 'synced';
}

function ensureDefaultVersion(db, strategyRowId, manifest) {
  const currentDefault = db.prepare('SELECT default_version_id FROM strategy_definitions WHERE id = ?').get(strategyRowId);
  if (currentDefault?.default_version_id != null) return;

  const defaultVersion = Number(manifest.studio?.defaultVersion);
  if (!Number.isInteger(defaultVersion) || defaultVersion < 1) return;

  const versionRow = db.prepare(`
    SELECT id FROM strategy_versions
    WHERE strategy_id = ? AND version = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(strategyRowId, defaultVersion);
  if (!versionRow) return;

  db.prepare(`
    UPDATE strategy_definitions
    SET default_version_id = ?
    WHERE id = ?
  `).run(versionRow.id, strategyRowId);
}

export function seedPromotedStrategy(db, manifest) {
  const slug = resolveStudioSlug(manifest);
  const trashed = db.prepare('SELECT id, deleted_at FROM strategy_definitions WHERE slug = ?').get(slug);
  if (trashed?.deleted_at) {
    return { slug, strategy: null, skipped: 'trashed' };
  }

  let strategy = getStrategyBySlug(db, slug);
  if (!strategy) {
    strategy = createStrategy(db, {
      slug,
      name: manifest.name,
      description: resolveStudioDescription(manifest),
      tags: resolveStudioTags(manifest),
    });
  }

  const presets = listPresets({
    strategyFamily: manifest.strategyFamily,
    strategyId: manifest.strategyId,
    includeAliases: false,
  }).sort((a, b) => resolvePresetVersion(a) - resolvePresetVersion(b));

  if (presets.length === 0) {
    throw new Error(`Nenhum preset encontrado para estratégia promovida ${manifest.strategyId}`);
  }

  const existingVersions = db.prepare(`
    SELECT id, version, source_code
    FROM strategy_versions
    WHERE strategy_id = ?
  `).all(strategy.id);

  for (const preset of presets) {
    const versionNum = resolvePresetVersion(preset);
    const baseSource = resolvePresetGlsSource(manifest, preset);
    const params = resolvePresetParams(preset, manifest.strategyRoot);
    const sourceCode = renderPresetGls(baseSource, params, resolveDisplayName(manifest, preset));
    const validation = validateStrategySource({ language: 'gls-v1', source_code: sourceCode });
    const checksum = checksumSource(sourceCode);
    const notes = resolveVersionNotes(preset);
    const action = upsertStrategyVersion(db, {
      strategyId: strategy.id,
      versionNum,
      sourceCode,
      validation,
      checksum,
      notes,
      existingVersions,
    });
    console.log(`[seed] ${slug} v${versionNum} (${preset.id}) ${action === 'seeded' ? 'semeada' : 'sincronizada'}.`);
  }

  db.prepare(`
    UPDATE strategy_definitions
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(strategy.id);

  ensureDefaultVersion(db, strategy.id, manifest);

  return { slug, strategy: getStrategy(db, strategy.id) };
}

export function seedPromotedStrategies(db, { manifests = null } = {}) {
  const promoted = manifests || listPromotedStrategies();
  return promoted.map((manifest) => seedPromotedStrategy(db, manifest));
}

/** Compat: retorna a estratégia Edge Sniper V3 após seed genérico. */
export function seedEdgeSniperV3Presets(db) {
  const results = seedPromotedStrategies(db);
  return results.find((row) => row.slug === 'edge-sniper-v3-gls')?.strategy ?? null;
}
