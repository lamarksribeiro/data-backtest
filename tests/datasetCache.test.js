import test from 'node:test';
import assert from 'node:assert/strict';

import {
  datasetCacheKey,
  fromColumnarBatch,
  getDatasetCache,
  materializeBatches,
  toColumnarBatch,
} from '../src/backtest/datasetCache.js';

test('dataset cache stores and returns column set without copy', () => {
  const cache = getDatasetCache(64);
  const key = datasetCacheKey({
    from: '2026-05-01T00:00:00.000Z',
    to: '2026-05-02T00:00:00.000Z',
    underlying: 'BTC',
    interval: '5m',
    bookDepth: 10,
  }, 'cols');
  const columnSet = {
    length: 1,
    columns: new Map([['_ts_ms', new Float64Array([Date.parse('2026-05-01T00:00:00.000Z')])]]),
    codes: new Map(),
    dictionaries: new Map(),
    flags: new Map(),
    events: [],
  };
  cache.set(key, columnSet);
  assert.equal(cache.get(key), columnSet);
  cache.clear();
});

test('dataset cache key changes with window', () => {
  const a = datasetCacheKey({ from: '2026-05-01', to: '2026-05-02', underlying: 'BTC', interval: '5m', bookDepth: 10 });
  const b = datasetCacheKey({ from: '2026-05-01', to: '2026-05-03', underlying: 'BTC', interval: '5m', bookDepth: 10 });
  assert.notEqual(a, b);
});

test('columnar batch roundtrip preserves tick rows', () => {
  const batch = [
    { ts: '2026-05-01T00:00:00.000Z', underlying_price: 73001.5, condition_id: 'c1' },
    { ts: '2026-05-01T00:00:01.000Z', underlying_price: 73002, condition_id: 'c1' },
  ];
  const columnar = toColumnarBatch(batch);
  assert.ok(columnar.columns.underlying_price instanceof Float64Array);
  assert.deepEqual(fromColumnarBatch(columnar), batch);
  assert.deepEqual(materializeBatches([columnar]), [batch]);
});
