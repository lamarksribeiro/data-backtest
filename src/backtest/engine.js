import { DuckDbTickProvider } from './tickProvider.js';
import { applyPolymarketFeesToBacktestResult } from './fees.js';
import { createEdgeSniperBacktestRunner } from '../strategies/edgeSniperV2.js';
import { createGlsBacktestRunner } from '../backtestStudio/gls/runtime.js';
import { loadConfig } from '../config.js';
import { analyzeStrategyColumns } from '../backtestStudio/gls/compiler.js';
import { datasetCacheKey, getDatasetCache } from './datasetCache.js';

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
  const createRunner = resolveRunnerFactory(request);
  if (!createRunner) throw new Error(`Unsupported strategy: ${request.strategy}`);
  const timings = { startedAt: Date.now(), firstBatchAt: null, completedAt: null, duckdbReadMs: 0, processMs: 0, finishMs: 0 };

  const columnAnalysis = request.columnAnalysis
    ?? (request.glsAst ? analyzeStrategyColumns(request.glsAst, request.bookDepth ?? 25) : null);
  const dataset = resolveBacktestDataset(request, columnAnalysis);
  const effectiveBookDepth = columnAnalysis?.needsBookLevels
    ? (columnAnalysis.bookDepth || request.bookDepth)
    : request.bookDepth;

  const provider = new DuckDbTickProvider(db, {
    underlying: request.underlying,
    interval: request.interval,
    bookDepth: effectiveBookDepth,
    selectColumns: columnAnalysis?.scalarColumns,
    dataset,
  });
  const runner = createRunner(request.params ?? {}, {
    fastRun: Boolean(request.fastRun),
    onEventFinalized: request.onEventFinalized,
    chartSeriesWriter: request.chartSeriesWriter,
  });
  let ticks = 0;
  let batches = 0;
  const totalTicks = Number(request.estimatedTicks || 0) || null;
  const progressStartedAt = Date.now();
  const emitProgress = createProgressEmitter(onProgress, progressStartedAt);
  emitProgress({ phase: 'loading', ticks, batches, totalTicks, force: true });

  const cache = getDatasetCache(loadConfig().datasetCacheMaxMb);
  const cacheKey = datasetCacheKey({ ...request, dataset }, columnAnalysis?.scalarColumns?.join(','));
  const cachedBatches = cache.get(cacheKey);
  const capturedBatches = cachedBatches ? null : [];

  let iterator = null;
  try {
    if (cachedBatches) {
      for (const batch of cachedBatches) {
        if (timings.firstBatchAt == null) timings.firstBatchAt = Date.now();
        batches += 1;
        ticks += batch.length;
        const processStartedAt = Date.now();
        for (const tick of batch) runner.processTick(tick);
        timings.processMs += Date.now() - processStartedAt;
        emitProgress({ phase: 'processing', ticks, batches, totalTicks });
      }
    } else {
      const asyncIter = provider.streamTicks({
        from: request.from,
        to: request.to,
        batchSize: request.batchSize,
        legacy: !request.glsAst,
        dataset,
      })[Symbol.asyncIterator]();
      let pending = asyncIter.next();
      while (true) {
        const readStartedAt = Date.now();
        const next = await pending;
        timings.duckdbReadMs += Date.now() - readStartedAt;
        if (next.done) break;
        pending = asyncIter.next();
        const batch = next.value;
        if (capturedBatches) capturedBatches.push(batch);
        if (timings.firstBatchAt == null) timings.firstBatchAt = Date.now();
        batches += 1;
        ticks += batch.length;
        const processStartedAt = Date.now();
        for (const tick of batch) runner.processTick(tick);
        timings.processMs += Date.now() - processStartedAt;
        emitProgress({ phase: 'processing', ticks, batches, totalTicks });
      }
      if (capturedBatches?.length) cache.set(cacheKey, capturedBatches);
    }
  } catch (err) {
    await iterator?.return?.();
    timings.completedAt = Date.now();
    err.partialResult = buildPartialResult({ request, ticks, batches, timings, error: err.message });
    throw err;
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

function buildPartialResult({ request, ticks, batches, timings, error }) {
  return {
    strategy: request.strategyLabel || request.strategy,
    source: 'lakehouse',
    underlying: request.underlying,
    interval: request.interval,
    bookDepth: request.bookDepth,
    from: new Date(request.from).toISOString(),
    to: new Date(request.to).toISOString(),
    ticks,
    batches,
    summary: { failed: true, error, ticksProcessed: ticks, batches, timings: formatTimings(timings) },
    events: [],
    equity: [],
    log: [],
    timings: formatTimings(timings),
    strategyMeta: request.strategyMeta ?? null,
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

function resolveRunnerFactory(request) {
  if (request.glsAst) {
    return (params, options) => createGlsBacktestRunner(request.glsAst, params, {
      ...options,
      executionMode: request.glsExecution,
    });
  }
  return STRATEGIES[request.strategy];
}

export function listStrategies() {
  return Object.keys(STRATEGIES);
}
