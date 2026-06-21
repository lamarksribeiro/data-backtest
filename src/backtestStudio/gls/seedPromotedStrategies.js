import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { listPromotedGlsStrategies } from '../../../labs/shared/discoverStrategies.js';
import { listPresets, resolvePresetParams } from '../../../labs/shared/presets.js';
import { renderPresetGls } from '../../../labs/shared/renderPresetGls.js';
import {
  createStrategy,
  getStrategy,
  getStrategyBySlug,
  validateStrategySource,
} from '../state/strategies.js';
import { glsToStrategyJs } from '../strategyJs/glsToStrategyJs.js';
import { buildCompiledArtifact } from '../strategyJs/resolveVersion.js';
import { composeStrategyJsFromGls } from '../strategyJs/composeStrategyJs.js';

function checksumSource(sourceCode) {
  return createHash('sha256').update(String(sourceCode)).digest('hex');
}

function readGlsSource(relPath) {
  return readFileSync(path.resolve(relPath), 'utf8');
}

function resolveStudioSlug(manifest) {
  const raw = manifest.studioSlug || manifest.strategyId || manifest.id;
  return String(raw).replace(/-gls$/i, '');
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

function resolveVersionPayload(glsSource, { jsOnly, db = null }) {
  if (!jsOnly) {
    const validation = validateStrategySource({ language: 'gls-v1', source_code: glsSource });
    return {
      language: 'gls-v1',
      sourceCode: glsSource,
      validation,
      compiled: null,
    };
  }
  const sourceCode = composeStrategyJsFromGls(glsSource);
  const validation = validateStrategySource({ language: 'strategy-js-v1', source_code: sourceCode, db });
  const compiled = validation.ok ? buildCompiledArtifact(sourceCode) : null;
  return {
    language: 'strategy-js-v1',
    sourceCode,
    validation,
    compiled,
  };
}

function upsertStrategyVersion(db, {
  strategyId,
  versionNum,
  language,
  sourceCode,
  validation,
  checksum,
  compiled,
  notes,
  existingVersions,
}) {
  const existingVersion = existingVersions.find((row) => row.version === versionNum);
  if (!existingVersion) {
    db.prepare(`
      INSERT INTO strategy_versions (
        strategy_id, version, language, source_code, params_schema_json, compiled_json, validation_json, checksum, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      strategyId,
      versionNum,
      language,
      sourceCode,
      JSON.stringify(validation.params_schema || {}),
      compiled ? JSON.stringify(compiled) : null,
      JSON.stringify(validation),
      checksum,
      notes,
    );
    return 'seeded';
  }

  db.prepare(`
    UPDATE strategy_versions
    SET language = ?, source_code = ?, params_schema_json = ?, compiled_json = ?, validation_json = ?, checksum = ?, notes = ?
    WHERE id = ?
  `).run(
    language,
    sourceCode,
    JSON.stringify(validation.params_schema || {}),
    compiled ? JSON.stringify(compiled) : null,
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

function findStrategyByLegacySlug(db, slug, manifest) {
  const direct = getStrategyBySlug(db, slug);
  if (direct) return direct;
  const legacySlug = `${manifest.strategyId}-gls`;
  if (legacySlug !== slug) {
    const legacy = getStrategyBySlug(db, legacySlug);
    if (legacy) {
      db.prepare('UPDATE strategy_definitions SET slug = ? WHERE id = ?').run(slug, legacy.id);
      return getStrategy(db, legacy.id);
    }
  }
  return null;
}

export function seedPromotedStrategy(db, manifest, { jsOnly = true } = {}) {
  const slug = resolveStudioSlug(manifest);
  const trashed = db.prepare('SELECT id, deleted_at FROM strategy_definitions WHERE slug = ?').get(slug);
  if (trashed?.deleted_at) {
    return { slug, strategy: null, skipped: 'trashed' };
  }

  let strategy = findStrategyByLegacySlug(db, slug, manifest);
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
    const glsSource = renderPresetGls(baseSource, params, resolveDisplayName(manifest, preset));
    const payload = resolveVersionPayload(glsSource, { jsOnly, db });
    if (!payload.validation.ok) {
      console.warn(`[seed] skip ${slug} v${versionNum}: ${payload.validation.errors?.[0]?.message}`);
      continue;
    }
    const checksum = checksumSource(payload.sourceCode);
    const notes = resolveVersionNotes(preset);
    const action = upsertStrategyVersion(db, {
      strategyId: strategy.id,
      versionNum,
      language: payload.language,
      sourceCode: payload.sourceCode,
      validation: payload.validation,
      checksum,
      compiled: payload.compiled,
      notes,
      existingVersions,
    });
    const lang = jsOnly ? 'js' : 'gls';
    console.log(`[seed] ${slug} v${versionNum} (${preset.id}) ${lang} ${action === 'seeded' ? 'semeada' : 'sincronizada'}.`);
  }

  db.prepare(`
    UPDATE strategy_definitions
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(strategy.id);

  ensureDefaultVersion(db, strategy.id, manifest);

  return { slug, strategy: getStrategy(db, strategy.id) };
}

export function seedPromotedStrategies(db, { manifests = null, jsOnly = true } = {}) {
  const promoted = manifests || listPromotedGlsStrategies();
  return promoted.map((manifest) => seedPromotedStrategy(db, manifest, { jsOnly }));
}

/** Compat: retorna a estratégia Edge Sniper V3 após seed genérico. */
export function seedEdgeSniperV3Presets(db) {
  const results = seedPromotedStrategies(db);
  return results.find((row) => row.slug === 'edge-sniper-v3')?.strategy ?? null;
}