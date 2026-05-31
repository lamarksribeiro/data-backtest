import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { listManifest, manifestStats, upsertManifestPartition } from '../src/state/manifest.js';
import { checkLakeStorage } from '../src/lake/storage.js';

test('manifest initializes in SQLite WAL and upserts partition', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state', 'data-backtest.db'));
    try {
      const journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode;
      assert.equal(String(journalMode).toLowerCase(), 'wal');

      upsertManifestPartition(db, {
        dataset: 'scalars',
        underlying: 'BTC',
        interval: '5m',
        dt: '2026-05-31',
        activePath: '/lake/scalars/underlying=BTC/interval=5m/dt=2026-05-31/part-test.parquet',
        runId: 'test',
        rows: 10,
        eventsCount: 1,
        sourceTickCount: 10,
        sourceConditionCount: 1,
        sourceFingerprint: 'fingerprint',
        status: 'valid',
      });

      const rows = listManifest(db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'valid');
      assert.equal(rows[0].source_fingerprint, 'fingerprint');

      const stats = manifestStats(db);
      assert.equal(stats.partitions, 1);
      assert.equal(stats.rows, 10);
      assert.equal(stats.by_status.valid, 1);

      upsertManifestPartition(db, {
        dataset: 'scalars',
        underlying: 'BTC',
        interval: '5m',
        dt: '2026-05-31',
        activePath: '/lake/scalars/underlying=BTC/interval=5m/dt=2026-05-31/part-rebuild.parquet',
        runId: 'rebuild',
        rows: 12,
        eventsCount: 1,
        sourceTickCount: 12,
        sourceConditionCount: 1,
        sourceFingerprint: 'fingerprint-rebuild',
        status: 'valid',
      });

      const rebuilt = listManifest(db);
      assert.equal(rebuilt.length, 1);
      assert.equal(rebuilt[0].rows, 12);
      assert.equal(rebuilt[0].run_id, 'rebuild');
      assert.equal(rebuilt[0].source_fingerprint, 'fingerprint-rebuild');
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('lake storage check creates expected writable layout', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-lake-'));
  try {
    const result = await checkLakeStorage(path.join(dir, 'lake'));
    assert.equal(result.ok, true);
    assert.equal(result.lake_root, path.join(dir, 'lake'));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
