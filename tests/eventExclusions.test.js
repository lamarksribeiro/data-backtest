import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

async function removeTempDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (err) {
      if (attempt === 4 || (err.code !== 'ENOTEMPTY' && err.code !== 'EBUSY' && err.code !== 'EPERM')) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import {
  addEventExclusion,
  listExcludedConditionIdsForDay,
  listEventExclusionsForDay,
  removeEventExclusion,
} from '../src/state/eventExclusions.js';
import { applyTickNormalization } from '../src/sync/applyNormalization.js';

function tick(conditionId, index) {
  return {
    conditionId,
    eventStart: '2026-06-01T14:00:00.000Z',
    eventEnd: '2026-06-01T14:05:00.000Z',
    ts: `2026-06-01T14:00:${String(index).padStart(2, '0')}.000Z`,
    underlyingPrice: 100000 + index,
    priceToBeat: 99999,
    upPrice: 0.52,
    downPrice: 0.48,
    upBestBid: 0.51,
    upBestAsk: 0.53,
    downBestBid: 0.47,
    downBestAsk: 0.49,
  };
}

test('event exclusions persist and restore in sqlite', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'db-excl-'));
  const db = openStateDatabase(path.join(dir, 'state.db'));
  try {
    addEventExclusion(db, {
      marketId: 'market-1',
      conditionId: '0xabc',
      eventStart: '2026-06-01T14:00:00.000Z',
      dt: '2026-06-01',
      underlying: 'BTC',
      interval: '5m',
      reason: 'manual',
    });
    const listed = listEventExclusionsForDay(db, { dt: '2026-06-01', underlying: 'BTC', interval: '5m', marketId: 'market-1' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].conditionId, '0xabc');

    const ids = listExcludedConditionIdsForDay(db, {
      dt: '2026-06-01',
      underlying: 'BTC',
      interval: '5m',
      marketId: 'market-1',
    });
    assert.ok(ids.has('0xabc'));

    assert.equal(removeEventExclusion(db, { marketId: 'market-1', conditionId: '0xabc' }), true);
    assert.equal(listEventExclusionsForDay(db, { dt: '2026-06-01', underlying: 'BTC', interval: '5m', marketId: 'market-1' }).length, 0);
  } finally {
    closeStateDatabase(db);
    await removeTempDir(dir);
  }
});

test('applyTickNormalization removes manually excluded events', () => {
  const ticks = [
    ...Array.from({ length: 10 }, (_, index) => tick('0xgood', index)),
    ...Array.from({ length: 10 }, (_, index) => tick('0xbad', index)),
  ];
  const result = applyTickNormalization(ticks, {}, {
    manualExcludedConditionIds: new Set(['0xbad']),
  });
  assert.equal(result.ticks.length, 10);
  assert.ok(result.ticks.every((row) => row.conditionId === '0xgood'));
  assert.equal(result.normalization.events_manual_omitted, 1);
});
