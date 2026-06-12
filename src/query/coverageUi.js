import { checkDatasetAvailability, partitionDatesForRange } from './availability.js';
import { datasetRequestFromParams, inclusiveDateRangeFromRequest } from './request.js';

/** Mapeamento 9 estados do manifest → 3 estados na UI (função pura). */

export const UI_READY = new Set(['valid', 'accepted']);
export const UI_PROCESSING = new Set(['pending', 'writing', 'rebuilding']);
export const UI_ATTENTION = new Set(['missing', 'invalid', 'needs_review', 'stale']);

export const UI_STATE_LABELS = {
  ready: 'Pronto',
  processing: 'Processando',
  attention: 'Atenção',
};

export function mapStatusToUiState(status, { activeJob = false } = {}) {
  if (activeJob || UI_PROCESSING.has(status)) return 'processing';
  if (UI_READY.has(status)) return 'ready';
  return 'attention';
}

export function uiStateTone(state) {
  if (state === 'ready') return 'ok';
  if (state === 'processing') return 'warn';
  return 'err';
}

export function getDataCoverage(db, params, config) {
  const request = datasetRequestFromParams(params, config);

  // Find min and max dt in lake_manifest for this specific config
  const dbParams = [request.dataset, request.underlying, request.interval];
  let boundsSql = `
    SELECT MIN(dt) AS min_dt, MAX(dt) AS max_dt 
    FROM lake_manifest
    WHERE dataset = ? 
      AND underlying = ? 
      AND interval = ?`;

  if (request.resolution) {
    dbParams.push(request.resolution);
    boundsSql += ` AND resolution = ?`;
  } else {
    boundsSql += ` AND resolution IS NULL`;
  }

  if (request.bookDepth != null) {
    dbParams.push(request.bookDepth);
    boundsSql += ` AND book_depth = ?`;
  } else {
    boundsSql += ` AND book_depth IS NULL`;
  }

  const bounds = db.prepare(boundsSql).get(...dbParams);

  const reqFromDt = request.from.slice(0, 10);
  const { from_date, to_date } = inclusiveDateRangeFromRequest(request);

  let startDt = reqFromDt;
  let endDt = to_date;

  if (bounds && bounds.min_dt && bounds.max_dt) {
    if (bounds.min_dt < startDt) startDt = bounds.min_dt;
    if (bounds.max_dt > endDt) endDt = bounds.max_dt;
  }

  const endPlusOne = new Date(`${endDt}T00:00:00.000Z`);
  endPlusOne.setUTCDate(endPlusOne.getUTCDate() + 1);

  const wideRequest = {
    ...request,
    from: `${startDt}T00:00:00.000Z`,
    to: endPlusOne.toISOString(),
  };

  const availability = checkDatasetAvailability(db, wideRequest);
  const activeJobDates = findActiveJobDates(db, wideRequest);
  const { days, summary } = aggregateCoverageDays(availability.partitions, { activeJobDates });

  // Calculate ok status specifically for the requested (narrow) range
  const requestedDates = new Set(partitionDatesForRange(request.from, request.to));
  const requestedPartitions = availability.partitions.filter((p) => requestedDates.has(p.dt));
  const requestedOk = requestedPartitions.length === requestedDates.size && requestedPartitions.every((p) => p.usable);

  return {
    dataset: request.dataset,
    underlying: request.underlying,
    interval: request.interval,
    book_depth: request.bookDepth ?? null,
    from: request.from,
    to: request.to,
    from_date,
    to_date,
    days,
    summary,
    ok: requestedOk,
  };
}

function findActiveJobDates(db, request) {
  const dates = new Set();
  const jobs = db.prepare("SELECT request_json FROM prepare_jobs WHERE status IN ('queued', 'running')").all();
  for (const job of jobs) {
    try {
      const req = JSON.parse(job.request_json || '{}');
      if (req.underlying !== request.underlying || req.interval !== request.interval) continue;
      if (request.bookDepth != null && req.bookDepth !== request.bookDepth) continue;
      const parts = checkDatasetAvailability(db, { ...request, from: req.from, to: req.to });
      for (const p of parts.partitions || []) dates.add(p.dt);
    } catch { /* ignore */ }
  }
  return dates;
}

export function aggregateCoverageDays(partitions, { activeJobDates = new Set() } = {}) {
  const days = [];
  for (const partition of partitions) {
    const uiState = mapStatusToUiState(partition.status, { activeJob: activeJobDates.has(partition.dt) });
    days.push({
      dt: partition.dt,
      status: partition.status,
      raw_status: partition.status,
      ui_state: uiState,
      ui_label: UI_STATE_LABELS[uiState],
      rows: partition.rows ?? null,
      has_degraded: Boolean(partition.has_degraded),
      error: partition.error ?? null,
      partitions: [partition],
    });
  }
  const summary = {
    total: days.length,
    ready: days.filter((d) => d.ui_state === 'ready').length,
    processing: days.filter((d) => d.ui_state === 'processing').length,
    attention: days.filter((d) => d.ui_state === 'attention').length,
  };
  return { days, summary };
}
