import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProgress } from '../src/backtest/engine.js';

test('buildProgress advances loading percent from loaded rows', () => {
  const startedAt = Date.now() - 5000;
  const early = buildProgress({
    phase: 'loading',
    ticks: 0,
    batches: 0,
    totalTicks: 1_000_000,
    startedAt,
  });
  assert.ok((early.percent ?? 0) > 0, 'loading without rows still shows minimal activity');

  const mid = buildProgress({
    phase: 'loading',
    ticks: 0,
    loadedTicks: 500_000,
    batches: 0,
    totalTicks: 1_000_000,
    startedAt,
  });
  assert.ok(mid.percent > early.percent);
  assert.ok(mid.percent < 12);
  assert.equal(mid.ticks, 0);
  assert.equal(mid.loaded_ticks, 500_000);
  assert.equal(mid.eta_ms, null);

  const doneLoad = buildProgress({
    phase: 'processing',
    ticks: 0,
    batches: 1,
    totalTicks: 1_000_000,
    startedAt,
  });
  assert.ok(doneLoad.percent >= 12);
});

test('buildProgress shows merge step near end of loading phase', () => {
  const startedAt = Date.now() - 5000;
  const merge = buildProgress({
    phase: 'loading',
    ticks: 0,
    loadedTicks: 1_000_000,
    batches: 0,
    totalTicks: 1_000_000,
    loadingStep: 'merge',
    startedAt,
  });
  assert.ok(merge.percent >= 11);
  assert.equal(merge.loading_step, 'merge');
});

test('buildProgress maps processing ticks into weighted percent', () => {
  const startedAt = Date.now() - 10_000;
  const half = buildProgress({
    phase: 'processing',
    ticks: 500_000,
    batches: 1,
    totalTicks: 1_000_000,
    startedAt,
  });
  assert.ok(half.percent > 50);
  assert.ok(half.percent < 99);
  assert.ok(half.eta_ms != null);
  assert.ok(half.processing_elapsed_ms != null);
});

test('buildProgress exposes late phases near completion', () => {
  const startedAt = Date.now() - 12_000;
  const finalizing = buildProgress({
    phase: 'finalizing',
    ticks: 1_000_000,
    batches: 1,
    totalTicks: 1_000_000,
    startedAt,
  });
  assert.equal(finalizing.percent, 99);
  assert.ok(finalizing.elapsed_ms >= 12_000);

  const saving = buildProgress({
    phase: 'saving',
    ticks: 1_000_000,
    batches: 1,
    totalTicks: 1_000_000,
    startedAt,
  });
  assert.equal(saving.percent, 99.5);
});
