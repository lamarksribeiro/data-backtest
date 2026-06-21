import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { bindStrategyLibraryDatabase } from '../src/backtestStudio/nativeLibrary/registry.js';
import { runBacktest } from '../src/backtest/engine.js';
import { compileStrategyJs } from '../src/backtestStudio/strategyJs/index.js';
import { composeStrategyJsFromGls } from '../src/backtestStudio/strategyJs/composeStrategyJs.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { getStrategyBySlug, getStrategyVersion } from '../src/backtestStudio/state/strategies.js';
import { extractDefaultParamsFromSchema } from '../src/backtestStudio/state/strategyPresets.js';
import { seedPortedStrategies } from '../scripts/seed-ported-strategies.js';
import { resolveNativeModels } from '../src/backtestStudio/nativeLibrary/registry.js';
import { createStandardLibrary } from '../src/backtestStudio/gls/standardLibrary.js';

test('terminalConvexityV1 compiles to compiled-soa', () => {
  const gls = readFileSync('src/backtestStudio/gls/strategies/terminalConvexityV1.gls', 'utf8');
  const js = composeStrategyJsFromGls(gls);
  const compiled = compileStrategyJs(js, { bookDepth: 25 });
  assert.equal(compiled.ok, true, compiled.errors?.[0]?.message);
  assert.equal(compiled.execution_kind, 'compiled-soa');
  assert.equal(compiled.editable_logic, true);
  assert.deepEqual(compiled.inlined_models, ['terminal-convexity-models']);
});

test('bundled terminal-convexity-models exposes scoreTerminalSides', () => {
  const lib = createStandardLibrary({
    bookDepth: 25,
    nativeLibraries: [{ slug: 'terminal-convexity-models', version: 1 }],
  });
  assert.equal(typeof lib.model.scoreTerminalSides, 'function');
  const models = resolveNativeModels(lib, 'terminal-convexity-models', 1);
  assert.equal(typeof models?.scoreTerminalSides, 'function');
});

test('compiled terminal convexity backtest meets performance target vs library-runner', async () => {
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);
  bindStrategyLibraryDatabase(db);
  seedPortedStrategies(db);

  const row = db.prepare(`
    SELECT dt FROM lake_manifest
    WHERE dataset = 'backtest_ticks' AND underlying = 'BTC' AND interval = '5m'
      AND book_depth = 25 AND status IN ('valid', 'accepted')
    ORDER BY dt DESC LIMIT 1
  `).get();
  if (!row?.dt) {
    closeStateDatabase(db);
    return;
  }
  const next = new Date(`${row.dt}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const window = {
    from: `${row.dt}T00:00:00.000Z`,
    to: `${next.toISOString().slice(0, 10)}T00:00:00.000Z`,
  };

  const strategy = getStrategyBySlug(db, 'terminal-convexity-v1');
  const version = getStrategyVersion(db, strategy.id, strategy.default_version_id);
  const compiledResolved = resolveVersionForBacktest(version, { bookDepth: 25, db });
  assert.equal(compiledResolved.runnerLibrary, null);

  const base = {
    ...window,
    underlying: 'BTC',
    interval: '5m',
    bookDepth: 25,
    batchSize: 25000,
    fastRun: true,
    params: extractDefaultParamsFromSchema(version.params_schema || {}),
    db,
    strategyMeta: {
      strategy_id: strategy.id,
      strategy_version_id: version.id,
      slug: 'terminal-convexity-v1',
    },
  };

  const t0 = performance.now();
  const compiledResult = await runBacktest(db, {
    ...base,
    strategy: 'gls:terminal-convexity-v1',
    glsAst: compiledResolved.glsAst,
    columnAnalysis: compiledResolved.columnAnalysis,
    generatedSource: compiledResolved.generatedSource,
    extensionLibraries: compiledResolved.extensionLibraries,
    embeddedModels: compiledResolved.embeddedModels,
    strategySourceCode: compiledResolved.strategySourceCode,
  });
  const compiledMs = performance.now() - t0;

  const libraryVersion = db.prepare(`
    SELECT slv.*
    FROM strategy_library_versions slv
    JOIN strategy_library_definitions sld ON sld.id = slv.library_id
    WHERE sld.slug = 'terminal-convexity-runner' AND slv.version = 1
  `).get();
  assert.ok(libraryVersion, 'library runner should remain available for benchmark');

  const legacySource = `export default strategy({
    name: "Terminal Convexity Legacy",
    dependencies: { runner: strategyLibrary("terminal-convexity-runner", 1) },
    params: ${JSON.stringify(base.params)},
    onEventStart() {},
    onTick() {},
    onEventEnd() {},
  });`;
  const { validateStrategySource } = await import('../src/backtestStudio/strategyJs/index.js');
  const legacyValidation = validateStrategySource({ language: 'strategy-js-v1', source_code: legacySource, db });
  const legacyResolved = resolveVersionForBacktest({
    language: 'strategy-js-v1',
    source_code: legacySource,
    validation: legacyValidation,
    params_schema: version.params_schema,
    checksum: 'legacy',
    compiled: null,
    compiled_json: null,
  }, { bookDepth: 25, db });
  assert.ok(legacyResolved.runnerLibrary);

  const t1 = performance.now();
  const libraryResult = await runBacktest(db, {
    ...base,
    strategy: 'gls:terminal-convexity-v1-legacy',
    glsAst: legacyResolved.glsAst,
    columnAnalysis: legacyResolved.columnAnalysis,
    runnerLibrary: legacyResolved.runnerLibrary,
  });
  const libraryMs = performance.now() - t1;

  closeStateDatabase(db);

  assert.ok(compiledResult.ticks > 1000);
  assert.ok(compiledResult.timings.processMs < libraryResult.timings.processMs * 0.35,
    `compiled processMs ${compiledResult.timings.processMs} should be <35% of library ${libraryResult.timings.processMs}`);
  assert.ok(compiledMs < libraryMs * 0.5,
    `compiled wall ${Math.round(compiledMs)}ms vs library ${Math.round(libraryMs)}ms`);

  const entryDelta = Math.abs((compiledResult.summary?.totalEntries ?? 0) - (libraryResult.summary?.totalEntries ?? 0));
  assert.ok(entryDelta <= 3,
    `entry count delta ${entryDelta} too high (compiled=${compiledResult.summary?.totalEntries}, library=${libraryResult.summary?.totalEntries})`);
});