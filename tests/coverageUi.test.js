import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { upsertManifestPartition } from '../src/state/manifest.js';
import { createPrepareJob } from '../src/state/prepareJobs.js';
import { getDataCoverage, invalidateCoverageCache, mapStatusToUiState, aggregateCoverageDays } from '../src/query/coverageUi.js';
import { buildDataFixPlan, describeFixActions } from '../src/data/fixPipeline.js';
import { testServerConfig } from './testAuth.js';

test('mapStatusToUiState maps 9 statuses to 3 UI states', () => {
  assert.equal(mapStatusToUiState('valid'), 'ready');
  assert.equal(mapStatusToUiState('accepted'), 'ready');
  assert.equal(mapStatusToUiState('writing'), 'processing');
  assert.equal(mapStatusToUiState('stale'), 'attention');
  assert.equal(mapStatusToUiState('missing'), 'attention');
});

test('aggregateCoverageDays summarizes ready/processing/attention', () => {
  const { days, summary } = aggregateCoverageDays([
    { dt: '2026-06-01', status: 'valid', rows: 10 },
    { dt: '2026-06-02', status: 'missing', rows: 0 },
  ]);
  assert.equal(days.length, 2);
  assert.equal(summary.ready, 1);
  assert.equal(summary.attention, 1);
});

test('getDataCoverage aggregates days with derived ui_state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'coverage-ui-'));
  const config = testServerConfig({ stateDbPath: path.join(dir, 'state.db') });
  const db = openStateDatabase(config.stateDbPath);
  try {
    upsertManifestPartition(db, {
      dataset: 'backtest_ticks',
      underlying: 'BTC',
      interval: '5m',
      bookDepth: 25,
      dt: '2026-06-01',
      activePath: '/lake/a.parquet',
      status: 'valid',
    });
    upsertManifestPartition(db, {
      dataset: 'backtest_ticks',
      underlying: 'BTC',
      interval: '5m',
      bookDepth: 25,
      dt: '2026-06-02',
      activePath: null,
      status: 'missing',
    });
    createPrepareJob(db, {
      request: {
        dataset: 'backtest_ticks',
        from: '2026-06-02T00:00:00.000Z',
        to: '2026-06-03T00:00:00.000Z',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 25,
      },
      mode: 'prepare',
      dryRun: false,
      plan: { ready: false, preparation: [] },
    });
    const params = new URLSearchParams({
      underlying: 'BTC',
      interval: '5m',
      book_depth: '25',
      from: '2026-06-01',
      to: '2026-06-02',
    });
    const coverage = getDataCoverage(db, params, config);
    assert.equal(coverage.days.length, 2);
    assert.equal(coverage.summary.ready, 1);
    assert.equal(coverage.summary.processing, 1);
    assert.equal(coverage.days[1].active_jobs[0].id, 1);
  } finally {
    closeStateDatabase(db);
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('getDataCoverage full cache applies current requested range on cache hit', async () => {
  invalidateCoverageCache();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'coverage-ui-cache-'));
  const config = testServerConfig({ stateDbPath: path.join(dir, 'state.db') });
  const db = openStateDatabase(config.stateDbPath);
  try {
    for (const dt of ['2026-06-01', '2026-06-02', '2026-06-15']) {
      upsertManifestPartition(db, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 25,
        dt,
        activePath: `/lake/${dt}.parquet`,
        status: 'valid',
      });
    }
    const base = {
      underlying: 'BTC',
      interval: '5m',
      book_depth: '25',
      full: '1',
    };
    const first = getDataCoverage(db, new URLSearchParams({ ...base, from: '2026-06-01', to: '2026-06-02' }), config);
    const second = getDataCoverage(db, new URLSearchParams({ ...base, from: '2026-06-01', to: '2026-06-15' }), config);
    assert.equal(first.to_date, '2026-06-02');
    assert.equal(second.to_date, '2026-06-15');
    assert.equal(second.from_date, '2026-06-01');
  } finally {
    invalidateCoverageCache();
    closeStateDatabase(db);
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('describeFixActions reads dates from preparation args', () => {
  const lines = describeFixActions([{
    command: 'sync:backfill-backtest-ticks',
    args: ['--from', '2026-05-01T00:00:00.000Z', '--to', '2026-05-08T00:00:00.000Z', '--underlying', 'BTC', '--interval', '5m', '--book-depth', '25'],
  }]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /2026-05-01/);
  assert.match(lines[0], /2026-05-07/);
  assert.doesNotMatch(lines[0], /2026-05-08/);
  assert.doesNotMatch(lines[0], /undefined/);
});

test('buildDataFixPlan returns summary for unavailable window', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fix-plan-'));
  const config = testServerConfig({ stateDbPath: path.join(dir, 'state.db') });
  const db = openStateDatabase(config.stateDbPath);
  try {
    const built = buildDataFixPlan(db, {
      dataset: 'backtest_ticks',
      from: '2026-06-01',
      to: '2026-06-02',
      underlying: 'BTC',
      interval: '5m',
      book_depth: 25,
    }, config);
    assert.equal(built.ready, false);
    assert.ok(built.summary);
    const lines = describeFixActions(built.preparation);
    for (const line of lines) assert.doesNotMatch(line, /undefined/);
  } finally {
    closeStateDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildDataFixPlan schedules rebuild for ready partitions when rebuild=true', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fix-plan-rebuild-'));
  const config = testServerConfig({ stateDbPath: path.join(dir, 'state.db') });
  const db = openStateDatabase(config.stateDbPath);
  try {
    upsertManifestPartition(db, {
      dataset: 'backtest_ticks',
      underlying: 'BTC',
      interval: '5m',
      bookDepth: 25,
      dt: '2026-06-01',
      activePath: '/lake/a.parquet',
      status: 'valid',
    });
    const built = buildDataFixPlan(db, {
      dataset: 'backtest_ticks',
      from: '2026-06-01',
      to: '2026-06-01',
      underlying: 'BTC',
      interval: '5m',
      book_depth: 25,
      rebuild: true,
    }, config);
    assert.equal(built.ready, false);
    assert.equal(built.rebuild_required, true);
    assert.ok(built.preparation.length > 0);
    assert.ok(built.preparation[0].args.includes('--rebuild'));
    assert.match(built.summary, /reprocessados/);
  } finally {
    closeStateDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});
