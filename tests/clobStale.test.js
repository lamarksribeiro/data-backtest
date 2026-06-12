import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeFlatQuoteSegments,
  analyzeFlatUnderlyingSegments,
  findClobStaleTickIndices,
  findTrimTickIndices,
  findUnderlyingStaleTickIndices,
  underlyingFeedLooksStuck,
} from '../src/quality/clobStale.js';
import { normalizeEventTicks } from '../src/quality/normalizeEvent.js';

function buildTicks({
  length,
  secondStep = 1,
  quoteForIndex = () => ({ up: 0.52, down: 0.48 }),
  underlyingForIndex = (index) => 100_000 + index,
  bookForIndex = null,
}) {
  const baseMs = Date.parse('2026-06-01T14:00:00.000Z');
  return Array.from({ length }, (_, index) => {
    const { up, down } = quoteForIndex(index);
    const books = bookForIndex ? bookForIndex(index, up, down) : {
      upBestBid: up - 0.01,
      upBestAsk: up + 0.01,
      downBestBid: down - 0.01,
      downBestAsk: down + 0.01,
    };
    return {
      ts: new Date(baseMs + index * secondStep * 1000).toISOString(),
      underlyingPrice: underlyingForIndex(index),
      upPrice: up,
      downPrice: down,
      ...books,
    };
  });
}

test('confirmed quiet market keeps flat quotes when underlying is also flat', () => {
  const ticks = buildTicks({
    length: 35,
    quoteForIndex: () => ({ up: 0.52, down: 0.48 }),
    underlyingForIndex: () => 100_000,
  });
  const segments = analyzeFlatQuoteSegments(ticks, { minStaleSec: 30 });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].classification, 'confirmed_quiet_market');
  assert.equal(findClobStaleTickIndices(ticks, { minStaleSec: 30 }).size, 0);
});

test('noise segment keeps event when underlying barely moves during flat quotes', () => {
  const ticks = buildTicks({
    length: 35,
    quoteForIndex: () => ({ up: 0.52, down: 0.48 }),
    underlyingForIndex: (index) => 100_000 + (index % 2 === 0 ? 0 : 8),
  });
  const segments = analyzeFlatQuoteSegments(ticks, { minStaleSec: 30, quietUnderlyingMax: 5, minUnderlyingMove: 25 });
  assert.equal(segments[0].classification, 'noise');
  assert.equal(findClobStaleTickIndices(ticks, { minStaleSec: 30, quietUnderlyingMax: 5, minUnderlyingMove: 25 }).size, 0);
});

test('book active segment is not trimmed when quotes are flat but book updates', () => {
  const ticks = buildTicks({
    length: 35,
    quoteForIndex: () => ({ up: 0.52, down: 0.48 }),
    underlyingForIndex: (index) => 100_000 + index * 20,
    bookForIndex: (index, up, down) => ({
      upBestBid: up - 0.01 - (index % 3) * 0.001,
      upBestAsk: up + 0.01,
      downBestBid: down - 0.01,
      downBestAsk: down + 0.01 + (index % 3) * 0.001,
    }),
  });
  const segments = analyzeFlatQuoteSegments(ticks, { minStaleSec: 30 });
  assert.equal(segments[0].classification, 'book_active');
  assert.equal(findClobStaleTickIndices(ticks, { minStaleSec: 30 }).size, 0);
});

test('clob stale segment trims when quotes and book freeze with meaningful underlying move', () => {
  const ticks = buildTicks({
    length: 40,
    quoteForIndex: () => ({ up: 0.52, down: 0.48 }),
    underlyingForIndex: (index) => 100_000 + index * 15,
  });
  const segments = analyzeFlatQuoteSegments(ticks, { minStaleSec: 30 });
  assert.equal(segments[0].classification, 'clob_stale');
  assert.ok(findClobStaleTickIndices(ticks, { minStaleSec: 30 }).size >= 30);
});

