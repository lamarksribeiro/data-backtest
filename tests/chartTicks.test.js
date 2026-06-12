import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChartTicksFromScalars,
  spotPriceForChart,
  summarizeChartTicks,
} from '../src/quality/chartTicks.js';

function row(index, underlying, ptb = 63_517.89) {
  return {
    ts: new Date(Date.parse('2026-06-11T19:05:00.000Z') + index * 1000).toISOString(),
    underlyingPrice: underlying,
    priceToBeat: ptb,
    upPrice: 0.52,
    downPrice: 0.48,
  };
}

test('spotPriceForChart rejects zero and tiny values', () => {
  assert.equal(spotPriceForChart(0), null);
  assert.equal(spotPriceForChart(63_588.4), 63_588.4);
});

test('buildChartTicksFromScalars trims leading invalid rows before sampling', () => {
  const ticks = Array.from({ length: 30 }, (_, index) => row(index, index < 4 ? 0 : 63_500 + index));
  const chart = buildChartTicksFromScalars(ticks);
  assert.ok(chart.length > 0);
  assert.ok(chart.every((item) => item.underlying_price >= 1000));
  assert.equal(chart[0].underlying_price, 63_504);
});

test('OK exported ticks keep visible spot movement in chart meta', () => {
  const ticks = Array.from({ length: 120 }, (_, index) => row(index, 63_500 + index * 0.35));
  const chart = buildChartTicksFromScalars(ticks);
  const meta = summarizeChartTicks(chart);
  assert.equal(meta.spot_points, chart.length);
  assert.equal(meta.has_spot_movement, true);
  assert.ok(meta.spot_range > 10);
});
