import { checkDatasetAvailability } from './availability.js';
import { datasetRequestFromParams } from './request.js';

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
  const availability = checkDatasetAvailability(db, request);
  const activeJobDates = findActiveJobDates(db, request);
  const { days, summary } = aggregateCoverageDays(availability.partitions, { activeJobDates });
  return {
    dataset: request.dataset,
    underlying: request.underlying,
    interval: request.interval,
    book_depth: request.bookDepth ?? null,
    from: availability.from,
    to: availability.to,
    days,
    summary,
    ok: availability.ok,
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
