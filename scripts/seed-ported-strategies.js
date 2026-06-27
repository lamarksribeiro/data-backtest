#!/usr/bin/env node
/**
 * Semeia estratégias portadas (library-runner / portfolio-runner) no SQLite.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import {
  createStrategy,
  getStrategy,
  getStrategyBySlug,
} from '../src/backtestStudio/state/strategies.js';
import { validateStrategySource } from '../src/backtestStudio/strategyJs/index.js';
import { composeStrategyJsFromGls } from '../src/backtestStudio/strategyJs/composeStrategyJs.js';
import { buildCompiledArtifact } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { bindStrategyLibraryDatabase } from '../src/backtestStudio/nativeLibrary/registry.js';
import {
  createStrategyLibraryVersion,
  upsertStrategyLibraryDefinition,
} from '../src/backtestStudio/state/strategyLibrary.js';
import { loadBootstrapLibraryEntries } from '../src/backtestStudio/strategyLibrary/bootstrapEntries.js';
import { invalidateStrategyStatsCache } from '../src/backtestStudio/state/strategyStats.js';
import { listPresets, resolvePresetParams } from '../labs/shared/presets.js';
import { renderPresetGls } from '../labs/shared/renderPresetGls.js';
import { renderPresetStrategyJs } from '../labs/shared/renderPresetStrategyJs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const LABS_DIR = path.join(ROOT_DIR, 'labs/strategies');
const SEEDABLE_PORT_STATUSES = new Set(['ported', 'compiled-native']);

function checksum(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function discoverPortedManifests() {
  const results = [];
  for (const family of readdirSync(LABS_DIR, { withFileTypes: true })) {
    if (!family.isDirectory() || family.name.startsWith('_')) continue;
    const familyDir = path.join(LABS_DIR, family.name);
    for (const strategy of readdirSync(familyDir, { withFileTypes: true })) {
      if (!strategy.isDirectory()) continue;
      const manifestPath = path.join(familyDir, strategy.name, 'strategy.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (!SEEDABLE_PORT_STATUSES.has(manifest.portStatus)) continue;
      results.push({
        ...manifest,
        strategyRoot: path.join(familyDir, strategy.name),
      });
    }
  }
  return results.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function upsertLibrary(db, entry) {
  const libraryId = upsertStrategyLibraryDefinition(db, {
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    status: 'validated',
  });
  db.prepare(`
    DELETE FROM strategy_library_versions
    WHERE library_id = ? AND version = ?
  `).run(libraryId, entry.version);
  createStrategyLibraryVersion(db, libraryId, {
    version: entry.version,
    language: 'strategy-library-js',
    source_code: entry.source_code,
    validation: entry.validation,
    compiled: entry.compiled ?? null,
  });
}

export function seedLibraries(db) {
  const entries = loadBootstrapLibraryEntries();
  for (const entry of entries) {
    upsertLibrary(db, entry);
    console.log(`[seed-lib] ${entry.slug}@${entry.version}`);
  }
}

function upsertStrategyVersion(db, strategyId, versionNum, payload) {
  const existing = db.prepare(`
    SELECT id FROM strategy_versions WHERE strategy_id = ? AND version = ?
  `).get(strategyId, versionNum);

  if (!existing) {
    db.prepare(`
      INSERT INTO strategy_versions (
        strategy_id, version, language, source_code, params_schema_json, compiled_json, validation_json, checksum, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      strategyId,
      versionNum,
      payload.language,
      payload.sourceCode,
      JSON.stringify(payload.validation.params_schema || {}),
      payload.compiled ? JSON.stringify(payload.compiled) : null,
      JSON.stringify(payload.validation),
      payload.checksum,
      payload.notes,
    );
    return 'seeded';
  }

  db.prepare(`
    UPDATE strategy_versions
    SET language = ?, source_code = ?, params_schema_json = ?, compiled_json = ?, validation_json = ?, checksum = ?, notes = ?
    WHERE id = ?
  `).run(
    payload.language,
    payload.sourceCode,
    JSON.stringify(payload.validation.params_schema || {}),
    payload.compiled ? JSON.stringify(payload.compiled) : null,
    JSON.stringify(payload.validation),
    payload.checksum,
    payload.notes,
    existing.id,
  );
  return 'synced';
}

function pruneLegacyImportedVersions(db, strategyId, keepVersion = 1) {
  const rows = db.prepare(`
    SELECT id, version, notes, validation_json
    FROM strategy_versions
    WHERE strategy_id = ? AND version != ?
  `).all(strategyId, keepVersion);

  let removed = 0;
  for (const row of rows) {
    const notes = String(row.notes || '');
    let executionKind = null;
    try {
      executionKind = JSON.parse(row.validation_json || '{}').execution_kind ?? null;
    } catch {
      executionKind = null;
    }
    const isLegacyPresetImport = /^Preset v/i.test(notes)
      && ['compiled-soa', 'gls-v1'].includes(executionKind);
    if (!isLegacyPresetImport) continue;

    const runs = db.prepare('SELECT COUNT(*) AS n FROM backtest_runs WHERE strategy_version_id = ?').get(row.id)?.n ?? 0;
    if (runs > 0) continue;

    db.prepare('DELETE FROM strategy_presets WHERE strategy_version_id = ?').run(row.id);
    db.prepare('DELETE FROM strategy_versions WHERE id = ?').run(row.id);
    removed += 1;
  }
  return removed;
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

function readManifestGlsSource(manifest) {
  const glsPath = manifest.source?.glsPath || manifest.source?.path;
  if (glsPath && String(glsPath).endsWith('.gls')) {
    return readFileSync(path.resolve(ROOT_DIR, glsPath), 'utf8');
  }
  throw new Error(`${manifest.id}: GLS source not found for lab presets`);
}

function resolveDefaultPresetVersion(manifest, presets) {
  const fromManifest = Number(manifest.studio?.defaultVersion);
  if (Number.isInteger(fromManifest) && fromManifest >= 1) return fromManifest;
  const champion = presets.find((preset) => preset.role === 'champion');
  if (champion) return resolvePresetVersion(champion);
  return resolvePresetVersion(presets[presets.length - 1]);
}

function seedCompiledNativeFromLabPresets(db, manifest, strategy, slug) {
  const presets = listPresets({
    strategyFamily: manifest.family,
    strategyId: manifest.id,
    includeAliases: false,
  }).sort((left, right) => resolvePresetVersion(left) - resolvePresetVersion(right));
  if (!presets.length) return null;

  const baseGls = readManifestGlsSource(manifest);
  const versions = [];

  for (const preset of presets) {
    const versionNum = resolvePresetVersion(preset);
    const params = resolvePresetParams(preset, manifest.strategyRoot);
    const displayName = preset.studioName || `${manifest.name} · ${preset.name || preset.id}`;
    const glsSource = renderPresetGls(baseGls, params, displayName);
    const sourceCode = composeStrategyJsFromGls(glsSource);
    const validation = validateStrategySource({ language: 'strategy-js-v1', source_code: sourceCode, db });
    if (!validation.ok) {
      console.warn(`[seed-strategy] skip ${slug} v${versionNum} (${preset.id}): ${validation.errors?.[0]?.message}`);
      continue;
    }
    const compiled = buildCompiledArtifact(sourceCode, { bookDepth: 25, db });
    const action = upsertStrategyVersion(db, strategy.id, versionNum, {
      language: 'strategy-js-v1',
      sourceCode,
      validation,
      compiled,
      checksum: checksum(sourceCode),
      notes: preset.name || preset.id,
    });
    versions.push({ version: versionNum, preset: preset.id, action, execution_kind: validation.execution_kind });
    console.log(`[seed-strategy] ${slug} v${versionNum} (${preset.id}) ${action} (${validation.execution_kind})`);
  }

  const defaultVersion = resolveDefaultPresetVersion(manifest, presets);
  const versionRow = db.prepare(`
    SELECT id FROM strategy_versions WHERE strategy_id = ? AND version = ?
  `).get(strategy.id, defaultVersion);
  if (versionRow) {
    db.prepare('UPDATE strategy_definitions SET default_version_id = ? WHERE id = ?')
      .run(versionRow.id, strategy.id);
  }

  const removed = pruneLegacyImportedVersions(db, strategy.id, defaultVersion);
  if (removed > 0) {
    console.log(`[seed-strategy] ${slug} pruned ${removed} legacy preset version(s)`);
  }

  return {
    slug,
    presetSeed: true,
    versions,
    defaultVersion,
    execution_kind: 'compiled-soa',
    pruned: removed,
  };
}

function resolveManifestSourceCode(manifest) {
  if (manifest.portStatus === 'compiled-native' && manifest.source?.glsPath) {
    const glsPath = path.resolve(ROOT_DIR, manifest.source.glsPath);
    return composeStrategyJsFromGls(readFileSync(glsPath, 'utf8'));
  }
  return readFileSync(path.join(manifest.strategyRoot, 'strategy.js'), 'utf8');
}

function resolvePresetJsSource(manifest, preset) {
  const studio = manifest.studio || {};
  const jsSources = studio.jsSources || {};
  const variant = preset.jsSource || studio.defaultJsSource;
  if (variant && jsSources[variant]) {
    return readFileSync(path.join(manifest.strategyRoot, jsSources[variant]), 'utf8');
  }
  return readFileSync(path.join(manifest.strategyRoot, 'strategy.js'), 'utf8');
}

function seedLibraryRunnerFromLabPresets(db, manifest, strategy, slug) {
  const presets = listPresets({
    strategyFamily: manifest.family,
    strategyId: manifest.id,
    includeAliases: false,
  }).sort((left, right) => resolvePresetVersion(left) - resolvePresetVersion(right));
  if (!presets.length) return null;

  const versions = [];

  for (const preset of presets) {
    const versionNum = resolvePresetVersion(preset);
    const params = resolvePresetParams(preset, manifest.strategyRoot);
    const displayName = preset.studioName || `${manifest.name} · ${preset.name || preset.id}`;
    const baseSource = resolvePresetJsSource(manifest, preset);
    const sourceCode = renderPresetStrategyJs(baseSource, params, displayName);
    const validation = validateStrategySource({ language: 'strategy-js-v1', source_code: sourceCode, db });
    if (!validation.ok) {
      console.warn(`[seed-strategy] skip ${slug} v${versionNum} (${preset.id}): ${validation.errors?.[0]?.message}`);
      continue;
    }
    const compiled = buildCompiledArtifact(sourceCode, { bookDepth: 25, db });
    const action = upsertStrategyVersion(db, strategy.id, versionNum, {
      language: 'strategy-js-v1',
      sourceCode,
      validation,
      compiled,
      checksum: checksum(sourceCode),
      notes: preset.name || preset.id,
    });
    versions.push({ version: versionNum, preset: preset.id, action, execution_kind: validation.execution_kind });
    console.log(`[seed-strategy] ${slug} v${versionNum} (${preset.id}) ${action} (${validation.execution_kind})`);
  }

  if (!versions.length) return null;

  const defaultVersion = resolveDefaultPresetVersion(manifest, presets);
  const versionRow = db.prepare(`
    SELECT id FROM strategy_versions WHERE strategy_id = ? AND version = ?
  `).get(strategy.id, defaultVersion);
  if (versionRow) {
    db.prepare('UPDATE strategy_definitions SET default_version_id = ? WHERE id = ?')
      .run(versionRow.id, strategy.id);
  }

  const removed = pruneLegacyImportedVersions(db, strategy.id, defaultVersion);
  if (removed > 0) {
    console.log(`[seed-strategy] ${slug} pruned ${removed} legacy preset version(s)`);
  }

  return {
    slug,
    presetSeed: true,
    versions,
    defaultVersion,
    execution_kind: 'library-runner',
    pruned: removed,
  };
}

function seedManifest(db, manifest) {
  const slug = manifest.studioSlug || manifest.id;
  const trashed = db.prepare('SELECT id, deleted_at FROM strategy_definitions WHERE slug = ?').get(slug);
  if (trashed?.deleted_at) return { slug, skipped: 'trashed' };

  let strategy = getStrategyBySlug(db, slug);
  if (!strategy) {
    strategy = createStrategy(db, {
      slug,
      name: manifest.name,
      description: manifest.studio?.description || manifest.notes || manifest.name,
      tags: manifest.studio?.tags || [manifest.id, 'ported'],
    });
  }

  if (manifest.portStatus === 'compiled-native') {
    const presetSeed = seedCompiledNativeFromLabPresets(db, manifest, strategy, slug);
    if (presetSeed) return presetSeed;
  }

  if (manifest.portStatus === 'ported' && manifest.kind === 'library-runner') {
    const presetSeed = seedLibraryRunnerFromLabPresets(db, manifest, strategy, slug);
    if (presetSeed) return presetSeed;
  }

  const sourceCode = resolveManifestSourceCode(manifest);
  const validation = validateStrategySource({ language: 'strategy-js-v1', source_code: sourceCode, db });
  if (!validation.ok) {
    throw new Error(`${slug}: ${validation.errors?.[0]?.message}`);
  }
  const compiled = buildCompiledArtifact(sourceCode, { bookDepth: 25, db });
  const versionNum = manifest.studio?.defaultVersion || 1;
  const action = upsertStrategyVersion(db, strategy.id, versionNum, {
    language: 'strategy-js-v1',
    sourceCode,
    validation,
    compiled,
    checksum: checksum(sourceCode),
    notes: manifest.portStatus === 'compiled-native' ? 'compiled-native-default' : 'ported-default',
  });

  const versionRow = db.prepare(`
    SELECT id FROM strategy_versions WHERE strategy_id = ? AND version = ?
  `).get(strategy.id, versionNum);
  if (versionRow) {
    db.prepare('UPDATE strategy_definitions SET default_version_id = ? WHERE id = ?')
      .run(versionRow.id, strategy.id);
  }

  const removed = pruneLegacyImportedVersions(db, strategy.id, versionNum);
  if (removed > 0) {
    console.log(`[seed-strategy] ${slug} pruned ${removed} legacy preset version(s)`);
  }

  console.log(`[seed-strategy] ${slug} v${versionNum} ${action} (${validation.execution_kind})`);
  return { slug, action, execution_kind: validation.execution_kind, pruned: removed };
}

export function seedPortedStrategies(db) {
  bindStrategyLibraryDatabase(db);
  seedLibraries(db);
  const manifests = discoverPortedManifests();
  const seeded = [];
  for (const manifest of manifests) {
    if (!manifest.promotedToStudio) continue;
    seeded.push(seedManifest(db, manifest));
  }
  invalidateStrategyStatsCache();
  return {
    ok: true,
    libraries: loadBootstrapLibraryEntries().length,
    strategies: seeded,
  };
}

function main() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  try {
    const result = seedPortedStrategies(db);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    closeStateDatabase(db);
  }
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}