import { acceptEligibleReviewPartitions } from '../state/manifest.js';

export function partitionDatesForRange(from, to) {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime())) throw new Error(`Invalid from: ${from}`);
  if (Number.isNaN(toDate.getTime())) throw new Error(`Invalid to: ${to}`);
  if (toDate <= fromDate) throw new Error('to must be after from');

  const endInclusive = new Date(toDate.getTime() - 1);
  const current = utcDateOnly(fromDate);
  const end = utcDateOnly(endInclusive);
  const dates = [];
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

const STATUS_HINTS = {
  valid: 'Pronta para backtest em modo strict.',
  accepted:
    'Aceita manualmente apesar de divergência de qualidade. Usável em modo strict, mas deve ser monitorada.',
  needs_review:
    'O parquet foi gerado, mas a contagem real de ticks divergiu do event_quality no Postgres. '
    + 'Bloqueada em modo strict até reprocessar com "Reprocessar indisponíveis" + confirmação REBUILD_PARTITIONS.',
  invalid: 'Exportação falhou ou o arquivo ficou inválido.',
  stale: 'A fonte mudou desde o último export; requer reexport.',
  writing: 'Sync em andamento nesta partição.',
  pending: 'Registrada no manifest, ainda não exportada.',
  rebuilding: 'Reexport em andamento.',
  missing: 'Sem entrada no manifest para esta data.',
};

export function partitionStatusHint(status) {
  return STATUS_HINTS[status] || `Status "${status}" não pode ser usado em modo strict.`;
}

export function checkDatasetAvailability(db, request) {
  const dates = partitionDatesForRange(request.from, request.to);
  acceptEligibleReviewPartitions(db, {
    dataset: request.dataset,
    underlying: request.underlying,
    interval: request.interval,
    resolution: request.resolution ?? null,
    bookDepth: request.bookDepth ?? null,
    fromDt: dates[0],
    toDt: dates.at(-1),
  }, request.acceptMismatchRatio ?? request.syncAcceptCountMismatchRatio ?? 0.02);
  const rows = findManifestPartitions(db, request, dates[0], dates.at(-1));
  const byDate = new Map(rows.map((row) => [row.dt, row]));
  const missing = [];
  const unavailable = [];
  const files = [];
  const partitions = [];

  for (const dt of dates) {
    const row = byDate.get(dt);
    if (!row) {
      missing.push(dt);
      partitions.push({
        dt,
        status: 'missing',
        usable: false,
        rows: null,
        active_path: null,
        error: null,
        hint: STATUS_HINTS.missing,
      });
      continue;
    }

    const usable = ['valid', 'accepted'].includes(row.status) && Boolean(row.active_path);
    const partition = {
      dt,
      status: row.status,
      usable,
      rows: row.rows ?? null,
      events_count: row.events_count ?? null,
      coverage_min: row.coverage_min ?? null,
      has_degraded: Boolean(row.has_degraded),
      quality_details: parseQualityDetails(row.quality_details_json),
      active_path: row.active_path ?? null,
      error: row.error ?? null,
      hint: partitionStatusHint(row.status),
    };
    partitions.push(partition);

    if (usable) {
      files.push(row.active_path);
      continue;
    }
    unavailable.push({
      dt,
      status: row.status,
      active_path: row.active_path,
      rows: row.rows ?? null,
      quality_details: partition.quality_details,
      error: row.error ?? null,
      hint: partition.hint,
    });
  }

  const validCount = partitions.filter((item) => item.usable).length;

  return {
    ok: missing.length === 0 && unavailable.length === 0,
    dataset: request.dataset,
    underlying: request.underlying,
    interval: request.interval,
    resolution: request.resolution ?? null,
    book_depth: request.bookDepth ?? null,
    from: new Date(request.from).toISOString(),
    to: new Date(request.to).toISOString(),
    expected_partitions: dates,
    partitions,
    summary: {
      total: dates.length,
      valid: validCount,
      missing: missing.length,
      unavailable: unavailable.length,
    },
    files,
    missing,
    unavailable,
  };
}

export function requireDatasetAvailability(db, request) {
  const availability = checkDatasetAvailability(db, request);
  if (!availability.ok) {
    const details = [
      availability.missing.length ? `missing=${availability.missing.join(',')}` : null,
      availability.unavailable.length ? `unavailable=${availability.unavailable.map((item) => `${item.dt}:${item.status}`).join(',')}` : null,
    ].filter(Boolean).join('; ');
    throw new Error(`Dataset not available for strict query: ${details}`);
  }
  return availability;
}

function findManifestPartitions(db, request, fromDt, toDt) {
  const params = [request.dataset, request.underlying, request.interval, fromDt, toDt];
  let sql = `
    SELECT * FROM lake_manifest
    WHERE dataset = ?
      AND underlying = ?
      AND interval = ?
      AND dt >= ?
      AND dt <= ?`;

  if (request.resolution) {
    params.push(request.resolution);
    sql += ` AND resolution = ?`;
  } else {
    sql += ` AND resolution IS NULL`;
  }

  if (request.bookDepth != null) {
    params.push(request.bookDepth);
    sql += ` AND book_depth = ?`;
  } else {
    sql += ` AND book_depth IS NULL`;
  }

  sql += ` ORDER BY dt ASC`;
  return db.prepare(sql).all(...params);
}

function parseQualityDetails(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function utcDateOnly(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
