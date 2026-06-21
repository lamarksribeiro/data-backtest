#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { runBacktest } from '../src/backtest/engine.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { getStrategyVersion, getStrategyBySlug } from '../src/backtestStudio/state/strategies.js';
import { checkDatasetAvailability } from '../src/query/availability.js';
import { analyzeStrategyColumns } from '../src/backtestStudio/gls/compiler.js';
import { extractDefaultParamsFromSchema, mergePresetParams } from '../src/backtestStudio/state/strategyPresets.js';

const ROOT = path.resolve('.');
const LABS = path.join(ROOT, 'labs/strategies');

function discoverPortedManifests() {
  const results = [];
  for (const family of readdirSync(LABS, { withFileTypes: true })) {
    if (!family.isDirectory() || family.name.startsWith('_')) continue;
    for (const strategy of readdirSync(path.join(LABS, family.name), { withFileTypes: true })) {
      if (!strategy.isDirectory()) continue;
      const manifestPath = path.join(LABS, family.name, strategy.name, 'strategy.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (!['ported', 'compiled-native'].includes(manifest.portStatus)) continue;
      results.push(manifest);
    }
  }
  return results.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function latestWindow(db, bookDepth) {
  const row = db.prepare(`
    SELECT dt FROM lake_manifest
    WHERE dataset = 'backtest_ticks' AND underlying = 'BTC' AND interval = '5m'
      AND book_depth = ? AND status IN ('valid', 'accepted') AND active_path IS NOT NULL
    ORDER BY dt DESC LIMIT 1
  `).get(bookDepth);
  if (!row?.dt) return null;
  const next = new Date(`${row.dt}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { from: `${row.dt}T00:00:00.000Z`, to: `${next.toISOString().slice(0, 10)}T00:00:00.000Z` };
}

async function testManifest(db, config, manifest, window) {
  const slug = manifest.studioSlug || manifest.id;
  const strategy = getStrategyBySlug(db, slug);
  if (!strategy) {
    return { slug, ok: false, stage: 'seed', error: 'strategy not in SQLite (run seed:ported-strategies)' };
  }

  const version = db.prepare(`
    SELECT sv.*
    FROM strategy_versions sv
    JOIN strategy_definitions sd ON sd.id = sv.strategy_id
    WHERE sv.strategy_id = ?
    ORDER BY CASE WHEN sv.id = sd.default_version_id THEN 0 ELSE 1 END, sv.version DESC
    LIMIT 1
  `).get(strategy.id);
  if (!version) {
    return { slug, ok: false, stage: 'seed', error: 'no strategy version' };
  }

  const versionRow = getStrategyVersion(db, strategy.id, version.id);
  const validation = versionRow.validation || JSON.parse(version.validation_json || '{}');
  if (!validation.ok) {
    return { slug, ok: false, stage: 'validation', error: validation.errors?.[0]?.message || 'invalid' };
  }

  let resolved;
  try {
    resolved = resolveVersionForBacktest(versionRow, { bookDepth: config.backtestBookDepth, db });
  } catch (err) {
    return { slug, ok: false, stage: 'resolve', error: err.message };
  }

  if (!resolved.runnerLibrary && validation.execution_kind !== 'compiled-soa') {
    return {
      slug,
      ok: false,
      stage: 'resolve',
      error: `missing runnerLibrary for ${validation.execution_kind}`,
      execution_kind: validation.execution_kind,
    };
  }

  try {
    const defaultParams = extractDefaultParamsFromSchema(versionRow.params_schema || {});
    const resolved = resolveVersionForBacktest(versionRow, { bookDepth: config.backtestBookDepth, db });
    const request = {
      from: window.from,
      to: window.to,
      underlying: 'BTC',
      interval: '5m',
      bookDepth: config.backtestBookDepth,
      batchSize: 25000,
      fastRun: true,
      params: mergePresetParams(defaultParams, {}, {}),
      glsAst: resolved.glsAst,
      columnAnalysis: resolved.columnAnalysis,
      extensionLibraries: resolved.extensionLibraries,
      generatedSource: resolved.generatedSource,
      db,
      runnerLibrary: resolved.runnerLibrary ?? null,
      embeddedRunner: resolved.embeddedRunner ?? false,
      embeddedModels: resolved.embeddedModels ?? false,
      strategySourceCode: resolved.strategySourceCode ?? null,
      strategyMeta: resolved.strategyMeta,
    };
    const started = performance.now();
    const result = await runBacktest(db, request);
    return {
      slug,
      ok: true,
      execution_kind: validation.execution_kind,
      runner: resolved.runnerLibrary?.slug || null,
      ms: Math.round(performance.now() - started),
      ticks: result.ticks,
      trades: result.summary?.totalEntries ?? 0,
      pnl: result.summary?.totalPnl ?? 0,
    };
  } catch (err) {
    return {
      slug,
      ok: false,
      stage: 'backtest',
      error: err.message,
      execution_kind: validation.execution_kind,
      runner: resolved.runnerLibrary?.slug || null,
    };
  }
}

async function main() {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  const bookDepth = config.backtestBookDepth;
  const window = latestWindow(db, bookDepth);

  if (!window) {
    console.error(JSON.stringify({ ok: false, error: 'no lake partition' }));
    closeStateDatabase(db);
    process.exit(1);
  }

  const availability = checkDatasetAvailability(db, {
    dataset: 'backtest_ticks',
    ...window,
    underlying: 'BTC',
    interval: '5m',
    bookDepth,
  });
  if (!availability.ok) {
    console.error(JSON.stringify({ ok: false, error: 'dataset not ready', availability }));
    closeStateDatabase(db);
    process.exit(1);
  }

  const manifests = discoverPortedManifests();
  const results = [];
  for (const manifest of manifests) {
    if (!manifest.promotedToStudio) {
      results.push({ slug: manifest.id, ok: false, stage: 'manifest', error: 'not promotedToStudio' });
      continue;
    }
    results.push(await testManifest(db, config, manifest, window));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    window,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  }, null, 2));

  closeStateDatabase(db);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});