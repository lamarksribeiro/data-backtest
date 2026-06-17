import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { createStrategy, createStrategyVersion } from '../src/backtestStudio/state/strategies.js';
import { getStrategyStats, listStrategiesWithStats } from '../src/backtestStudio/state/strategyStats.js';

function insertRun(db, {
	strategySlug,
	strategyId,
	versionId,
	fromTs,
	toTs,
	summary,
	result = {},
	createdAt = null,
}) {
	const cols = [
		'strategy', 'source', 'underlying', 'interval', 'book_depth', 'from_ts', 'to_ts', 'batch_size',
		'params_json', 'ticks', 'batches', 'summary_json', 'result_json', 'status', 'strategy_id', 'strategy_version_id',
	];
	const placeholders = cols.map(() => '?').join(', ');
	const values = [
		strategySlug,
		'lakehouse',
		'BTC',
		'5m',
		25,
		fromTs,
		toTs,
		1000,
		'{}',
		0,
		0,
		JSON.stringify(summary),
		JSON.stringify(result),
		'completed',
		strategyId,
		versionId,
	];
	if (createdAt) {
		db.prepare(`
      INSERT INTO backtest_runs (${cols.join(', ')}, created_at)
      VALUES (${placeholders}, ?)
    `).run(...values, createdAt);
		return;
	}
	db.prepare(`
    INSERT INTO backtest_runs (${cols.join(', ')})
    VALUES (${placeholders})
  `).run(...values);
}

test('listStrategiesWithStats aggregates multiple strategies in batched queries', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-strategy-stats-'));
	try {
		const db = openStateDatabase(path.join(dir, 'state.db'));
		try {
			const a = createStrategy(db, { name: 'Alpha', slug: 'alpha' });
			const b = createStrategy(db, { name: 'Beta', slug: 'beta' });
			const aVersion = createStrategyVersion(db, a.id, { source_code: 'strategy "Alpha" { onTick(tick, event) {} }' });
			const bVersion = createStrategyVersion(db, b.id, { source_code: 'strategy "Beta" { onTick(tick, event) {} }' });

			insertRun(db, {
				strategySlug: 'alpha',
				strategyId: a.id,
				versionId: aVersion.id,
				fromTs: '2026-06-01T00:00:00.000Z',
				toTs: '2026-06-02T00:00:00.000Z',
				summary: { totalPnl: 12.5, winRate: 0.6 },
				result: { equity: [{ ts: '2026-06-01T00:05:00.000Z', pnl: 12.5 }] },
			});
			insertRun(db, {
				strategySlug: 'beta',
				strategyId: b.id,
				versionId: bVersion.id,
				fromTs: '2026-06-01T00:00:00.000Z',
				toTs: '2026-06-02T00:00:00.000Z',
				summary: { totalPnl: -3.2, winRate: 0.4 },
				result: { equity: [{ ts: '2026-06-01T00:05:00.000Z', pnl: -3.2 }] },
			});

			const list = listStrategiesWithStats(db);
			assert.equal(list.length, 2);
			const alpha = list.find((row) => row.slug === 'alpha');
			const beta = list.find((row) => row.slug === 'beta');
			assert.equal(alpha.totals.runs, 1);
			assert.equal(beta.totals.runs, 1);
			assert.equal(alpha.totals.best_pnl, 12.5);
			assert.equal(beta.totals.best_pnl, -3.2);
			assert.equal(alpha.latest_version, aVersion.version);
			assert.equal(alpha.card_chart.type, 'equity');
			assert.deepEqual(alpha.card_chart.values, [12.5]);
		} finally {
			closeStateDatabase(db);
		}
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
});

