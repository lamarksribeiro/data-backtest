import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { extractEquityFromResultJson } from '../src/state/backtestRuns.js';
import {
  readChartSidecarForEvent,
  appendChartSidecarLine,
  buildEventChartSeries,
  chartSidecarIndexPath,
  chartSidecarPath,
  ensureChartSidecarDir,
  pruneOrphanChartSidecars,
  removeChartSidecarRun,
  scanChartSidecarDir,
} from '../src/backtest/chartSidecar.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { createBacktestRun } from '../src/state/backtestRuns.js';
import { createColumnSetBuilder, createTickCursorView, snapshotTickCursorView } from '../src/backtest/columnStore.js';
import { chartSeriesHasChartablePoints, chartSeriesIsUsable } from '../src/backtestStudio/state/eventTraces.js';
import { loadConfig } from '../src/config.js';

test('extractEquityFromResultJson reads equity without full parse', () => {
  const equity = [{ ts: '2026-01-01T00:00:00.000Z', pnl: 1 }, { ts: '2026-01-02T00:00:00.000Z', pnl: 2 }];
  const json = JSON.stringify({ strategy: 'x', summary: { totalPnl: 2 }, equity, log: [] });
  const out = extractEquityFromResultJson(json);
  assert.deepEqual(out, equity);
});

test('resolveDatasetCacheMaxMb defaults to 0 with disk cache enabled', () => {
  const cfg = loadConfig({ ...process.env, DATASET_CACHE_MAX_MB: '', DATASET_DISK_CACHE: '1', SWEEP_VARIANT_WORKERS: '3' });
  assert.equal(cfg.datasetCacheMaxMb, 0);
  assert.equal(cfg.sweepVariantWorkers, 3);
  const explicit = loadConfig({ ...process.env, DATASET_CACHE_MAX_MB: '1024' });
  assert.equal(explicit.datasetCacheMaxMb, 1024);
});

test('resolveDatasetCacheMaxMb scales with NODE_OPTIONS when disk cache is off', () => {
  const cfg = loadConfig({ ...process.env, DATASET_CACHE_MAX_MB: '', DATASET_DISK_CACHE: '0', NODE_OPTIONS: '--max-old-space-size=7168' });
  assert.equal(cfg.datasetCacheMaxMb, 1433);
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
  assert.ok(chartSeriesIsUsable(series));
  assert.equal(series.underlying.length, 2);
  assert.equal(series.underlying[0].value, 100);
  assert.equal(series.underlying[1].value, 101);
});

test('chart sidecar append writes byte-offset index', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sidecar-idx-'));
  const file = path.join(dir, 'run-1.jsonl');
  try {
    appendChartSidecarLine(file, 'cond-a', { series: { underlying: [{ ts: 't', value: 1 }] }, meta: {} });
    appendChartSidecarLine(file, 'cond-b', { series: { underlying: [{ ts: 't', value: 2 }] }, meta: {} });
    assert.ok(existsSync(chartSidecarIndexPath(file)));
    const b = await readChartSidecarForEvent(file, 'cond-b');
    assert.equal(b.series.underlying[0].value, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('chart sidecar builds index lazily for legacy jsonl without idx', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sidecar-legacy-'));
  const file = path.join(dir, 'run-legacy.jsonl');
  try {
    const lines = [
      JSON.stringify({ condition_id: 'cond-a', series: { underlying: [{ ts: 't', value: 1 }] }, meta: {} }),
      JSON.stringify({ condition_id: 'cond-b', series: { underlying: [{ ts: 't', value: 99 }] }, meta: {} }),
    ];
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
    assert.equal(existsSync(chartSidecarIndexPath(file)), false);
    const row = await readChartSidecarForEvent(file, 'cond-b');
    assert.equal(row.series.underlying[0].value, 99);
    assert.ok(existsSync(chartSidecarIndexPath(file)));
    const again = await readChartSidecarForEvent(file, 'cond-a');
    assert.equal(again.series.underlying[0].value, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('chart sidecar streams large jsonl without loading entire file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sidecar-stream-'));
  const file = path.join(dir, 'run-large.jsonl');
  try {
    for (let i = 0; i < 5000; i += 1) {
      appendChartSidecarLine(file, `cond-${i}`, {
        series: { underlying: [{ ts: 't', value: i }] },
        meta: {},
      });
    }
    const first = await readChartSidecarForEvent(file, 'cond-0');
    const last = await readChartSidecarForEvent(file, 'cond-4999');
    assert.equal(first.series.underlying[0].value, 0);
    assert.equal(last.series.underlying[0].value, 4999);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('removeChartSidecarRun deletes jsonl and idx', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sidecar-remove-'));
  const stateDbPath = path.join(dir, 'state.db');
  try {
    ensureChartSidecarDir(stateDbPath);
    const file = chartSidecarPath(stateDbPath, 42);
    appendChartSidecarLine(file, 'cond-a', { series: { underlying: [{ ts: 't', value: 1 }] }, meta: {} });
    assert.ok(existsSync(file));
    assert.ok(existsSync(chartSidecarIndexPath(file)));

    const removed = removeChartSidecarRun(stateDbPath, 42);
    assert.equal(removed.removed_files, 2);
    assert.ok(removed.removed_bytes > 0);
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(chartSidecarIndexPath(file)), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pruneOrphanChartSidecars removes sidecars without backtest_runs row', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sidecar-prune-'));
  const stateDbPath = path.join(dir, 'state.db');
  const db = openStateDatabase(stateDbPath);
  try {
    ensureChartSidecarDir(stateDbPath);
    appendChartSidecarLine(chartSidecarPath(stateDbPath, 7), 'orphan', {
      series: { underlying: [{ ts: 't', value: 1 }] },
      meta: {},
    });

    const run = createBacktestRun(db, {
      request: { batchSize: 1000, params: {} },
      result: {
        strategy: 'test',
        source: 'lakehouse',
        underlying: 'BTC',
        interval: '5m',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-02T00:00:00.000Z',
        ticks: 1,
        batches: 1,
        summary: {},
        events: [],
        equity: [],
        log: [],
      },
    });
    appendChartSidecarLine(chartSidecarPath(stateDbPath, run.id), 'active', {
      series: { underlying: [{ ts: 't', value: 2 }] },
      meta: {},
    });

    const before = scanChartSidecarDir(stateDbPath);
    assert.equal(before.run_files, 2);

    const dry = pruneOrphanChartSidecars(stateDbPath, db, { dryRun: true });
    assert.deepEqual(dry.orphan_runs, [7]);
    assert.ok(existsSync(chartSidecarPath(stateDbPath, 7)));

    const pruned = pruneOrphanChartSidecars(stateDbPath, db);
    assert.deepEqual(pruned.orphan_runs, [7]);
    assert.equal(existsSync(chartSidecarPath(stateDbPath, 7)), false);
    assert.ok(existsSync(chartSidecarPath(stateDbPath, run.id)));
  } finally {
    closeStateDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
});

test('chart sidecar serves repeated event reads', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sidecar-cache-'));
  const file = path.join(dir, 'run-1.jsonl');
  try {
    appendChartSidecarLine(file, 'cond-a', { series: { underlying: [{ ts: 't', value: 1 }] }, meta: {} });
    appendChartSidecarLine(file, 'cond-b', { series: { underlying: [{ ts: 't', value: 2 }] }, meta: {} });
    const a = await readChartSidecarForEvent(file, 'cond-a');
    const b = await readChartSidecarForEvent(file, 'cond-b');
    assert.equal(a.series.underlying[0].value, 1);
    assert.equal(b.series.underlying[0].value, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
