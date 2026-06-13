import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeProgressFiles } from '../src/prepare/progressReporter.js';
import { mergeNormalizationReports } from '../src/sync/applyNormalization.js';

test('mergeProgressFiles keeps only recent files and accumulates counters', () => {
  const first = mergeProgressFiles({ files: [], files_count: 0, bytes_total: 0 }, [
    { dt: '2026-01-01', bytes: 100 },
    { dt: '2026-01-02', bytes: 200 },
  ]);
  const second = mergeProgressFiles(first, [
    { dt: '2026-01-03', bytes: 300 },
    { dt: '2026-01-04', bytes: 400 },
    { dt: '2026-01-05', bytes: 500 },
    { dt: '2026-01-06', bytes: 600 },
    { dt: '2026-01-07', bytes: 700 },
  ]);
  assert.equal(second.files_count, 7);
  assert.equal(second.bytes_total, 2800);
  assert.equal(second.files.length, 5);
  assert.equal(second.files[0].dt, '2026-01-03');
});

test('mergeNormalizationReports sums event and tick counters', () => {
  const merged = mergeNormalizationReports([
    { events_total: 2, events_omitted: 1, ticks_in: 10, ticks_out: 8, ticks_removed: 2, applied: true },
    { events_total: 1, events_kept: 1, ticks_in: 5, ticks_out: 5, ticks_removed: 0 },
  ]);
  assert.equal(merged.events_total, 3);
  assert.equal(merged.events_omitted, 1);
  assert.equal(merged.ticks_in, 15);
  assert.equal(merged.ticks_out, 13);
  assert.equal(merged.applied, true);
});
