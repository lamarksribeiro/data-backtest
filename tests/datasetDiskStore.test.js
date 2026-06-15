import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
	clearDatasetDiskCache,
	isPartitionCacheValid,
	scanDatasetDiskCache,
} from '../src/backtest/datasetDiskStore.js';
import {
	writeColumnSetPartition,
	partitionBinPath,
	partitionMetaPath,
} from '../src/backtest/columnSetDisk.js';
import { buildEventIndex } from '../src/backtest/columnStore.js';

test('isPartitionCacheValid rejects stale fingerprint', () => {
	const meta = { source_fingerprint: 'a', active_path: 'p1' };
	const row = { status: 'valid', source_fingerprint: 'b', active_path: 'p1' };
	assert.equal(isPartitionCacheValid(meta, row, '/tmp/x.bin'), false);
});

test('scan and clear dataset disk cache', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'disk-store-'));
	const config = { datasetDiskCacheDir: root, datasetDiskCacheMaxGb: 0 };
	const dir = path.join(root, 'backtest_ticks', 'underlying=BTC', 'interval=5m', 'book_depth=25', 'cols=abc');
	const columnSet = {
		length: 1,
		columns: new Map([['_ts_ms', new Float64Array([1])], ['_event_start_ms', new Float64Array([1])], ['_event_end_ms', new Float64Array([2])]]),
		codes: new Map([['condition_id', new Int32Array([0])]]),
		flags: new Map(),
		dictionaries: new Map([['condition_id', ['c1']]]),
		events: [],
	};
	columnSet.events = buildEventIndex({ length: 1, codes: columnSet.codes, columns: columnSet.columns });
	writeColumnSetPartition({
		binPath: partitionBinPath(dir, '2026-06-01'),
		metaPath: partitionMetaPath(dir, '2026-06-01'),
		columnSet,
		meta: { dt: '2026-06-01', source_fingerprint: 'fp', active_path: 'lake/a.parquet' },
	});
	const scan = scanDatasetDiskCache(config);
	assert.ok(scan.total_bytes > 0);
	assert.equal(scan.groups.length, 1);
	const cleared = clearDatasetDiskCache(config);
	assert.ok(cleared.removed_files >= 2);
	await rm(root, { recursive: true, force: true });
});
