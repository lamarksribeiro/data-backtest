import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import {
  buildEventOrderClause,
  listEventTraces,
  normalizeEventSort,
  persistEventTraces,
} from '../src/backtestStudio/state/eventTraces.js';

test('normalizeEventSort accepts legacy and column:dir tokens', () => {
  assert.deepEqual(normalizeEventSort('default'), { column: 'event_start', dir: 'asc' });
  assert.equal(buildEventOrderClause('default'), 'event_start ASC');
  assert.deepEqual(normalizeEventSort('pnl_desc'), { column: 'pnl', dir: 'desc' });
  assert.deepEqual(normalizeEventSort('cost:asc'), { column: 'cost', dir: 'asc' });
});

test('buildEventOrderClause supports sortable table columns', () => {
  assert.match(buildEventOrderClause('pnl:desc'), /final_pnl DESC/);
  assert.match(buildEventOrderClause('quantity:asc'), /json_extract\(summary_json, '\$\.quantity'\)/);
  assert.match(buildEventOrderClause('dist:desc'), /entryDistanceToPtb/);
  assert.match(buildEventOrderClause('result:desc'), /CASE result/);
});

test('listEventTraces sorts by pnl and cost from summary_json', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-event-sort-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      db.prepare(`
        INSERT INTO backtest_runs (
          strategy, source, underlying, interval, book_depth, from_ts, to_ts,
          batch_size, params_json, ticks, batches, summary_json, result_json, status
        ) VALUES ('test', 'lakehouse', 'BTC', '5m', 2, '2026-06-01', '2026-06-02', 100, '{}', 0, 0, '{}', '{}', 'completed')
      `).run();
      const runId = db.prepare('SELECT id FROM backtest_runs ORDER BY id DESC LIMIT 1').get().id;

      persistEventTraces(db, runId, {
        events: [
          {
            eventId: 'low-pnl',
            eventStart: '2026-06-01T00:00:00.000Z',
            eventEnd: '2026-06-01T00:05:00.000Z',
            closedAt: '2026-06-01T00:05:00.000Z',
            finalPnl: 1,
            reason: 'win',
            quantity: 2,
            cost: 4,
            orders: [{ type: 'entry' }],
          },
          {
            eventId: 'high-pnl',
            eventStart: '2026-06-01T00:05:00.000Z',
            eventEnd: '2026-06-01T00:10:00.000Z',
            closedAt: '2026-06-01T00:10:00.000Z',
            finalPnl: 9,
            reason: 'win',
            quantity: 10,
            cost: 20,
            orders: [{ type: 'entry' }],
          },
        ],
      });

      const byPnl = listEventTraces(db, runId, { sort: 'pnl:desc', limit: 10 });
      assert.equal(byPnl[0].condition_id, 'high-pnl');
      assert.equal(byPnl[1].condition_id, 'low-pnl');

      const byCost = listEventTraces(db, runId, { sort: 'cost:asc', limit: 10 });
      assert.equal(byCost[0].condition_id, 'low-pnl');
      assert.equal(byCost[1].condition_id, 'high-pnl');
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});