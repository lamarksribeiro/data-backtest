import { analyzeTrimSegments, findTrimTickIndices } from './clobStale.js';
import { normalizeEventTicks } from './normalizeEvent.js';
import { buildNormalizationOptions } from '../sync/applyNormalization.js';

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildEventPreviewFromTicks(ticks, config = {}) {
  const sorted = [...ticks].sort((left, right) => String(left.ts).localeCompare(String(right.ts)));
  const opts = buildNormalizationOptions(config);
  const result = normalizeEventTicks(sorted, opts);
  const trimIndices = findTrimTickIndices(sorted, opts);
  const segments = analyzeTrimSegments(sorted, opts);

  const trimRegions = segments
    .filter((segment) => segment.classification === 'clob_stale' || segment.classification === 'underlying_stale')
    .map((segment) => ({
      kind: segment.classification,
      feed: segment.feed,
      from: sorted[segment.startIndex]?.ts ?? null,
      to: sorted[segment.endIndex]?.ts ?? null,
      duration_sec: segment.durationSec,
    }))
    .filter((region) => region.from && region.to);

  return {
    action: result.action,
    issues: result.issues,
    ticks_in: sorted.length,
    ticks_out: result.exportTicks.length,
    ticks_removed: result.stats?.ticksRemoved ?? 0,
    bad_ratio: result.stats?.badRatio ?? 0,
    trim_regions: trimRegions,
    removed_ticks: [...trimIndices]
      .sort((left, right) => left - right)
      .map((index) => ({
        ts: sorted[index]?.ts ?? null,
        underlying: num(sorted[index]?.underlyingPrice),
        up: num(sorted[index]?.upPrice),
        down: num(sorted[index]?.downPrice),
      })),
    series: {
      underlying: sorted.map((tick) => ({ ts: tick.ts, value: num(tick.underlyingPrice) })),
      price_to_beat: sorted.map((tick) => ({ ts: tick.ts, value: num(tick.priceToBeat) })),
      up: sorted.map((tick) => ({ ts: tick.ts, value: num(tick.upPrice) })),
      down: sorted.map((tick) => ({ ts: tick.ts, value: num(tick.downPrice) })),
    },
  };
}
