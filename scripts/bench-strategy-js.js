#!/usr/bin/env node
/**
 * Benchmark Strategy JS vs GLS equivalent.
 * Uso: npm run bench:strategy-js
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { runBacktest } from '../src/backtest/engine.js';
import { compileStrategyJs } from '../src/backtestStudio/strategyJs/index.js';
import { composeStrategyJsFromGls } from '../src/backtestStudio/strategyJs/composeStrategyJs.js';
import { parse as parseGls } from '../src/backtestStudio/gls/parser.js';
import { analyzeStrategyColumns } from '../src/backtestStudio/gls/compiler.js';
import { getEdgeSniperV2GlsSource } from '../src/backtestStudio/gls/loadStrategySource.js';
import { checkDatasetAvailability } from '../src/query/availability.js';
import { detectEmbeddedModels } from '../src/backtestStudio/strategyJs/embeddedModels.js';

const GLS_SOURCE = getEdgeSniperV2GlsSource();
const JS_SOURCE = composeStrategyJsFromGls(GLS_SOURCE);

function defaultRange() {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 1);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

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
  return { from: row.dt, to: next.toISOString().slice(0, 10) };
}

async function main() {
  const config = loadConfig();
  const bookDepth = config.backtestBookDepth;
  const db = openStateDatabase(config.stateDbPath);

  let range = defaultRange();
  let from = `${range.from}T00:00:00.000Z`;
  let to = `${range.to}T00:00:00.000Z`;

  let availability = checkDatasetAvailability(db, {
    dataset: 'backtest_ticks',
    from,
    to,
    underlying: 'BTC',
    interval: '5m',
    bookDepth,
  });
  if (!availability.ok) {
    const fallback = latestManifestDay(db, bookDepth);
    if (!fallback) {
      console.error(JSON.stringify({ ok: false, error: 'Dataset not ready', availability }));
      closeStateDatabase(db);
      process.exit(1);
    }
    range = fallback;
    from = `${range.from}T00:00:00.000Z`;
    to = `${range.to}T00:00:00.000Z`;
    availability = checkDatasetAvailability(db, {
      dataset: 'backtest_ticks',
      from,
      to,
      underlying: 'BTC',
      interval: '5m',
      bookDepth,
    });
    if (!availability.ok) {
      console.error(JSON.stringify({ ok: false, error: 'Dataset not ready', availability }));
      closeStateDatabase(db);
      process.exit(1);
    }
  }

  const glsAst = parseGls(GLS_SOURCE);
  const jsCompile = compileStrategyJs(JS_SOURCE, { bookDepth });
  const columnAnalysis = analyzeStrategyColumns(glsAst, bookDepth);
  const jsEmbeddedModels = detectEmbeddedModels(JS_SOURCE);

  async function bench(label, glsAstInput, options = {}) {
    const { compileMeta = null, columnAnalysis: columnAnalysisOverride = columnAnalysis } = options;
    const started = performance.now();
    const compileStarted = performance.now();
    const result = await runBacktest(db, {
      from,
      to,
      underlying: 'BTC',
      interval: '5m',
      bookDepth,
      batchSize: 25000,
      fastRun: true,
      glsAst: glsAstInput,
      columnAnalysis: columnAnalysisOverride,
      params: {},
      db,
      embeddedModels: options.embeddedModels ?? false,
      strategySourceCode: options.strategySourceCode ?? null,
      generatedSource: options.generatedSource ?? null,
      strategyMeta: compileMeta ? {
        language: 'strategy-js-v1',
        compilerMode: 'compiled-soa',
        compileMs: compileMeta.compile?.compileMs,
        compileCacheHit: false,
      } : { language: 'gls-v1' },
    });
    const totalMs = performance.now() - started;
    const compileMs = compileMeta ? compileMeta.compile?.compileMs : performance.now() - compileStarted;
    return {
      label,
      totalMs: Math.round(totalMs),
      compileMs: Math.round(compileMs),
      processMs: result.timings?.processMs ?? result.summary?.timings?.processMs,
      ticks: result.ticks,
      totalPnl: result.summary?.totalPnl,
    };
  }

  try {
    const rows = [];
    rows.push(await bench('gls-v1', glsAst));
    rows.push(await bench('strategy-js-v1', jsCompile.ast, {
      compileMeta: jsCompile.compiled,
      columnAnalysis: jsCompile.column_analysis,
      embeddedModels: Boolean(jsEmbeddedModels),
      strategySourceCode: JS_SOURCE,
      generatedSource: jsCompile.compiled.generated_source,
    }));

    const report = {
      ok: true,
      window: { from, to, underlying: 'BTC', interval: '5m', bookDepth },
      results: rows,
      parity: {
        pnlDelta: Math.abs((rows[0]?.totalPnl ?? 0) - (rows[1]?.totalPnl ?? 0)),
      },
    };

    console.log(JSON.stringify(report, null, 2));
    const outDir = path.resolve('reports/bench');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, `strategy-js-${Date.now()}.json`), JSON.stringify(report, null, 2));
  } finally {
    closeStateDatabase(db);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});