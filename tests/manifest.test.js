import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { acceptEligibleReviewPartitions, acceptManifestPartition, listManifest, manifestStats, revokeAcceptedManifestPartition, upsertManifestPartition } from '../src/state/manifest.js';
import { cleanupOrphanParquetFiles } from '../src/lake/cleanup.js';
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
      assert.equal(stats.usable, 1);
      assert.equal(stats.warnings, 0);
      assert.equal(stats.blocked, 0);

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

test('manifest can accept and revoke needs_review partitions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-manifest-accept-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state', 'data-backtest.db'));
    try {
      const partition = {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 25,
        dt: '2026-06-02',
      };
      upsertManifestPartition(db, {
        ...partition,
        activePath: '/lake/backtest_ticks/review.parquet',
        rows: 172749,
        status: 'needs_review',
        error: 'actual tick count 172749 differs from event_quality 171733',
      });

      const accepted = acceptManifestPartition(db, partition, 'difference below tolerance');
      assert.equal(accepted.ok, true);
      assert.equal(accepted.partition.status, 'accepted');
      assert.match(accepted.partition.error, /difference below tolerance/);

      const revoked = revokeAcceptedManifestPartition(db, partition, 'bad sample');
      assert.equal(revoked.ok, true);
      assert.equal(revoked.partition.status, 'needs_review');
      assert.match(revoked.partition.error, /bad sample/);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('manifest bulk accepts eligible stale event_quality mismatches', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-manifest-bulk-accept-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state', 'data-backtest.db'));
    try {
      const base = {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 25,
      };
      upsertManifestPartition(db, {
        ...base,
        dt: '2026-06-02',
        activePath: '/lake/backtest_ticks/review-small.parquet',
        rows: 172749,
        status: 'needs_review',
        error: 'actual tick count 172749 differs from event_quality 171733',
      });
      upsertManifestPartition(db, {
        ...base,
        dt: '2026-06-03',
        activePath: '/lake/backtest_ticks/review-large.parquet',
        rows: 100,
        status: 'needs_review',
        error: 'actual tick count 100 differs from event_quality 1000',
      });

      const result = acceptEligibleReviewPartitions(db, {
        ...base,
        fromDt: '2026-06-02',
        toDt: '2026-06-03',
      }, 0.02);

      assert.equal(result.accepted.length, 1);
      assert.equal(result.skipped.length, 1);
      const rows = listManifest(db, { limit: 10 }).sort((left, right) => left.dt.localeCompare(right.dt));
      assert.equal(rows[0].status, 'accepted');
      assert.equal(rows[1].status, 'needs_review');
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('lake cleanup removes only parquet files not referenced by active_path', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-lake-cleanup-'));
  try {
    const lakeRoot = path.join(dir, 'lake');
    const partitionDir = path.join(lakeRoot, 'backtest_ticks', 'underlying=BTC', 'interval=5m', 'book_depth=25', 'dt=2026-06-04');
    await mkdir(partitionDir, { recursive: true });
    const activePath = path.join(partitionDir, 'part-active.parquet');
    const oldPath = path.join(partitionDir, 'part-old.parquet');
    await writeFile(activePath, 'active');
    await writeFile(oldPath, 'old');

    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      upsertManifestPartition(db, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 25,
        dt: '2026-06-04',
        activePath,
        status: 'valid',
      });

      const result = await cleanupOrphanParquetFiles({
        db,
        lakeRoot,
        relativePath: 'backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-06-04',
      });

      assert.equal(result.deleted.length, 1);
      assert.match(result.deleted[0].relativePath, /part-old\.parquet$/);
      assert.equal(await readFile(activePath, 'utf8'), 'active');
      await assert.rejects(() => readFile(oldPath, 'utf8'), /ENOENT/);
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
