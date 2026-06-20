import { parentPort, workerData } from 'node:worker_threads';

import { runSequentialSoA } from './engine.js';
import { applyPolymarketFeesToBacktestResult } from './fees.js';
import { wrapSharedColumnSet } from './columnStore.js';
import { createGlsBacktestRunner } from '../backtestStudio/gls/runtime.js';
import { createLibraryRunnerAdapter } from '../backtestStudio/strategyLibrary/runnerAdapter.js';
import { createEmbeddedRunnerAdapter } from '../backtestStudio/strategyJs/embeddedRunnerAdapter.js';

(async () => {
try {
  const columnSet = wrapSharedColumnSet(workerData.sharedColumnSet);
  const request = workerData.request;
  const variants = workerData.variants || [];
  const isEmbeddedRunner = Boolean(request.embeddedRunner && request.strategySourceCode);
  const isLibraryRunner = Boolean(request.runnerLibrary && request.db);
  const useCustomSoa = isEmbeddedRunner || isLibraryRunner;
  const bookDepth = request.effectiveBookDepth ?? request.bookDepth;
  const results = [];

  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index];
    const startedAt = Date.now();
    const params = { ...(request.params || {}), ...(variant.params || {}) };
    const runner = isEmbeddedRunner
      ? createEmbeddedRunnerAdapter(request.strategySourceCode, params, { fastRun: true, bookDepth })
      : (isLibraryRunner
        ? createLibraryRunnerAdapter(request.db, request.runnerLibrary, params, { fastRun: true, bookDepth })
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
      order: variant.order,
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
    });
  }

  parentPort?.postMessage({ type: 'done', results });
} catch (err) {
  parentPort?.postMessage({ type: 'error', error: err?.message || String(err) });
}
})();