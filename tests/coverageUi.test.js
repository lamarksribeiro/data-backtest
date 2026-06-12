import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { upsertManifestPartition } from '../src/state/manifest.js';
import { getDataCoverage, mapStatusToUiState, aggregateCoverageDays } from '../src/query/coverageUi.js';
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
    assert.equal(coverage.summary.attention, 1);
  } finally {
    closeStateDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});

test('describeFixActions reads dates from preparation args', () => {
  const lines = describeFixActions([{
    command: 'sync:backfill-backtest-ticks',
    args: ['--from', '2026-05-01T00:00:00.000Z', '--to', '2026-05-08T00:00:00.000Z', '--underlying', 'BTC', '--interval', '5m', '--book-depth', '25'],
  }]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /2026-05-01/);
  assert.match(lines[0], /2026-05-08/);
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
