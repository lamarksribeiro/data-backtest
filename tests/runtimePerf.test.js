import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { extractEquityFromResultJson } from '../src/state/backtestRuns.js';
import { readChartSidecarForEvent, appendChartSidecarLine } from '../src/backtest/chartSidecar.js';
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
