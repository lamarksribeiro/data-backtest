import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEventTicks } from '../src/quality/normalizeEvent.js';
import { normalizePartitionTicks } from '../src/quality/normalizePartition.js';
import { classifyExportQuality } from '../src/sync/qualityPolicy.js';

function tick(index, {
  underlying = 100000 + index,
  up = 0.52,
  down = 0.48,
  ptb = 99999,
} = {}) {
  const second = String(index).padStart(2, '0');
  return {
    conditionId: '0xabc',
    eventStart: '2026-06-01T14:00:00.000Z',
    eventEnd: '2026-06-01T14:05:00.000Z',
    ts: `2026-06-01T14:00:${second}.000Z`,
    underlyingPrice: underlying,
    priceToBeat: ptb,
    upPrice: up,
    downPrice: down,
    upBestBid: up - 0.01,
    upBestAsk: up + 0.01,
    downBestBid: down - 0.01,
    downBestAsk: down + 0.01,
  };
}

test('normalizeEvent keeps clean events untouched', () => {
  const ticks = Array.from({ length: 20 }, (_, index) => tick(index));
  const result = normalizeEventTicks(ticks, { omitEventBadRatio: 0.5, minStaleSec: 30 });
  assert.equal(result.action, 'keep');
  assert.equal(result.exportTicks.length, 20);
});

test('normalizeEvent trims when minority of ticks are incomplete', () => {
  const ticks = Array.from({ length: 20 }, (_, index) => tick(index));
  ticks[5] = { ...ticks[5], underlyingPrice: null };
  ticks[6] = { ...ticks[6], underlyingPrice: null };
  const result = normalizeEventTicks(ticks, { omitEventBadRatio: 0.5, minStaleSec: 30 });
  assert.equal(result.action, 'trim');
  assert.equal(result.exportTicks.length, 18);
  assert.ok(result.issues.includes('null_underlying'));
});

test('normalizeEvent omits when majority of ticks are incomplete', () => {
  const ticks = Array.from({ length: 10 }, (_, index) => tick(index));
  for (let index = 0; index < 6; index += 1) {
    ticks[index] = { ...ticks[index], underlyingPrice: null };
  }
  const result = normalizeEventTicks(ticks, { omitEventBadRatio: 0.5, minStaleSec: 30 });
  assert.equal(result.action, 'omit');
  assert.equal(result.exportTicks.length, 0);
});

test('normalizeEvent trims clob_stale streaks below omit threshold', () => {
  const ticks = [];
  const baseMs = Date.parse('2026-06-01T14:00:00.000Z');
  for (let index = 0; index < 80; index += 1) {
    const stale = index >= 20 && index < 45;
    ticks.push({
      ...tick(index),
      ts: new Date(baseMs + index * 1000).toISOString(),
      underlyingPrice: stale ? 100000 + index * 10 : 100000 + index,
      upPrice: stale ? 0.52 : 0.52 + (index % 4) * 0.001,
      downPrice: stale ? 0.48 : 0.48 - (index % 4) * 0.001,
      upBestBid: stale ? 0.51 : 0.51 + (index % 4) * 0.001,
      upBestAsk: stale ? 0.53 : 0.53 + (index % 4) * 0.001,
      downBestBid: stale ? 0.47 : 0.47 - (index % 4) * 0.001,
      downBestAsk: stale ? 0.49 : 0.49 - (index % 4) * 0.001,
    });
  }
  const result = normalizeEventTicks(ticks, { omitEventBadRatio: 0.5, minStaleSec: 20 });
  assert.equal(result.action, 'trim');
  assert.ok(result.exportTicks.length < ticks.length);
  assert.ok(result.issues.includes('clob_stale'));
});

test('normalizePartition aggregates hours affected and export quality stays valid', () => {
  const good = Array.from({ length: 20 }, (_, index) => tick(index, { up: 0.51, down: 0.49 }));
  const badEvent = Array.from({ length: 10 }, (_, index) => tick(index, { up: 0.51, down: 0.49 }));
  for (let index = 0; index < 6; index += 1) badEvent[index] = { ...badEvent[index], underlyingPrice: null };
  badEvent.forEach((row) => {
    row.conditionId = '0xbad';
    row.eventStart = '2026-06-01T15:00:00.000Z';
  });

  const result = normalizePartitionTicks([...good, ...badEvent], { omitEventBadRatio: 0.5, minStaleSec: 30 });
  assert.equal(result.report.events_total, 2);
  assert.equal(result.report.events_omitted, 1);
  assert.equal(result.report.events_kept, 1);
  assert.ok(result.report.hours_affected.some((entry) => entry.hour === 15));

  const quality = classifyExportQuality({
    actualRows: result.exportTicks.length,
    expectedRows: 30,
    normalization: result.report,
    maxDayOmitRatio: 0.5,
  });
  assert.equal(quality.status, 'valid');
  assert.equal(quality.normalizationApplied, true);
});

test('classifyExportQuality needs review when entire day is omitted', () => {
  const quality = classifyExportQuality({
    actualRows: 0,
    expectedRows: 1000,
    normalization: {
      applied: true,
      events_total: 10,
      events_exported: 0,
      events_omitted: 10,
      skip_ratio: 1,
      ticks_removed: 1000,
    },
    maxDayOmitRatio: 0.5,
  });
  assert.equal(quality.status, 'needs_review');
});
