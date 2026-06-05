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

  const provider = new DuckDbTickProvider(db, {
    underlying: request.underlying,
    interval: request.interval,
    bookDepth: request.bookDepth,
  });
  const runner = createRunner(request.params ?? {});
  let ticks = 0;
  let batches = 0;

  for await (const batch of provider.streamTicks({
    from: request.from,
    to: request.to,
    batchSize: request.batchSize,
  })) {
    batches += 1;
    ticks += batch.length;
    for (const tick of batch) runner.processTick(tick);
  }

  const result = runner.finish();
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
    strategyMeta: request.strategyMeta ?? null,
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
