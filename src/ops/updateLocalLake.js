/**
 * Helpers for the one-shot local lake update flow (BTC 5m by default).
 * Keeps date-range math testable and free of SSH.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function utcToday(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function addUtcDays(isoDate, deltaDays) {
  if (!DATE_RE.test(String(isoDate))) {
    throw new Error(`Invalid date: ${isoDate}`);
  }
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(deltaDays));
  return dt.toISOString().slice(0, 10);
}

export function readLocalCoverage(db, {
  underlying = 'BTC',
  interval = '5m',
  bookDepth = 25,
  dataset = 'backtest_ticks',
} = {}) {
  const row = db.prepare(`
    SELECT
      MIN(dt) AS min_dt,
      MAX(dt) AS max_dt,
      COUNT(*) AS partitions
    FROM lake_manifest
    WHERE underlying = ?
      AND interval = ?
      AND book_depth = ?
      AND dataset = ?
      AND status IN ('valid', 'accepted')
      AND active_path IS NOT NULL
      AND active_path != ''
  `).get(underlying, interval, bookDepth, dataset);

  return {
    minDt: row?.min_dt ?? null,
    maxDt: row?.max_dt ?? null,
    partitions: Number(row?.partitions || 0),
  };
}

/**
 * Decide the selective pull window.
 * - With local data: from = localMax - lookbackDays (inclusive refresh of the tip)
 * - Empty local: from = today - emptyLookbackDays
 * - Always to = today (UTC). Missing "today" on remote is expected before daily sync.
 */
export function computeUpdateRange({
  localMaxDt = null,
  today = utcToday(),
  lookbackDays = 0,
  emptyLookbackDays = 14,
  fromOverride = null,
  toOverride = null,
} = {}) {
  if (fromOverride && !DATE_RE.test(fromOverride)) throw new Error(`Invalid --from: ${fromOverride}`);
  if (toOverride && !DATE_RE.test(toOverride)) throw new Error(`Invalid --to: ${toOverride}`);

  const to = toOverride || today;
  let from;
  if (fromOverride) {
    from = fromOverride;
  } else if (localMaxDt) {
    from = addUtcDays(localMaxDt, -Math.max(0, Number(lookbackDays) || 0));
  } else {
    from = addUtcDays(to, -Math.max(1, Number(emptyLookbackDays) || 14));
  }

  if (from > to) {
    throw new Error(`Computed range is empty: from=${from} to=${to}`);
  }

  return { from, to, refreshedFromLocalMax: Boolean(localMaxDt && !fromOverride) };
}

export function summarizeUpdateResult({
  coverageBefore,
  coverageAfter,
  range,
  pullResult,
}) {
  const filesCopied = Number(pullResult?.filesCopied || pullResult?.filesToCopy || 0);
  const filesSkipped = Number(pullResult?.filesSkipped || pullResult?.filesToSkip || 0);
  const partitions = Number(pullResult?.partitions || pullResult?.files?.length || 0);
  const remoteDts = [...new Set(
    (pullResult?.files || [])
      .filter((f) => !f.action || f.action === 'copy')
      .map((f) => f.partition?.dt || f.relativePath?.match(/dt=(\d{4}-\d{2}-\d{2})/)?.[1])
      .filter(Boolean),
  )].sort();

  return {
    ok: Boolean(pullResult?.ok),
    dryRun: Boolean(pullResult?.dryRun),
    range,
    before: coverageBefore,
    after: coverageAfter,
    partitions,
    filesCopied,
    filesSkipped,
    remoteDts,
    note: coverageAfter?.maxDt === utcToday()
      ? null
      : 'Dia corrente costuma faltar até o sync ~06:00 UTC no Brutus — normal.',
  };
}