test('card_chart uses equity from last run when only one comparable execution exists', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-card-equity-'));
	try {
		const db = openStateDatabase(path.join(dir, 'state.db'));
		try {
			const strategy = createStrategy(db, { name: 'Impulse', slug: 'impulse' });
			const version = createStrategyVersion(db, strategy.id, {
				source_code: 'strategy "Impulse" { onTick(tick, event) {} }',
			});
			insertRun(db, {
				strategySlug: 'impulse',
				strategyId: strategy.id,
				versionId: version.id,
				fromTs: '2026-06-01T00:00:00.000Z',
				toTs: '2026-06-13T00:00:00.000Z',
				summary: { totalPnl: 34.58, winRate: 0.56 },
				result: {
					equity: [
						{ ts: '2026-06-01T00:05:00.000Z', pnl: 10 },
						{ ts: '2026-06-01T00:10:00.000Z', pnl: 20 },
						{ ts: '2026-06-01T00:15:00.000Z', pnl: 34.58 },
					],
				},
				createdAt: '2026-06-14T02:37:00.000Z',
			});

			const stats = getStrategyStats(db, strategy.id);
			assert.equal(stats.card_chart.type, 'equity');
			assert.deepEqual(stats.card_chart.values, [10, 20, 34.58]);
			assert.equal(stats.card_chart.run_id > 0, true);
			assert.equal(stats.card_chart.version, version.version);
		} finally {
			closeStateDatabase(db);
		}
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
});

test('card_chart shows evolution when same version and window have different results', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-card-evolution-'));
	try {
		const db = openStateDatabase(path.join(dir, 'state.db'));
		try {
			const strategy = createStrategy(db, { name: 'Iter', slug: 'iter' });
			const version = createStrategyVersion(db, strategy.id, {
				source_code: 'strategy "Iter" { onTick(tick, event) {} }',
			});
			const window = {
				fromTs: '2026-06-01T00:00:00.000Z',
				toTs: '2026-06-13T00:00:00.000Z',
			};

			insertRun(db, {
				strategySlug: 'iter',
				strategyId: strategy.id,
				versionId: version.id,
				...window,
				summary: { totalPnl: 12, winRate: 0.5 },
				result: { equity: [{ ts: '2026-06-01T00:05:00.000Z', pnl: 12 }] },
				createdAt: '2026-06-10T10:00:00.000Z',
			});
			insertRun(db, {
				strategySlug: 'iter',
				strategyId: strategy.id,
				versionId: version.id,
				...window,
				summary: { totalPnl: 28, winRate: 0.62 },
				result: { equity: [{ ts: '2026-06-01T00:05:00.000Z', pnl: 28 }] },
				createdAt: '2026-06-12T10:00:00.000Z',
			});
			insertRun(db, {
				strategySlug: 'iter',
				strategyId: strategy.id,
				versionId: version.id,
				...window,
				summary: { totalPnl: 34.58, winRate: 0.56 },
				result: { equity: [{ ts: '2026-06-01T00:05:00.000Z', pnl: 34.58 }] },
				createdAt: '2026-06-14T02:37:00.000Z',
			});

			const stats = getStrategyStats(db, strategy.id);
			assert.equal(stats.card_chart.type, 'evolution');
			assert.deepEqual(stats.card_chart.values, [12, 28, 34.58]);
			assert.equal(stats.card_chart.comparable_runs, 3);
		} finally {
			closeStateDatabase(db);
		}
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
});

test('card_chart keeps equity when comparable runs have identical pnl', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'data-backtest-card-same-pnl-'));
	try {
		const db = openStateDatabase(path.join(dir, 'state.db'));
		try {
			const strategy = createStrategy(db, { name: 'Stable', slug: 'stable' });
			const version = createStrategyVersion(db, strategy.id, {
				source_code: 'strategy "Stable" { onTick(tick, event) {} }',
			});
			const window = {
				fromTs: '2026-06-01T00:00:00.000Z',
				toTs: '2026-06-13T00:00:00.000Z',
			};

			insertRun(db, {
				strategySlug: 'stable',
				strategyId: strategy.id,
				versionId: version.id,
				...window,
				summary: { totalPnl: 20, winRate: 0.5 },
				result: { equity: [{ ts: '2026-06-01T00:05:00.000Z', pnl: 5 }, { ts: '2026-06-01T00:10:00.000Z', pnl: 20 }] },
				createdAt: '2026-06-10T10:00:00.000Z',
			});
			insertRun(db, {
				strategySlug: 'stable',
				strategyId: strategy.id,
				versionId: version.id,
				...window,
				summary: { totalPnl: 20, winRate: 0.5 },
				result: { equity: [{ ts: '2026-06-01T00:05:00.000Z', pnl: 20 }] },
				createdAt: '2026-06-14T02:37:00.000Z',
			});

			const stats = getStrategyStats(db, strategy.id);
			assert.equal(stats.card_chart.type, 'equity');
			assert.deepEqual(stats.card_chart.values, [20]);
		} finally {
			closeStateDatabase(db);
		}
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
});
