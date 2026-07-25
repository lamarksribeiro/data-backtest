import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { runBacktest } from '../src/backtest/engine.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { getStrategyBySlug, getStrategyVersion } from '../src/backtestStudio/state/strategies.js';
import { extractDefaultParamsFromSchema, mergePresetParams } from '../src/backtestStudio/state/strategyPresets.js';

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath);
const slug = 'escada-dupla-v1';
const strategy = getStrategyBySlug(db, slug);
if (!strategy) {
  console.log(JSON.stringify({ ok: false, error: 'not seeded' }));
  process.exit(1);
}

const version = db.prepare(`
  SELECT sv.*
  FROM strategy_versions sv
  JOIN strategy_definitions sd ON sd.id = sv.strategy_id
  WHERE sv.strategy_id = ?
  ORDER BY CASE WHEN sv.id = sd.default_version_id THEN 0 ELSE 1 END, sv.version DESC
  LIMIT 1
`).get(strategy.id);

const versionRow = getStrategyVersion(db, strategy.id, version.id);
const validation = versionRow.validation || JSON.parse(version.validation_json || '{}');
const resolved = resolveVersionForBacktest(versionRow, { bookDepth: 25, db });
const defaultParams = extractDefaultParamsFromSchema(versionRow.params_schema || {});
const request = {
  from: '2026-07-21T00:00:00.000Z',
  to: '2026-07-22T00:00:00.000Z',
  underlying: 'BTC',
  interval: '5m',
  bookDepth: 25,
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
console.log(JSON.stringify({
  ok: true,
  slug,
  defaultVersion: version.version,
  notes: version.notes,
  execution_kind: validation.execution_kind,
  runner: resolved.runnerLibrary?.slug || null,
  ms: Math.round(performance.now() - started),
  ticks: result.ticks,
  entries: result.summary?.totalEntries ?? result.summary?.entries ?? 0,
  totalPnl: result.summary?.totalPnl ?? 0,
  winRate: result.summary?.winRate ?? null,
  profitFactor: result.summary?.profitFactor ?? null,
}, null, 2));
closeStateDatabase(db);
