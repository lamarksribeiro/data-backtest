import { analyzeTrimSegments, findUnderlyingFlatTickIndices } from './clobStale.js';
import { buildChartTicksFromScalars, summarizeChartTicks } from './chartTicks.js';
import { normalizeEventTicks } from './normalizeEvent.js';
import { buildNormalizationOptions } from '../sync/applyNormalization.js';

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function scalarPrice(value, min = 1000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) return null;
  return parsed;
}

function oddsPrice(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return null;
  return parsed;
}

export function buildSourceEventPreview(ticks, config = {}) {
  const sorted = [...ticks].sort((left, right) => String(left.ts).localeCompare(String(right.ts)));
  const opts = buildNormalizationOptions(config);
  const result = normalizeEventTicks(sorted, opts);
  const segments = analyzeTrimSegments(sorted, opts);

  const flatIndices = findUnderlyingFlatTickIndices(sorted, opts);
  const minStaleSec = opts.minStaleSec ?? 30;
  const trimRegions = result.action === 'omit'
    ? segments
      .filter((segment) => {
        if (result.issues.includes(segment.classification)) return true;
        if (!result.issues.includes('underlying_flat')) return false;
        if (segment.feed !== 'underlying' || segment.durationSec < minStaleSec) return false;
        for (let index = segment.startIndex; index <= segment.endIndex; index += 1) {
          if (flatIndices.has(index)) return true;
        }
        return false;
      })
      .map((segment) => ({
        kind: result.issues.includes(segment.classification)
          ? segment.classification
          : 'underlying_flat',
        feed: segment.feed,
        from: sorted[segment.startIndex]?.ts ?? null,
        to: sorted[segment.endIndex]?.ts ?? null,
        duration_sec: segment.durationSec,
      }))
      .filter((region) => region.from && region.to)
    : [];

  const chart_ticks = buildChartTicksFromScalars(sorted, config);

  return {
    action: result.action,
    issues: result.issues,
    ticks_in: sorted.length,
    ticks_out: result.exportTicks.length,
    ticks_removed: result.stats?.ticksRemoved ?? 0,
    bad_ratio: result.stats?.badRatio ?? 0,
    trim_regions: trimRegions,
    removed_ticks: [],
    series: {
      underlying: sorted.map((tick) => ({ ts: tick.ts, value: scalarPrice(tick.underlyingPrice) })),
      price_to_beat: sorted.map((tick) => ({ ts: tick.ts, value: scalarPrice(tick.priceToBeat) })),
      up: sorted.map((tick) => ({ ts: tick.ts, value: oddsPrice(tick.upPrice) })),
      down: sorted.map((tick) => ({ ts: tick.ts, value: oddsPrice(tick.downPrice) })),
    },
    chart_ticks,
    chart_meta: summarizeChartTicks(chart_ticks),
    data_role: 'source',
  };
}

export function buildParquetEventPreview(ticks, normMeta = {}, config = {}) {
  const sorted = [...ticks].sort((left, right) => String(left.ts).localeCompare(String(right.ts)));
  const chart_ticks = buildChartTicksFromScalars(sorted, config);

  return {
    action: normMeta.action ?? (sorted.length ? 'keep' : 'omit'),
    issues: normMeta.issues ?? [],
    ticks_in: normMeta.ticks_in ?? sorted.length,
    ticks_out: sorted.length,
    ticks_removed: Math.max(0, (normMeta.ticks_in ?? sorted.length) - sorted.length),
    bad_ratio: normMeta.bad_ratio ?? 0,
    trim_regions: [],
    chart_ticks,
    chart_meta: summarizeChartTicks(chart_ticks),
    data_role: 'parquet',
  };
}

/** @deprecated use buildSourceEventPreview */
export const buildEventPreviewFromTicks = buildSourceEventPreview;
