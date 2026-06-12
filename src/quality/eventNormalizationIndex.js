import { getPartitionEvents, getScalarTicksForEvents } from '../source/postgres.js';
import { buildNormalizationOptions } from '../sync/applyNormalization.js';
import { normalizePartitionTicks } from './normalizePartition.js';

export function mapEventResultsToIndex(eventResults = []) {
  return eventResults.map((event) => ({
    condition_id: event.conditionId,
    event_start: event.eventStart,
    action: event.action,
    issues: event.issues,
    ticks_in: event.stats?.ticksIn ?? 0,
    ticks_out: event.stats?.ticksOut ?? 0,
    bad_ratio: event.stats?.badRatio ?? 0,
    trim_segments: (event.stats?.trimSegments || [])
      .filter((segment) => segment.classification === 'clob_stale' || segment.classification === 'underlying_stale')
      .map((segment) => ({
        feed: segment.feed,
        classification: segment.classification,
        start_index: segment.startIndex,
        end_index: segment.endIndex,
        duration_sec: segment.durationSec,
      })),
  }));
}

export function buildNormalizationIndexFromReport(report) {
  const byConditionId = new Map();
  for (const row of report?.events_index || report?.samples || []) {
    if (row.condition_id) byConditionId.set(row.condition_id, row);
  }
  return byConditionId;
}

export async function buildLiveNormalizationIndex(pool, partition, config = {}) {
  const events = await getPartitionEvents(pool, partition);
  const conditionIds = [...new Set(events.map((event) => event.conditionId))];
  if (!conditionIds.length) return new Map();

  const ticks = await getScalarTicksForEvents(pool, partition, conditionIds);
  const { report } = normalizePartitionTicks(ticks, buildNormalizationOptions(config), events);
  return buildNormalizationIndexFromReport(report);
}