test('underlying stale segment trims when spot freezes but up down keep moving', () => {
  const ticks = buildTicks({
    length: 40,
    underlyingForIndex: () => 100_000,
    quoteForIndex: (index) => ({
      up: 0.50 + (index % 10) * 0.004,
      down: 0.50 - (index % 10) * 0.004,
    }),
  });
  const segments = analyzeFlatUnderlyingSegments(ticks, { minStaleSec: 30, minQuoteMove: 0.003 });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].classification, 'underlying_stale');
  assert.ok(findUnderlyingStaleTickIndices(ticks, { minStaleSec: 30, minQuoteMove: 0.003 }).size >= 30);
  assert.equal(findClobStaleTickIndices(ticks, { minStaleSec: 30 }).size, 0);
});

test('underlying quiet market with small spot movement is not trimmed', () => {
  const baseMs = Date.parse('2026-06-11T22:10:00.000Z');
  const ticks = Array.from({ length: 600 }, (_, index) => {
    const up = 0.52 + (index % 8) * 0.01;
    return {
      ts: new Date(baseMs + index * 500).toISOString(),
      underlyingPrice: 61_900 + (index % 20) * 0.4,
      priceToBeat: 61_910,
      upPrice: up,
      downPrice: 1 - up,
      upBestBid: up - 0.01,
      upBestAsk: up + 0.01,
      downBestBid: (1 - up) - 0.01,
      downBestAsk: (1 - up) + 0.01,
    };
  });

  assert.equal(findUnderlyingStaleTickIndices(ticks, { minStaleSec: 30 }).size, 0);
  const result = normalizeEventTicks(ticks, { omitEventBadRatio: 0.5, minStaleSec: 30 });
  assert.equal(result.action, 'keep');
  assert.equal(result.exportTicks.length, 600);
});

test('flat underlying streak breaks when cumulative range exceeds quiet band', () => {
  const ticks = buildTicks({
    length: 200,
    secondStep: 0.5,
    underlyingForIndex: (index) => 62_000 + index * 0.08,
    quoteForIndex: (index) => ({
      up: 0.50 + (index % 10) * 0.004,
      down: 0.50 - (index % 10) * 0.004,
    }),
  });
  const segments = analyzeFlatUnderlyingSegments(ticks, { minStaleSec: 30, minQuoteMove: 0.003 });
  assert.ok(segments.length >= 2);
  assert.ok(segments.every((segment) => segment.underlyingRange <= 6));
  assert.ok(segments.every((segment) => segment.endIndex - segment.startIndex < 80));
});

test('underlyingFeedLooksStuck distinguishes frozen feed from small oscillation', () => {
  const frozen = buildTicks({
    length: 80,
    underlyingForIndex: (index) => 100_000 + index * 0.02,
    quoteForIndex: (index) => ({
      up: 0.50 + (index % 10) * 0.004,
      down: 0.50 - (index % 10) * 0.004,
    }),
  });
  const oscillating = buildTicks({
    length: 80,
    underlyingForIndex: (index) => 100_000 + Math.sin(index / 4) * 6,
    quoteForIndex: (index) => ({
      up: 0.50 + (index % 10) * 0.004,
      down: 0.50 - (index % 10) * 0.004,
    }),
  });
  assert.equal(underlyingFeedLooksStuck(frozen, 0, frozen.length - 1, { minStaleSec: 30 }), true);
  assert.equal(underlyingFeedLooksStuck(oscillating, 0, oscillating.length - 1, { minStaleSec: 30 }), false);
});

