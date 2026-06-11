import { DuckDbTickProvider } from './tickProvider.js';
import { applyPolymarketFeesToBacktestResult } from './fees.js';
import { createEdgeSniperBacktestRunner } from '../strategies/edgeSniperV2.js';
import { createGlsBacktestRunner } from '../backtestStudio/gls/runtime.js';
import { loadConfig } from '../config.js';
import { analyzeStrategyColumns, analyzeStrategyParallelism } from '../backtestStudio/gls/compiler.js';
import { runParallelEventSlices } from './eventPool.js';
import { datasetCacheKey, getDatasetCache } from './datasetCache.js';
import { createTickCursorView } from './columnStore.js';
import { loadBacktestColumnSet } from '../query/columnChunkReader.js';

const STRATEGIES = {
  'edge-sniper-v2': createEdgeSniperBacktestRunner,
  edgeSniperV2: createEdgeSniperBacktestRunner,
};

export function resolveBacktestDataset(request, columnAnalysis) {
  if (request.dataset) return request.dataset;
  if (columnAnalysis && !columnAnalysis.needsBookLevels) return 'backtest_ticks_lite';
  return 'backtest_ticks';
}

export function availabilityRequestForBacktest(request, columnAnalysis) {
  const dataset = resolveBacktestDataset(request, columnAnalysis);
  return {
    ...request,
    dataset,
    bookDepth: dataset === 'backtest_ticks_lite' ? null : request.bookDepth,
  };
}

export async function runBacktest(db, request, { onProgress } = {}) {
  const config = loadConfig();
  const useSoA = config.backtestEngine === 'soa';
  const createRunner = resolveRunnerFactory(request, config, useSoA);
  if (!createRunner) throw new Error(`Unsupported strategy: ${request.strategy}`);
  const timings = { startedAt: Date.now(), firstBatchAt: null, completedAt: null, duckdbReadMs: 0, processMs: 0, finishMs: 0 };

  const columnAnalysis = request.columnAnalysis
    ?? (request.glsAst ? analyzeStrategyColumns(request.glsAst, request.bookDepth ?? 25) : null);
  const dataset = resolveBacktestDataset(request, columnAnalysis);
  const effectiveBookDepth = columnAnalysis?.needsBookLevels
    ? (columnAnalysis.bookDepth || request.bookDepth)
    : request.bookDepth;

  const runner = createRunner(request.params ?? {}, {
    fastRun: Boolean(request.fastRun),
    onEventFinalized: request.onEventFinalized,
    chartSeriesWriter: request.chartSeriesWriter,
    bookDepth: effectiveBookDepth,
  });

  let ticks = 0;
  let batches = 0;
  const totalTicks = Number(request.estimatedTicks || 0) || null;
  const progressStartedAt = Date.now();
  const emitProgress = createProgressEmitter(onProgress, progressStartedAt);
  emitProgress({ phase: 'loading', ticks, batches, totalTicks, force: true });

  if (useSoA) {
    ({ ticks, batches } = await runSoAEngine(db, request, {
      runner,
      dataset,
      columnAnalysis,
      effectiveBookDepth,
      timings,
      emitProgress,
      totalTicks,
      config,
    }));
  } else {
    ({ ticks, batches } = await runRowsEngine(db, request, {
      runner,
      dataset,
      columnAnalysis,
      effectiveBookDepth,
      timings,
      emitProgress,
      totalTicks,
      config,
    }));
  }

  const finishStartedAt = Date.now();
  const result = runner.finish();
  applyPolymarketFeesToBacktestResult(result, request.feeOptions);
  timings.finishMs = Date.now() - finishStartedAt;
  timings.completedAt = Date.now();
  emitProgress({ phase: 'finalizing', ticks, batches, totalTicks, force: true });
  return {
    strategy: result.strategy,
    source: 'lakehouse',
    underlying: request.underlying,
    interval: request.interval,
    bookDepth: request.bookDepth,
    from: new Date(request.from).toISOString(),
    to: new Date(request.to).toISOString(),
    ticks,
    batches,
    summary: result.summary,
    events: result.events,
    equity: result.equity,
    log: result.log,
    timings: formatTimings(timings),
    strategyMeta: request.strategyMeta ?? null,
  };
}

