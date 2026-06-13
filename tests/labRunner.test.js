import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveChunkDays } from '../labs/shared/labRunner.js';

test('resolveChunkDays defaults to single-pass sweep', () => {
  assert.equal(resolveChunkDays({ name: 'smoke' }), 0);
  assert.equal(resolveChunkDays({ name: 'smoke', chunkDays: 0 }), 0);
});

test('resolveChunkDays enables daily chunks via dailyMetrics', () => {
  assert.equal(resolveChunkDays({ dailyMetrics: true }), 1);
});

test('resolveChunkDays prefers explicit chunkDays over dailyMetrics', () => {
  assert.equal(resolveChunkDays({ dailyMetrics: true, chunkDays: 7 }), 7);
  assert.equal(resolveChunkDays({ dailyMetrics: true }, { chunkDays: 3 }), 3);
});
