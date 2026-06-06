import test from 'node:test';
import assert from 'node:assert/strict';

import { downsamplePoints } from '../src/utils/downsample.js';

test('downsamplePoints keeps endpoints and max size', () => {
  const points = Array.from({ length: 1000 }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString(),
    value: i,
  }));
  const out = downsamplePoints(points, { maxPoints: 50 });
  assert.ok(out.length <= 50);
  assert.ok(out.length > 10);
  assert.equal(out[0].value, 0);
  assert.equal(out.at(-1).value, 999);
});
