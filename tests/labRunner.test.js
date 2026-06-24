import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveChunkDays } from '../labs/shared/labRunner.js';
import { checkDatasetAvailability } from '../src/query/availability.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { listManifest, upsertManifestPartition } from '../src/state/manifest.js';

test('resolveChunkDays defaults to single-pass sweep', () => {
  assert.equal(resolveChunkDays({ name: 'smoke' }), 0);
  assert.equal(resolveChunkDays({ name: 'smoke', chunkDays: 0 }), 0);
});

test('resolveChunkDays enables daily chunks via dailyMetrics', () => {
  assert.equal(resolveChunkDays({ dailyMetrics: true }), 1);
});

test('resolveChunkDays prefers explicit chunkDays over dailyMetrics', () => {
  assert.equal(resolveChunkDays({ dailyMetrics: true, chunkDays: 7 }), 7);
  assert.equal(resolveChunkDays({ dailyMetrics: true }, { chunkDays: 3 }), 3);
});

test('lab availability path can use readonly SQLite without auto-accept writes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-lab-readonly-'));
  const dbPath = path.join(dir, 'state', 'data-backtest.db');
  try {
    const writable = openStateDatabase(dbPath);
    try {
      upsertManifestPartition(writable, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 25,
        dt: '2026-06-02',
        activePath: '/lake/backtest_ticks/review-small.parquet',
        rows: 172749,
        status: 'needs_review',
        error: 'actual tick count 172749 differs from event_quality 171733',
      });
    } finally {
      closeStateDatabase(writable);
    }

    const readonly = openStateDatabase(dbPath, { readOnly: true });
    try {
      const availability = checkDatasetAvailability(readonly, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 25,
        from: '2026-06-02T00:00:00.000Z',
        to: '2026-06-03T00:00:00.000Z',
        autoAcceptReviewPartitions: false,
      });
      assert.equal(availability.ok, false);
      assert.equal(availability.unavailable[0].status, 'needs_review');
    } finally {
      closeStateDatabase(readonly);
    }

    const verify = openStateDatabase(dbPath);
    try {
      assert.equal(listManifest(verify)[0].status, 'needs_review');
    } finally {
      closeStateDatabase(verify);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
