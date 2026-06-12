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

function withClobStaleStreak(length, { staleFrom, staleTo, minStaleSec = 20 }) {
  const ticks = [];
  const baseMs = Date.parse('2026-06-01T14:00:00.000Z');
  for (let index = 0; index < length; index += 1) {
    const stale = index >= staleFrom && index < staleTo;
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
  return { ticks, minStaleSec };
}

test('normalizeEvent keeps clean events untouched', () => {
  const ticks = Array.from({ length: 20 }, (_, index) => tick(index));
  const result = normalizeEventTicks(ticks, { omitEventBadRatio: 0.5, minStaleSec: 30 });
  assert.equal(result.action, 'keep');
  assert.equal(result.exportTicks.length, 20);
});

test('normalizeEvent keeps incomplete feed at boundaries without trimming', () => {
  const ticks = Array.from({ length: 20 }, (_, index) => tick(index));
  ticks[0] = { ...ticks[0], priceToBeat: null };
  ticks[1] = { ...ticks[1], underlyingPrice: null };
  ticks[19] = { ...ticks[19], upPrice: null, downPrice: null };
  const result = normalizeEventTicks(ticks, { omitEventBadRatio: 0.5, minStaleSec: 30 });
  assert.equal(result.action, 'keep');
  assert.equal(result.exportTicks.length, 20);
});

test('normalizeEvent keeps event when majority of ticks have incomplete feed but no clob_stale', () => {
  const ticks = Array.from({ length: 10 }, (_, index) => tick(index));
  for (let index = 0; index < 6; index += 1) {
    ticks[index] = { ...ticks[index], underlyingPrice: null };
  }
  const result = normalizeEventTicks(ticks, { omitEventBadRatio: 0.5, minStaleSec: 30 });
  assert.equal(result.action, 'keep');
  assert.equal(result.exportTicks.length, 10);
});

test('normalizeEvent keeps full event when stale ratio is below omit threshold', () => {
  const { ticks, minStaleSec } = withClobStaleStreak(80, { staleFrom: 20, staleTo: 45 });
  const result = normalizeEventTicks(ticks, { omitEventBadRatio: 0.5, minStaleSec });
  assert.equal(result.action, 'keep');
  assert.equal(result.exportTicks.length, ticks.length);
  assert.deepEqual(result.issues, []);
});

test('normalizeEvent keeps full event when only part of ticks are underlying stale', () => {
  const baseMs = Date.parse('2026-06-01T14:00:00.000Z');
  const ticks = Array.from({ length: 80 }, (_, index) => {
    const desynced = index >= 20 && index < 55;
    return {
      ...tick(index),
      ts: new Date(baseMs + index * 1000).toISOString(),
      underlyingPrice: desynced ? 100_000 : 100_000 + index,
      upPrice: desynced ? 0.50 + (index % 10) * 0.004 : 0.52 + (index % 4) * 0.001,
      downPrice: desynced ? 0.50 - (index % 10) * 0.004 : 0.48 - (index % 4) * 0.001,
      upBestBid: desynced ? 0.49 + (index % 10) * 0.004 : 0.51 + (index % 4) * 0.001,
      upBestAsk: desynced ? 0.51 + (index % 10) * 0.004 : 0.53 + (index % 4) * 0.001,
      downBestBid: desynced ? 0.47 - (index % 10) * 0.004 : 0.47 - (index % 4) * 0.001,
      downBestAsk: desynced ? 0.49 - (index % 10) * 0.004 : 0.49 - (index % 4) * 0.001,
    };
  });
  const result = normalizeEventTicks(ticks, { omitEventBadRatio: 0.5, minStaleSec: 30, minQuoteMove: 0.003 });
  assert.equal(result.action, 'keep');
  assert.equal(result.exportTicks.length, ticks.length);
  assert.deepEqual(result.issues, []);
});

test('normalizeEvent omits when majority of ticks have prolonged flat spot', () => {
  const ticks = Array.from({ length: 40 }, (_, index) => ({
    ...tick(index),
    ts: new Date(Date.parse('2026-06-01T14:00:00.000Z') + index * 1000).toISOString(),
    underlyingPrice: 100_000,
    upPrice: 0.52,
    downPrice: 0.48,
    upBestBid: 0.51,
    upBestAsk: 0.53,
    downBestBid: 0.47,
    downBestAsk: 0.49,
  }));
  const result = normalizeEventTicks(ticks, { omitEventBadRatio: 0.5, minStaleSec: 30 });
  assert.equal(result.action, 'omit');
  assert.equal(result.exportTicks.length, 0);
  assert.ok(result.issues.includes('underlying_flat'));
});

test('normalizeEvent omits when spot stays flat for most of event even with late move', () => {
  const baseMs = Date.parse('2026-06-12T06:10:00.000Z');
  const ptb = 62_590.88;
  const ticks = Array.from({ length: 600 }, (_, index) => {
    const phase = index / 599;
    const underlying = phase < 0.9 ? ptb : ptb - (phase - 0.9) * 280;
    const up = phase < 0.55 ? 0.52 : Math.min(1, 0.52 + (phase - 0.55) * 1.1);
    const down = 1 - up;
    return {
      conditionId: '0xcac407',
      eventStart: '2026-06-12T06:10:00.000Z',
      eventEnd: '2026-06-12T06:15:00.000Z',
      ts: new Date(baseMs + index * 500).toISOString(),
      underlyingPrice: underlying,
      priceToBeat: ptb,
      upPrice: up,
      downPrice: down,
      upBestBid: up - 0.01,
      upBestAsk: up + 0.01,
      downBestBid: down - 0.01,
      downBestAsk: down + 0.01,
    };
  });
  const result = normalizeEventTicks(ticks, { omitEventBadRatio: 0.5, minStaleSec: 30, minQuoteMove: 0.003 });
  assert.equal(result.action, 'omit');
  assert.ok(result.issues.includes('underlying_flat'));
});

test('normalizeEvent keeps event when spot swings materially despite underlying_stale windows', () => {
  const baseMs = Date.parse('2026-06-12T03:15:00.000Z');
  const ptb = 62_600;
  const ticks = Array.from({ length: 600 }, (_, index) => {
    const phase = index / 599;
    const swing = Math.sin(phase * Math.PI) * 380;
    const underlying = 62_200 + swing + index * 0.02;
    const up = 0.42 + 0.38 * (0.5 + 0.5 * Math.sin(phase * Math.PI * 3));
    const down = 1 - up;
    return {
      conditionId: '0x9054',
      eventStart: '2026-06-12T03:15:00.000Z',
      eventEnd: '2026-06-12T03:20:00.000Z',
      ts: new Date(baseMs + index * 500).toISOString(),
      underlyingPrice: underlying,
      priceToBeat: ptb,
      upPrice: up,
      downPrice: down,
      upBestBid: up - 0.01,
      upBestAsk: up + 0.01,
      downBestBid: down - 0.01,
      downBestAsk: down + 0.01,
    };
  });

  const result = normalizeEventTicks(ticks, { omitEventBadRatio: 0.5, minStaleSec: 30, minQuoteMove: 0.003 });
  assert.equal(result.action, 'keep');
  assert.equal(result.exportTicks.length, 600);
  assert.deepEqual(result.issues, []);
});

test('normalizeEvent omits when spot drifts slowly but odds keep moving', () => {
  const ptb = 62_515.58;
  const baseMs = Date.parse('2026-06-11T14:00:00.000Z');
  const ticks = Array.from({ length: 600 }, (_, index) => {
    const phase = index / 600;
    const up = 0.5 + 0.48 * Math.min(1, Math.max(0, (phase - 0.75) / 0.25));
    return {
      conditionId: '0xabc',
      eventStart: '2026-06-11T14:00:00.000Z',
      eventEnd: '2026-06-11T14:05:00.000Z',
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
  const result = normalizeEventTicks(ticks, { omitEventBadRatio: 0.5, minStaleSec: 30 });
  assert.equal(result.action, 'omit');
  assert.equal(result.exportTicks.length, 0);
  assert.ok(result.issues.includes('underlying_stale'));
});

test('normalizeEvent omits when majority of ticks are clob_stale', () => {
  const { ticks, minStaleSec } = withClobStaleStreak(40, { staleFrom: 0, staleTo: 30 });
  const result = normalizeEventTicks(ticks, { omitEventBadRatio: 0.5, minStaleSec });
  assert.equal(result.action, 'omit');
  assert.equal(result.exportTicks.length, 0);
});

test('normalizePartition aggregates hours affected and export quality stays valid', () => {
  const good = Array.from({ length: 20 }, (_, index) => tick(index, { up: 0.51, down: 0.49 }));
  const { ticks: badEvent, minStaleSec } = withClobStaleStreak(40, { staleFrom: 0, staleTo: 30 });
  badEvent.forEach((row) => {
    row.conditionId = '0xbad';
    row.eventStart = '2026-06-01T15:00:00.000Z';
  });

  const result = normalizePartitionTicks([...good, ...badEvent], { omitEventBadRatio: 0.5, minStaleSec });
  assert.equal(result.report.events_total, 2);
  assert.equal(result.report.events_omitted, 1);
  assert.equal(result.report.events_kept, 1);
  assert.ok(result.report.hours_affected.some((entry) => entry.hour === 15));

  const quality = classifyExportQuality({
    actualRows: result.exportTicks.length,
    expectedRows: 60,
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
