import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  activePathToLakeRelative,
  buildManifestQuery,
  manifestRowToEntry,
  planLakePull,
} from '../src/ops/lakePull.js';

test('activePathToLakeRelative strips /lake prefix', () => {
  assert.equal(
    activePathToLakeRelative('/lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-06-01/part-abc.parquet'),
    'backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-06-01/part-abc.parquet',
  );
});

test('buildManifestQuery filters by range, dataset and status', () => {
  const sql = buildManifestQuery({
    from: '2026-06-01',
    to: '2026-06-07',
    underlying: 'BTC',
    interval: '5m',
    bookDepth: 25,
    datasets: ['backtest_ticks'],
    statuses: ['valid', 'accepted'],
  });

  assert.match(sql, /dt >= '2026-06-01'/);
  assert.match(sql, /dt <= '2026-06-07'/);
  assert.match(sql, /underlying = 'BTC'/);
  assert.match(sql, /interval = '5m'/);
  assert.match(sql, /book_depth = 25/);
  assert.match(sql, /dataset IN \('backtest_ticks'\)/);
  assert.match(sql, /status IN \('valid', 'accepted'\)/);
});

test('buildManifestQuery escapes single quotes', () => {
  const sql = buildManifestQuery({
    from: "2026-06-01'; DROP TABLE lake_manifest; --",
    to: '2026-06-02',
    datasets: ['scalars'],
    statuses: ['valid'],
  });
  assert.match(sql, /''; DROP TABLE lake_manifest; --'/);
});

test('manifestRowToEntry maps sqlite row to upsert payload', () => {
  const entry = manifestRowToEntry({
    dataset: 'backtest_ticks',
    market_id: null,
    underlying: 'BTC',
    interval: '5m',
    resolution: null,
    book_depth: 25,
    dt: '2026-06-01',
    active_path: '/lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-06-01/part-abc.parquet',
    run_id: 'abc',
    rows: 100,
    events_count: 288,
    min_ts: '2026-06-01T00:00:00.000Z',
    max_ts: '2026-06-01T23:59:59.000Z',
    coverage_min: 0.99,
    has_degraded: 0,
    quality_details_json: '{"events_omitted":1}',
    source_tick_count: 100,
    source_condition_count: 288,
    source_quality_recorded_at_max: '2026-06-02T00:00:00.000Z',
    source_fingerprint: 'fp',
    status: 'valid',
    verified_at: '2026-06-02T01:00:00.000Z',
    error: null,
  });

  assert.equal(entry.dataset, 'backtest_ticks');
  assert.equal(entry.bookDepth, 25);
  assert.equal(entry.activePath, '/lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-06-01/part-abc.parquet');
  assert.deepEqual(entry.qualityDetails, { events_omitted: 1 });
});

test('planLakePull deduplicates files and builds remote paths', () => {
  const rows = [
    {
      dataset: 'backtest_ticks',
      underlying: 'BTC',
      interval: '5m',
      dt: '2026-06-01',
      status: 'valid',
      active_path: '/lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-06-01/part-abc.parquet',
    },
    {
      dataset: 'backtest_ticks',
      underlying: 'BTC',
      interval: '5m',
      dt: '2026-06-02',
      status: 'valid',
      active_path: '/lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-06-02/part-def.parquet',
    },
  ];

  const plan = planLakePull({
    rows,
    remoteLakeRoot: '/data/goldenlens/lakehouse',
    localLakeRoot: path.join('/tmp', 'lake'),
  });

  assert.equal(plan.files.length, 2);
  assert.equal(
    plan.files[0].remoteAbsolutePath,
    '/data/goldenlens/lakehouse/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-06-01/part-abc.parquet',
  );
  assert.equal(
    plan.files[0].localAbsolutePath,
    path.join('/tmp', 'lake', 'backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-06-01/part-abc.parquet'),
  );
});
