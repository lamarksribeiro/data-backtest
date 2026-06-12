const DEFAULT_ACCEPT_MISMATCH_RATIO = 0.02;

export function normalizeAcceptCountMismatchRatio(value, fallback = DEFAULT_ACCEPT_MISMATCH_RATIO) {
  const parsed = Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), 1);
}

export function classifyExportQuality({
  actualRows,
  expectedRows,
  acceptMismatchRatio = DEFAULT_ACCEPT_MISMATCH_RATIO,
  normalization = null,
  maxDayOmitRatio = 0.5,
}) {
  const exportedRows = Math.max(Number(actualRows || 0), 0);
  const expected = Math.max(Number(expectedRows || 0), 0);

  if (normalization?.applied) {
    const skipRatio = normalization.skip_ratio ?? 0;
    const qualityNote = buildNormalizationQualityNote({ exportedRows, expected, normalization, skipRatio, maxDayOmitRatio });
    return {
      status: 'valid',
      diverged: exportedRows !== expected,
      error: qualityNote,
      mismatchRatio: expected > 0 ? Math.abs(exportedRows - expected) / expected : skipRatio,
      normalizationApplied: true,
    };
  }

  return classifyTickCountQuality({ actualRows, expectedRows, acceptMismatchRatio });
}

function buildNormalizationQualityNote({ exportedRows, expected, normalization, skipRatio, maxDayOmitRatio }) {
  const removed = normalization.ticks_removed ?? 0;
  const omitted = normalization.events_omitted ?? 0;
  if (normalization.events_exported === 0 && normalization.events_total > 0) {
    return `Normalized export approved: all ${normalization.events_total} events were omitted by quality filters (${removed} ticks removed)`;
  }
  if (exportedRows === 0 && expected > 0) {
    return `Normalized export approved: no exportable ticks after quality filters (${removed} ticks removed, ${omitted} events omitted)`;
  }
  if (skipRatio > maxDayOmitRatio) {
    return `Normalized export approved: ${(skipRatio * 100).toFixed(1)}% of events omitted by quality filters (> ${(maxDayOmitRatio * 100).toFixed(0)}%)`;
  }
  if (exportedRows !== expected || removed > 0 || omitted > 0) {
    return `Normalized export approved: ${exportedRows} rows (${removed} ticks removed, ${omitted} events omitted)`;
  }
  return null;
}

export function classifyTickCountQuality({ actualRows, expectedRows, acceptMismatchRatio = DEFAULT_ACCEPT_MISMATCH_RATIO }) {
  const actual = Math.max(Number(actualRows || 0), 0);
  const expected = Math.max(Number(expectedRows || 0), 0);
  const diverged = actual !== expected;

  if (!diverged) {
    return { status: 'valid', diverged: false, error: null, mismatchRatio: 0 };
  }

  const baseMessage = `actual tick count ${actual} differs from event_quality ${expected}`;
  if (actual === 0) {
    return {
      status: 'needs_review',
      diverged: true,
      error: `${baseMessage}; export has no ticks`,
      mismatchRatio: 1,
    };
  }

  if (expected === 0) {
    return {
      status: 'needs_review',
      diverged: true,
      error: `${baseMessage}; event_quality expects no ticks but export has data`,
      mismatchRatio: 1,
    };
  }

  const mismatchRatio = Math.abs(actual - expected) / expected;
  if (mismatchRatio <= acceptMismatchRatio) {
    return {
      status: 'accepted',
      diverged: true,
      error: `Accepted automatically: ${baseMessage}; mismatch ${(mismatchRatio * 100).toFixed(3)}% <= tolerance ${(acceptMismatchRatio * 100).toFixed(3)}%`,
      mismatchRatio,
    };
  }

  return {
    status: 'needs_review',
    diverged: true,
    error: `${baseMessage}; mismatch ${(mismatchRatio * 100).toFixed(3)}% > tolerance ${(acceptMismatchRatio * 100).toFixed(3)}%`,
    mismatchRatio,
  };
}
