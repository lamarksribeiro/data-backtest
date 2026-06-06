import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, stat } from 'node:fs/promises';

import { loadConfig } from '../src/config.js';
import { buildFinalParquetPath, buildTempParquetPath, toPortablePath } from '../src/lake/paths.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { upsertManifestPartition } from '../src/state/manifest.js';
import { resolutionToIntervalSql, writeBacktestTicksParquet, writeBooksParquet, writeOhlcParquetFromScalars, writeScalarsParquet } from '../src/sync/duckdbParquet.js';
import { createBacktestTicksRowsChecksum, createBooksRowsChecksum, createScalarRowsChecksum, createSourceFingerprint } from '../src/sync/fingerprint.js';
import { flattenBookTick, parseBookLevels } from '../src/sync/bookFlatten.js';
import { normalizeOhlcResolutions } from '../src/sync/ohlc.js';
import { incrementalRange, markScalarsPartitionStale, shouldProcessScalarsPartition } from '../src/sync/scalars.js';
import { intervalFromMarketType, marketTypeFromInterval } from '../src/source/postgres.js';
import { canPublishArchiveStatus, markPartitionArchiveStatusStale, publishPartitionArchiveStatus } from '../src/source/archiveApi.js';

test('config loads sync defaults and validates data mode', () => {
  const config = loadConfig({
    LAKE_ROOT: './custom-lake',
    STATE_DB_PATH: './custom-state/db.sqlite',
    BACKTEST_DATA_MODE: 'prepare',
    DATA_COLLECTOR_API_URL: 'http://collector.local',
    DATA_COLLECTOR_ARCHIVE_API_KEY: 'archive-key',
  });

  assert.equal(config.backtestDataMode, 'prepare');
  assert.equal(config.dataCollectorApiUrl, 'http://collector.local');
  assert.equal(config.dataCollectorArchiveApiKey, 'archive-key');
  assert.equal(config.syncBatchSize, 50000);
  assert.equal(config.syncStatementTimeoutMs, 120000);
  assert.equal(config.syncMarginMinutes, 2);
  assert.equal(config.backtestBookDepth, 25);
  assert.throws(() => loadConfig({ BACKTEST_DATA_MODE: 'invalid' }), /Invalid BACKTEST_DATA_MODE/);
});

