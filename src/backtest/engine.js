import { DuckDbTickProvider } from './tickProvider.js';
import { createEdgeSniperBacktestRunner } from '../strategies/edgeSniperV2.js';
import { createGlsBacktestRunner } from '../backtestStudio/gls/runtime.js';

const STRATEGIES = {
  'edge-sniper-v2': createEdgeSniperBacktestRunner,
  edgeSniperV2: createEdgeSniperBacktestRunner,
};

export async function runBacktest(db, request, { onProgress } = {}) {
  const createRunner = resolveRunnerFactory(request);
  if (!createRunner) throw new Error(`Unsupported strategy: ${request.strategy}`);
  const timings = { startedAt: Date.now(), firstBatchAt: null, completedAt: null };

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
  onProgress?.(buildProgress({ phase: 'loading', ticks, batches, totalTicks, startedAt: progressStartedAt }));

  try {
    for await (const batch of provider.streamTicks({
      from: request.from,
      to: request.to,
      batchSize: request.batchSize,
      legacy: !request.glsAst,
    })) {
      if (timings.firstBatchAt == null) timings.firstBatchAt = Date.now();
      batches += 1;
      ticks += batch.length;
      for (const tick of batch) runner.processTick(tick);
      onProgress?.(buildProgress({ phase: 'processing', ticks, batches, totalTicks, startedAt: progressStartedAt }));
    }
  } catch (err) {
    timings.completedAt = Date.now();
    err.partialResult = buildPartialResult({ request, ticks, batches, timings, error: err.message });
    throw err;
  }

  const result = runner.finish();
  timings.completedAt = Date.now();
  onProgress?.(buildProgress({ phase: 'finalizing', ticks, batches, totalTicks, startedAt: progressStartedAt }));
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
  return {
    loadMs: timings.firstBatchAt == null ? null : timings.firstBatchAt - timings.startedAt,
    processMs: timings.firstBatchAt == null ? null : end - timings.firstBatchAt,
    totalMs: end - timings.startedAt,
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
