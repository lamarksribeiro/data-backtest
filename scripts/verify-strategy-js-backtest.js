#!/usr/bin/env node
/**
 * Verifica backtest com Strategy JS no lake real (strategy_id/version).
 * Uso: npm run verify:strategy-js-backtest
 */
import 'dotenv/config';
import { performance } from 'node:perf_hooks';

import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { runBacktest } from '../src/backtest/engine.js';
import { checkDatasetAvailability } from '../src/query/availability.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';

function latestManifestDay(db, bookDepth) {
  const row = db.prepare(`
    SELECT dt FROM lake_manifest
    WHERE dataset = 'backtest_ticks'
      AND underlying = 'BTC'
      AND interval = '5m'
      AND book_depth = ?
      AND status IN ('valid', 'accepted')
      AND active_path IS NOT NULL
    ORDER BY dt DESC
    LIMIT 1
  `).get(bookDepth);
  if (!row?.dt) return null;
  const next = new Date(`${row.dt}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { from: `${row.dt}T00:00:00.000Z`, to: `${next.toISOString().slice(0, 10)}T00:00:00.000Z` };
}

async function main() {
  const config = loadConfig();
  const bookDepth = config.backtestBookDepth;
  const db = openStateDatabase(config.stateDbPath);

  const window = latestManifestDay(db, bookDepth);
  if (!window) {
    console.error(JSON.stringify({ ok: false, error: 'No lake partition available' }));
    closeStateDatabase(db);
    process.exit(1);
  }

  const availability = checkDatasetAvailability(db, {
    dataset: 'backtest_ticks',
    from: window.from,
    to: window.to,
    underlying: 'BTC',
    interval: '5m',
    bookDepth,
  });
  if (!availability.ok) {
    console.error(JSON.stringify({ ok: false, error: 'Dataset not ready', availability }));
    closeStateDatabase(db);
    process.exit(1);
  }

  const version = db.prepare(`
    SELECT sv.*, sd.slug
    FROM strategy_versions sv
    JOIN strategy_definitions sd ON sd.id = sv.strategy_id
    WHERE sd.slug = 'edge-sniper-v3-gls' AND sv.language = 'strategy-js-v1'
    ORDER BY sv.version DESC
    LIMIT 1
  `).get();

  if (!version) {
    console.error(JSON.stringify({ ok: false, error: 'edge-sniper-v3-gls Strategy JS version not found' }));
    closeStateDatabase(db);
    process.exit(1);
  }

  const resolved = resolveVersionForBacktest(version, { bookDepth, db });
  const started = performance.now();
  const result = await runBacktest(db, {
    from: window.from,
    to: window.to,
    underlying: 'BTC',
    interval: '5m',
    bookDepth,
    batchSize: 25000,
    fastRun: true,
    glsAst: resolved.glsAst,
    columnAnalysis: resolved.columnAnalysis,
    embeddedRunner: resolved.embeddedRunner,
    strategySourceCode: resolved.strategySourceCode,
    db,
    strategyMeta: resolved.strategyMeta,
    params: {},
  });
  const totalMs = Math.round(performance.now() - started);

  const report = {
    ok: true,
    slug: version.slug,
    version: version.version,
    language: version.language,
    window,
    bookDepth,
    totalMs,
    processMs: result.timings?.processMs ?? result.summary?.timings?.processMs,
    ticks: result.ticks,
    trades: result.summary?.totalEntries,
    pnl: result.summary?.totalPnl,
    compileCacheHit: resolved.strategyMeta.compileCacheHit,
    strategyMeta: resolved.strategyMeta,
  };
  console.log(JSON.stringify(report, null, 2));
  closeStateDatabase(db);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});