async function runSoAEngine(db, request, ctx) {
  const cache = getDatasetCache(ctx.config.datasetCacheMaxMb);
  const cacheKey = datasetCacheKey({ ...request, dataset: ctx.dataset }, ctx.columnAnalysis?.scalarColumns?.join(','));
  let columnSet = cache.get(cacheKey);
  const useCompiledSoa = ctx.runner.executionMode === 'compiled-soa' && typeof ctx.runner.bindColumnSet === 'function';

  if (!columnSet) {
    const readStartedAt = Date.now();
    columnSet = await loadBacktestColumnSet(db, {
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
  }

  if (ctx.timings.firstBatchAt == null) ctx.timings.firstBatchAt = Date.now();
  const ticks = columnSet.length;
  const batches = 1;

  const processStartedAt = Date.now();
  const workerCount = Number(request.backtestWorkers ?? ctx.config.backtestWorkers ?? 1);
  const parallelism = request.glsAst ? analyzeStrategyParallelism(request.glsAst) : { parallelSafe: false };
  const canParallelize = useCompiledSoa
    && workerCount > 1
    && parallelism.parallelSafe
    && columnSet.events.length > 1
    && typeof ctx.runner.importParallelSlices === 'function';

  if (canParallelize) {
    const slices = await runParallelEventSlices({
      ast: request.glsAst,
      params: request.params ?? {},
      columnSet,
      workerCount,
      fastRun: Boolean(request.fastRun),
      bookDepth: ctx.effectiveBookDepth,
    });
    if (slices?.length) {
      ctx.runner.importParallelSlices(slices);
    } else {
      runSequentialSoA(ctx.runner, columnSet, useCompiledSoa);
    }
  } else if (useCompiledSoa) {
    ctx.runner.bindColumnSet(columnSet);
    runSequentialSoA(ctx.runner, columnSet, true);
  } else {
    runSequentialSoA(ctx.runner, columnSet, false);
  }
  ctx.timings.processMs += Date.now() - processStartedAt;
  ctx.emitProgress({ phase: 'processing', ticks, batches, totalTicks: ctx.totalTicks });

  return { ticks, batches };
}

export function runSequentialSoA(runner, columnSet, compiledSoa) {
  if (compiledSoa) {
    for (const ev of columnSet.events) {
      runner.beginEvent(ev);
      for (let i = ev.startRow; i < ev.endRow; i += 1) {
        runner.processIndex(i);
      }
      runner.endEvent(ev);
    }
    return;
  }
  const cursor = createTickCursorView(columnSet);
  for (let i = 0; i < columnSet.length; i += 1) {
    cursor.setIndex(i);
    runner.processTick(cursor);
  }
}

async function runRowsEngine(db, request, ctx) {
  const provider = new DuckDbTickProvider(db, {
    underlying: request.underlying,
    interval: request.interval,
    bookDepth: ctx.effectiveBookDepth,
    selectColumns: ctx.columnAnalysis?.scalarColumns,
    dataset: ctx.dataset,
  });

  let ticks = 0;
  let batches = 0;
  const asyncIter = provider.streamTicks({
    from: request.from,
    to: request.to,
    batchSize: request.batchSize,
    legacy: !request.glsAst,
    dataset: ctx.dataset,
  })[Symbol.asyncIterator]();

  let pending = asyncIter.next();
  while (true) {
    const readStartedAt = Date.now();
    const next = await pending;
    ctx.timings.duckdbReadMs += Date.now() - readStartedAt;
    if (next.done) break;
    pending = asyncIter.next();
    const batch = next.value;
    if (ctx.timings.firstBatchAt == null) ctx.timings.firstBatchAt = Date.now();
    batches += 1;
    ticks += batch.length;
    const processStartedAt = Date.now();
    for (const tick of batch) ctx.runner.processTick(tick);
    ctx.timings.processMs += Date.now() - processStartedAt;
    ctx.emitProgress({ phase: 'processing', ticks, batches, totalTicks: ctx.totalTicks });
  }

  return { ticks, batches };
}

const PROGRESS_MIN_MS = 1500;

function createProgressEmitter(onProgress, startedAt) {
  let lastEmitAt = 0;
  return ({ phase, ticks, batches, totalTicks, force = false }) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmitAt < PROGRESS_MIN_MS) return;
    lastEmitAt = now;
    onProgress(buildProgress({ phase, ticks, batches, totalTicks, startedAt }));
  };
}

function buildProgress({ phase, ticks, batches, totalTicks, startedAt }) {
  const elapsedMs = Math.max(Date.now() - startedAt, 1);
  const percent = totalTicks ? Math.min(99, Math.max(0, (ticks / totalTicks) * 100)) : null;
  const rate = ticks > 0 ? ticks / elapsedMs : 0;
  const remainingTicks = totalTicks ? Math.max(totalTicks - ticks, 0) : null;
  return {
    phase,
    ticks,
    batches,
    total_ticks: totalTicks,
    percent,
    elapsed_ms: elapsedMs,
    eta_ms: rate > 0 && remainingTicks != null ? remainingTicks / rate : null,
    updated_at: new Date().toISOString(),
  };
}

function formatTimings(timings) {
  const end = timings.completedAt ?? Date.now();
  const totalMs = end - timings.startedAt;
  const duckdbReadMs = Math.max(0, Number(timings.duckdbReadMs || 0));
  const processMs = Math.max(0, Number(timings.processMs || 0));
  const finishMs = Math.max(0, Number(timings.finishMs || 0));
  return {
    loadMs: timings.firstBatchAt == null ? null : timings.firstBatchAt - timings.startedAt,
    duckdbReadMs,
    processMs: timings.firstBatchAt == null ? null : processMs,
    finishMs,
    overheadMs: Math.max(0, totalMs - duckdbReadMs - processMs - finishMs),
    totalMs,
  };
}

function resolveRunnerFactory(request, config, useSoA) {
  if (request.glsAst) {
    const executionMode = request.glsExecution
      ?? (useSoA ? 'compiled-soa' : config.glsExecution);
    return (params, options) => createGlsBacktestRunner(request.glsAst, params, {
      ...options,
      executionMode,
    });
  }
  return STRATEGIES[request.strategy];
}

export function listStrategies() {
  return Object.keys(STRATEGIES);
}
