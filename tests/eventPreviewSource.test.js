import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { upsertManifestPartition } from '../src/state/manifest.js';
import { toPortablePath } from '../src/lake/paths.js';
import { writeScalarsParquet } from '../src/sync/duckdbParquet.js';
import { buildParquetEventPreview, buildSourceEventPreview } from '../src/quality/eventPreview.js';
import { loadParquetScalarTicksForEvent } from '../src/quality/parquetEventTicks.js';

const CONDITION_ID = '0xdual-preview';

function makeScalarRow(ts, underlyingPrice) {
  return {
    marketId: 'm1',
    underlying: 'BTC',
    interval: '5m',
    conditionId: CONDITION_ID,
    eventStart: '2026-06-11T19:05:00.000Z',
    eventEnd: '2026-06-11T19:10:00.000Z',
    ts,
    underlyingPrice,
    priceToBeat: 63_517.89,
    upPrice: 0.52,
    downPrice: 0.48,
    upBestBid: 0.51,
    upBestAsk: 0.53,
    downBestBid: 0.47,
    downBestAsk: 0.49,
    coverage: 1,
    degraded: false,
  };
}

test('source preview charts raw ticks and keeps trim regions', () => {
  const ticks = Array.from({ length: 25 }, (_, index) => ({
    conditionId: CONDITION_ID,
    eventStart: '2026-06-11T19:05:00.000Z',
    eventEnd: '2026-06-11T19:10:00.000Z',
    ts: new Date(Date.parse('2026-06-11T19:05:00.000Z') + index * 1000).toISOString(),
    underlyingPrice: 63_500 + index,
    priceToBeat: 63_517.89,
    upPrice: 0.50 + (index % 6) * 0.008,
    downPrice: 0.50 - (index % 6) * 0.008,
  }));
  const preview = buildSourceEventPreview(ticks);
  assert.equal(preview.data_role, 'source');
  assert.equal(preview.ticks_in, 25);
  assert.ok(preview.chart_ticks.length > 0);
});

test('parquet preview has no trim regions and reflects exported rows', () => {
  const ticks = Array.from({ length: 12 }, (_, index) => ({
    ts: new Date(Date.parse('2026-06-11T19:05:00.000Z') + index * 1000).toISOString(),
    underlyingPrice: 63_500 + index * 0.5,
    priceToBeat: 63_517.89,
    upPrice: 0.52,
    downPrice: 0.48,
  }));
  const preview = buildParquetEventPreview(ticks, {
    action: 'trim',
    ticks_in: 600,
    ticks_out: 12,
    bad_ratio: 0.1,
  });
  assert.equal(preview.data_role, 'parquet');
  assert.equal(preview.ticks_out, 12);
  assert.equal(preview.trim_regions.length, 0);
});

test('loadParquetScalarTicksForEvent reads event rows from active partition', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-dual-preview-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const scalarsPath = path.join(dir, 'lake', 'scalars', 'part-test.parquet');
      await writeScalarsParquet({
        tempPath: path.join(dir, 'lake', '.tmp', 'scalars.parquet'),
        finalPath: scalarsPath,
        rows: [
          makeScalarRow('2026-06-11T19:05:01.000Z', 63_520),
          makeScalarRow('2026-06-11T19:05:02.000Z', 63_528),
        ],
      });
      upsertManifestPartition(db, {
        dataset: 'scalars',
        underlying: 'BTC',
        interval: '5m',
        dt: '2026-06-11',
        activePath: toPortablePath(scalarsPath),
        rows: 2,
        status: 'valid',
      });

      const ticks = await loadParquetScalarTicksForEvent(db, {
        dt: '2026-06-11',
        underlying: 'BTC',
        interval: '5m',
        conditionId: CONDITION_ID,
      });
      assert.equal(ticks.length, 2);
      assert.equal(ticks[1].underlyingPrice, 63_528);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
