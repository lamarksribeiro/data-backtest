import { applyPolymarketFeesToBacktestResult } from './fees.js';
import { Worker } from 'node:worker_threads';
import { loadConfig } from '../config.js';
import { analyzeStrategyColumns, analyzeStrategyParallelism } from '../backtestStudio/gls/compiler.js';
import { createGlsBacktestRunner } from '../backtestStudio/gls/runtime.js';
import { createLibraryRunnerAdapter, LIBRARY_RUNNER_COLUMN_ANALYSIS } from '../backtestStudio/strategyLibrary/runnerAdapter.js';
import { createEmbeddedRunnerAdapter, EMBEDDED_RUNNER_COLUMN_ANALYSIS } from '../backtestStudio/strategyJs/embeddedRunnerAdapter.js';
import { datasetCacheKey, getDatasetCache } from './datasetCache.js';
import { loadBacktestColumnSet } from '../query/columnChunkReader.js';
import { runParallelEventSlices } from './eventPool.js';
import { columnSetToShared, wrapSharedColumnSet } from './columnStore.js';
import {
  availabilityRequestForBacktest,
  resolveBacktestDataset,
  runSequentialSoA,
} from './engine.js';

/**
 * F5 — sweep multi-variante: 1× leitura ColumnSet, N× fast-run compiled-soa.
 */
