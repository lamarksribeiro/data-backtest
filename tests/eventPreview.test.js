import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEventPreviewFromTicks } from '../src/quality/eventPreview.js';
import { mapEventResultsToIndex } from '../src/quality/eventNormalizationIndex.js';
import { normalizePartitionTicks } from '../src/quality/normalizePartition.js';

function tick(index, { underlying = 100_000 + index, up = 0.52, down = 0.48 } = {}) {
  return {
    conditionId: '0xabc',
    eventStart: '2026-06-01T14:00:00.000Z',
    eventEnd: '2026-06-01T14:05:00.000Z',
    ts: new Date(Date.parse('2026-06-01T14:00:00.000Z') + index * 1000).toISOString(),
    underlyingPrice: underlying,
    priceToBeat: 99_999,
    upPrice: up,
    downPrice: down,
    upBestBid: up - 0.01,
    upBestAsk: up + 0.01,
    downBestBid: down - 0.01,
    downBestAsk: down + 0.01,
  };
}

test('buildEventPreviewFromTicks omits only when stale ratio crosses threshold', () => {
  const ticks = Array.from({ length: 80 }, (_, index) => {
    const desynced = index >= 20 && index < 55;
    return tick(index, {
      underlying: desynced ? 100_000 : 100_000 + index,
      up: desynced ? 0.50 + (index % 10) * 0.004 : 0.52,
      down: desynced ? 0.50 - (index % 10) * 0.004 : 0.48,
    });
  });
  const preview = buildEventPreviewFromTicks(ticks, { omitEventBadRatio: 0.5, minStaleSec: 30, minQuoteMove: 0.003 });
  assert.equal(preview.action, 'keep');
  assert.equal(preview.trim_regions.length, 0);
  assert.equal(preview.series.underlying.length, 80);
  assert.equal(preview.removed_ticks.length, 0);
});

test('buildEventPreviewFromTicks sanitizes chart ticks and drops zero spot', () => {
  const ticks = Array.from({ length: 20 }, (_, index) => tick(index, {
    underlying: index < 3 ? 0 : 63_500 + index * 2,
    up: 0.52,
    down: 0.48,
  }));
  ticks.forEach((row) => {
    row.priceToBeat = 63_517.89;
  });
  const preview = buildEventPreviewFromTicks(ticks);
  assert.equal(preview.series.underlying[0].value, null);
  assert.equal(preview.series.underlying[3].value, 63_506);
  assert.ok(preview.chart_ticks.length > 0);
  assert.ok(preview.chart_ticks.every((row) => row.underlying_price == null || row.underlying_price >= 1000));
  assert.ok(preview.chart_ticks.some((row) => row.underlying_price != null));
});

test('keep action chart uses exported ticks with movement', () => {
  const ticks = Array.from({ length: 25 }, (_, index) => tick(index, {
    underlying: 63_500 + index * 0.8,
    up: 0.50 + (index % 6) * 0.008,
    down: 0.50 - (index % 6) * 0.008,
  }));
  ticks.forEach((row) => {
    row.priceToBeat = 63_517.89;
  });
  const preview = buildEventPreviewFromTicks(ticks);
  assert.equal(preview.action, 'keep');
  assert.ok(preview.chart_meta.has_spot_movement);
  assert.ok(preview.chart_meta.spot_range > 5);
  assert.equal(preview.data_role, 'source');
});

test('normalizePartition stores full events_index', () => {
  const good = Array.from({ length: 20 }, (_, index) => tick(index));
  const bad = Array.from({ length: 40 }, (_, index) => tick(index, { up: 0.52, down: 0.48 }));
  bad.forEach((row, index) => {
    row.conditionId = '0xbad';
    row.underlyingPrice = index < 30 ? 100_000 + index * 15 : 100_000;
    row.upPrice = index < 30 ? 0.52 : 0.50 + (index % 10) * 0.004;
    row.downPrice = index < 30 ? 0.48 : 0.50 - (index % 10) * 0.004;
  });
  const result = normalizePartitionTicks([...good, ...bad], { omitEventBadRatio: 0.5, minStaleSec: 30, minQuoteMove: 0.003 });
  assert.equal(result.report.events_index.length, 2);
  const mapped = mapEventResultsToIndex(result.report.events_index);
  assert.equal(mapped.length, 2);
});
