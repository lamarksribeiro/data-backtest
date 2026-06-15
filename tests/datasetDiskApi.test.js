import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { createApiServer } from '../src/api/server.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { createTestAuthService, testServerConfig } from './testAuth.js';
import {
	writeColumnSetPartition,
	partitionBinPath,
	partitionMetaPath,
} from '../src/backtest/columnSetDisk.js';
import { buildEventIndex } from '../src/backtest/columnStore.js';

function sampleColumnSet() {
	const length = 2;
	const columns = new Map([
		['_ts_ms', new Float64Array([1000, 2000])],
		['_event_start_ms', new Float64Array([1000, 1000])],
		['_event_end_ms', new Float64Array([5000, 5000])],
	]);
	const codes = new Map([['condition_id', new Int32Array([0, 0])]]);
	const dictionaries = new Map([['condition_id', ['c1']]]);
	return {
		length,
		columns,
		codes,
		flags: new Map(),
		dictionaries,
		events: buildEventIndex({ length, codes, columns }),
	};
}

test('dataset-cache API returns stats and clears cache', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'dataset-cache-api-'));
	let server = null;
	try {
		const cacheDir = path.join(dir, 'dataset-cache');
		const config = testServerConfig({
			lakeRoot: path.join(dir, 'lake'),
			stateDbPath: path.join(dir, 'state.db'),
			datasetDiskCacheDir: cacheDir,
			datasetDiskCacheEnabled: true,
			datasetDiskCacheMaxGb: 0,
		});
		const db = openStateDatabase(config.stateDbPath);
		const authService = createTestAuthService(db);
		try {
			const groupDir = path.join(
				cacheDir,
				'backtest_ticks',
				'underlying=BTC',
				'interval=5m',
				'book_depth=25',
				'cols=abc123',
			);
			writeColumnSetPartition({
				binPath: partitionBinPath(groupDir, '2026-06-01'),
				metaPath: partitionMetaPath(groupDir, '2026-06-01'),
				columnSet: sampleColumnSet(),
				meta: {
					dt: '2026-06-01',
					source_fingerprint: 'fp',
					active_path: 'lake/x.parquet',
				},
			});

			server = createApiServer({ config, db, authService });
			await new Promise((resolve) => server.listen(0, resolve));
			const baseUrl = `http://127.0.0.1:${server.address().port}`;

			const stats = await getJson(`${baseUrl}/api/settings/dataset-cache`);
			assert.equal(stats.enabled, true);
			assert.equal(stats.cache_dir, cacheDir);
			assert.ok(stats.total_bytes > 0);
			assert.equal(stats.groups.length, 1);
			assert.equal(stats.groups[0].underlying, 'BTC');

			const cleared = await fetch(`${baseUrl}/api/settings/dataset-cache`, { method: 'DELETE' });
			assert.equal(cleared.status, 200);
			const body = await cleared.json();
			assert.equal(body.ok, true);
			assert.ok(body.removed_files >= 2);

			const after = await getJson(`${baseUrl}/api/settings/dataset-cache`);
			assert.equal(after.total_bytes, 0);
			assert.equal(after.total_files, 0);
		} finally {
			if (server) await new Promise((resolve) => server.close(resolve));
			closeStateDatabase(db);
		}
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
});

async function getJson(url) {
	const res = await fetch(url);
	assert.equal(res.status, 200);
	return res.json();
}
