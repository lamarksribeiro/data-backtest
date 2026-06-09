import { DuckDbTickProvider } from './tickProvider.js';
import { applyPolymarketFeesToBacktestResult } from './fees.js';
import { createEdgeSniperBacktestRunner } from '../strategies/edgeSniperV2.js';
import { createGlsBacktestRunner } from '../backtestStudio/gls/runtime.js';

const STRATEGIES = {
  'edge-sniper-v2': createEdgeSniperBacktestRunner,
  edgeSniperV2: createEdgeSniperBacktestRunner,
};

export async function runBacktest(db, request, { onProgress } = {}) {
  const createRunner = resolveRunnerFactory(request);
  if (!createRunner) throw new Error(`Unsupported strategy: ${request.strategy}`);
  const timings = { startedAt: Date.now(), firstBatchAt: null, completedAt: null, duckdbReadMs: 0, processMs: 0, finishMs: 0 };

  const provider = new DuckDbTickProvider(db, {
    underlying: request.underlying,
    interval: request.interval,
    bookDepth: request.bookDepth,
  });
  const runner = createRunner(request.params ?? {});
  let ticks = 0;
  let batches = 0;
  const totalTicks = Number(request.estimatedTicks || 0) || null;
  const progressStartedAt = Date.now();
  const emitProgress = createProgressEmitter(onProgress, progressStartedAt);
  emitProgress({ phase: 'loading', ticks, batches, totalTicks, force: true });

  const YIELD_EVERY_TICKS = 2000;
  let iterator = null;
  try {
    iterator = provider.streamTicks({
      from: request.from,
      to: request.to,
      batchSize: request.batchSize,
      legacy: !request.glsAst,
    })[Symbol.asyncIterator]();
    while (true) {
      const readStartedAt = Date.now();
      const next = await iterator.next();
      timings.duckdbReadMs += Date.now() - readStartedAt;
      if (next.done) break;
      const batch = next.value;
      if (timings.firstBatchAt == null) timings.firstBatchAt = Date.now();
      batches += 1;
      ticks += batch.length;
      const processStartedAt = Date.now();
      let ticksInSlice = 0;
      for (const tick of batch) {
        runner.processTick(tick);
        ticksInSlice += 1;
        if (ticksInSlice >= YIELD_EVERY_TICKS) {
          ticksInSlice = 0;
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      timings.processMs += Date.now() - processStartedAt;
      emitProgress({ phase: 'processing', ticks, batches, totalTicks });
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
    return (params) => createGlsBacktestRunner(request.glsAst, params);
  }
  return STRATEGIES[request.strategy];
}

export function listStrategies() {
  return Object.keys(STRATEGIES);
}
