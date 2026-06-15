import test from 'node:test';
import assert from 'node:assert/strict';

import { concatColumnSets, sliceColumnSet } from '../src/backtest/columnSetMerge.js';
import { buildEventIndex } from '../src/backtest/columnStore.js';

function dayColumnSet(baseMs, conditionId, rows = 2) {
	const length = rows;
	const ts = new Float64Array(length);
	const starts = new Float64Array(length);
	const ends = new Float64Array(length);
	for (let i = 0; i < length; i += 1) {
		ts[i] = baseMs + i * 1000;
		starts[i] = baseMs;
		ends[i] = baseMs + 5000;
	}
	const columns = new Map([
		['_ts_ms', ts],
		['_event_start_ms', starts],
		['_event_end_ms', ends],
		['underlying_price', new Float64Array(length).fill(100)],
	]);
	const codes = new Map([['condition_id', new Int32Array(length).fill(0)]]);
	const dictionaries = new Map([['condition_id', [conditionId]]]);
	return {
		length,
		columns,
		codes,
		flags: new Map(),
		dictionaries,
		events: buildEventIndex({ length, codes, columns }),
	};
}

test('concatColumnSets merges dictionaries across days', () => {
	const a = dayColumnSet(1_000, 'cond-a');
	const b = dayColumnSet(10_000, 'cond-b');
	const merged = concatColumnSets([a, b]);
	assert.equal(merged.length, 4);
	assert.deepEqual(merged.dictionaries.get('condition_id'), ['cond-a', 'cond-b']);
	assert.equal(merged.codes.get('condition_id')[2], 1);
});

test('sliceColumnSet trims by timestamp window', () => {
	const a = dayColumnSet(0, 'cond-a', 5);
	const sliced = sliceColumnSet(a, 2000, 4000);
	assert.equal(sliced.length, 2);
	assert.equal(sliced.columns.get('_ts_ms')[0], 2000);
	assert.equal(sliced.columns.get('_ts_ms')[1], 3000);
});

test('subset window inside merged range keeps only matching ticks', () => {
	const a = dayColumnSet(0, 'cond-a', 3);
	const b = dayColumnSet(10_000, 'cond-b', 3);
	const merged = concatColumnSets([a, b]);
	const subset = sliceColumnSet(merged, 1500, 10_500);
	assert.equal(subset.length, 2);
	assert.equal(subset.columns.get('_ts_ms')[0], 2000);
	assert.equal(subset.columns.get('_ts_ms')[1], 10_000);
});
