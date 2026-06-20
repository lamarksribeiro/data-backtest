import { performance } from 'node:perf_hooks';

import { loadConfig } from '../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { runBacktest } from '../src/backtest/engine.js';
import { checkDatasetAvailability } from '../src/query/availability.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';

const config = loadConfig();
const bookDepth = config.backtestBookDepth;
const db = openStateDatabase(config.stateDbPath);

const row = db.prepare(`
  SELECT dt FROM lake_manifest
  WHERE dataset = 'backtest_ticks' AND underlying = 'BTC' AND interval = '5m'
    AND book_depth = ? AND status IN ('valid', 'accepted')
  ORDER BY dt DESC LIMIT 1
`).get(bookDepth);
if (!row?.dt) {
  console.log(JSON.stringify({ ok: false, error: 'no lake partition' }));
  closeStateDatabase(db);
  process.exit(1);
}
const from = `${row.dt}T00:00:00.000Z`;
const toDate = new Date(from);
toDate.setUTCDate(toDate.getUTCDate() + 1);
const to = toDate.toISOString();

const version = db.prepare(`
  SELECT sv.*, sd.slug
  FROM strategy_versions sv
  JOIN strategy_definitions sd ON sd.id = sv.strategy_id
  WHERE sd.slug = 'gamma-ladder-v1-gls' AND sv.language = 'strategy-js-v1'
  ORDER BY sv.version ASC
  LIMIT 1
`).get();
if (!version) {
  console.log(JSON.stringify({ ok: false, error: 'gamma-ladder-v1-gls Strategy JS version not found' }));
  closeStateDatabase(db);
  process.exit(1);
}

const availability = checkDatasetAvailability(db, {
  dataset: 'backtest_ticks',
  from,
  to,
  underlying: 'BTC',
  interval: '5m',
  bookDepth,
});
if (!availability.ok) {
  console.log(JSON.stringify({ ok: false, error: 'Dataset not ready', availability }));
  closeStateDatabase(db);
  process.exit(1);
}

const resolved = resolveVersionForBacktest(version, { bookDepth, db });
const started = performance.now();
const result = await runBacktest(db, {
  from,
  to,
  underlying: 'BTC',
  interval: '5m',
  bookDepth,
  batchSize: 25000,
  fastRun: true,
  glsAst: resolved.glsAst,
  columnAnalysis: resolved.columnAnalysis,
  embeddedRunner: resolved.embeddedRunner,
  embeddedModels: resolved.embeddedModels,
  strategySourceCode: resolved.strategySourceCode,
  db,
  strategyMeta: resolved.strategyMeta,
  params: {},
});

console.log(JSON.stringify({
  ok: true,
  slug: version.slug,
  version: version.version,
  source_bytes: version.source_code.length,
  execution_kind: resolved.strategyMeta.execution_kind,
  editable_logic: resolved.strategyMeta.editable_logic,
  window: { from, to },
  totalMs: Math.round(performance.now() - started),
  processMs: result.timings?.processMs ?? result.summary?.timings?.processMs,
  ticks: result.ticks,
  trades: result.summary?.totalEntries,
  pnl: result.summary?.totalPnl,
}, null, 2));
closeStateDatabase(db);