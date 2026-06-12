import test from 'node:test';
import assert from 'node:assert/strict';

import { computePrepareJobPercent } from '../src/prepare/progress.js';

test('computePrepareJobPercent weights multiple preparation actions', () => {
  const pct = computePrepareJobPercent({
    actions_total: 3,
    action_index: 1,
    partitions_total: 1,
    partitions_done: 0,
    current: { phase: 'writing_parquet' },
  });
  assert.ok(pct >= 60);
  assert.ok(pct <= 95);
});

test('computePrepareJobPercent reaches high value on last partition phase', () => {
  const pct = computePrepareJobPercent({
    actions_total: 1,
    action_index: 0,
    partitions_total: 1,
    partitions_done: 0,
    current: { phase: 'writing_parquet' },
  });
  assert.ok(pct >= 85);
});
