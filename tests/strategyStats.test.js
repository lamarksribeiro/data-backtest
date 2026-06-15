import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { createStrategy, createStrategyVersion } from '../src/backtestStudio/state/strategies.js';
import { listStrategiesWithStats } from '../src/backtestStudio/state/strategyStats.js';

test('listStrategiesWithStats aggregates multiple strategies in batched queries', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-strategy-stats-'));
	try {
		const db = openStateDatabase(path.join(dir, 'state.db'));
		try {
			const a = createStrategy(db, { name: 'Alpha', slug: 'alpha' });
			const b = createStrategy(db, { name: 'Beta', slug: 'beta' });
			const aVersion = createStrategyVersion(db, a.id, { source_code: 'strategy "Alpha" { onTick(tick, event) {} }' });
			const bVersion = createStrategyVersion(db, b.id, { source_code: 'strategy "Beta" { onTick(tick, event) {} }' });

			db.prepare(`
        INSERT INTO backtest_runs (
          strategy, source, underlying, interval, book_depth, from_ts, to_ts, batch_size,
          params_json, ticks, batches, summary_json, result_json, status, strategy_id, strategy_version_id
        ) VALUES (?, 'lakehouse', 'BTC', '5m', 25, ?, ?, 1000, '{}', 0, 0, ?, '{}', 'completed', ?, ?)
      `).run(
				'alpha',
				'2026-06-01T00:00:00.000Z',
				'2026-06-02T00:00:00.000Z',
				JSON.stringify({ totalPnl: 12.5, winRate: 0.6 }),
				a.id,
				aVersion.id,
			);
			db.prepare(`
        INSERT INTO backtest_runs (
          strategy, source, underlying, interval, book_depth, from_ts, to_ts, batch_size,
          params_json, ticks, batches, summary_json, result_json, status, strategy_id, strategy_version_id
        ) VALUES (?, 'lakehouse', 'BTC', '5m', 25, ?, ?, 1000, '{}', 0, 0, ?, '{}', 'completed', ?, ?)
      `).run(
				'beta',
				'2026-06-01T00:00:00.000Z',
				'2026-06-02T00:00:00.000Z',
				JSON.stringify({ totalPnl: -3.2, winRate: 0.4 }),
				b.id,
				bVersion.id,
			);

			const list = listStrategiesWithStats(db);
			assert.equal(list.length, 2);
			const alpha = list.find((row) => row.slug === 'alpha');
			const beta = list.find((row) => row.slug === 'beta');
			assert.equal(alpha.totals.runs, 1);
			assert.equal(beta.totals.runs, 1);
			assert.equal(alpha.totals.best_pnl, 12.5);
			assert.equal(beta.totals.best_pnl, -3.2);
			assert.equal(alpha.latest_version, aVersion.version);
		} finally {
			closeStateDatabase(db);
		}
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
});
