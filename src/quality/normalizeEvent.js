import {
  analyzeTrimSegments,
  collectTrimIssues,
  findTrimTickIndices,
} from './clobStale.js';

export function normalizeEventTicks(ticks, opts = {}) {
  const omitEventBadRatio = opts.omitEventBadRatio ?? 0.5;
  const sorted = [...ticks].sort((left, right) => String(left.ts).localeCompare(String(right.ts)));

  if (!sorted.length) {
    return {
      action: 'omit',
      exportTicks: [],
      issues: ['missing_ticks'],
      stats: {
        ticksIn: 0,
        ticksOut: 0,
        ticksRemoved: 0,
        badRatio: 1,
      },
    };
  }

  const segments = analyzeTrimSegments(sorted, opts);
  const trimIndices = findTrimTickIndices(sorted, opts);
  const trimCount = trimIndices.size;
  const trimRatio = trimCount / sorted.length;
  const trimSegments = segments.filter((segment) => segment.classification === 'clob_stale'
    || segment.classification === 'underlying_stale');
  const issues = collectTrimIssues(segments);

  if (trimRatio > omitEventBadRatio) {
    return {
      action: 'omit',
      exportTicks: [],
      issues: issues.length ? issues : ['feed_desync'],
      stats: {
        ticksIn: sorted.length,
        ticksOut: 0,
        ticksRemoved: sorted.length,
        badRatio: trimRatio,
        trimSegments,
      },
    };
  }

  return {
    action: 'keep',
    exportTicks: sorted,
    issues: [],
    stats: {
      ticksIn: sorted.length,
      ticksOut: sorted.length,
      ticksRemoved: 0,
      badRatio: trimRatio,
      trimSegments: trimCount > 0 ? trimSegments : [],
    },
  };
}
