import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEventIndex,
  createColumnSetBuilder,
  createTickCursorView,
  estimateColumnSetSize,
} from '../src/backtest/columnStore.js';

test('column set builder builds event index', () => {
  const builder = createColumnSetBuilder({ initialCapacity: 8 });
  builder.registerColumn('condition_id', 'code');
  builder.registerColumn('_ts_ms', 'ms');
  builder.registerColumn('_event_start_ms', 'ms');
  builder.registerColumn('_event_end_ms', 'ms');
  builder.registerColumn('price_to_beat', 'numeric');
  builder.registerColumn('underlying_price', 'numeric');

  const appendRow = (conditionId, startMs, endMs, price) => {
    builder.ensureCapacity(1);
    const i = builder.length;
    builder.codes.get('condition_id')[i] = builder.internCode('condition_id', conditionId);
    builder.columns.get('_ts_ms')[i] = startMs + 1;
    builder.columns.get('_event_start_ms')[i] = startMs;
    builder.columns.get('_event_end_ms')[i] = endMs;
    builder.columns.get('price_to_beat')[i] = price;
    builder.columns.get('underlying_price')[i] = price + 10;
    builder.length += 1;
  };

  appendRow('c1', 1000, 2000, 73000);
  appendRow('c1', 1000, 2000, 73001);
  appendRow('c2', 3000, 4000, 73100);

  const columnSet = builder.finalize();
  assert.equal(columnSet.length, 3);
  assert.equal(columnSet.events.length, 2);
  assert.equal(columnSet.events[0].startRow, 0);
  assert.equal(columnSet.events[0].endRow, 2);
  assert.equal(columnSet.events[0].startRow, 0);
  assert.equal(columnSet.events[1].startRow, 2);
  assert.equal(columnSet.events[1].endRow, 3);

  const cursor = createTickCursorView(columnSet);
  cursor.setIndex(1);
  assert.equal(cursor.condition_id, 'c1');
  assert.equal(cursor.underlying_price, 73011);
  assert.ok(Number.isFinite(cursor._tsMs));

  assert.ok(estimateColumnSetSize(columnSet) > 0);
});

test('buildEventIndex handles empty column set', () => {
  assert.deepEqual(buildEventIndex({ length: 0, codes: new Map(), columns: new Map() }), []);
});
