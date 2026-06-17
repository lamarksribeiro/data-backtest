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

const COVERAGE_CACHE_TTL_MS = 30_000;
const coverageCache = new Map();

export function invalidateCoverageCache() {
  coverageCache.clear();
}

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

function applyRequestScopeToCoverage(request, { days, summary, scope }) {
  const { from_date, to_date } = inclusiveDateRangeFromRequest(request);
  const requestedDates = partitionDatesForRange(request.from, request.to);
  const dayByDt = new Map(days.map((d) => [d.dt, d]));
  const requestedOk = requestedDates.length > 0 && requestedDates.every((dt) => {
    const partition = dayByDt.get(dt)?.partitions?.[0];
    return Boolean(partition?.usable);
  });

  return {
    dataset: request.dataset,
    underlying: request.underlying,
    interval: request.interval,
    book_depth: request.bookDepth ?? null,
    from: request.from,
    to: request.to,
    from_date,
    to_date,
    scope,
    days,
    summary,
    ok: requestedOk,
  };
}

export function getDataCoverage(db, params, config) {
  const request = datasetRequestFromParams(params, config);
  const fullHistory = params.get('full') === '1';
  const cacheKey = fullHistory
    ? `full:${request.dataset}:${request.underlying}:${request.interval}:${request.bookDepth}:${request.resolution || ''}`
    : `narrow:${request.dataset}:${request.underlying}:${request.interval}:${request.bookDepth}:${request.resolution || ''}:${request.from}:${request.to}`;

  const now = Date.now();
  const cached = coverageCache.get(cacheKey);
  if (cached && now - cached.at < COVERAGE_CACHE_TTL_MS) {
    if (fullHistory) {
      return applyRequestScopeToCoverage(request, cached.value);
    }
    return cached.value;
  }

  const { from_date, to_date } = inclusiveDateRangeFromRequest(request);
  let startDt = request.from.slice(0, 10);
  let endDt = to_date;

  if (fullHistory) {
    const dbParams = [request.dataset, request.underlying, request.interval];
    let boundsSql = `
      SELECT MIN(dt) AS min_dt, MAX(dt) AS max_dt
      FROM lake_manifest
      WHERE dataset = ?
        AND underlying = ?
        AND interval = ?`;

    if (request.resolution) {
      dbParams.push(request.resolution);
      boundsSql += ' AND resolution = ?';
    } else {
      boundsSql += ' AND resolution IS NULL';
    }

    if (request.bookDepth != null) {
      dbParams.push(request.bookDepth);
      boundsSql += ' AND book_depth = ?';
    } else {
      boundsSql += ' AND book_depth IS NULL';
    }

    const bounds = db.prepare(boundsSql).get(...dbParams);
    if (bounds?.min_dt && bounds.min_dt < startDt) startDt = bounds.min_dt;
    if (bounds?.max_dt && bounds.max_dt > endDt) endDt = bounds.max_dt;
  }

  const endPlusOne = new Date(`${endDt}T00:00:00.000Z`);
  endPlusOne.setUTCDate(endPlusOne.getUTCDate() + 1);

  const rangeRequest = {
    ...request,
    from: `${startDt}T00:00:00.000Z`,
    to: endPlusOne.toISOString(),
  };

  const availability = checkDatasetAvailability(db, rangeRequest, { includeQualityDetails: fullHistory });
  const activeJobsByDate = findActiveJobsByDate(db, rangeRequest);
  const { days, summary } = aggregateCoverageDays(availability.partitions, { activeJobsByDate });

  const scope = fullHistory ? 'full' : 'requested';
  const value = applyRequestScopeToCoverage(request, { days, summary, scope });

  coverageCache.set(cacheKey, {
    at: now,
    value: fullHistory ? { days, summary, scope } : value,
  });
  return value;
}

function findActiveJobsByDate(db, request) {
  const jobsByDate = new Map();
  const visibleDates = new Set(partitionDatesForRange(request.from, request.to));
  const jobs = db.prepare(`
    SELECT id, status, request_json, progress_json, started_at, created_at
    FROM prepare_jobs
    WHERE status IN ('queued', 'running')
    ORDER BY id ASC
  `).all();
  for (const job of jobs) {
    try {
      const req = JSON.parse(job.request_json || '{}');
      if (req.dataset && req.dataset !== request.dataset) continue;
      if (req.underlying !== request.underlying || req.interval !== request.interval) continue;
      const jobBookDepth = req.bookDepth ?? req.book_depth ?? null;
      if (request.bookDepth != null && Number(jobBookDepth) !== Number(request.bookDepth)) continue;
      const progress = job.progress_json ? JSON.parse(job.progress_json) : null;
      const summary = {
        id: Number(job.id),
        status: job.status,
        percent: progress?.percent ?? null,
        phase: progress?.current?.phase ?? null,
        current_dt: progress?.current?.dt ?? null,
        updated_at: progress?.updated_at ?? null,
        started_at: job.started_at ?? null,
        created_at: job.created_at ?? null,
      };
      for (const dt of partitionDatesForRange(req.from, req.to)) {
        if (!visibleDates.has(dt)) continue;
        const list = jobsByDate.get(dt) || [];
        list.push(summary);
        jobsByDate.set(dt, list);
      }
    } catch { /* ignore */ }
  }
  return jobsByDate;
}

export function aggregateCoverageDays(partitions, { activeJobDates = new Set(), activeJobsByDate = new Map() } = {}) {
  const days = [];
  for (const partition of partitions) {
    const activeJobs = activeJobsByDate.get(partition.dt) || [];
    const uiState = mapStatusToUiState(partition.status, { activeJob: activeJobDates.has(partition.dt) || activeJobs.length > 0 });
    days.push({
      dt: partition.dt,
      status: partition.status,
      raw_status: partition.status,
      ui_state: uiState,
      ui_label: UI_STATE_LABELS[uiState],
      rows: partition.rows ?? null,
      has_degraded: Boolean(partition.has_degraded),
      error: partition.error ?? null,
      hint: partition.hint ?? null,
      active_jobs: activeJobs,
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
