import { findClobStaleTickIndices } from './clobStale.js';
import { getTickQualityIssues } from './tickUsable.js';

export function normalizeEventTicks(ticks, opts = {}) {
  const omitEventBadRatio = opts.omitEventBadRatio ?? 0.5;
  const minPriceToBeat = opts.minPriceToBeat ?? 1000;
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

  const staleIndices = findClobStaleTickIndices(sorted, opts);
  const evaluated = sorted.map((tick, index) => {
    const issues = getTickQualityIssues(tick, { minPriceToBeat });
    if (staleIndices.has(index)) issues.push('clob_stale');
    return { tick, bad: issues.length > 0, issues: [...new Set(issues)] };
  });

  const badCount = evaluated.filter((entry) => entry.bad).length;
  const badRatio = badCount / sorted.length;
  const issueSet = new Set(evaluated.flatMap((entry) => entry.issues));

  if (badRatio > omitEventBadRatio) {
    return {
      action: 'omit',
      exportTicks: [],
      issues: [...issueSet],
      stats: {
        ticksIn: sorted.length,
        ticksOut: 0,
        ticksRemoved: sorted.length,
        badRatio,
      },
    };
  }

  const exportTicks = evaluated.filter((entry) => !entry.bad).map((entry) => entry.tick);
  if (!exportTicks.length) {
    return {
      action: 'omit',
      exportTicks: [],
      issues: [...issueSet],
      stats: {
        ticksIn: sorted.length,
        ticksOut: 0,
        ticksRemoved: sorted.length,
        badRatio: 1,
      },
    };
  }

  return {
    action: badCount > 0 ? 'trim' : 'keep',
    exportTicks,
    issues: badCount > 0 ? [...issueSet] : [],
    stats: {
      ticksIn: sorted.length,
      ticksOut: exportTicks.length,
      ticksRemoved: badCount,
      badRatio,
    },
  };
}
