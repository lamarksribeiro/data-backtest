import { parentPort, workerData } from 'node:worker_threads';

import { runSequentialSoA } from './engine.js';
import { applyPolymarketFeesToBacktestResult } from './fees.js';
import { wrapSharedColumnSet } from './columnStore.js';
import { createGlsBacktestRunner } from '../backtestStudio/gls/runtime.js';
import {
  createGammaLadderGlsRunner,
  isGammaLadderStrategy,
} from '../backtestStudio/gls/gammaLadder/glsAdapter.js';

(async () => {
try {
  const columnSet = wrapSharedColumnSet(workerData.sharedColumnSet);
  const request = workerData.request;
  const variants = workerData.variants || [];
  const isGammaLadder = isGammaLadderStrategy(request.glsAst);
  const bookDepth = request.effectiveBookDepth ?? request.bookDepth;
  const results = [];

  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index];
    const startedAt = Date.now();
    const params = { ...(request.params || {}), ...(variant.params || {}) };
    const runner = isGammaLadder
      ? createGammaLadderGlsRunner(params, { fastRun: true, bookDepth })
      : createGlsBacktestRunner(request.glsAst, params, {
        executionMode: 'compiled-soa',
        fastRun: true,
        bookDepth,
      });

    runner.bindColumnSet(columnSet);
    await runSequentialSoA(runner, columnSet, !isGammaLadder);

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
      variantId: variant.id,
    });
  }

  parentPort?.postMessage({ type: 'done', workerIndex: workerData.workerIndex, results });
} catch (err) {
  parentPort?.postMessage({ type: 'error', error: err.message, stack: err.stack });
}
})();
