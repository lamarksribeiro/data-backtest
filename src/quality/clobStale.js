import { pricesEqual } from './tickUsable.js';

function parseTsMs(ts) {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function quotesMatch(left, right) {
  return pricesEqual(left.upPrice, right.upPrice)
    && pricesEqual(left.downPrice, right.downPrice)
    && left.upPrice != null
    && left.downPrice != null;
}

function underlyingPricesMatch(left, right, epsilon) {
  const leftPrice = left.underlyingPrice;
  const rightPrice = right.underlyingPrice;
  if (leftPrice == null || rightPrice == null || !Number.isFinite(leftPrice) || !Number.isFinite(rightPrice)) {
    return false;
  }
  return Math.abs(leftPrice - rightPrice) <= epsilon;
}

function booksMatch(left, right) {
  return pricesEqual(left.upBestBid, right.upBestBid)
    && pricesEqual(left.upBestAsk, right.upBestAsk)
    && pricesEqual(left.downBestBid, right.downBestBid)
    && pricesEqual(left.downBestAsk, right.downBestAsk);
}

function segmentHasBookData(ticks, startIndex, endIndex) {
  for (let index = startIndex; index <= endIndex; index += 1) {
    const tick = ticks[index];
    if (tick.upBestBid != null || tick.upBestAsk != null || tick.downBestBid != null || tick.downBestAsk != null) {
      return true;
    }
  }
  return false;
}

function booksFlatInSegment(ticks, startIndex, endIndex) {
  if (!segmentHasBookData(ticks, startIndex, endIndex)) return null;
  const first = ticks[startIndex];
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    if (!booksMatch(first, ticks[index])) return false;
  }
  return true;
}

function underlyingRangeInSegment(ticks, startIndex, endIndex) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = startIndex; index <= endIndex; index += 1) {
    const value = ticks[index].underlyingPrice;
    if (value == null || !Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (!Number.isFinite(min)) return 0;
  return max - min;
}

function quotesRangeInSegment(ticks, startIndex, endIndex) {
  let upMin = Number.POSITIVE_INFINITY;
  let upMax = Number.NEGATIVE_INFINITY;
  let downMin = Number.POSITIVE_INFINITY;
  let downMax = Number.NEGATIVE_INFINITY;
  for (let index = startIndex; index <= endIndex; index += 1) {
    const up = ticks[index].upPrice;
    const down = ticks[index].downPrice;
    if (up != null && Number.isFinite(up)) {
      upMin = Math.min(upMin, up);
      upMax = Math.max(upMax, up);
    }
    if (down != null && Number.isFinite(down)) {
      downMin = Math.min(downMin, down);
      downMax = Math.max(downMax, down);
    }
  }
  return {
    upRange: Number.isFinite(upMin) ? upMax - upMin : 0,
    downRange: Number.isFinite(downMin) ? downMax - downMin : 0,
  };
}

function medianUnderlyingInSegment(ticks, startIndex, endIndex) {
  const values = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const value = ticks[index].underlyingPrice;
    if (value != null && Number.isFinite(value) && value > 0) values.push(value);
  }
  if (!values.length) return null;
  values.sort((left, right) => left - right);
  return values[Math.floor(values.length / 2)];
}

function segmentQuoteSample(ticks, startIndex, endIndex) {
  let resolvedTicks = 0;
  let totalTicks = 0;
  const upThreshold = 0.92;
  const downThreshold = 0.08;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const up = ticks[index].upPrice;
    const down = ticks[index].downPrice;
    if (up == null || down == null || !Number.isFinite(up) || !Number.isFinite(down)) continue;
    totalTicks += 1;
    const upWon = up >= upThreshold && down <= downThreshold;
    const downWon = down >= upThreshold && up <= downThreshold;
    if (upWon || downWon) resolvedTicks += 1;
  }

  return { resolvedTicks, totalTicks };
}

export function quotesInResolutionZone(ticks, startIndex, endIndex, opts = {}) {
  const ratioMin = opts.resolvedQuoteRatioMin ?? 0.75;
  const { resolvedTicks, totalTicks } = segmentQuoteSample(ticks, startIndex, endIndex, opts);
  return totalTicks > 0 && (resolvedTicks / totalTicks) >= ratioMin;
}

