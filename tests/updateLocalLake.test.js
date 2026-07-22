import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addUtcDays,
  computeUpdateRange,
  summarizeUpdateResult,
  utcToday,
} from '../src/ops/updateLocalLake.js';

test('utcToday returns YYYY-MM-DD', () => {
  assert.match(utcToday(new Date('2026-07-22T15:30:00.000Z')), /^2026-07-22$/);
});

test('addUtcDays crosses month boundaries in UTC', () => {
  assert.equal(addUtcDays('2026-07-31', 1), '2026-08-01');
  assert.equal(addUtcDays('2026-07-01', -1), '2026-06-30');
});

test('computeUpdateRange refreshes tip from local max with lookback', () => {
  const range = computeUpdateRange({
    localMaxDt: '2026-07-20',
    today: '2026-07-22',
    lookbackDays: 1,
  });
  assert.deepEqual(range, {
    from: '2026-07-19',
    to: '2026-07-22',
    refreshedFromLocalMax: true,
  });
});

test('computeUpdateRange uses empty lookback when local is empty', () => {
  const range = computeUpdateRange({
    localMaxDt: null,
    today: '2026-07-22',
    emptyLookbackDays: 14,
  });
  assert.equal(range.from, '2026-07-08');
  assert.equal(range.to, '2026-07-22');
  assert.equal(range.refreshedFromLocalMax, false);
});

test('computeUpdateRange honors from/to overrides', () => {
  const range = computeUpdateRange({
    localMaxDt: '2026-07-20',
    today: '2026-07-22',
    fromOverride: '2026-07-01',
    toOverride: '2026-07-05',
  });
  assert.deepEqual(range, {
    from: '2026-07-01',
    to: '2026-07-05',
    refreshedFromLocalMax: false,
  });
});

test('summarizeUpdateResult keeps a short agent-friendly payload', () => {
  const summary = summarizeUpdateResult({
    coverageBefore: { minDt: '2026-04-23', maxDt: '2026-07-20', partitions: 90 },
    coverageAfter: { minDt: '2026-04-23', maxDt: '2026-07-21', partitions: 91 },
    range: { from: '2026-07-20', to: '2026-07-22' },
    pullResult: {
      ok: true,
      dryRun: false,
      partitions: 2,
      filesCopied: 2,
      files: [
        { partition: { dt: '2026-07-20' } },
        { partition: { dt: '2026-07-21' } },
      ],
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.filesCopied, 2);
  assert.deepEqual(summary.remoteDts, ['2026-07-20', '2026-07-21']);
  assert.match(summary.note || '', /06:00 UTC/);
});