test('underlying stale requires exact frozen spot even when odds keep moving', () => {
  const ptb = 62_515.58;
  const baseMs = Date.parse('2026-06-11T14:00:00.000Z');
  const frozen = Array.from({ length: 600 }, (_, index) => {
    const phase = index / 600;
    const up = 0.5 + 0.48 * Math.min(1, Math.max(0, (phase - 0.75) / 0.25));
    return {
      ts: new Date(baseMs + index * 500).toISOString(),
      underlyingPrice: 62_487.69,
      priceToBeat: ptb,
      upPrice: up,
      downPrice: 1 - up,
      upBestBid: up - 0.01,
      upBestAsk: up + 0.01,
      downBestBid: (1 - up) - 0.01,
      downBestAsk: (1 - up) + 0.01,
    };
  });
  const drifting = Array.from({ length: 600 }, (_, index) => {
    const phase = index / 600;
    const up = 0.5 + 0.48 * Math.min(1, Math.max(0, (phase - 0.75) / 0.25));
    return {
      ts: new Date(baseMs + index * 500).toISOString(),
      underlyingPrice: index < 30 ? ptb - 20 + index * 0.3 : 62_487.69 + (index - 30) * 0.02,
      priceToBeat: ptb,
      upPrice: up,
      downPrice: 1 - up,
      upBestBid: up - 0.01,
      upBestAsk: up + 0.01,
      downBestBid: (1 - up) - 0.01,
      downBestAsk: (1 - up) + 0.01,
    };
  });

  const frozenSegments = analyzeFlatUnderlyingSegments(frozen, { minStaleSec: 30 });
  const driftingSegments = analyzeFlatUnderlyingSegments(drifting, { minStaleSec: 30 });
  assert.ok(frozenSegments.some((segment) => segment.classification === 'underlying_stale'));
  assert.ok(findUnderlyingStaleTickIndices(frozen, { minStaleSec: 30 }).size >= 300);
  assert.equal(driftingSegments.some((segment) => segment.classification === 'underlying_stale'), false);
});

test('resolved market keeps flat quotes near 1/0 when underlying moved away from PTB', () => {
  const ptb = 63_517.89;
  const ticks = buildTicks({
    length: 45,
    quoteForIndex: (index) => (index < 10
      ? { up: 0.55 + index * 0.03, down: 0.45 - index * 0.03 }
      : { up: 0.99, down: 0.01 }),
    underlyingForIndex: (index) => ptb + (index < 10 ? index * 2 : 180 + index),
  }).map((tick) => ({ ...tick, priceToBeat: ptb }));

  const segments = analyzeFlatQuoteSegments(ticks, { minStaleSec: 30 });
  const resolved = segments.filter((segment) => segment.classification === 'resolved_market');
  assert.ok(resolved.length >= 1);
  assert.equal(findClobStaleTickIndices(ticks, { minStaleSec: 30 }).size, 0);
});

test('underlying stale is not flagged when quotes lock into resolution zone', () => {
  const ptb = 100_000;
  const ticks = buildTicks({
    length: 40,
    underlyingForIndex: () => 100_180,
    quoteForIndex: (index) => ({ up: 0.98, down: 0.02 }),
  }).map((tick) => ({ ...tick, priceToBeat: ptb }));

  const segments = analyzeFlatUnderlyingSegments(ticks, { minStaleSec: 30, minQuoteMove: 0.003 });
  assert.equal(segments.some((segment) => segment.classification === 'underlying_stale'), false);
  assert.equal(findUnderlyingStaleTickIndices(ticks, { minStaleSec: 30, minQuoteMove: 0.003 }).size, 0);
});

test('findTrimTickIndices unions clob stale and underlying stale windows', () => {
  const ticks = buildTicks({
    length: 80,
    underlyingForIndex: (index) => (index < 40 ? 100_000 : 100_000 + (index - 40) * 15),
    quoteForIndex: (index) => (index < 40
      ? { up: 0.50 + (index % 10) * 0.004, down: 0.50 - (index % 10) * 0.004 }
      : { up: 0.52, down: 0.48 }),
  });
  const trim = findTrimTickIndices(ticks, { minStaleSec: 30, minQuoteMove: 0.003 });
  assert.ok(trim.size >= 55);
});