export function underlyingFarFromPtb(ticks, startIndex, endIndex, opts = {}) {
  const ratioMin = opts.farFromPtbRatioMin ?? 0.00025;
  const shareMin = opts.farFromPtbShareMin ?? 0.7;
  let farTicks = 0;
  let totalTicks = 0;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const underlying = ticks[index].underlyingPrice;
    const ptb = ticks[index].priceToBeat;
    if (underlying == null || ptb == null || !Number.isFinite(underlying) || !Number.isFinite(ptb) || ptb <= 0) {
      continue;
    }
    totalTicks += 1;
    if (Math.abs(underlying - ptb) / ptb >= ratioMin) farTicks += 1;
  }

  return totalTicks > 0 && (farTicks / totalTicks) >= shareMin;
}

function isResolvedMarketSegment(ticks, startIndex, endIndex, opts = {}) {
  if (quotesInResolutionZone(ticks, startIndex, endIndex, opts)) return true;
  // Spot longe do PTB só isenta trim quando as odds também estão travadas no extremo.
  if (!underlyingFarFromPtb(ticks, startIndex, endIndex, opts)) return false;
  const first = ticks[startIndex];
  const last = ticks[endIndex];
  return quotesMatch(first, last)
    && (quotesInResolutionZone(ticks, startIndex, endIndex, { ...opts, resolvedQuoteRatioMin: 0.5 })
      || (first.upPrice >= 0.85 || first.downPrice >= 0.85));
}

export function resolveSegmentMoveThresholds(ticks, startIndex, endIndex, opts = {}) {
  const ref = medianUnderlyingInSegment(ticks, startIndex, endIndex) ?? 100_000;
  const minUnderlyingMove = opts.minUnderlyingMove ?? Math.max(20, ref * 0.00025);
  const quietUnderlyingMax = opts.quietUnderlyingMax ?? Math.max(5, ref * 0.00008);
  const frozenUnderlyingMax = opts.frozenUnderlyingMax ?? quietUnderlyingMax * 2;
  const minQuoteMove = opts.minQuoteMove ?? 0.003;
  return { minUnderlyingMove, quietUnderlyingMax, frozenUnderlyingMax, minQuoteMove, refUnderlying: ref };
}

function medianAbsUnderlyingDelta(ticks, startIndex, endIndex) {
  const deltas = [];
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    const left = ticks[index - 1].underlyingPrice;
    const right = ticks[index].underlyingPrice;
    if (left == null || right == null || !Number.isFinite(left) || !Number.isFinite(right)) continue;
    deltas.push(Math.abs(right - left));
  }
  if (!deltas.length) return 0;
  deltas.sort((left, right) => left - right);
  return deltas[Math.floor(deltas.length / 2)];
}

export function underlyingFeedLooksStuck(ticks, startIndex, endIndex, opts = {}) {
  const { quietUnderlyingMax, frozenUnderlyingMax } = resolveSegmentMoveThresholds(ticks, startIndex, endIndex, opts);
  const underlyingRange = underlyingRangeInSegment(ticks, startIndex, endIndex);
  const startTs = parseTsMs(ticks[startIndex]?.ts);
  const endTs = parseTsMs(ticks[endIndex]?.ts);
  const durationSec = startTs != null && endTs != null ? Math.max(0, (endTs - startTs) / 1000) : 0;
  const minStaleDriftSec = opts.minStaleDriftSec ?? 45;
  const stuckTickDelta = opts.stuckTickDelta ?? Math.max(0.02, quietUnderlyingMax * 0.004);

  if (underlyingRange <= quietUnderlyingMax) return true;
  if (durationSec < minStaleDriftSec) return false;

  const medianDelta = medianAbsUnderlyingDelta(ticks, startIndex, endIndex);
  const driftRangeMax = opts.driftRangeMax ?? Math.max(frozenUnderlyingMax, quietUnderlyingMax * 2.5);
  return medianDelta <= stuckTickDelta && underlyingRange <= driftRangeMax;
}

