import {
  analyzeTrimSegments,
  collectOmitIssues,
  findOmitTickIndices,
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
  const omitIndices = findOmitTickIndices(sorted, opts);
  const trimCount = omitIndices.size;
  const trimRatio = trimCount / sorted.length;
  const trimSegments = segments.filter((segment) => {
    if (segment.classification === 'clob_stale' || segment.classification === 'underlying_stale') return true;
    if (segment.feed !== 'underlying') return false;
    for (let index = segment.startIndex; index <= segment.endIndex; index += 1) {
      if (omitIndices.has(index)) return true;
    }
    return false;
  });
  const issues = collectOmitIssues(sorted, omitIndices, opts);

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
