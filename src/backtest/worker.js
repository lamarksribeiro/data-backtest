import { parentPort, workerData } from 'node:worker_threads';

import { runBacktest } from './engine.js';
import {
  appendChartSidecarLine,
  buildEventChartSeries,
  chartSidecarPath,
  ensureChartSidecarDir,
} from './chartSidecar.js';
import { openStateDatabase, closeStateDatabase } from '../state/sqlite.js';
import {
  completeBacktestRun,
  failBacktestRun,
} from '../state/backtestRuns.js';
import { appendEventTraceBatch } from '../backtestStudio/state/eventTraces.js';

const FLUSH_BATCH_EVENTS = 200;
const db = openStateDatabase(workerData.stateDbPath);
const runId = workerData.runId;
const sidecarFile = chartSidecarPath(workerData.stateDbPath, runId);
ensureChartSidecarDir(workerData.stateDbPath);

let pendingEvents = [];
let pendingResult = null;

function flushTraces() {
  if (!pendingEvents.length) return;
  const chunk = { events: pendingEvents };
  appendEventTraceBatch(db, runId, chunk);
  pendingEvents = [];
}

try {
  const request = {
    ...workerData.request,
    fastRun: Boolean(workerData.fastRun),
    onEventFinalized: workerData.fastRun
      ? null
      : (eventRecord, samples) => {
        const side = eventRecord.positionType || 'UP';
        const { series, meta } = buildEventChartSeries(samples, side);
        appendChartSidecarLine(sidecarFile, eventRecord.eventId, { series, meta });
        const row = normalizeEventForTrace(runId, eventRecord, sidecarFile);
        pendingEvents.push(row);
        if (pendingEvents.length >= FLUSH_BATCH_EVENTS) flushTraces();
      },
  };

  const result = await runBacktest(db, request, {
    onProgress: (progress) => parentPort?.postMessage({ type: 'progress', progress }),
  });

  flushTraces();
  pendingResult = result;

  const run = completeBacktestRun(db, workerData.runId, {
    request: workerData.request,
    result,
    strategyMeta: workerData.request.strategyMeta ?? null,
    startedAt: workerData.startedAt,
  });
  parentPort?.postMessage({ ok: true, runId: run.id });
} catch (err) {
  flushTraces();
  const traceCount = db.prepare('SELECT COUNT(*) AS c FROM backtest_event_traces WHERE run_id = ?').get(runId)?.c || 0;
  const isPartial = Boolean(err.partialResult?.ticks) || traceCount > 0;
  const failedResult = err.partialResult || {
    strategy: workerData.request.strategyLabel || workerData.request.strategy,
    source: 'lakehouse',
    underlying: workerData.request.underlying,
    interval: workerData.request.interval,
    bookDepth: workerData.request.bookDepth,
    from: new Date(workerData.request.from).toISOString(),
    to: new Date(workerData.request.to).toISOString(),
    ticks: 0,
    batches: 0,
    summary: { failed: true, error: err.message },
    events: [],
    equity: [],
    log: [],
  };
  failBacktestRun(db, workerData.runId, {
    request: workerData.request,
    result: failedResult,
    strategyMeta: workerData.request.strategyMeta ?? null,
    error: err.message,
    startedAt: workerData.startedAt,
    partial: isPartial,
  });
  parentPort?.postMessage({ ok: false, runId: workerData.runId, error: err.message });
} finally {
  closeStateDatabase(db);
}

function normalizeEventForTrace(runId, event, chartPath) {
  const eventStart = new Date(event.eventStart).toISOString();
  const eventEnd = new Date(event.eventEnd).toISOString();
  const orders = Array.isArray(event.orders) ? event.orders : [];
  const pnl = Number(event.finalPnl || 0);
  return {
    eventId: event.eventId,
    eventStart,
    eventEnd,
    marketId: event.marketId,
    positionType: event.positionType,
    orders,
    exits: event.exits || [],
    marks: event.marks || [],
    logs: event.logs || [],
    metrics: event.metrics || {},
    finalPnl: pnl,
    reason: event.reason,
    ticksProcessed: event.ticksProcessed,
    diagnostics: event.diagnostics,
    chart_series_path: chartPath,
    closedAt: event.closedAt,
    expirationResult: event.expirationResult,
    winnerSide: event.winnerSide,
    expiryPnl: event.expiryPnl,
    entryTime: event.entryTime,
    quantity: event.quantity,
    cost: event.cost,
    avgEntryPrice: event.avgEntryPrice,
  };
}
