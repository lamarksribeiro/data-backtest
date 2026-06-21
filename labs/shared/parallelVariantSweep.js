import { Worker } from 'node:worker_threads';

import { columnSetToShared } from '../../src/backtest/columnStore.js';
import { loadBacktestColumnSet } from '../../src/query/columnChunkReader.js';

export async function runParallelVariantSweep(db, request, variants, {
  variantWorkers = 1,
  onProgress,
} = {}) {
  const timings = { startedAt: Date.now(), duckdbReadMs: 0, shareMs: 0, sweepProcessMs: 0, completedAt: null };
  const readStartedAt = Date.now();
  const columnSet = await loadBacktestColumnSet(db, {
    from: request.from,
    to: request.to,
    underlying: request.underlying,
    interval: request.interval,
    bookDepth: request.bookDepth,
    selectColumns: request.columnAnalysis?.scalarColumns,
    dataset: request.dataset,
    validBacktestRows: true,
  });
  timings.duckdbReadMs = Date.now() - readStartedAt;

  const shareStartedAt = Date.now();
  const sharedColumnSet = columnSetToShared(columnSet);
  timings.shareMs = Date.now() - shareStartedAt;

  const processStartedAt = Date.now();
  const workerCount = Math.max(1, Math.min(Number(variantWorkers) || 1, variants.length));
  const chunks = splitVariants(variants, workerCount);
  const progressState = new Map();
  const results = await Promise.all(chunks.map((chunk, workerIndex) => runWorker({
    workerIndex,
    request,
    sharedColumnSet,
    variants: chunk,
    onProgress: (msg) => {
      progressState.set(workerIndex, msg.completed || 0);
      const completed = [...progressState.values()].reduce((sum, count) => sum + count, 0);
      onProgress?.({
        phase: 'sweep',
        variantIndex: Math.max(0, completed - 1),
        variantCount: variants.length,
        variantId: msg.variantId,
        workerIndex,
      });
    },
  })));
  timings.sweepProcessMs = Date.now() - processStartedAt;
  timings.completedAt = Date.now();

  const flatResults = results.flat().sort((left, right) => variantOrder(left.id, variants) - variantOrder(right.id, variants));
  const totalMs = timings.completedAt - timings.startedAt;

  return {
    strategy: request.strategyLabel || request.strategy,
    source: 'lakehouse',
    underlying: request.underlying,
    interval: request.interval,
    bookDepth: request.bookDepth,
    from: new Date(request.from).toISOString(),
    to: new Date(request.to).toISOString(),
    ticks: columnSet.length,
    variantCount: flatResults.length,
    variants: flatResults,
    timings: {
      duckdbReadMs: timings.duckdbReadMs,
      shareMs: timings.shareMs,
      sweepProcessMs: timings.sweepProcessMs,
      avgVariantMs: flatResults.length ? Math.round(timings.sweepProcessMs / flatResults.length) : null,
      totalMs,
      variantWorkers: workerCount,
    },
    strategyMeta: request.strategyMeta || null,
  };
}

function splitVariants(variants, workerCount) {
  const chunks = Array.from({ length: workerCount }, () => []);
  for (let index = 0; index < variants.length; index += 1) {
    chunks[index % workerCount].push(variants[index]);
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

function cloneRequestForWorker(request) {
  const {
    db: _db,
    strategyMeta: _strategyMeta,
    ...cloneable
  } = request || {};
  return cloneable;
}

function runWorker({ workerIndex, request, sharedColumnSet, variants, onProgress }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./variantSweepWorker.js', import.meta.url), {
      workerData: { workerIndex, request: cloneRequestForWorker(request), sharedColumnSet, variants },
    });
    worker.on('message', (msg) => {
      if (msg?.type === 'progress') {
        onProgress?.(msg);
        return;
      }
      if (msg?.type === 'done') {
        resolve(msg.results || []);
        worker.terminate().catch(() => {});
        return;
      }
      if (msg?.type === 'error') {
        reject(new Error(msg.error || 'variant worker failed'));
      }
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`variant worker exited with code ${code}`));
    });
  });
}

function variantOrder(id, variants) {
  const index = variants.findIndex((variant) => variant.id === id);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}
