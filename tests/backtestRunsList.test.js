import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import {
  createStrategy,
  createStrategyVersion,
  trashStrategy,
  permanentlyDeleteStrategy,
  updateStrategy,
} from '../src/backtestStudio/state/strategies.js';
import { listBacktestRuns } from '../src/state/backtestRuns.js';

function insertRun(db, {
  strategy = 'legacy',
  strategyId = null,
  strategyVersionId = null,
  summary = { totalPnl: 0 },
} = {}) {
  db.prepare(`
    INSERT INTO backtest_runs (
      strategy, source, underlying, interval, book_depth, from_ts, to_ts, batch_size,
      params_json, ticks, batches, summary_json, result_json, status,
      strategy_id, strategy_version_id
    ) VALUES (?, 'lakehouse', 'BTC', '5m', 25, ?, ?, 1000, '{}', 0, 0, ?, '{}', 'completed', ?, ?)
  `).run(
    strategy,
    '2026-06-01T00:00:00.000Z',
    '2026-06-02T00:00:00.000Z',
    JSON.stringify(summary),
    strategyId,
    strategyVersionId,
  );
  return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
}

test('listBacktestRuns hides orphan and trashed-strategy runs from global list', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-runs-list-'));
  try {
    const db = openStateDatabase(path.join(dir, 'state.db'));
    try {
      const active = createStrategy(db, { name: 'Active', slug: 'active' });
      const activeVersion = createStrategyVersion(db, active.id, {
        source_code: 'strategy "Active" { onTick(tick, event) {} }',
      });
      const trashed = createStrategy(db, { name: 'Trashed', slug: 'trashed' });
      const trashedVersion = createStrategyVersion(db, trashed.id, {
        source_code: 'strategy "Trashed" { onTick(tick, event) {} }',
      });

      const activeRunId = insertRun(db, {
        strategy: 'active',
        strategyId: active.id,
        strategyVersionId: activeVersion.id,
      });
      const legacyRunId = insertRun(db, { strategy: 'EDGE_SNIPER_V2' });
      const trashedRunId = insertRun(db, {
        strategy: 'trashed',
        strategyId: trashed.id,
        strategyVersionId: trashedVersion.id,
      });

      trashStrategy(db, trashed.id);

      const deleted = createStrategy(db, { name: 'Gone', slug: 'gone' });
      const deletedVersion = createStrategyVersion(db, deleted.id, {
        source_code: 'strategy "Gone" { onTick(tick, event) {} }',
      });
      const danglingRunId = insertRun(db, {
        strategy: 'gone',
        strategyId: deleted.id,
        strategyVersionId: deletedVersion.id,
      });
      trashStrategy(db, deleted.id);
      permanentlyDeleteStrategy(db, deleted.id, { deleteRuns: false });

      const archived = createStrategy(db, { name: 'Archived', slug: 'archived' });
      const archivedVersion = createStrategyVersion(db, archived.id, {
        source_code: 'strategy "Archived" { onTick(tick, event) {} }',
      });
      updateStrategy(db, archived.id, { status: 'archived' });
      const archivedRunId = insertRun(db, {
        strategy: 'archived',
        strategyId: archived.id,
        strategyVersionId: archivedVersion.id,
      });

      const listed = listBacktestRuns(db, { limit: 100 });
      assert.deepEqual(listed.map((run) => run.id), [activeRunId]);

      const withOrphans = listBacktestRuns(db, { limit: 100, include_orphans: true });
      assert.equal(withOrphans.length, 5);

      const trashedOnly = listBacktestRuns(db, { limit: 100, strategy_id: trashed.id });
      assert.deepEqual(trashedOnly.map((run) => run.id), [trashedRunId]);

      const danglingOnly = listBacktestRuns(db, { limit: 100, strategy_id: deleted.id });
      assert.deepEqual(danglingOnly.map((run) => run.id), [danglingRunId]);

      assert.equal(listBacktestRuns(db, { limit: 100 }).some((run) => run.id === legacyRunId), false);
      assert.equal(listBacktestRuns(db, { limit: 100 }).some((run) => run.id === danglingRunId), false);
      assert.equal(listBacktestRuns(db, { limit: 100 }).some((run) => run.id === archivedRunId), false);

      const archivedOnly = listBacktestRuns(db, { limit: 100, strategy_id: archived.id });
      assert.deepEqual(archivedOnly.map((run) => run.id), [archivedRunId]);

      const oldVersion = createStrategyVersion(db, active.id, {
        source_code: 'strategy "ActiveOld" { onTick(tick, event) {} }',
      });
      const staleVersionRunId = insertRun(db, {
        strategy: 'active-old',
        strategyId: active.id,
        strategyVersionId: oldVersion.id,
      });
      db.prepare('DELETE FROM strategy_versions WHERE id = ?').run(oldVersion.id);
      assert.equal(listBacktestRuns(db, { limit: 100 }).some((run) => run.id === staleVersionRunId), false);
    } finally {
      closeStateDatabase(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
