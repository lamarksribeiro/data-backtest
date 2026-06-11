const DEGRADED_COVERAGE_THRESHOLD = 0.8;

export function buildPartitionQualityDetails({
  partition,
  events,
  actualRows,
  expectedRows,
  quality,
  normalization = null,
  sampleLimit = 8,
}) {
  const eventList = Array.isArray(events) ? events : [];
  const coverageValues = eventList
    .map((event) => numberOrNull(event.coverage))
    .filter((value) => value != null);
  const degradedEvents = eventList.filter((event) => Boolean(event.degraded));
  const lowCoverageEvents = eventList.filter((event) => {
    const coverage = numberOrNull(event.coverage);
    return coverage != null && coverage < DEGRADED_COVERAGE_THRESHOLD;
  });
  const sourceTicksRecorded = sum(eventList, 'ticksRecorded');
  const sourceTicksExpected = sum(eventList, 'ticksExpected');
  const sourceMissingTicks = Math.max(sourceTicksExpected - sourceTicksRecorded, 0);
  const countMismatch = !normalization?.applied
    && (quality?.diverged || Number(actualRows ?? 0) !== Number(expectedRows ?? 0));
  const issues = [];

  if (normalization?.applied) {
    issues.push({
      code: 'normalization',
      label: 'Normalização automática no sync',
      events_omitted: normalization.events_omitted,
      events_trimmed: normalization.events_trimmed,
      ticks_removed: normalization.ticks_removed,
      hours_affected: normalization.hours_affected?.length ?? 0,
    });
  }

  if (degradedEvents.length || lowCoverageEvents.length) {
    issues.push({
      code: 'low_coverage',
      label: 'Cobertura abaixo do mínimo por evento',
      events: Math.max(degradedEvents.length, lowCoverageEvents.length),
      threshold: DEGRADED_COVERAGE_THRESHOLD,
    });
  }

  if (sourceMissingTicks > 0) {
    issues.push({
      code: 'missing_ticks',
      label: 'Ticks faltantes na janela esperada do evento',
      missing_ticks: sourceMissingTicks,
      expected_ticks: sourceTicksExpected,
      recorded_ticks: sourceTicksRecorded,
    });
  }

  if (countMismatch) {
    issues.push({
      code: 'manifest_count_mismatch',
      label: 'Contagem exportada diverge do event_quality',
      actual_rows: Number(actualRows ?? 0),
      event_quality_rows: Number(expectedRows ?? 0),
      delta: Number(actualRows ?? 0) - Number(expectedRows ?? 0),
      mismatch_ratio: quality?.mismatchRatio ?? null,
    });
  }

  if (!issues.length && partition?.hasDegraded) {
    issues.push({
      code: 'degraded_flag',
      label: 'event_quality marcou pelo menos um evento como degradado',
    });
  }

  const samples = eventList
    .filter((event) => event.degraded || (numberOrNull(event.coverage) ?? 1) < DEGRADED_COVERAGE_THRESHOLD)
    .sort((a, b) => (numberOrNull(a.coverage) ?? 1) - (numberOrNull(b.coverage) ?? 1))
    .slice(0, sampleLimit)
    .map((event) => ({
      condition_id: event.conditionId,
      event_start: event.eventStart,
      event_end: event.eventEnd,
      coverage: numberOrNull(event.coverage),
      ticks_recorded: numberOrNull(event.ticksRecorded),
      ticks_expected: numberOrNull(event.ticksExpected),
      actual_count: numberOrNull(event.actualCount),
      missing_ticks: Math.max(Number(event.ticksExpected || 0) - Number(event.ticksRecorded || 0), 0),
    }));

  if (!issues.length && !samples.length && !normalization?.applied) return null;

  return {
    version: normalization?.applied ? 2 : 1,
    generated_at: new Date().toISOString(),
    normalization: normalization?.applied ? normalization : null,
    degraded_threshold: DEGRADED_COVERAGE_THRESHOLD,
    events_total: eventList.length,
    events_degraded: degradedEvents.length,
    events_low_coverage: lowCoverageEvents.length,
    coverage_min: coverageValues.length ? Math.min(...coverageValues) : null,
    coverage_avg: coverageValues.length ? coverageValues.reduce((sumValue, value) => sumValue + value, 0) / coverageValues.length : null,
    source_ticks_recorded: sourceTicksRecorded,
    source_ticks_expected: sourceTicksExpected,
    source_missing_ticks: sourceMissingTicks,
    actual_rows: Number(actualRows ?? 0),
    event_quality_rows: Number(expectedRows ?? 0),
    row_count_delta: Number(actualRows ?? 0) - Number(expectedRows ?? 0),
    issues,
    samples,
  };
}

function numberOrNull(value) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sum(events, key) {
  return events.reduce((total, event) => total + Number(event[key] || 0), 0);
}
