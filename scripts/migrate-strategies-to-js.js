#!/usr/bin/env node
/**
 * Converte todas as strategy_versions gls-v1 para strategy-js-v1 in-place,
 * renomeia slugs *-gls -> sem sufixo, e define default_version na versão JS mais recente.
 *
 * Uso: npm run migrate:strategies-to-js
 *      npm run migrate:strategies-to-js -- --dry-run
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';

import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { glsToStrategyJs } from '../src/backtestStudio/strategyJs/glsToStrategyJs.js';
import { validateStrategySource } from '../src/backtestStudio/strategyJs/index.js';
import { buildCompiledArtifact, isCompiledArtifactValid } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { inferNativeDependencies } from '../src/backtestStudio/strategyJs/dependencies.js';
import { composeStrategyJsFromGls, composeStrategyJsFromSource } from '../src/backtestStudio/strategyJs/composeStrategyJs.js';
import { seedPromotedStrategies } from '../src/backtestStudio/gls/seedPromotedStrategies.js';
import { allocateUniqueSlug } from '../src/backtestStudio/state/strategies.js';
import { invalidateStrategyStatsCache } from '../src/backtestStudio/state/strategyStats.js';

function checksumSource(sourceCode) {
  return createHash('sha256').update(String(sourceCode)).digest('hex');
}

function cleanSlug(slug) {
  return String(slug || '').replace(/-gls$/i, '');
}

function needsStrategyJsRefresh(row) {
  const source = String(row.source_code || '');
  const missingDeps = inferNativeDependencies(source).length > 0
    && !/dependencies\s*:/.test(source)
    && !source.includes('function createLibrary');
  const externalDeps = /strategyLibrary\s*\(\s*["']edge-sniper-models/.test(source);
  let compiled = null;
  try {
    compiled = row.compiled_json ? JSON.parse(row.compiled_json) : null;
  } catch {
    compiled = null;
  }
  const staleArtifact = !compiled || !isCompiledArtifactValid(compiled, row.checksum);
  return missingDeps || externalDeps || staleArtifact;
}

function persistStrategyJsVersion(db, row, jsSource, { dryRun, reason }) {
  const validation = validateStrategySource({ language: 'strategy-js-v1', source_code: jsSource });
  if (!validation.ok) {
    return { ok: false, id: row.id, slug: row.slug, version: row.version, reason, error: validation.errors?.[0]?.message };
  }
  const compiled = buildCompiledArtifact(jsSource);
  const checksum = checksumSource(jsSource);
  if (!dryRun) {
    db.prepare(`
      UPDATE strategy_versions
      SET language = 'strategy-js-v1',
          source_code = ?,
          params_schema_json = ?,
          compiled_json = ?,
          validation_json = ?,
          checksum = ?
      WHERE id = ?
    `).run(
      jsSource,
      JSON.stringify(validation.params_schema || {}),
      compiled ? JSON.stringify(compiled) : null,
      JSON.stringify(validation),
      checksum,
      row.id,
    );
  }
  return { ok: true, id: row.id, slug: row.slug, version: row.version, reason };
}

function convertVersion(db, row, { dryRun }) {
  const jsSource = composeStrategyJsFromGls(row.source_code);
  return persistStrategyJsVersion(db, row, jsSource, { dryRun, reason: 'gls-convert' });
}

function refreshStrategyJsVersion(db, row, { dryRun }) {
  const jsSource = composeStrategyJsFromSource(row.source_code);
  return persistStrategyJsVersion(db, row, jsSource, { dryRun, reason: 'strategy-js-refresh' });
}

function renameSlugs(db, { dryRun }) {
  const rows = db.prepare(`
    SELECT id, slug FROM strategy_definitions
    WHERE slug LIKE '%-gls' OR slug LIKE '%-gls-%'
    ORDER BY id
  `).all();
  const renamed = [];
  for (const row of rows) {
    const target = cleanSlug(row.slug);
    if (target === row.slug) continue;
    const nextSlug = allocateUniqueSlug(db, target, row.id);
    if (!dryRun) {
      db.prepare('UPDATE strategy_definitions SET slug = ? WHERE id = ?').run(nextSlug, row.id);
    }
    renamed.push({ id: row.id, from: row.slug, to: nextSlug });
  }
  return renamed;
}

function refreshDefaultVersions(db, { dryRun }) {
  const strategies = db.prepare('SELECT id, default_version_id FROM strategy_definitions WHERE deleted_at IS NULL').all();
  const updated = [];
  for (const s of strategies) {
    const latest = db.prepare(`
      SELECT id, version, language FROM strategy_versions
      WHERE strategy_id = ? AND language = 'strategy-js-v1'
      ORDER BY version DESC, id DESC LIMIT 1
    `).get(s.id);
    if (!latest) continue;
    if (s.default_version_id === latest.id) continue;
    if (!dryRun) {
      db.prepare('UPDATE strategy_definitions SET default_version_id = ? WHERE id = ?').run(latest.id, s.id);
    }
    updated.push({ strategyId: s.id, defaultVersionId: latest.id, version: latest.version });
  }
  return updated;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);

  const glsRows = db.prepare(`
    SELECT sv.id, sv.strategy_id, sv.version, sv.source_code, sd.slug
    FROM strategy_versions sv
    JOIN strategy_definitions sd ON sd.id = sv.strategy_id
    WHERE sv.language = 'gls-v1'
    ORDER BY sd.slug, sv.version
  `).all();

  const converted = [];
  const refreshed = [];
  const failed = [];
  for (const row of glsRows) {
    const result = convertVersion(db, row, { dryRun });
    (result.ok ? converted : failed).push(result);
  }

  const jsRows = db.prepare(`
    SELECT sv.id, sv.strategy_id, sv.version, sv.source_code, sv.compiled_json, sv.checksum, sd.slug
    FROM strategy_versions sv
    JOIN strategy_definitions sd ON sd.id = sv.strategy_id
    WHERE sv.language = 'strategy-js-v1'
    ORDER BY sd.slug, sv.version
  `).all();

  for (const row of jsRows) {
    if (!needsStrategyJsRefresh(row)) continue;
    const result = refreshStrategyJsVersion(db, row, { dryRun });
    (result.ok ? refreshed : failed).push(result);
  }

  const renamed = renameSlugs(db, { dryRun });
  const defaults = refreshDefaultVersions(db, { dryRun });

  let seeded = [];
  if (!dryRun) {
    seeded = seedPromotedStrategies(db, { jsOnly: true });
    invalidateStrategyStatsCache();
  }

  const remainingGls = db.prepare(`SELECT COUNT(*) AS n FROM strategy_versions WHERE language = 'gls-v1'`).get()?.n ?? 0;

  const report = {
    ok: failed.length === 0,
    dryRun,
    converted: converted.length,
    refreshed: refreshed.length,
    failed,
    renamed,
    defaultsUpdated: defaults.length,
    seeded: seeded.map((r) => ({ slug: r.slug, skipped: r.skipped ?? null })),
    remainingGlsVersions: remainingGls,
  };

  console.log(JSON.stringify(report, null, 2));
  closeStateDatabase(db);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});