export function classifyFlatQuoteSegment(ticks, startIndex, endIndex, opts = {}) {
  const startTs = parseTsMs(ticks[startIndex]?.ts);
  const endTs = parseTsMs(ticks[endIndex]?.ts);
  const durationSec = startTs != null && endTs != null ? Math.max(0, (endTs - startTs) / 1000) : 0;
  const minStaleSec = opts.minStaleSec ?? 30;
  const underlyingRange = underlyingRangeInSegment(ticks, startIndex, endIndex);
  const { minUnderlyingMove, quietUnderlyingMax } = resolveSegmentMoveThresholds(ticks, startIndex, endIndex, opts);
  const booksFlat = booksFlatInSegment(ticks, startIndex, endIndex);

  const base = {
    feed: 'clob',
    startIndex,
    endIndex,
    durationSec,
    underlyingRange,
    booksFlat,
    minUnderlyingMove,
    quietUnderlyingMax,
  };

  if (durationSec < minStaleSec) {
    return { ...base, classification: 'too_short' };
  }

  if (underlyingRange <= quietUnderlyingMax) {
    return { ...base, classification: 'confirmed_quiet_market' };
  }

  if (isResolvedMarketSegment(ticks, startIndex, endIndex, opts)) {
    return { ...base, classification: 'resolved_market' };
  }

  if (booksFlat === false) {
    return { ...base, classification: 'book_active' };
  }

  if (underlyingRange >= minUnderlyingMove) {
    return { ...base, classification: 'clob_stale' };
  }

  return { ...base, classification: 'noise' };
}

export function classifyFlatUnderlyingSegment(ticks, startIndex, endIndex, opts = {}) {
  const startTs = parseTsMs(ticks[startIndex]?.ts);
  const endTs = parseTsMs(ticks[endIndex]?.ts);
  const durationSec = startTs != null && endTs != null ? Math.max(0, (endTs - startTs) / 1000) : 0;
  const minStaleSec = opts.minStaleSec ?? 30;
  const underlyingRange = underlyingRangeInSegment(ticks, startIndex, endIndex);
  const { quietUnderlyingMax, minQuoteMove } = resolveSegmentMoveThresholds(ticks, startIndex, endIndex, opts);
  const { upRange, downRange } = quotesRangeInSegment(ticks, startIndex, endIndex);
  const quoteRange = Math.max(upRange, downRange);
  const booksFlat = booksFlatInSegment(ticks, startIndex, endIndex);

  const base = {
    feed: 'underlying',
    startIndex,
    endIndex,
    durationSec,
    underlyingRange,
    quoteRange,
    booksFlat,
    quietUnderlyingMax,
    minQuoteMove,
  };

  if (durationSec < minStaleSec) {
    return { ...base, classification: 'too_short' };
  }

  if (quoteRange < minQuoteMove && booksFlat !== false) {
    return { ...base, classification: 'confirmed_quiet_market' };
  }

  if (quoteRange >= minQuoteMove || booksFlat === false) {
    if (underlyingFeedLooksStuck(ticks, startIndex, endIndex, opts)) {
      return { ...base, classification: 'underlying_stale' };
    }
    return { ...base, classification: 'underlying_quiet' };
  }

  return { ...base, classification: 'noise' };
}

export function analyzeFlatQuoteSegments(ticks, opts = {}) {
  if (ticks.length < 2) return [];

  const segments = [];
  let streakStart = 0;

  for (let index = 1; index < ticks.length; index += 1) {
    if (quotesMatch(ticks[index - 1], ticks[index])) continue;

    segments.push(classifyFlatQuoteSegment(ticks, streakStart, index - 1, opts));
    streakStart = index;
  }

  segments.push(classifyFlatQuoteSegment(ticks, streakStart, ticks.length - 1, opts));
  return segments.filter((segment) => segment.classification !== 'too_short');
}

