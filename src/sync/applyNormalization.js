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
