import path from 'node:path';

import { readChartSidecarForEvent } from '../../backtest/chartSidecar.js';
import { queryChartTicks } from '../../query/duckdbQuery.js';
import { downsamplePoints } from '../../utils/downsample.js';

const CHART_MAX_POINTS = 400;

export function persistEventTraces(db, runId, result, { transaction = true } = {}) {
  if (transaction) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = persistEventTracesRows(db, runId, result);
      db.exec('COMMIT');
      return rows;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return persistEventTracesRows(db, runId, result);
}

const INSERT_TRACE_SQL = `
  INSERT INTO backtest_event_traces (
    run_id, condition_id, market_id, event_start, event_end, side,
    entries_count, exits_count, final_pnl, result, reason, ticks_count,
    summary_json, orders_json, marks_json, logs_json, metrics_json, chart_series_path
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export function appendEventTraceBatch(db, runId, result, { chartSeriesPath = null } = {}) {
  const rows = normalizeEventsFromResult(runId, result);
  if (!rows.length) return 0;
  const insert = db.prepare(INSERT_TRACE_SQL);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const seriesPath = row.chart_series_path ?? chartSeriesPath;
      insert.run(
        row.run_id,
        row.condition_id,
        row.market_id,
        row.event_start,
        row.event_end,
        row.side,
        row.entries_count,
        row.exits_count,
        row.final_pnl,
        row.result,
        row.reason,
        row.ticks_count,
        JSON.stringify(row.summary),
        JSON.stringify(row.orders),
        JSON.stringify(row.marks),
        JSON.stringify(row.logs),
        JSON.stringify(row.metrics),
        seriesPath,
      );
    }
    db.exec('COMMIT');
    return rows.length;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function persistEventTracesRows(db, runId, result) {
  db.prepare('DELETE FROM backtest_event_traces WHERE run_id = ?').run(runId);
  const rows = normalizeEventsFromResult(runId, result);
  const insert = db.prepare(INSERT_TRACE_SQL);
  for (const row of rows) {
    insert.run(
      row.run_id,
      row.condition_id,
      row.market_id,
      row.event_start,
      row.event_end,
      row.side,
      row.entries_count,
      row.exits_count,
      row.final_pnl,
      row.result,
      row.reason,
      row.ticks_count,
      JSON.stringify(row.summary),
      JSON.stringify(row.orders),
      JSON.stringify(row.marks),
      JSON.stringify(row.logs),
      JSON.stringify(row.metrics),
      row.chart_series_path ?? null,
    );
  }
  return listEventTraces(db, runId);
}

export function listEventTraces(db, runId, {
  result,
  reason,
  q,
  sort = 'default',
  limit = 100,
  offset = 0,
} = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 100, 1), 5000);
  const safeOffset = Math.max(Number.parseInt(String(offset), 10) || 0, 0);
  let sql = `SELECT
    id, run_id, condition_id, market_id, event_start, event_end, side,
    entries_count, exits_count, final_pnl, result, reason, ticks_count,
    summary_json, created_at
    FROM backtest_event_traces WHERE run_id = ?`;
  const params = [runId];
  if (result === 'all_with_entries') {
    sql += " AND result != 'no_entry'";
  } else if (result && result !== 'all') {
    sql += ' AND result = ?';
    params.push(String(result));
  }
  if (reason) {
    sql += ' AND reason = ?';
    params.push(String(reason));
  }
  if (q) {
    sql += ' AND condition_id LIKE ?';
    params.push(`%${String(q)}%`);
  }
  sql += ` ORDER BY ${orderClauseForSort(sort)} LIMIT ? OFFSET ?`;
  params.push(safeLimit, safeOffset);
  return db.prepare(sql).all(...params).map(toApiEventSummary);
}

function orderClauseForSort(sort) {
  switch (String(sort)) {
    case 'pnl_asc': return 'final_pnl ASC, event_start ASC';
    case 'pnl_desc': return 'final_pnl DESC, event_start ASC';
    case 'event_start': return 'event_start ASC';
    case 'event_start_desc': return 'event_start DESC';
    default:
      return `CASE WHEN entries_count > 0 OR result IN ('win', 'loss') THEN 0 ELSE 1 END ASC,
        ABS(final_pnl) DESC, event_start ASC`;
  }
}

export function getEventTrace(db, runId, eventTraceId, { stateDbPath = null } = {}) {
  const row = db.prepare('SELECT * FROM backtest_event_traces WHERE run_id = ? AND id = ?').get(runId, eventTraceId);
  if (!row) return null;
  const detail = toApiEventDetail(row);
  if (stateDbPath && row.chart_series_path) {
    const sidecar = readChartSidecarForEvent(row.chart_series_path, row.condition_id);
    if (sidecar?.series) {
      detail.series = sidecar.series;
      detail.series_meta = sidecar.meta;
    }
  }
  return detail;
}

export function getEventTraceByConditionId(db, runId, conditionId) {
  const row = db.prepare(`
    SELECT * FROM backtest_event_traces
    WHERE run_id = ? AND condition_id = ?
    ORDER BY event_start ASC
    LIMIT 1
  `).get(runId, conditionId);
  return row ? toApiEventDetail(row) : null;
}

export async function getChartData(db, config, run, conditionId) {
  const event = getEventTraceByConditionId(db, run.id, conditionId);
  if (!event) return null;

  if (config?.stateDbPath && event.chart_series_path) {
    const sidecar = readChartSidecarForEvent(event.chart_series_path, conditionId);
    if (sidecar?.series) {
      return {
        event: toApiEventSummaryFromDetail(event),
        series: sidecar.series,
        series_meta: sidecar.meta ?? { source: 'sidecar' },
        summary: event.summary,
        exits: event.summary?.exits ?? [],
        orders: event.orders,
        marks: event.marks,
        logs: event.logs,
        metrics: event.metrics,
      };
    }
  }

  const side = event.side || 'UP';
  const rows = await queryChartTicks(db, {
    underlying: run.underlying,
    interval: run.interval,
    bookDepth: run.bookDepth,
    chartSide: side,
    conditionId,
    from: event.event_start,
    to: event.event_end,
    limit: 20000,
    offset: 0,
    validBacktestRows: true,
  });
  const fullSeries = buildChartSeries(rows, side);
  const keepTs = collectMarkerTimestamps(event);
  const { series, meta } = downsampleChartSeries(fullSeries, keepTs);

  return {
    event: toApiEventSummaryFromDetail(event),
    series,
    series_meta: meta,
    summary: event.summary,
    exits: event.summary?.exits ?? [],
    orders: event.orders,
    marks: event.marks,
    logs: event.logs,
    metrics: event.metrics,
  };
}

function normalizeEventsFromResult(runId, result) {
  const events = Array.isArray(result?.events) ? result.events : [];
  const globalLog = Array.isArray(result?.log) ? result.log : [];
  return events.map((event) => {
    const eventStart = new Date(event.eventStart).toISOString();
    const eventEnd = new Date(event.eventEnd).toISOString();
    const closedAt = event.closedAt ? new Date(event.closedAt).toISOString() : eventEnd;
    const orders = Array.isArray(event.orders) ? event.orders : [];
    const exits = Array.isArray(event.exits) ? event.exits : [];
    const eventLogs = Array.isArray(event.logs) ? event.logs : [];
    const logs = eventLogs.length ? eventLogs : globalLog.filter((entry) => {
      const ts = new Date(entry.ts).getTime();
      return ts >= new Date(eventStart).getTime() && ts <= new Date(closedAt).getTime();
    });
    const summary = {
      eventId: event.eventId,
      positionType: event.positionType ?? null,
      entryTime: event.entryTime ?? null,
      entryDistanceToPtb: event.entryDistanceToPtb ?? null,
      entryTimeRemaining: event.entryTimeRemaining ?? null,
      quantity: event.quantity ?? 0,
      cost: event.cost ?? 0,
      avgEntryPrice: event.avgEntryPrice ?? null,
      expirationResult: event.expirationResult ?? null,
      winnerSide: event.winnerSide ?? null,
      expiryPnl: event.expiryPnl ?? 0,
      finalPnlBeforeFees: event.finalPnlBeforeFees ?? null,
      fees: event.fees ?? null,
      closedAt,
      exits: event.exits ?? [],
      profitOrders: event.profitOrders ?? [],
      reversals: event.reversals ?? [],
      diagnostics: event.diagnostics ?? null,
    };
    return {
      run_id: runId,
      condition_id: String(event.eventId),
      market_id: event.marketId ?? null,
      event_start: eventStart,
      event_end: eventEnd,
      side: event.positionType ?? null,
      entries_count: orders.filter((order) => !order?.type || order.type === 'entry').length,
      exits_count: exits.length,
      final_pnl: Number(event.finalPnl || 0),
      result: deriveEventResult(event),
      reason: event.reason ?? null,
      ticks_count: Number(event.ticksProcessed ?? event.ticksInEvent ?? 0) || logs.length,
      summary,
      orders,
      marks: Array.isArray(event.marks) ? event.marks : [],
      logs,
      metrics: buildEventMetrics(event),
      chart_series_path: event.chart_series_path ?? null,
    };
  });
}

function deriveEventResult(event) {
  if (event.reason === 'no_entry') return 'no_entry';
  const pnl = Number(event.finalPnl || 0);
  if (pnl > 0) return 'win';
  if (pnl < 0) return 'loss';
  return 'breakeven';
}

function buildEventMetrics(event) {
  if (event.metrics && typeof event.metrics === 'object') return event.metrics;
  const metrics = {};
  if (event.diagnostics) {
    for (const [key, value] of Object.entries(event.diagnostics)) {
      if (value != null) metrics[key] = [{ ts: event.entryTime || event.closedAt || event.eventEnd, value }];
    }
  }
  if (event.entryDiagnostics) {
    for (const [key, value] of Object.entries(event.entryDiagnostics)) {
      if (value != null) metrics[key] = [{ ts: event.entryTime || event.eventStart, value }];
    }
  }
  return metrics;
}

function buildChartSeries(rows, side) {
  const prefix = side === 'DOWN' ? 'down' : 'up';
  return {
    underlying: rows.map((row) => point(row.ts, row.underlying_price)),
    priceToBeat: rows.map((row) => point(row.ts, row.price_to_beat)),
    upPrice: rows.map((row) => point(row.ts, row.up_price)),
    downPrice: rows.map((row) => point(row.ts, row.down_price)),
    bid: rows.map((row) => point(row.ts, row[`${prefix}_best_bid`])),
    ask: rows.map((row) => point(row.ts, row[`${prefix}_best_ask`])),
  };
}

function collectMarkerTimestamps(event) {
  const stamps = [];
  for (const mark of event.marks || []) if (mark?.ts) stamps.push(mark.ts);
  for (const order of event.orders || []) if (order?.ts || order?.createdAt) stamps.push(order.ts || order.createdAt);
  for (const exit of event.summary?.exits || []) if (exit?.ts || exit?.time) stamps.push(exit.ts || exit.time);
  for (const order of event.summary?.profitOrders || []) if (order?.fillTime || order?.time) stamps.push(order.fillTime || order.time);
  for (const reversal of event.summary?.reversals || []) if (reversal?.time) stamps.push(reversal.time);
  return stamps;
}

function downsampleChartSeries(series, keepTs) {
  const base = series.underlying || [];
  const total = base.length;
  if (total <= CHART_MAX_POINTS) {
    return { series, meta: { total_points: total, displayed_points: total, downsampled: false } };
  }
  const picked = downsamplePoints(base, { maxPoints: CHART_MAX_POINTS, keepTs });
  const pickedTs = new Set(picked.map((p) => p.ts));
  const pick = (arr) => (arr || []).filter((p) => pickedTs.has(p.ts));
  return {
    series: {
      underlying: pick(series.underlying),
      priceToBeat: pick(series.priceToBeat),
      upPrice: pick(series.upPrice),
      downPrice: pick(series.downPrice),
      bid: pick(series.bid),
      ask: pick(series.ask),
    },
    meta: { total_points: total, displayed_points: picked.length, downsampled: true },
  };
}

function point(ts, value) {
  return { ts: new Date(ts).toISOString(), value: value == null ? null : Number(value) };
}

function toApiEventSummary(row) {
  const summary = JSON.parse(row.summary_json || '{}');
  return {
    id: Number(row.id),
    run_id: Number(row.run_id),
    condition_id: row.condition_id,
    market_id: row.market_id,
    event_start: row.event_start,
    event_end: row.event_end,
    side: row.side,
    entries_count: row.entries_count,
    exits_count: row.exits_count,
    final_pnl: row.final_pnl,
    result: row.result,
    reason: row.reason,
    reason_detail: summary?.diagnostics?.lastNoEntryReason ?? null,
    ticks_count: row.ticks_count,
    created_at: row.created_at,
  };
}

function toApiEventDetail(row) {
  return {
    id: Number(row.id),
    run_id: Number(row.run_id),
    condition_id: row.condition_id,
    market_id: row.market_id,
    event_start: row.event_start,
    event_end: row.event_end,
    side: row.side,
    entries_count: row.entries_count,
    exits_count: row.exits_count,
    final_pnl: row.final_pnl,
    result: row.result,
    reason: row.reason,
    ticks_count: row.ticks_count,
    summary: JSON.parse(row.summary_json),
    orders: JSON.parse(row.orders_json),
    marks: JSON.parse(row.marks_json),
    logs: JSON.parse(row.logs_json),
    metrics: JSON.parse(row.metrics_json),
    chart_series_path: row.chart_series_path,
    created_at: row.created_at,
  };
}

function toApiEventSummaryFromDetail(event) {
  const { summary, orders, marks, logs, metrics, ...rest } = event;
  return rest;
}
