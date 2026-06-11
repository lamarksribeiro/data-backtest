export function buildNormalizationIndex(qualityDetails) {
  const norm = qualityDetails?.normalization;
  const byConditionId = new Map();
  if (!norm) return byConditionId;
  for (const sample of norm.samples || []) {
    if (sample.condition_id) {
      byConditionId.set(sample.condition_id, sample);
    }
  }
  return byConditionId;
}

export function mergeDayEvents({ events, exclusions, normalizationIndex }) {
  const excludedIds = new Set((exclusions || []).map((row) => row.conditionId));
  return events.map((event) => {
    const norm = normalizationIndex.get(event.conditionId);
    return {
      condition_id: event.conditionId,
      event_start: event.eventStart,
      event_end: event.eventEnd,
      coverage: event.coverage,
      degraded: event.degraded,
      ticks_recorded: event.ticksRecorded,
      hour_utc: new Date(event.eventStart).getUTCHours(),
      normalization_action: norm?.action ?? null,
      normalization_issues: norm?.issues ?? [],
      manually_excluded: excludedIds.has(event.conditionId),
    };
  });
}

export function summarizeHours(events) {
  const hours = new Map();
  for (const event of events) {
    const hour = event.hour_utc;
    if (!hours.has(hour)) {
      hours.set(hour, { hour, total: 0, omitted: 0, trimmed: 0, manual: 0, kept: 0 });
    }
    const bucket = hours.get(hour);
    bucket.total += 1;
    if (event.manually_excluded) bucket.manual += 1;
    else if (event.normalization_action === 'omit') bucket.omitted += 1;
    else if (event.normalization_action === 'trim') bucket.trimmed += 1;
    else bucket.kept += 1;
  }
  return [...hours.values()].sort((left, right) => left.hour - right.hour);
}
