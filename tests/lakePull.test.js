import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  activePathToLakeRelative,
  buildManifestQuery,
  fetchRemoteManifestRows,
  manifestRowToEntry,
  parseRemoteManifestJson,
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

test('parseRemoteManifestJson parses sqlite3 -json output', () => {
  const rows = parseRemoteManifestJson('[{"dataset":"backtest_ticks","dt":"2026-06-17","underlying":"BTC"}]');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset, 'backtest_ticks');
  assert.deepEqual(parseRemoteManifestJson(''), []);
});

test('fetchRemoteManifestRows prefers docker exec node over scp', async () => {
  const calls = [];
  const rows = await fetchRemoteManifestRows({
    remoteHost: 'Brutus',
    remoteStatePath: '/data/goldenlens/backtest-state/data-backtest.db',
    query: 'SELECT 1',
    remoteContainer: 'abc123',
    runCommand: async (command, args) => {
      calls.push([command, args]);
      if (command === 'ssh' && args[1]?.includes('docker exec')) {
        return '[{"dataset":"backtest_ticks","dt":"2026-06-17","underlying":"BTC","active_path":"/lake/x.parquet","status":"valid"}]';
      }
      throw new Error(`${command} should not be called`);
    },
    log: () => {},
  });

  assert.equal(rows.length, 1);
  assert.match(calls[0][1][1], /docker exec -i abc123 node --input-type=module/);
});

test('fetchRemoteManifestRows falls back to scp when remote node fails', async () => {
  const calls = [];
  await assert.rejects(
    fetchRemoteManifestRows({
      remoteHost: 'Brutus',
      remoteStatePath: '/data/goldenlens/backtest-state/data-backtest.db',
      query: 'SELECT 1',
      remoteContainer: 'abc123',
      runCommand: async (command) => {
        calls.push(command);
        if (command === 'ssh') throw new Error('docker exec failed');
        if (command === 'scp') throw new Error('scp failed');
        throw new Error(`unexpected command: ${command}`);
      },
      log: () => {},
    }),
    /scp failed/,
  );
  assert.deepEqual(calls, ['ssh', 'ssh', 'ssh', 'scp']);
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
