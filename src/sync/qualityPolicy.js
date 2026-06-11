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
    if (normalization.events_exported === 0 && normalization.events_total > 0) {
      return {
        status: 'needs_review',
        diverged: true,
        error: 'Normalization omitted every event in the partition',
        mismatchRatio: 1,
        normalizationApplied: true,
      };
    }
    if ((normalization.skip_ratio ?? 0) > maxDayOmitRatio) {
      return {
        status: 'needs_review',
        diverged: true,
        error: `Normalization omitted ${(normalization.skip_ratio * 100).toFixed(1)}% of events (> ${(maxDayOmitRatio * 100).toFixed(0)}%)`,
        mismatchRatio: normalization.skip_ratio,
        normalizationApplied: true,
      };
    }
    if (exportedRows === 0) {
      return {
        status: 'needs_review',
        diverged: true,
        error: 'Normalization produced no exportable ticks',
        mismatchRatio: expected > 0 ? 1 : 0,
        normalizationApplied: true,
      };
    }
    return {
      status: 'valid',
      diverged: exportedRows !== expected,
      error: exportedRows !== expected
        ? `Normalized export: ${exportedRows} rows (${normalization.ticks_removed} ticks removed, ${normalization.events_omitted} events omitted)`
        : null,
      mismatchRatio: expected > 0 ? Math.abs(exportedRows - expected) / expected : 0,
      normalizationApplied: true,
    };
  }

  return classifyTickCountQuality({ actualRows, expectedRows, acceptMismatchRatio });
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
