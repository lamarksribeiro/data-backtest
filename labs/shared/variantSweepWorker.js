import { parentPort, workerData } from 'node:worker_threads';

import { runSequentialSoA } from '../../src/backtest/engine.js';
import { applyPolymarketFeesToBacktestResult } from '../../src/backtest/fees.js';
import { wrapSharedColumnSet } from '../../src/backtest/columnStore.js';
import { createGlsBacktestRunner } from '../../src/backtestStudio/gls/runtime.js';

try {
  const columnSet = wrapSharedColumnSet(workerData.sharedColumnSet);
  const request = workerData.request;
  const variants = workerData.variants || [];
  const results = [];

  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index];
    const startedAt = Date.now();
    const params = { ...(request.params || {}), ...(variant.params || {}) };
    const runner = createGlsBacktestRunner(request.glsAst, params, {
      executionMode: request.glsExecution || 'compiled-soa',
      fastRun: true,
      bookDepth: request.bookDepth,
    });

    runner.bindColumnSet(columnSet);
    runSequentialSoA(runner, columnSet, true);

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

  parentPort?.postMessage({ type: 'done', workerIndex: workerData.workerIndex, results });
} catch (err) {
  parentPort?.postMessage({ type: 'error', error: err.message, stack: err.stack });
}