export function analyzeFlatUnderlyingSegments(ticks, opts = {}) {
  if (ticks.length < 2) return [];

  const segments = [];
  let streakStart = 0;

  for (let index = 1; index < ticks.length; index += 1) {
    const { quietUnderlyingMax } = resolveSegmentMoveThresholds(ticks, streakStart, index - 1, opts);
    const pairwiseFlat = underlyingPricesMatch(ticks[index - 1], ticks[index], quietUnderlyingMax);
    const segmentRange = underlyingRangeInSegment(ticks, streakStart, index);
    const segmentStillQuiet = segmentRange <= quietUnderlyingMax;

    if (pairwiseFlat && segmentStillQuiet) continue;

    segments.push(classifyFlatUnderlyingSegment(ticks, streakStart, index - 1, opts));
    streakStart = index;
  }

  segments.push(classifyFlatUnderlyingSegment(ticks, streakStart, ticks.length - 1, opts));
  return segments.filter((segment) => segment.classification !== 'too_short');
}

export function analyzeTrimSegments(ticks, opts = {}) {
  return [
    ...analyzeFlatQuoteSegments(ticks, opts),
    ...analyzeFlatUnderlyingSegments(ticks, opts),
  ];
}

export function collectTrimIssues(segments) {
  const issues = [];
  if (segments.some((segment) => segment.classification === 'clob_stale')) issues.push('clob_stale');
  if (segments.some((segment) => segment.classification === 'underlying_stale')) issues.push('underlying_stale');
  return issues;
}

function addSegmentIndices(target, ticks, segments, classification) {
  for (const segment of segments) {
    if (segment.classification !== classification) continue;
    for (let index = segment.startIndex; index <= segment.endIndex; index += 1) target.add(index);
  }
}

export function findClobStaleTickIndices(ticks, opts = {}) {
  const stale = new Set();
  addSegmentIndices(stale, ticks, analyzeFlatQuoteSegments(ticks, opts), 'clob_stale');
  return stale;
}

export function findUnderlyingStaleTickIndices(ticks, opts = {}) {
  const stale = new Set();
  addSegmentIndices(stale, ticks, analyzeFlatUnderlyingSegments(ticks, opts), 'underlying_stale');
  return stale;
}

export function findTrimTickIndices(ticks, opts = {}) {
  const trim = new Set();
  for (const index of findClobStaleTickIndices(ticks, opts)) trim.add(index);
  for (const index of findUnderlyingStaleTickIndices(ticks, opts)) trim.add(index);
  return trim;
}

export function eventUnderlyingRange(ticks) {
  if (!ticks.length) return 0;
  return underlyingRangeInSegment(ticks, 0, ticks.length - 1);
}

export function eventSpotMovedMaterially(ticks, opts = {}) {
  if (ticks.length < 2) return false;
  const { minUnderlyingMove } = resolveSegmentMoveThresholds(ticks, 0, ticks.length - 1, opts);
  return eventUnderlyingRange(ticks) >= minUnderlyingMove;
}

export function findUnderlyingFlatTickIndices(ticks, opts = {}) {
  const flat = new Set();
  const minStaleSec = opts.minStaleSec ?? 30;
  for (const segment of analyzeFlatUnderlyingSegments(ticks, opts)) {
    if (segment.durationSec < minStaleSec) continue;
    for (let index = segment.startIndex; index <= segment.endIndex; index += 1) flat.add(index);
  }
  return flat;
}

export function collectOmitIssues(ticks, omitIndices, opts = {}) {
  const issues = [];
  const clobStale = findClobStaleTickIndices(ticks, opts);
  const underlyingStale = findUnderlyingStaleTickIndices(ticks, opts);
  const underlyingFlat = findUnderlyingFlatTickIndices(ticks, opts);
  for (const index of omitIndices) {
    if (clobStale.has(index)) {
      issues.push('clob_stale');
      break;
    }
  }
  for (const index of omitIndices) {
    if (underlyingStale.has(index)) {
      issues.push('underlying_stale');
      break;
    }
  }
  for (const index of omitIndices) {
    if (underlyingFlat.has(index)) {
      issues.push('underlying_flat');
      break;
    }
  }
  return issues;
}

export function findOmitTickIndices(ticks, opts = {}) {
  const omit = findTrimTickIndices(ticks, opts);
  if (omit.size && eventSpotMovedMaterially(ticks, opts)) {
    for (const index of findUnderlyingStaleTickIndices(ticks, opts)) omit.delete(index);
  }
  for (const index of findUnderlyingFlatTickIndices(ticks, opts)) omit.add(index);
  return omit;
}
