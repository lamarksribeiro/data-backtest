import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { extractEquityFromResultJson } from '../src/state/backtestRuns.js';
import { readChartSidecarForEvent, appendChartSidecarLine, buildEventChartSeries } from '../src/backtest/chartSidecar.js';
import { createColumnSetBuilder, createTickCursorView, snapshotTickCursorView } from '../src/backtest/columnStore.js';
import { chartSeriesHasChartablePoints } from '../src/backtestStudio/state/eventTraces.js';
import { loadConfig } from '../src/config.js';

test('extractEquityFromResultJson reads equity without full parse', () => {
  const equity = [{ ts: '2026-01-01T00:00:00.000Z', pnl: 1 }, { ts: '2026-01-02T00:00:00.000Z', pnl: 2 }];
  const json = JSON.stringify({ strategy: 'x', summary: { totalPnl: 2 }, equity, log: [] });
  const out = extractEquityFromResultJson(json);
  assert.deepEqual(out, equity);
});

test('resolveDatasetCacheMaxMb scales with NODE_OPTIONS heap', () => {
  const cfg = loadConfig({ ...process.env, DATASET_CACHE_MAX_MB: '', NODE_OPTIONS: '--max-old-space-size=7168' });
  assert.equal(cfg.datasetCacheMaxMb, 1433);
  const explicit = loadConfig({ ...process.env, DATASET_CACHE_MAX_MB: '1024' });
  assert.equal(explicit.datasetCacheMaxMb, 1024);
});

test('snapshotTickCursorView freezes per-index tick values', () => {
  const builder = createColumnSetBuilder({ initialCapacity: 4 });
  builder.registerColumn('condition_id', 'code');
  builder.registerColumn('_ts_ms', 'ms');
  builder.registerColumn('_event_start_ms', 'ms');
  builder.registerColumn('_event_end_ms', 'ms');
  builder.registerColumn('underlying_price', 'numeric');
  builder.registerColumn('price_to_beat', 'numeric');
  builder.registerColumn('up_price', 'numeric');

  const appendRow = (startMs, underlying, ptb, up) => {
    builder.ensureCapacity(1);
    const i = builder.length;
    builder.codes.get('condition_id')[i] = builder.internCode('condition_id', 'c1');
    builder.columns.get('_ts_ms')[i] = startMs;
    builder.columns.get('_event_start_ms')[i] = startMs - 1000;
    builder.columns.get('_event_end_ms')[i] = startMs + 1000;
    builder.columns.get('underlying_price')[i] = underlying;
    builder.columns.get('price_to_beat')[i] = ptb;
    builder.columns.get('up_price')[i] = up;
    builder.length += 1;
  };

  appendRow(1_000, 100, 99, 0.55);
  appendRow(2_000, 101, 99, 0.56);

  const columnSet = builder.finalize();
  const cursor = createTickCursorView(columnSet);
  cursor.setIndex(0);
  const first = snapshotTickCursorView(cursor);
  cursor.setIndex(1);
  const second = snapshotTickCursorView(cursor);
  assert.equal(first.underlying_price, 100);
  assert.equal(second.underlying_price, 101);
  assert.equal(first.underlying_price, 100);

  const { series } = buildEventChartSeries([first, second], 'UP');
  assert.ok(chartSeriesHasChartablePoints(series));
  assert.equal(series.underlying.length, 2);
  assert.equal(series.underlying[0].value, 100);
  assert.equal(series.underlying[1].value, 101);
});

test('chart sidecar cache serves repeated event reads', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sidecar-cache-'));
  const file = path.join(dir, 'run-1.jsonl');
  try {
    appendChartSidecarLine(file, 'cond-a', { series: { underlying: [{ ts: 't', value: 1 }] }, meta: {} });
    appendChartSidecarLine(file, 'cond-b', { series: { underlying: [{ ts: 't', value: 2 }] }, meta: {} });
    const a = readChartSidecarForEvent(file, 'cond-a');
    const b = readChartSidecarForEvent(file, 'cond-b');
    assert.equal(a.series.underlying[0].value, 1);
    assert.equal(b.series.underlying[0].value, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