test('archive status publishing posts one valid status per event when configured', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  try {
    const config = { dataCollectorApiUrl: 'http://collector.local/', dataCollectorArchiveApiKey: 'archive-key' };
    assert.equal(canPublishArchiveStatus(config), true);
    const result = await publishPartitionArchiveStatus({
      config,
      partition: { marketId: 'market-1', dt: '2026-05-31', bookDepth: 10 },
      events: [
        { conditionId: 'condition-1', eventStart: '2026-05-31T00:00:00.000Z', eventEnd: '2026-05-31T00:05:00.000Z' },
        { conditionId: 'condition-2', eventStart: '2026-05-31T00:05:00.000Z', eventEnd: '2026-05-31T00:10:00.000Z' },
      ],
      exportResult: {
        status: 'valid',
        rows: 1200,
        expectedRows: 1200,
        activePath: '/lake/backtest_ticks/part.parquet',
        sourceFingerprint: 'fingerprint',
      },
    });

    assert.deepEqual(result, { skipped: false, published: 2 });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'http://collector.local/api/archive/status');
    assert.equal(calls[0].options.headers['x-api-key'], 'archive-key');
    assert.equal(calls[0].body.status, 'valid');
    assert.equal(calls[0].body.datasets.backtest_ticks.rows, 1200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('archive status publishing is skipped without API config', async () => {
  assert.equal(canPublishArchiveStatus({}), false);
  const result = await publishPartitionArchiveStatus({
    config: {},
    partition: {},
    events: [],
    exportResult: { status: 'valid' },
  });
  assert.equal(result.skipped, true);
});

test('archive status stale marking posts condition ids in chunks', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ changed: 2 }) };
  };
  try {
    const config = { dataCollectorApiUrl: 'http://collector.local/', dataCollectorArchiveApiKey: 'archive-key' };
    const events = Array.from({ length: 501 }, (_, index) => ({ conditionId: `condition-${index}` }));
    const result = await markPartitionArchiveStatusStale({
      config,
      partition: { marketId: 'market-1' },
      events,
      reason: 'source changed',
    });

    assert.deepEqual(result, { skipped: false, changed: 4, requests: 2 });
    assert.equal(calls[0].url, 'http://collector.local/api/archive/status/stale');
    assert.equal(calls[0].options.headers['x-api-key'], 'archive-key');
    assert.equal(calls[0].body.market_id, 'market-1');
    assert.equal(calls[0].body.condition_ids.length, 500);
    assert.equal(calls[1].body.condition_ids.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('lake paths use versioned parquet filenames', () => {
  const lakeRoot = path.resolve('/lake');
  const partition = { dataset: 'backtest_ticks', underlying: 'BTC', interval: '5m', bookDepth: 10, dt: '2026-05-31' };
  const finalPath = buildFinalParquetPath(lakeRoot, partition, 'run-1');
  const tempPath = buildTempParquetPath(lakeRoot, 'backtest_ticks', 'run-1');

  assert.match(toPortablePath(finalPath), /backtest_ticks\/underlying=BTC\/interval=5m\/book_depth=10\/dt=2026-05-31\/part-run-1\.parquet$/);
  assert.match(toPortablePath(tempPath), /\.tmp\/backtest_ticks\/run-1\/part-run-1\.parquet$/);
});

test('source fingerprint is deterministic independent of event order', () => {
  const base = {
    dataset: 'scalars',
    marketId: 'market-1',
    underlying: 'BTC',
    interval: '5m',
    dt: '2026-05-31',
    rows: 3,
  };
  const events = [
    { conditionId: 'b', ticksRecorded: 1, actualCount: 1, recordedAt: '2026-05-31T00:05:00.000Z', minTs: '1', maxTs: '2' },
    { conditionId: 'a', ticksRecorded: 2, actualCount: 2, recordedAt: '2026-05-31T00:00:00.000Z', minTs: '3', maxTs: '4' },
  ];

  assert.equal(
    createSourceFingerprint({ ...base, events }),
    createSourceFingerprint({ ...base, events: [...events].reverse() }),
  );
});

test('scalar rows checksum changes when scalar values change', () => {
  const rows = [{
    conditionId: 'c1',
    ts: '2026-05-31T00:00:00.000Z',
    underlyingPrice: 100,
    priceToBeat: 99,
    upPrice: 0.51,
    downPrice: 0.49,
    upBestBid: 0.50,
    upBestAsk: 0.52,
    downBestBid: 0.48,
    downBestAsk: 0.50,
  }];
  const changed = [{ ...rows[0], priceToBeat: 101 }];

  assert.notEqual(createScalarRowsChecksum(rows), createScalarRowsChecksum(changed));
});

test('book parsing and flattening sorts levels by side', () => {
  const row = {
    marketId: 'm1',
    underlying: 'BTC',
    interval: '5m',
    conditionId: 'c1',
    eventStart: '2026-05-31T00:00:00.000Z',
    eventEnd: '2026-05-31T00:05:00.000Z',
    ts: '2026-05-31T00:00:01.000Z',
    upBookAsks: JSON.stringify([{ price: '0.12', size: '5' }, { price: '0.10', size: '2' }]),
    upBookBids: JSON.stringify([{ price: '0.08', size: '7' }, { price: '0.09', size: '3' }]),
    downBookAsks: [],
    downBookBids: [],
  };

  assert.deepEqual(parseBookLevels(row.upBookAsks, 'ask').map((level) => level.price), [0.10, 0.12]);
  assert.deepEqual(parseBookLevels(row.upBookBids, 'bid').map((level) => level.price), [0.09, 0.08]);

  const flat = flattenBookTick(row, 2);
  assert.equal(flat.up_ask_px_1, 0.10);
  assert.equal(flat.up_ask_sz_1, 2);
  assert.equal(flat.up_bid_px_1, 0.09);
  assert.equal(flat.up_bid_sz_1, 3);
  assert.equal(flat.down_ask_px_1, null);
});

test('book and backtest tick checksums change when book changes', () => {
  const bookRows = [{ conditionId: 'c1', ts: 't1', upBookAsks: '[{"price":"0.1","size":"1"}]', upBookBids: '[]', downBookAsks: '[]', downBookBids: '[]' }];
  const changedBookRows = [{ ...bookRows[0], upBookAsks: '[{"price":"0.2","size":"1"}]' }];
  assert.notEqual(createBooksRowsChecksum(bookRows), createBooksRowsChecksum(changedBookRows));

  const backtestRows = [flattenBookTick({ ...bookRows[0], upBookAsks: bookRows[0].upBookAsks }, 1)];
  const changedBacktestRows = [flattenBookTick({ ...changedBookRows[0], upBookAsks: changedBookRows[0].upBookAsks }, 1)];
  assert.notEqual(createBacktestTicksRowsChecksum(backtestRows, 1), createBacktestTicksRowsChecksum(changedBacktestRows, 1));
});

test('market type and interval conversion is stable', () => {
  assert.equal(marketTypeFromInterval('5m'), 'crypto-updown-5m');
  assert.equal(marketTypeFromInterval('15m'), 'crypto-updown-15m');
  assert.equal(intervalFromMarketType('crypto-updown-5m'), '5m');
  assert.equal(intervalFromMarketType('crypto-updown-15m'), '15m');
});

test('duckdb writer creates scalars parquet file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-parquet-'));
  try {
    const tempPath = path.join(dir, '.tmp', 'part-test.parquet');
    const finalPath = path.join(dir, 'scalars', 'part-test.parquet');
    await writeScalarsParquet({
      tempPath,
      finalPath,
      rows: [{
        marketId: 'market-1',
        underlying: 'BTC',
        interval: '5m',
        conditionId: 'condition-1',
        eventStart: '2026-05-31T00:00:00.000Z',
        eventEnd: '2026-05-31T00:05:00.000Z',
        ts: '2026-05-31T00:00:01.000Z',
        underlyingPrice: 100000.12,
        priceToBeat: 99900.01,
        upPrice: 0.51,
        downPrice: 0.49,
        upBestBid: 0.50,
        upBestAsk: 0.52,
        downBestBid: 0.48,
        downBestAsk: 0.50,
        coverage: 1,
        degraded: false,
      }],
    });
    const info = await stat(finalPath);
    assert.equal(info.isFile(), true);
    assert.ok(info.size > 0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('duckdb writers create books and backtest_ticks parquet files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-book-parquet-'));
  try {
    const bookRow = {
      marketId: 'market-1',
      underlying: 'BTC',
      interval: '5m',
      conditionId: 'condition-1',
      eventStart: '2026-05-31T00:00:00.000Z',
      eventEnd: '2026-05-31T00:05:00.000Z',
      ts: '2026-05-31T00:00:01.000Z',
      underlyingPrice: 100000.12,
      priceToBeat: 99900.01,
      upPrice: 0.51,
      downPrice: 0.49,
      upBestBid: 0.50,
      upBestAsk: 0.52,
      downBestBid: 0.48,
      downBestAsk: 0.50,
      coverage: 1,
      degraded: false,
      upBookAsks: '[{"price":"0.52","size":"10"}]',
      upBookBids: '[{"price":"0.50","size":"7"}]',
      downBookAsks: '[{"price":"0.50","size":"5"}]',
      downBookBids: '[{"price":"0.48","size":"4"}]',
    };

    const booksFinal = path.join(dir, 'books', 'part-test.parquet');
    await writeBooksParquet({
      rows: [bookRow],
      tempPath: path.join(dir, '.tmp', 'books.parquet'),
      finalPath: booksFinal,
    });
    assert.ok((await stat(booksFinal)).size > 0);

    const backtestFinal = path.join(dir, 'backtest_ticks', 'part-test.parquet');
    await writeBacktestTicksParquet({
      rows: [flattenBookTick(bookRow, 2)],
      tempPath: path.join(dir, '.tmp', 'backtest.parquet'),
      finalPath: backtestFinal,
      bookDepth: 2,
    });
    assert.ok((await stat(backtestFinal)).size > 0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('duckdb writer creates ohlc parquet from scalars parquet', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-ohlc-parquet-'));
  try {
    const scalarsPath = path.join(dir, 'scalars', 'part-test.parquet');
    await writeScalarsParquet({
      tempPath: path.join(dir, '.tmp', 'scalars.parquet'),
      finalPath: scalarsPath,
      rows: [
        {
          marketId: 'market-1', underlying: 'BTC', interval: '5m', conditionId: 'condition-1',
          eventStart: '2026-05-31T00:00:00.000Z', eventEnd: '2026-05-31T00:05:00.000Z', ts: '2026-05-31T00:00:01.000Z',
          underlyingPrice: 100, priceToBeat: 99, upPrice: 0.51, downPrice: 0.49,
          upBestBid: 0.50, upBestAsk: 0.52, downBestBid: 0.48, downBestAsk: 0.50,
          coverage: 1, degraded: false,
        },
        {
          marketId: 'market-1', underlying: 'BTC', interval: '5m', conditionId: 'condition-1',
          eventStart: '2026-05-31T00:00:00.000Z', eventEnd: '2026-05-31T00:05:00.000Z', ts: '2026-05-31T00:00:02.000Z',
          underlyingPrice: 101, priceToBeat: 99, upPrice: 0.52, downPrice: 0.48,
          upBestBid: 0.51, upBestAsk: 0.53, downBestBid: 0.47, downBestAsk: 0.49,
          coverage: 1, degraded: false,
        },
      ],
    });

    const ohlcPath = path.join(dir, 'ohlc', 'part-test.parquet');
    const stats = await writeOhlcParquetFromScalars({
      scalarPath: scalarsPath,
      tempPath: path.join(dir, '.tmp', 'ohlc.parquet'),
      finalPath: ohlcPath,
      resolution: '1s',
    });

    assert.ok((await stat(ohlcPath)).size > 0);
    assert.equal(stats.rows, 2);
    assert.equal(resolutionToIntervalSql('5m'), '5 minutes');
    assert.deepEqual(normalizeOhlcResolutions('1s,1m'), ['1s', '1m']);
    assert.throws(() => normalizeOhlcResolutions('2m'), /Unsupported OHLC resolution/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('incremental range applies lookback and margin', () => {
  const range = incrementalRange({
    now: new Date('2026-05-31T12:00:00.000Z'),
    lookbackDays: 2,
    marginMinutes: 5,
  });

  assert.equal(range.to, '2026-05-31T11:55:00.000Z');
  assert.equal(range.maxEventEnd, '2026-05-31T11:55:00.000Z');
  assert.equal(range.from, '2026-05-29T11:55:00.000Z');
});

test('incremental processing skips valid and protects needs_review', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-status-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const partition = { marketId: 'm1', underlying: 'BTC', interval: '5m', dt: '2026-05-31' };

      assert.equal(shouldProcessScalarsPartition(db, partition).process, true);

      upsertManifestPartition(db, {
        dataset: 'scalars',
        marketId: partition.marketId,
        underlying: partition.underlying,
        interval: partition.interval,
        dt: partition.dt,
        status: 'valid',
        activePath: '/lake/part-valid.parquet',
      });
      const validDecision = shouldProcessScalarsPartition(db, partition);
      assert.equal(validDecision.process, false);
      assert.equal(validDecision.reason, 'already_valid');

      upsertManifestPartition(db, {
        dataset: 'scalars',
        marketId: partition.marketId,
        underlying: partition.underlying,
        interval: partition.interval,
        dt: partition.dt,
        status: 'needs_review',
      });
      const protectedDecision = shouldProcessScalarsPartition(db, partition);
      assert.equal(protectedDecision.process, false);
      assert.equal(protectedDecision.reason, 'needs_review_requires_manual_rebuild');

      const allowedDecision = shouldProcessScalarsPartition(db, partition, { allowNeedsReview: true });
      assert.equal(allowedDecision.process, true);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('marking scalars stale cascades to derived ohlc partition', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-stale-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const partition = { marketId: 'm1', underlying: 'BTC', interval: '5m', dt: '2026-05-31' };
      upsertManifestPartition(db, {
        dataset: 'scalars',
        ...partition,
        status: 'valid',
        activePath: '/lake/scalars/part.parquet',
      });
      upsertManifestPartition(db, {
        dataset: 'ohlc',
        ...partition,
        resolution: '1m',
        status: 'valid',
        activePath: '/lake/ohlc/part.parquet',
      });

      const result = markScalarsPartitionStale(db, partition, 'test stale');
      assert.equal(result.changed, 1);
      assert.equal(result.derivedChanged, 1);

      const statuses = db.prepare('SELECT dataset, status FROM lake_manifest ORDER BY dataset ASC').all();
      assert.deepEqual(statuses.map((row) => [row.dataset, row.status]), [['ohlc', 'stale'], ['scalars', 'stale']]);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
