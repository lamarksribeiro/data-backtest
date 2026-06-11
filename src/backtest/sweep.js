import { applyPolymarketFeesToBacktestResult } from './fees.js';
import { loadConfig } from '../config.js';
import { analyzeStrategyColumns, analyzeStrategyParallelism } from '../backtestStudio/gls/compiler.js';
import { createGlsBacktestRunner } from '../backtestStudio/gls/runtime.js';
import { datasetCacheKey, getDatasetCache } from './datasetCache.js';
import { loadBacktestColumnSet } from '../query/columnChunkReader.js';
import { runParallelEventSlices } from './eventPool.js';
import {
  availabilityRequestForBacktest,
  resolveBacktestDataset,
  runSequentialSoA,
} from './engine.js';

/**
 * F5 — sweep multi-variante: 1× leitura ColumnSet, N× fast-run compiled-soa.
 */
export async function runBacktestSweep(db, baseRequest, variants, { onProgress, maxVariants } = {}) {
  if (!baseRequest?.glsAst) throw new Error('Sweep requires a GLS strategy (glsAst)');
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

  const columnAnalysis = baseRequest.columnAnalysis
    ?? analyzeStrategyColumns(baseRequest.glsAst, baseRequest.bookDepth ?? 25);
  const dataset = resolveBacktestDataset(baseRequest, columnAnalysis);
  const effectiveBookDepth = columnAnalysis?.needsBookLevels
    ? (columnAnalysis.bookDepth || baseRequest.bookDepth)
    : baseRequest.bookDepth;

  const timings = { startedAt: Date.now(), duckdbReadMs: 0, processMs: 0, completedAt: null };
  const columnSet = await loadOrGetColumnSet(db, baseRequest, {
    dataset,
    columnAnalysis,
    effectiveBookDepth,
    config,
    timings,
  });

  const parallelism = analyzeStrategyParallelism(baseRequest.glsAst);
  const workerCount = Number(baseRequest.backtestWorkers ?? config.backtestWorkers ?? 1);
  const canParallelize = parallelism.parallelSafe
    && workerCount > 1
    && columnSet.events.length > 1;

  const executionMode = baseRequest.glsExecution ?? 'compiled-soa';
  const variantResults = [];
  const processStartedAt = Date.now();

  for (let index = 0; index < normalized.length; index += 1) {
    const variant = normalized[index];
    const variantStartedAt = Date.now();
    const params = { ...(baseRequest.params ?? {}), ...variant.params };
    const runner = createGlsBacktestRunner(baseRequest.glsAst, params, {
      executionMode,
      fastRun: true,
      bookDepth: effectiveBookDepth,
    });

    if (canParallelize) {
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
        runSequentialSoA(runner, columnSet, true);
      }
    } else {
      runner.bindColumnSet(columnSet);
      runSequentialSoA(runner, columnSet, true);
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
  const cache = getDatasetCache(ctx.config.datasetCacheMaxMb);
  const cacheKey = datasetCacheKey(
    { ...request, dataset: ctx.dataset },
    ctx.columnAnalysis?.scalarColumns?.join(','),
  );
  const cached = cache.get(cacheKey);
  if (cached) return cached;

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
  return columnSet;
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