export async function runBacktestSweep(db, baseRequest, variants, { onProgress, maxVariants } = {}) {
  if (!baseRequest?.glsAst && !baseRequest?.runnerLibrary) {
    throw new Error('Sweep requires a GLS strategy (glsAst) or library runner');
  }
  if (!Array.isArray(variants) || !variants.length) throw new Error('variants must be a non-empty array');

  const config = loadConfig();
  if (config.backtestEngine !== 'soa') {
    throw new Error('Sweep requires BACKTEST_ENGINE=soa');
  }

  const limit = maxVariants ?? config.sweepMaxVariants;
  if (variants.length > limit) {
    throw new Error(`Sweep supports at most ${limit} variants`);
  }

  const normalized = variants.map((variant, index) => ({
    id: variant?.id ?? variant?.name ?? String(index),
    params: variant?.params && typeof variant.params === 'object' ? variant.params : {},
  }));

  const isEmbeddedRunner = Boolean(baseRequest.embeddedRunner && baseRequest.strategySourceCode);
  const isLibraryRunner = Boolean(baseRequest.runnerLibrary && baseRequest.db);
  const columnAnalysis = baseRequest.columnAnalysis
    ?? (isEmbeddedRunner
      ? EMBEDDED_RUNNER_COLUMN_ANALYSIS
      : (isLibraryRunner
        ? LIBRARY_RUNNER_COLUMN_ANALYSIS
        : analyzeStrategyColumns(baseRequest.glsAst, baseRequest.bookDepth ?? 25)));
  const dataset = resolveBacktestDataset(baseRequest, columnAnalysis);
  const effectiveBookDepth = columnAnalysis?.needsBookLevels
    ? (columnAnalysis.bookDepth || baseRequest.bookDepth)
    : baseRequest.bookDepth;

  const timings = { startedAt: Date.now(), duckdbReadMs: 0, processMs: 0, completedAt: null };
  const loaded = await loadOrGetColumnSet(db, baseRequest, {
    dataset,
    columnAnalysis,
    effectiveBookDepth,
    config,
    timings,
  });
  let columnSet = loaded.columnSet;

  const variantWorkerCount = Math.max(Number(baseRequest.variantWorkers ?? config.sweepVariantWorkers ?? 1) || 1, 1);
  if (variantWorkerCount > 1 && normalized.length > 1) {
    return runParallelVariantSweep({
      baseRequest,
      variants: normalized,
      columnSet,
      cache: loaded.cache,
      cacheKey: loaded.cacheKey,
      effectiveBookDepth,
      timings,
      workerCount: variantWorkerCount,
      onProgress,
    });
  }

  const parallelism = baseRequest.glsAst
    ? analyzeStrategyParallelism(baseRequest.glsAst)
    : { parallelSafe: false };
  const workerCount = Number(baseRequest.backtestWorkers ?? config.backtestWorkers ?? 1);
  const canParallelize = parallelism.parallelSafe
    && workerCount > 1
    && columnSet.events.length > 1;

  const executionMode = isEmbeddedRunner ? 'embedded-runner' : (isLibraryRunner ? 'library-runner' : 'compiled-soa');
  const useCustomSoa = isEmbeddedRunner || isLibraryRunner;
  const variantResults = [];
  const processStartedAt = Date.now();

  for (let index = 0; index < normalized.length; index += 1) {
    const variant = normalized[index];
    const variantStartedAt = Date.now();
    const params = { ...(baseRequest.params ?? {}), ...variant.params };
    const runner = isEmbeddedRunner
      ? createEmbeddedRunnerAdapter(baseRequest.strategySourceCode, params, { fastRun: true, bookDepth: effectiveBookDepth })
      : (isLibraryRunner
        ? createLibraryRunnerAdapter(baseRequest.db, baseRequest.runnerLibrary, params, { fastRun: true, bookDepth: effectiveBookDepth })
        : createGlsBacktestRunner(baseRequest.glsAst, params, {
          executionMode,
          fastRun: true,
          bookDepth: effectiveBookDepth,
          extensionLibraries: baseRequest.extensionLibraries,
          generatedSource: baseRequest.generatedSource,
        }));

    if (canParallelize && !useCustomSoa) {
      const slices = await runParallelEventSlices({
        ast: baseRequest.glsAst,
        params,
        columnSet,
        workerCount,
        fastRun: true,
        bookDepth: effectiveBookDepth,
      });
      if (slices?.length) {
        runner.importParallelSlices(slices);
      } else {
        runner.bindColumnSet(columnSet);
        await runSequentialSoA(runner, columnSet, !useCustomSoa);
      }
    } else {
      runner.bindColumnSet(columnSet);
      await runSequentialSoA(runner, columnSet, !useCustomSoa);
    }

    const result = runner.finish();
    applyPolymarketFeesToBacktestResult(result, baseRequest.feeOptions);
    const variantMs = Date.now() - variantStartedAt;

    variantResults.push({
      id: variant.id,
      params,
      summary: result.summary,
      ticks: columnSet.length,
      variantMs,
    });

    onProgress?.({
      phase: 'sweep',
      variantIndex: index,
      variantCount: normalized.length,
      variantId: variant.id,
      elapsed_ms: Date.now() - timings.startedAt,
    });
  }

  timings.processMs = Date.now() - processStartedAt;
  timings.completedAt = Date.now();
  const totalMs = timings.completedAt - timings.startedAt;
  const processMs = timings.processMs;

  return {
    strategy: variantResults[0] ? baseRequest.strategyLabel || baseRequest.strategy : null,
    source: 'lakehouse',
    underlying: baseRequest.underlying,
    interval: baseRequest.interval,
    bookDepth: baseRequest.bookDepth,
    from: new Date(baseRequest.from).toISOString(),
    to: new Date(baseRequest.to).toISOString(),
    ticks: columnSet.length,
    variantCount: variantResults.length,
    variants: variantResults,
    timings: {
      duckdbReadMs: timings.duckdbReadMs,
      sweepProcessMs: processMs,
      avgVariantMs: variantResults.length ? Math.round(processMs / variantResults.length) : null,
      totalMs,
    },
    strategyMeta: baseRequest.strategyMeta ?? null,
  };
}

async function loadOrGetColumnSet(db, request, ctx) {
  const cache = ctx.config.datasetDiskCacheEnabled
    ? { get: () => null, set: () => {} }
    : getDatasetCache(ctx.config.datasetCacheMaxMb);
  const cacheKey = datasetCacheKey(
    { ...request, dataset: ctx.dataset },
    ctx.columnAnalysis?.scalarColumns?.join(','),
  );
  const cached = cache.get(cacheKey);
  if (cached) return { columnSet: cached, cache, cacheKey };

  const readStartedAt = Date.now();
  const columnSet = await loadBacktestColumnSet(db, {
    from: request.from,
    to: request.to,
    underlying: request.underlying,
    interval: request.interval,
    bookDepth: ctx.effectiveBookDepth,
    selectColumns: ctx.columnAnalysis?.scalarColumns,
    dataset: ctx.dataset,
    validBacktestRows: true,
  });
  ctx.timings.duckdbReadMs += Date.now() - readStartedAt;
  cache.set(cacheKey, columnSet);
  return { columnSet, cache, cacheKey };
}

