import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { upsertManifestPartition } from '../src/state/manifest.js';
import { resolveDataRequest, requireStrictDataRequest } from '../src/query/dataMode.js';

test('strict mode resolves ready when all partitions are valid', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-mode-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      upsertManifestPartition(db, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 10,
        dt: '2026-05-31',
        activePath: '/lake/backtest_ticks/part.parquet',
        status: 'valid',
      });

      const request = requestFor('backtest_ticks', '2026-05-31T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
      const result = resolveDataRequest(db, request, 'strict');
      assert.equal(result.ready, true);
      assert.equal(result.status, 'ready');
      assert.equal(requireStrictDataRequest(db, request).ready, true);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('strict mode accepts manually accepted warning partitions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-mode-accepted-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      upsertManifestPartition(db, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 10,
        dt: '2026-05-31',
        activePath: '/lake/backtest_ticks/accepted.parquet',
        status: 'accepted',
        error: 'Accepted: mismatch below tolerance',
      });

      const request = requestFor('backtest_ticks', '2026-05-31T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
      const result = resolveDataRequest(db, request, 'strict');
      assert.equal(result.ready, true);
      assert.equal(result.availability.partitions[0].status, 'accepted');
      assert.equal(requireStrictDataRequest(db, request).ready, true);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('prepare mode with rebuild plans already valid degraded partitions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-mode-rebuild-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      upsertManifestPartition(db, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 10,
        dt: '2026-05-31',
        activePath: '/lake/backtest_ticks/valid.parquet',
        hasDegraded: true,
        status: 'valid',
      });

      const request = {
        ...requestFor('backtest_ticks', '2026-05-31T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
        rebuild: true,
      };
      const result = resolveDataRequest(db, request, 'prepare');

      assert.equal(result.ready, false);
      assert.equal(result.status, 'prepare_required');
      assert.equal(result.preparation.length, 1);
      assert.equal(result.preparation[0].command, 'sync:backfill-backtest-ticks');
      assert.ok(result.preparation[0].args.includes('--rebuild'));
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('prepare mode with rebuild stays ready when no partition is degraded', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-mode-rebuild-clean-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      upsertManifestPartition(db, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 10,
        dt: '2026-05-31',
        activePath: '/lake/backtest_ticks/valid.parquet',
        hasDegraded: false,
        status: 'valid',
      });

      const request = {
        ...requestFor('backtest_ticks', '2026-05-31T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
        rebuild: true,
      };
      const result = resolveDataRequest(db, request, 'prepare');

      assert.equal(result.ready, true);
      assert.equal(result.status, 'ready');
      assert.equal(result.preparation.length, 0);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('prepare mode returns sync plan for missing backtest_ticks partitions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-prepare-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const request = requestFor('backtest_ticks', '2026-05-31T00:00:00.000Z', '2026-06-02T00:00:00.000Z');
      const result = resolveDataRequest(db, request, 'prepare');
      assert.equal(result.ready, false);
      assert.equal(result.status, 'prepare_required');
      assert.deepEqual(result.availability.missing, ['2026-05-31', '2026-06-01']);
      assert.equal(result.preparation.length, 1);
      assert.equal(result.preparation[0].command, 'sync:backfill-backtest-ticks');
      assert.deepEqual(result.preparation[0].args, [
        '--from', '2026-05-31T00:00:00.000Z',
        '--to', '2026-06-02T00:00:00.000Z',
        '--underlying', 'BTC',
        '--interval', '5m',
        '--book-depth', '10',
      ]);
      assert.throws(() => requireStrictDataRequest(db, request), /Dataset not available for strict mode/);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('prepare mode returns scalar prerequisite for missing ohlc partitions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-prepare-ohlc-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const result = resolveDataRequest(db, {
        dataset: 'ohlc',
        underlying: 'BTC',
        interval: '5m',
        resolution: '1m',
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
      }, 'prepare');

      assert.equal(result.preparation.length, 2);
      assert.equal(result.preparation[0].command, 'sync:backfill');
      assert.equal(result.preparation[0].prerequisite, true);
      assert.equal(result.preparation[1].command, 'sync:backfill-ohlc');
      assert.ok(result.preparation[1].args.includes('--resolution'));
      assert.ok(result.preparation[1].args.includes('1m'));
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function requestFor(dataset, from, to) {
  return {
    dataset,
    underlying: 'BTC',
    interval: '5m',
    bookDepth: dataset === 'backtest_ticks' ? 10 : null,
    from,
    to,
  };
}
