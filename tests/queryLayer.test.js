import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { upsertManifestPartition } from '../src/state/manifest.js';
import { toPortablePath } from '../src/lake/paths.js';
import { writeOhlcParquetFromScalars, writeScalarsParquet } from '../src/sync/duckdbParquet.js';
import { checkDatasetAvailability, partitionDatesForRange } from '../src/query/availability.js';
import { rangeFromParams, inclusiveEndDateFromExclusive, inclusiveDateRangeFromRequest } from '../src/query/request.js';
import { queryCandles, queryTicks, buildTicksSql } from '../src/query/duckdbQuery.js';
import { MIN_SPOT_USD, listedUnderlyings } from '../public/shared/underlyingAssets.js';

test('availability resolves valid active_path and reports missing partitions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-query-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      upsertManifestPartition(db, {
        dataset: 'scalars',
        underlying: 'BTC',
        interval: '5m',
        dt: '2026-05-31',
        activePath: '/lake/scalars/part.parquet',
        status: 'valid',
      });

      assert.deepEqual(partitionDatesForRange('2026-05-31T12:00:00.000Z', '2026-06-02T00:00:00.000Z'), [
        '2026-05-31',
        '2026-06-01',
      ]);
      assert.deepEqual(rangeFromParams(new URLSearchParams({ from: '2026-06-02', to: '2026-06-02' })), {
        from: '2026-06-02T00:00:00.000Z',
        to: '2026-06-03T00:00:00.000Z',
      });
      assert.deepEqual(rangeFromParams(new URLSearchParams({ from: '2026-05-31', to: '2026-06-07' })), {
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-06-08T00:00:00.000Z',
      });
      assert.equal(inclusiveEndDateFromExclusive('2026-06-08T00:00:00.000Z'), '2026-06-07');
      assert.deepEqual(inclusiveDateRangeFromRequest({
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-06-08T00:00:00.000Z',
      }), { from_date: '2026-05-31', to_date: '2026-06-07' });

      const lakeRoot = '/lake';
      const availability = checkDatasetAvailability(db, {
        dataset: 'scalars',
        underlying: 'BTC',
        interval: '5m',
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-06-02T00:00:00.000Z',
        lakeRoot,
      });

      assert.equal(availability.ok, false);
      assert.deepEqual(
        availability.files.map((f) => toPortablePath(path.relative(path.resolve(lakeRoot), f))),
        ['scalars/part.parquet']
      );
      assert.deepEqual(availability.missing, ['2026-06-01']);
      assert.equal(availability.summary.valid, 1);
      assert.equal(availability.summary.missing, 1);
      assert.equal(availability.partitions.length, 2);
      assert.equal(availability.partitions[0].usable, true);
      assert.equal(availability.partitions[1].status, 'missing');
      upsertManifestPartition(db, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 25,
        dt: '2026-06-02',
        activePath: '/lake/backtest_ticks/dt=2026-06-02/part.parquet',
        rows: 172749,
        eventsCount: 288,
        hasDegraded: true,
        qualityDetails: {
          version: 1,
          events_total: 288,
          events_degraded: 2,
          coverage_min: 0.49,
          source_missing_ticks: 300,
          row_count_delta: 72749,
          issues: [{ code: 'low_coverage', label: 'Cobertura abaixo do mínimo por evento', events: 2 }],
          samples: [{ condition_id: 'cond-1', event_start: '2026-06-02T00:00:00.000Z', coverage: 0.49 }],
        },
        status: 'needs_review',
        error: 'actual tick count 172749 differs from event_quality 100000',
      });

      const reviewAvailability = checkDatasetAvailability(db, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 25,
        from: '2026-06-02T00:00:00.000Z',
        to: '2026-06-03T00:00:00.000Z',
      });

      assert.equal(reviewAvailability.ok, false);
      assert.equal(reviewAvailability.summary.unavailable, 1);
      assert.equal(reviewAvailability.partitions[0].status, 'needs_review');
      assert.equal(reviewAvailability.partitions[0].usable, false);
      assert.equal(reviewAvailability.partitions[0].has_degraded, true);
      assert.equal(reviewAvailability.partitions[0].quality_details.events_degraded, 2);
      assert.equal(reviewAvailability.unavailable[0].quality_details.coverage_min, 0.49);
      assert.match(reviewAvailability.partitions[0].hint, /event_quality/);
      assert.match(reviewAvailability.unavailable[0].error, /event_quality 100000/);

      upsertManifestPartition(db, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 25,
        dt: '2026-06-03',
        activePath: '/lake/backtest_ticks/dt=2026-06-03/part.parquet',
        rows: 172789,
        status: 'needs_review',
        error: 'actual tick count 172789 differs from event_quality 172587',
      });

      const autoAcceptedAvailability = checkDatasetAvailability(db, {
        dataset: 'backtest_ticks',
        underlying: 'BTC',
        interval: '5m',
        bookDepth: 25,
        from: '2026-06-03T00:00:00.000Z',
        to: '2026-06-04T00:00:00.000Z',
        acceptMismatchRatio: 0.02,
      });

      assert.equal(autoAcceptedAvailability.ok, true);
      assert.equal(autoAcceptedAvailability.partitions[0].status, 'accepted');
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('queryTicks reads only manifest active_path parquet files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-query-ticks-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const scalarsPath = path.join(dir, 'lake', 'scalars', 'part-test.parquet');
      await writeScalarsParquet({
        tempPath: path.join(dir, 'lake', '.tmp', 'scalars.parquet'),
        finalPath: scalarsPath,
        rows: [
          makeScalarRow('2026-05-31T00:00:01.000Z', 100),
          makeScalarRow('2026-05-31T00:00:02.000Z', 101),
        ],
      });
      upsertManifestPartition(db, {
        dataset: 'scalars',
        underlying: 'BTC',
        interval: '5m',
        dt: '2026-05-31',
        activePath: toPortablePath(scalarsPath),
        rows: 2,
        status: 'valid',
      });

      const rows = await queryTicks(db, {
        dataset: 'scalars',
        underlying: 'BTC',
        interval: '5m',
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
        limit: 10,
      });

      assert.equal(rows.length, 2);
      assert.equal(rows[0].underlying_price, 100);
      assert.equal(rows[1].underlying_price, 101);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('queryCandles reads OHLC partitions resolved by resolution', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-query-candles-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const scalarsPath = path.join(dir, 'lake', 'scalars', 'part-test.parquet');
      await writeScalarsParquet({
        tempPath: path.join(dir, 'lake', '.tmp', 'scalars.parquet'),
        finalPath: scalarsPath,
        rows: [makeScalarRow('2026-05-31T00:00:01.000Z', 100), makeScalarRow('2026-05-31T00:00:02.000Z', 101)],
      });
      const ohlcPath = path.join(dir, 'lake', 'ohlc', 'part-test.parquet');
      await writeOhlcParquetFromScalars({
        scalarPath: scalarsPath,
        tempPath: path.join(dir, 'lake', '.tmp', 'ohlc.parquet'),
        finalPath: ohlcPath,
        resolution: '1s',
      });
      upsertManifestPartition(db, {
        dataset: 'ohlc',
        underlying: 'BTC',
        interval: '5m',
        resolution: '1s',
        dt: '2026-05-31',
        activePath: toPortablePath(ohlcPath),
        rows: 2,
        status: 'valid',
      });

      const rows = await queryCandles(db, {
        underlying: 'BTC',
        interval: '5m',
        resolution: '1s',
        from: '2026-05-31T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
        limit: 10,
      });

      assert.equal(rows.length, 2);
      assert.equal(rows[0].open_underlying, 100);
      assert.equal(rows[1].close_underlying, 101);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function makeScalarRow(ts, underlyingPrice) {
  return {
    marketId: 'market-1',
    underlying: 'BTC',
    interval: '5m',
    conditionId: 'condition-1',
    eventStart: '2026-05-31T00:00:00.000Z',
    eventEnd: '2026-05-31T00:05:00.000Z',
    ts,
    underlyingPrice,
    priceToBeat: 99,
    upPrice: 0.51,
    downPrice: 0.49,
    upBestBid: 0.50,
    upBestAsk: 0.52,
    downBestBid: 0.48,
    downBestAsk: 0.50,
    coverage: 1,
    degraded: false,
  };
}

test('buildTicksSql uses per-asset min price_to_beat for validBacktestRows', () => {
  const availability = { files: ['/lake/part.parquet'] };
  const base = {
    from: '2026-06-01T00:00:00.000Z',
    to: '2026-06-02T00:00:00.000Z',
    validBacktestRows: true,
  };
  for (const underlying of listedUnderlyings()) {
    const sql = buildTicksSql(availability, { ...base, underlying });
    const minPtb = MIN_SPOT_USD[underlying];
    assert.match(sql, new RegExp(`price_to_beat > ${String(minPtb).replace('.', '\\.')}`));
  }
});
