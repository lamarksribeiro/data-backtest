#!/usr/bin/env node
/**
 * Benchmark processMs das library/portfolio runners (facade SoA, arrays nativos).
 * Uso: node scripts/bench-library-runner-soa.js
 */
import 'dotenv/config';
import { performance } from 'node:perf_hooks';

import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { bindStrategyLibraryDatabase } from '../src/backtestStudio/nativeLibrary/registry.js';
import { runBacktest } from '../src/backtest/engine.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { getStrategyBySlug } from '../src/backtestStudio/state/strategies.js';
import { extractDefaultParamsFromSchema } from '../src/backtestStudio/state/strategyPresets.js';
import { clearStrategyLibraryRunnerCache } from '../src/backtestStudio/strategyLibrary/loadRunner.js';

const TARGETS = [
  'convergence-undershoot-v1',
  'lead-inertia-v1',
  'impulse-elasticity',
  'momentum-edge-v1',
  'cofre-sete-v1',
  'fusion-five-v1',
  'omni-edge-v1',
];

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
  return {
    from: `${row.dt}T00:00:00.000Z`,
    to: `${next.toISOString().slice(0, 10)}T00:00:00.000Z`,
  };
}

async function benchSlug(db, slug, window, bookDepth) {
  clearStrategyLibraryRunnerCache();
  const strategy = getStrategyBySlug(db, slug);
  if (!strategy) return { slug, ok: false, error: 'strategy not found' };

  const version = db.prepare(`
    SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version DESC LIMIT 1
  `).get(strategy.id);
  const versionRow = {
    ...version,
    params_schema: JSON.parse(version.params_schema_json || '{}'),
    validation: JSON.parse(version.validation_json || '{}'),
    compiled: version.compiled_json ? JSON.parse(version.compiled_json) : null,
  };
  const resolved = resolveVersionForBacktest(versionRow, { bookDepth, db });
  const wallStart = performance.now();
  const result = await runBacktest(db, {
    ...window,
    underlying: 'BTC',
    interval: '5m',
    bookDepth,
    batchSize: 25000,
    fastRun: true,
    params: extractDefaultParamsFromSchema(versionRow.params_schema || {}),
    db,
    glsAst: resolved.glsAst,
    columnAnalysis: resolved.columnAnalysis,
    runnerLibrary: resolved.runnerLibrary,
  });
  const wallMs = Math.round(performance.now() - wallStart);
  return {
    slug,
    ok: true,
    execution_kind: versionRow.validation?.execution_kind,
    ticks: result.ticks,
    processMs: Math.round(result.timings.processMs),
    duckdbReadMs: Math.round(result.timings.duckdbReadMs ?? 0),
    wallMs,
    trades: result.summary?.totalEntries ?? 0,
  };
}

async function main() {
  const config = loadConfig();
  const bookDepth = config.backtestBookDepth;
  const db = openStateDatabase(config.stateDbPath);
  bindStrategyLibraryDatabase(db);

  const window = latestWindow(db, bookDepth);
  if (!window) {
    console.error(JSON.stringify({ ok: false, error: 'no lake partition' }));
    closeStateDatabase(db);
    process.exit(1);
  }

  const results = [];
  for (const slug of TARGETS) {
    results.push(await benchSlug(db, slug, window, bookDepth));
  }

  console.log(JSON.stringify({ ok: true, window, results }, null, 2));
  closeStateDatabase(db);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});