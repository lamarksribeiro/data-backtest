import { parentPort, workerData } from 'node:worker_threads';

import { runSequentialSoA } from '../../src/backtest/engine.js';
import { applyPolymarketFeesToBacktestResult } from '../../src/backtest/fees.js';
import { wrapSharedColumnSet } from '../../src/backtest/columnStore.js';
import { createGlsBacktestRunner } from '../../src/backtestStudio/gls/runtime.js';
import { createLibraryRunnerAdapter } from '../../src/backtestStudio/strategyLibrary/runnerAdapter.js';
import { createEmbeddedRunnerAdapter } from '../../src/backtestStudio/strategyJs/embeddedRunnerAdapter.js';
import { openStateDatabase } from '../../src/state/sqlite.js';
import { bindStrategyLibraryDatabase } from '../../src/backtestStudio/nativeLibrary/registry.js';
import { loadConfig } from '../../src/config.js';

(async () => {
try {
  const columnSet = wrapSharedColumnSet(workerData.sharedColumnSet);
  const request = workerData.request;
  const variants = workerData.variants || [];
  const isEmbeddedRunner = Boolean(request.embeddedRunner && request.strategySourceCode);
  const isLibraryRunner = Boolean(request.runnerLibrary);
  const useCustomSoa = isEmbeddedRunner || isLibraryRunner;
  const bookDepth = request.effectiveBookDepth ?? request.bookDepth;
  const results = [];

  let db = null;
  if (isLibraryRunner) {
    const config = loadConfig();
    db = openStateDatabase(config.stateDbPath, { readOnly: true });
    bindStrategyLibraryDatabase(db);
  }

  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index];
    const startedAt = Date.now();
    const params = { ...(request.params || {}), ...(variant.params || {}) };
    const runner = isEmbeddedRunner
      ? createEmbeddedRunnerAdapter(request.strategySourceCode, params, { fastRun: true, bookDepth })
      : (isLibraryRunner
        ? createLibraryRunnerAdapter(db, request.runnerLibrary, params, { fastRun: true, bookDepth })
        : createGlsBacktestRunner(request.glsAst, params, {
          executionMode: 'compiled-soa',
          fastRun: true,
          bookDepth,
          extensionLibraries: request.extensionLibraries,
          generatedSource: request.generatedSource,
        }));

    runner.bindColumnSet(columnSet);
    await runSequentialSoA(runner, columnSet, !useCustomSoa);

    const result = runner.finish();
    applyPolymarketFeesToBacktestResult(result, request.feeOptions);

    results.push({
      id: variant.id,
      params,
      summary: result.summary,
      ticks: columnSet.length,
      variantMs: Date.now() - startedAt,
    });

    parentPort?.postMessage({
      type: 'progress',
      workerIndex: workerData.workerIndex,
      completed: index + 1,
      total: variants.length,
      variantId: variant.id,
    });
  }

  if (db) {
    try {
      db.close();
    } catch (_) {}
  }

  parentPort?.postMessage({ type: 'done', workerIndex: workerData.workerIndex, results });
} catch (err) {
  parentPort?.postMessage({ type: 'error', error: err.message, stack: err.stack });
}
})();