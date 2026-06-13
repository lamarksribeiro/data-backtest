import { normalizePartitionTicks } from '../quality/normalizePartition.js';

export function buildNormalizationOptions(config = {}) {
  return {
    omitEventBadRatio: config.syncNormalizeOmitEventRatio ?? 0.5,
    minStaleSec: config.syncNormalizeMinStaleSec ?? 30,
    minPriceToBeat: config.syncNormalizeMinPtb ?? 1000,
    minUnderlyingMove: config.syncNormalizeMinUnderlyingMove ?? null,
    quietUnderlyingMax: config.syncNormalizeQuietUnderlyingMax ?? null,
    minQuoteMove: config.syncNormalizeMinQuoteMove ?? null,
  };
}

function applyManualExclusions(exportTicks, manualExcludedConditionIds) {
  if (!manualExcludedConditionIds?.size) {
    return { ticks: exportTicks, manualEventsOmitted: 0 };
  }
  const omittedEvents = new Set();
  const ticks = exportTicks.filter((tick) => {
    if (manualExcludedConditionIds.has(tick.conditionId)) {
      omittedEvents.add(tick.conditionId);
      return false;
    }
    return true;
  });
  return { ticks, manualEventsOmitted: omittedEvents.size };
}

export function applyTickNormalization(ticks, config = {}, {
  manualExcludedConditionIds = null,
  partitionEvents = [],
} = {}) {
  const startedAt = Date.now();
  const normalization = normalizePartitionTicks(
    ticks,
    buildNormalizationOptions(config),
    partitionEvents,
  );
  const manual = applyManualExclusions(normalization.exportTicks, manualExcludedConditionIds);
  const exportedConditionIds = new Set(manual.ticks.map((tick) => tick.conditionId));
  const report = {
    ...normalization.report,
    manual_exclusions_applied: (manual.manualEventsOmitted || 0) > 0,
    events_manual_omitted: manual.manualEventsOmitted || 0,
    applied: normalization.report.applied || (manual.manualEventsOmitted || 0) > 0,
    events_exported: exportedConditionIds.size,
    ticks_out: manual.ticks.length,
    ticks_removed: Math.max(0, (normalization.report.ticks_in || 0) - manual.ticks.length),
  };
  return {
    ticks: manual.ticks,
    normalization: report,
    qualityClassifyMs: Date.now() - startedAt,
  };
}

export function mergeNormalizationReports(reports) {
  const merged = {
    version: 1,
    applied: false,
    events_total: 0,
    events_exported: 0,
    events_omitted: 0,
    events_trimmed: 0,
    events_kept: 0,
    ticks_in: 0,
    ticks_out: 0,
    ticks_removed: 0,
    manual_exclusions_applied: false,
    events_manual_omitted: 0,
    hours_affected: [],
    events_index: [],
    samples: [],
  };
  const hours = new Map();

  for (const report of reports) {
    if (!report) continue;
    merged.applied = merged.applied || Boolean(report.applied);
    merged.events_total += report.events_total || 0;
    merged.events_exported += report.events_exported || 0;
    merged.events_omitted += report.events_omitted || 0;
    merged.events_trimmed += report.events_trimmed || 0;
    merged.events_kept += report.events_kept || 0;
    merged.ticks_in += report.ticks_in || 0;
    merged.ticks_out += report.ticks_out || 0;
    merged.ticks_removed += report.ticks_removed || 0;
    merged.manual_exclusions_applied = merged.manual_exclusions_applied || Boolean(report.manual_exclusions_applied);
    merged.events_manual_omitted += report.events_manual_omitted || 0;
    for (const entry of report.hours_affected || []) {
      hours.set(entry.hour, (hours.get(entry.hour) || 0) + (entry.events || 0));
    }
    if (Array.isArray(report.events_index)) merged.events_index.push(...report.events_index);
    if (Array.isArray(report.samples)) merged.samples.push(...report.samples);
  }

  merged.skip_ratio = merged.events_total ? merged.events_omitted / merged.events_total : 0;
  merged.hours_affected = [...hours.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([hour, events]) => ({ hour, events }));
  merged.samples = merged.samples.slice(0, 12);
  return merged;
}
