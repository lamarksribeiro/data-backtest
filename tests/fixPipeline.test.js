import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { upsertManifestPartition } from '../src/state/manifest.js';
import { buildDataFixPlan, runDataFix } from '../src/data/fixPipeline.js';
import { testServerConfig } from './testAuth.js';

test('runDataFix enfileira sync:backtest-ticks para dias missing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fix-missing-'));
  const config = testServerConfig({ stateDbPath: path.join(dir, 'state.db') });
  const db = openStateDatabase(config.stateDbPath);
  const enqueued = [];
  try {
    const result = runDataFix(db, config, {
      body: {
        request: {
          dataset: 'backtest_ticks',
          from: '2026-06-01',
          to: '2026-06-01',
          underlying: 'BTC',
          interval: '5m',
          book_depth: 25,
        },
      },
      prepareRunner: {
        enqueue(payload) {
          enqueued.push(payload);
          return { id: 42, status: 'queued' };
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.job?.id, 42);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].mode, 'prepare');
    assert.equal(enqueued[0].dryRun, false);

    const plan = buildDataFixPlan(db, enqueued[0].request, config);
    assert.ok(plan.preparation.length > 0);
    assert.equal(plan.preparation[0].command, 'sync:backfill-backtest-ticks');
    assert.equal(plan.preparation[0].args.includes('--rebuild'), false);
  } finally {
    closeStateDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});

test('runDataFix exige confirm e aplica --rebuild em needs_review', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fix-review-'));
  const config = testServerConfig({ stateDbPath: path.join(dir, 'state.db') });
  const db = openStateDatabase(config.stateDbPath);
  const enqueued = [];
  try {
    upsertManifestPartition(db, {
      dataset: 'backtest_ticks',
      underlying: 'BTC',
      interval: '5m',
      bookDepth: 25,
      dt: '2026-06-01',
      activePath: '/lake/review.parquet',
      status: 'needs_review',
    });

    const request = {
      dataset: 'backtest_ticks',
      from: '2026-06-01',
      to: '2026-06-01',
      underlying: 'BTC',
      interval: '5m',
      book_depth: 25,
    };

    const dry = runDataFix(db, config, {
      body: { request },
      dryRun: true,
      prepareRunner: { enqueue() { throw new Error('dry_run não deve enfileirar'); } },
    });
    assert.equal(dry.ok, true);
    assert.equal(dry.needs_rebuild_confirm, true);
    assert.ok(dry.preparation_count > 0);

    const blocked = runDataFix(db, config, {
      body: { request },
      dryRun: false,
      prepareRunner: { enqueue() { throw new Error('sem confirm não deve enfileirar'); } },
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'CONFIRMATION_REQUIRED');

    const result = runDataFix(db, config, {
      body: { request, confirm_rebuild: true },
      dryRun: false,
      prepareRunner: {
        enqueue(payload) {
          enqueued.push(payload);
          return { id: 7, status: 'queued' };
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.job?.id, 7);
    assert.equal(enqueued.length, 1);

    // O plano reavaliado no enqueue inclui --rebuild para needs_review.
    const { resolveDataRequest } = await import('../src/query/dataMode.js');
    const queuedPlan = resolveDataRequest(db, enqueued[0].request, 'prepare');
    assert.equal(queuedPlan.preparation[0].command, 'sync:backfill-backtest-ticks');
    assert.ok(queuedPlan.preparation[0].args.includes('--rebuild'));
    assert.equal(Boolean(enqueued[0].request.rebuild), false);
  } finally {
    closeStateDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});

test('runDataFix retorna ready sem job quando período já está válido', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fix-ready-'));
  const config = testServerConfig({ stateDbPath: path.join(dir, 'state.db') });
  const db = openStateDatabase(config.stateDbPath);
  try {
    upsertManifestPartition(db, {
      dataset: 'backtest_ticks',
      underlying: 'BTC',
      interval: '5m',
      bookDepth: 25,
      dt: '2026-06-01',
      activePath: '/lake/ok.parquet',
      status: 'valid',
    });
    const result = runDataFix(db, config, {
      body: {
        request: {
          dataset: 'backtest_ticks',
          from: '2026-06-01',
          to: '2026-06-01',
          underlying: 'BTC',
          interval: '5m',
          book_depth: 25,
        },
      },
      prepareRunner: { enqueue() { throw new Error('ready não deve enfileirar'); } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.ready, true);
    assert.equal(result.job, undefined);
  } finally {
    closeStateDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});
