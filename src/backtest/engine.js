import { DuckDbTickProvider } from './tickProvider.js';
import { applyPolymarketFeesToBacktestResult } from './fees.js';
import { loadConfig } from '../config.js';
import { analyzeStrategyParallelism } from '../backtestStudio/gls/compiler.js';
import { runParallelEventSlices } from './eventPool.js';
import { datasetCacheKey, getDatasetCache } from './datasetCache.js';
import { createTickCursorView } from './columnStore.js';
import { loadBacktestColumnSet } from '../query/columnChunkReader.js';
import { loadStrategy } from './strategyLoader.js';

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

export async function runBacktest(db, request, { onProgress, progressStartedAt: progressStartedAtInput } = {}) {
  const config = loadConfig();
  const useSoA = config.backtestEngine === 'soa';
  const strategyDetails = await loadStrategy(request, config);
  const timings = { startedAt: Date.now(), firstBatchAt: null, completedAt: null, duckdbReadMs: 0, processMs: 0, finishMs: 0 };

  const glsAst = request.glsAst ?? strategyDetails.glsAst ?? null;
  const columnAnalysis = request.columnAnalysis ?? strategyDetails.columnAnalysis;
  const dataset = resolveBacktestDataset(request, columnAnalysis);
  const effectiveBookDepth = columnAnalysis?.needsBookLevels
    ? (columnAnalysis.bookDepth || request.bookDepth || 25)
    : request.bookDepth;

  const runner = strategyDetails.createRunner(request.params ?? {}, {
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
      glsAst,
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
      glsAst,
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
  const cache = ctx.config.datasetDiskCacheEnabled
    ? { get: () => null, set: () => {} }
    : getDatasetCache(ctx.config.datasetCacheMaxMb);
  const cacheKey = datasetCacheKey({ ...request, dataset: ctx.dataset }, ctx.columnAnalysis?.scalarColumns?.join(','));
  let columnSet = cache.get(cacheKey);
  const useCompiledSoa = ctx.runner.executionMode === 'compiled-soa' && typeof ctx.runner.bindColumnSet === 'function';

  const releaseColumnSet = () => {
    columnSet = null;
  };

  ctx.emitProgress({
    phase: 'loading',
    ticks: 0,
    batches: 0,
    totalTicks: ctx.totalTicks,
    force: true,
  });

  if (!columnSet) {
    const readStartedAt = Date.now();
    const estimatedLoad = ctx.totalTicks || 0;
    let loadedRows = 0;
    const heartbeat = setInterval(() => {
      ctx.emitProgress({
        phase: 'loading',
        ticks: 0,
        loadedTicks: loadedRows,
        batches: 0,
        totalTicks: estimatedLoad || null,
        force: true,
      });
    }, 1000);

    try {
      columnSet = await loadBacktestColumnSet(db, {
        from: request.from,
        to: request.to,
        underlying: request.underlying,
        interval: request.interval,
        bookDepth: ctx.effectiveBookDepth,
        selectColumns: ctx.columnAnalysis?.scalarColumns,
        dataset: ctx.dataset,
        validBacktestRows: true,
      }, {
        onProgress: ({ loadedRows: nextLoaded, loadingStep }) => {
          loadedRows = nextLoaded;
          ctx.emitProgress({
            phase: 'loading',
            ticks: 0,
            loadedTicks: loadedRows,
            batches: 0,
            totalTicks: estimatedLoad || loadedRows || null,
            loadingStep,
          });
        },
      });
    } finally {
      clearInterval(heartbeat);
    }
    ctx.timings.duckdbReadMs += Date.now() - readStartedAt;
    cache.set(cacheKey, columnSet);
  } else {
    ctx.emitProgress({
      phase: 'loading',
      ticks: 0,
      loadedTicks: columnSet.length,
      batches: 0,
      totalTicks: columnSet.length,
      force: true,
    });
  }

  if (ctx.timings.firstBatchAt == null) ctx.timings.firstBatchAt = Date.now();
  const ticks = columnSet.length;
  const batches = 1;
  ctx.totalTicks = ticks;

  ctx.emitProgress({
    phase: 'loading',
    ticks: 0,
    loadedTicks: ticks,
    batches: 1,
    totalTicks: ticks,
    force: true,
  });
  ctx.emitProgress({
    phase: 'processing',
    ticks: 0,
    batches: 1,
    totalTicks: ticks,
    force: true,
  });

  const processStartedAt = Date.now();
  const workerCount = Number(request.backtestWorkers ?? ctx.config.backtestWorkers ?? 1);
  const parallelism = ctx.glsAst ? analyzeStrategyParallelism(ctx.glsAst) : { parallelSafe: false };
  const canParallelize = useCompiledSoa
    && workerCount > 1
    && parallelism.parallelSafe
    && columnSet.events.length > 1
    && typeof ctx.runner.importParallelSlices === 'function';

  let processingTicks = 0;
  const processingHeartbeat = setInterval(() => {
    ctx.emitProgress({
      phase: 'processing',
      ticks: processingTicks,
      batches: 1,
      totalTicks: ticks,
      force: true,
    });
  }, 1000);

  try {
    if (canParallelize) {
      ctx.emitProgress({ phase: 'processing', ticks: 0, batches: 1, totalTicks: ticks, force: true });
      const slices = await runParallelEventSlices({
        ast: ctx.glsAst,
        params: request.params ?? {},
        columnSet,
        workerCount,
        fastRun: Boolean(request.fastRun),
        bookDepth: ctx.effectiveBookDepth,
      });
      if (slices?.length) {
        ctx.runner.importParallelSlices(slices);
        processingTicks = ticks;
        ctx.emitProgress({ phase: 'processing', ticks: ticks, batches: 1, totalTicks: ticks, force: true });
      } else {
        await runSequentialSoA(ctx.runner, columnSet, useCompiledSoa, (processed) => {
          processingTicks = processed;
          ctx.emitProgress({ phase: 'processing', ticks: processed, batches: 1, totalTicks: ticks });
        });
      }
    } else if (useCompiledSoa) {
      ctx.runner.bindColumnSet(columnSet);
      await runSequentialSoA(ctx.runner, columnSet, true, (processed) => {
        processingTicks = processed;
        ctx.emitProgress({ phase: 'processing', ticks: processed, batches: 1, totalTicks: ticks });
      });
    } else {
      await runSequentialSoA(ctx.runner, columnSet, false, (processed) => {
        processingTicks = processed;
        ctx.emitProgress({ phase: 'processing', ticks: processed, batches: 1, totalTicks: ticks });
      });
    }
  } finally {
    clearInterval(processingHeartbeat);
    releaseColumnSet();
  }
  ctx.timings.processMs += Date.now() - processStartedAt;
  ctx.emitProgress({ phase: 'processing', ticks, batches, totalTicks: ticks, force: true });

  return { ticks, batches };
}

const PROCESS_YIELD_EVERY = 512;

export async function runSequentialSoA(runner, columnSet, compiledSoa, onProgress = null) {
  const total = columnSet.length;
  let lastEmitAt = 0;

  const emitProgress = (processed) => {
    if (!onProgress || total <= 0) return;
    const now = Date.now();
    if (processed < total && now - lastEmitAt < 350) return;
    lastEmitAt = now;
    onProgress(processed);
  };

  const yieldIfNeeded = async (index) => {
    if (index > 0 && index % PROCESS_YIELD_EVERY === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  if (compiledSoa) {
    for (const ev of columnSet.events) {
      runner.beginEvent(ev);
      for (let i = ev.startRow; i < ev.endRow; i += 1) {
        runner.processIndex(i);
        emitProgress(i + 1);
        await yieldIfNeeded(i - ev.startRow);
      }
      runner.endEvent(ev);
    }
    emitProgress(total);
    return;
  }
  const cursor = createTickCursorView(columnSet);
  for (let i = 0; i < columnSet.length; i += 1) {
    cursor.setIndex(i);
    runner.processTick(cursor);
    emitProgress(i + 1);
    await yieldIfNeeded(i);
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
    legacy: !ctx.glsAst,
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

const PROGRESS_MIN_MS = 400;
const LOADING_PHASE_WEIGHT = 0.12;
const PROCESSING_PHASE_WEIGHT = 0.87;

function createProgressEmitter(onProgress, startedAt) {
  let lastEmitAt = 0;
  let processingStartedAt = null;
  let lastPercent = 0;
  return ({ phase, ticks, loadedTicks, batches, totalTicks, loadingStep, force = false }) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmitAt < PROGRESS_MIN_MS) return;
    lastEmitAt = now;
    if (phase === 'processing' && processingStartedAt == null) processingStartedAt = now;
    const progress = buildProgress({
      phase, ticks, loadedTicks, batches, totalTicks, loadingStep, startedAt, processingStartedAt,
    });
    if (progress.percent != null) {
      progress.percent = Math.max(lastPercent, progress.percent);
      lastPercent = progress.percent;
    }
    onProgress(progress);
  };
}

export function buildProgress({
  phase, ticks, loadedTicks = null, batches, totalTicks, loadingStep = null, startedAt, processingStartedAt = null,
}) {
  const elapsedMs = Math.max(Date.now() - startedAt, 1);
  const safeTotal = totalTicks > 0 ? totalTicks : null;
  const safeTicks = Math.max(Number(ticks) || 0, 0);
  const safeLoadedTicks = Math.max(Number(loadedTicks) || 0, 0);
  let percent = null;

  if (phase === 'loading') {
    const loadingCap = LOADING_PHASE_WEIGHT * 100;
    const loadingFloor = loadingCap * 0.04;
    if (loadingStep === 'merge') {
      percent = loadingCap * 0.95;
    } else if (safeTotal && safeLoadedTicks > 0) {
      const loadRatio = Math.min(1, safeLoadedTicks / safeTotal);
      percent = Math.max(loadingFloor, loadRatio * loadingCap);
    } else {
      percent = loadingFloor;
    }
  } else if (phase === 'processing' && safeTotal) {
    const processRatio = Math.min(1, safeTicks / safeTotal);
    percent = (LOADING_PHASE_WEIGHT + processRatio * PROCESSING_PHASE_WEIGHT) * 100;
  } else if (phase === 'finalizing') {
    percent = 99;
  } else if (safeTotal) {
    percent = Math.min(99, (safeTicks / safeTotal) * 100);
  }

  const effectiveProcessingStartedAt = processingStartedAt ?? (phase === 'processing' ? startedAt : null);
  const processingElapsedMs = effectiveProcessingStartedAt ? Math.max(Date.now() - effectiveProcessingStartedAt, 1) : null;
  const processingTicks = phase === 'processing' ? safeTicks : 0;
  const rate = processingTicks > 0 && processingElapsedMs ? processingTicks / processingElapsedMs : 0;
  const remainingTicks = phase === 'processing' && safeTotal
    ? Math.max(safeTotal - safeTicks, 0)
    : null;
  const processEtaMs = rate > 0 && remainingTicks != null
    ? (remainingTicks / rate)
    : null;

  return {
    phase,
    ticks: safeTicks,
    loaded_ticks: safeLoadedTicks || null,
    loading_step: loadingStep || null,
    batches,
    total_ticks: safeTotal,
    percent: percent != null ? Math.min(99, Math.max(0, percent)) : null,
    elapsed_ms: elapsedMs,
    processing_elapsed_ms: processingElapsedMs,
    eta_ms: processEtaMs,
    started_at: new Date(startedAt).toISOString(),
    processing_started_at: effectiveProcessingStartedAt ? new Date(effectiveProcessingStartedAt).toISOString() : null,
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
    runStartedAt: timings.startedAt,
  };
}

export function listStrategies() {
  return [];
}
