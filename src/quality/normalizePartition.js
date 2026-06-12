import { mapEventResultsToIndex } from './eventNormalizationIndex.js';
import { normalizeEventTicks } from './normalizeEvent.js';

function groupTicksByEvent(ticks) {
  const groups = new Map();
  for (const tick of ticks) {
    const key = tick.conditionId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tick);
  }
  return groups;
}

function hourUtc(isoTs) {
  const date = new Date(isoTs);
  return Number.isFinite(date.getTime()) ? date.getUTCHours() : null;
}

export function eventHasSourceTicks(event) {
  const actual = event.actualCount ?? event.actual_count ?? null;
  if (actual != null) return Number(actual) > 0;
  return Number(event.ticksRecorded ?? event.ticks_recorded ?? 0) > 0;
}

function appendEmptyEventOmissions(eventResults, hoursAffected, partitionEvents = []) {
  const seen = new Set(eventResults.map((event) => event.conditionId));
  for (const event of partitionEvents) {
    const conditionId = event.conditionId ?? event.condition_id;
    if (!conditionId || seen.has(conditionId) || eventHasSourceTicks(event)) continue;
    const eventStart = event.eventStart ?? event.event_start ?? null;
    eventResults.push({
      conditionId,
      eventStart,
      action: 'omit',
      issues: ['missing_ticks'],
      stats: {
        ticksIn: 0,
        ticksOut: 0,
        ticksRemoved: 0,
        badRatio: 1,
      },
    });
    seen.add(conditionId);
    if (eventStart != null) {
      const hour = hourUtc(eventStart);
      if (hour != null) hoursAffected.set(hour, (hoursAffected.get(hour) || 0) + 1);
    }
  }
}

export function normalizePartitionTicks(ticks, opts = {}, partitionEvents = []) {
  const groups = groupTicksByEvent(ticks);
  const eventResults = [];
  const exportTicks = [];
  const hoursAffected = new Map();

  for (const [conditionId, eventTicks] of groups) {
    const result = normalizeEventTicks(eventTicks, opts);
    const eventStart = eventTicks[0]?.eventStart ?? null;
    eventResults.push({
      conditionId,
      eventStart,
      action: result.action,
      issues: result.issues,
      stats: result.stats,
    });

    if (result.action !== 'keep' && eventStart != null) {
      const hour = hourUtc(eventStart);
      if (hour != null) hoursAffected.set(hour, (hoursAffected.get(hour) || 0) + 1);
    }

    if (result.action !== 'omit') {
      exportTicks.push(...result.exportTicks);
    }
  }

  appendEmptyEventOmissions(eventResults, hoursAffected, partitionEvents);

  exportTicks.sort((left, right) => String(left.ts).localeCompare(String(right.ts)));

  const eventsTotal = partitionEvents.length || eventResults.length;
  const eventsOmitted = eventResults.filter((event) => event.action === 'omit').length;
  const eventsTrimmed = eventResults.filter((event) => event.action === 'trim').length;
  const eventsKept = eventResults.filter((event) => event.action === 'keep').length;
  const ticksIn = ticks.length;
  const ticksOut = exportTicks.length;
  const ticksRemoved = ticksIn - ticksOut;

  return {
    exportTicks,
    report: {
      version: 1,
      applied: ticksRemoved > 0 || eventsOmitted > 0,
      events_total: eventsTotal,
      events_exported: eventsTotal - eventsOmitted,
      events_omitted: eventsOmitted,
      events_trimmed: eventsTrimmed,
      events_kept: eventsKept,
      ticks_in: ticksIn,
      ticks_out: ticksOut,
      ticks_removed: ticksRemoved,
      skip_ratio: eventsTotal ? eventsOmitted / eventsTotal : 0,
      hours_affected: [...hoursAffected.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([hour, events]) => ({ hour, events })),
      events_index: mapEventResultsToIndex(eventResults),
      samples: mapEventResultsToIndex(eventResults.filter((event) => event.action !== 'keep')).slice(0, 12),
    },
  };
}
