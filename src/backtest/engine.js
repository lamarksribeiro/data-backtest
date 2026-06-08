import { DuckDbTickProvider } from './tickProvider.js';
import { createEdgeSniperBacktestRunner } from '../strategies/edgeSniperV2.js';
import { createGlsBacktestRunner } from '../backtestStudio/gls/runtime.js';

const STRATEGIES = {
  'edge-sniper-v2': createEdgeSniperBacktestRunner,
  edgeSniperV2: createEdgeSniperBacktestRunner,
};

export async function runBacktest(db, request) {
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

  try {
    for await (const batch of provider.streamTicks({
      from: request.from,
      to: request.to,
      batchSize: request.batchSize,
    })) {
      if (timings.firstBatchAt == null) timings.firstBatchAt = Date.now();
      batches += 1;
      ticks += batch.length;
      for (const tick of batch) runner.processTick(tick);
    }
  } catch (err) {
    timings.completedAt = Date.now();
    err.partialResult = buildPartialResult({ request, ticks, batches, timings, error: err.message });
    throw err;
  }

  const result = runner.finish();
  timings.completedAt = Date.now();
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
