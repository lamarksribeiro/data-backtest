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

export function checkDatasetAvailability(db, request) {
  const dates = partitionDatesForRange(request.from, request.to);
  const rows = findManifestPartitions(db, request, dates[0], dates.at(-1));
  const byDate = new Map(rows.map((row) => [row.dt, row]));
  const missing = [];
  const unavailable = [];
  const files = [];

  for (const dt of dates) {
    const row = byDate.get(dt);
    if (!row) {
      missing.push(dt);
      continue;
    }
    if (row.status !== 'valid' || !row.active_path) {
      unavailable.push({ dt, status: row.status, active_path: row.active_path });
      continue;
    }
    files.push(row.active_path);
  }

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

function utcDateOnly(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
