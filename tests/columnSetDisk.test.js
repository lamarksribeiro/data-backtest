import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
	serializeColumnSet,
	deserializeColumnSet,
	writeColumnSetPartition,
	readColumnSetPartition,
	readPartitionMeta,
	partitionBinPath,
	partitionMetaPath,
} from '../src/backtest/columnSetDisk.js';
import { buildEventIndex } from '../src/backtest/columnStore.js';

function sampleColumnSet() {
	const length = 4;
	const columns = new Map([
		['_ts_ms', new Float64Array([1000, 2000, 3000, 4000])],
		['_event_start_ms', new Float64Array([1000, 1000, 3000, 3000])],
		['_event_end_ms', new Float64Array([5000, 5000, 7000, 7000])],
		['underlying_price', new Float64Array([100, 101, 102, 103])],
	]);
	const codes = new Map([
		['condition_id', new Int32Array([0, 0, 1, 1])],
	]);
	const flags = new Map();
	const dictionaries = new Map([
		['condition_id', ['c1', 'c2']],
	]);
	return {
		length,
		columns,
		codes,
		flags,
		dictionaries,
		events: buildEventIndex({ length, codes, columns }),
	};
}

test('columnSet disk roundtrip preserves typed data', () => {
	const original = sampleColumnSet();
	const restored = deserializeColumnSet(serializeColumnSet(original));
	assert.equal(restored.length, original.length);
	assert.equal(restored.columns.get('underlying_price')[2], 102);
	assert.equal(restored.dictionaries.get('condition_id')[1], 'c2');
	assert.equal(restored.events.length, 2);
});

test('writeColumnSetPartition writes bin and meta atomically', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'disk-part-'));
	try {
		const columnSet = sampleColumnSet();
		const binPath = partitionBinPath(dir, '2026-05-01');
		const metaPath = partitionMetaPath(dir, '2026-05-01');
		writeColumnSetPartition({
			binPath,
			metaPath,
			columnSet,
			meta: { dt: '2026-05-01', source_fingerprint: 'fp1', active_path: 'lake/x.parquet' },
		});
		const meta = readPartitionMeta(metaPath);
		assert.equal(meta.dt, '2026-05-01');
		assert.equal(meta.rows, 4);
		const loaded = readColumnSetPartition(binPath);
		assert.equal(loaded.length, 4);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
