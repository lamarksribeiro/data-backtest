import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeFlatQuoteSegments,
  analyzeFlatUnderlyingSegments,
  findClobStaleTickIndices,
  findTrimTickIndices,
  findUnderlyingStaleTickIndices,
} from '../src/quality/clobStale.js';

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