async function runParallelVariantSweep({
  baseRequest,
  variants,
  columnSet,
  cache,
  cacheKey,
  effectiveBookDepth,
  timings,
  workerCount,
  onProgress,
}) {
  const shareStartedAt = Date.now();
  const sharedColumnSet = columnSetToShared(columnSet);
  columnSet = wrapSharedColumnSet(sharedColumnSet);
  cache?.set?.(cacheKey, columnSet);
  const shareMs = Date.now() - shareStartedAt;

  const workers = Math.max(1, Math.min(Number(workerCount) || 1, variants.length));
  const chunks = splitVariants(variants, workers);
  const progressState = new Map();
  const processStartedAt = Date.now();

  const chunkResults = await Promise.all(chunks.map((chunk, workerIndex) => runVariantWorker({
    workerIndex,
    request: {
      ...baseRequest,
      effectiveBookDepth,
      glsExecution: 'compiled-soa',
    },
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

  const processMs = Date.now() - processStartedAt;
  timings.processMs = processMs;
  timings.completedAt = Date.now();

  const variantResults = chunkResults
    .flat()
    .sort((left, right) => left.order - right.order)
    .map(({ order, ...result }) => result);

  return {
    strategy: variantResults[0] ? baseRequest.strategyLabel || baseRequest.strategy : null,
    source: 'lakehouse',
    underlying: baseRequest.underlying,
    interval: baseRequest.interval,
    bookDepth: baseRequest.bookDepth,
    from: new Date(baseRequest.from).toISOString(),
    to: new Date(baseRequest.to).toISOString(),
    ticks: columnSet.length,
    variantCount: variantResults.length,
    variants: variantResults,
    timings: {
      duckdbReadMs: timings.duckdbReadMs,
      shareMs,
      sweepProcessMs: processMs,
      avgVariantMs: variantResults.length ? Math.round(processMs / variantResults.length) : null,
      totalMs: timings.completedAt - timings.startedAt,
      variantWorkers: workers,
    },
    strategyMeta: baseRequest.strategyMeta ?? null,
  };
}

function splitVariants(variants, workerCount) {
  const chunks = Array.from({ length: workerCount }, () => []);
  for (let index = 0; index < variants.length; index += 1) {
    chunks[index % workerCount].push({ ...variants[index], order: index });
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

function runVariantWorker({ workerIndex, request, sharedColumnSet, variants, onProgress }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL('./variantSweepWorker.js', import.meta.url), {
      workerData: { workerIndex, request, sharedColumnSet, variants },
    });
    worker.on('message', (msg) => {
      if (msg?.type === 'progress') {
        onProgress?.(msg);
        return;
      }
      if (msg?.type === 'done') {
        settled = true;
        resolve(msg.results || []);
        worker.terminate().catch(() => {});
        return;
      }
      if (msg?.type === 'error') {
        settled = true;
        reject(new Error(msg.error || 'variant worker failed'));
        worker.terminate().catch(() => {});
      }
    });
    worker.on('error', (err) => {
      if (!settled) reject(err);
    });
    worker.on('exit', (code) => {
      if (!settled && code !== 0) reject(new Error(`variant worker exited with code ${code}`));
    });
  });
}

export function parseSweepVariants(body, maxVariants = 500) {
  const raw = body?.variants;
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error('variants must be a non-empty array');
  }
  if (raw.length > maxVariants) {
    throw new Error(`At most ${maxVariants} variants per sweep`);
  }
  return raw.map((variant, index) => {
    if (variant == null || typeof variant !== 'object') {
      throw new Error(`variants[${index}] must be an object`);
    }
    return {
      id: variant.id ?? variant.name ?? String(index),
      params: variant.params && typeof variant.params === 'object' ? variant.params : {},
    };
  });
}

export { availabilityRequestForBacktest };
