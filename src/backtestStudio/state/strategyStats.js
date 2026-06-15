const STATS_CACHE_TTL_MS = 30_000;
const MAX_RUNS_PER_STRATEGY = 200;
const cache = new Map();

export function invalidateStrategyStatsCache() {
	cache.clear();
}

function cacheGet(key) {
	const entry = cache.get(key);
	if (!entry) return null;
	if (Date.now() - entry.at > STATS_CACHE_TTL_MS) {
		cache.delete(key);
		return null;
	}
	return entry.value;
}

function cacheSet(key, value) {
	cache.set(key, { at: Date.now(), value });
}

function parseSummary(row) {
	try {
		return JSON.parse(row.summary_json || '{}');
	} catch {
		return {};
	}
}

function winRateFromSummary(summary, entries) {
	if (summary.winRate != null) return Number(summary.winRate) / (summary.winRate > 1 ? 100 : 1);
	const wins = summary.totalWins ?? summary.wins ?? 0;
	const total = summary.totalEntries ?? summary.entries ?? entries;
	return total > 0 ? wins / total : 0;
}

function aggregateRuns(runs) {
	if (!runs.length) {
		return { runs: 0, win_rate: 0, avg_pnl: 0, best_pnl: 0, last_run_at: null };
	}
	let bestPnl = -Infinity;
	let totalPnl = 0;
	let winSum = 0;
	for (const row of runs) {
		const summary = parseSummary(row);
		const pnl = Number(summary.totalPnl ?? 0);
		totalPnl += pnl;
		if (pnl > bestPnl) bestPnl = pnl;
		winSum += winRateFromSummary(summary, 0);
	}
	return {
		runs: runs.length,
		win_rate: runs.length ? winSum / runs.length : 0,
		avg_pnl: runs.length ? totalPnl / runs.length : 0,
		best_pnl: bestPnl === -Infinity ? 0 : bestPnl,
		last_run_at: runs[0]?.created_at ?? null,
	};
}

function buildStatsFromRuns(strategyId, runs, versionRows = []) {
	const totals = aggregateRuns(runs);
	const byVersion = versionRows.map((row) => {
		const versionRuns = runs.filter((r) => r.strategy_version_id === row.version_id);
		const agg = aggregateRuns(versionRuns);
		return {
			version_id: Number(row.version_id),
			version: Number(row.version),
			runs: Number(row.runs || 0),
			win_rate: agg.win_rate,
			avg_pnl: agg.avg_pnl,
			best_pnl: agg.best_pnl,
			last_run_at: row.last_run_at,
		};
	});

	return {
		strategy_id: Number(strategyId),
		totals,
		sparkline: runs.slice(0, 20).reverse().map((r) => Number(parseSummary(r).totalPnl ?? 0)),
		by_version: byVersion,
	};
}

function loadRunsByStrategy(db, strategyIds) {
	if (!strategyIds.length) return new Map();
	const placeholders = strategyIds.map(() => '?').join(', ');
	const rows = db.prepare(`
    SELECT id, strategy_id, strategy_version_id, summary_json, created_at
    FROM (
      SELECT
        id,
        strategy_id,
        strategy_version_id,
        summary_json,
        created_at,
        ROW_NUMBER() OVER (PARTITION BY strategy_id ORDER BY created_at DESC) AS rn
      FROM backtest_runs
      WHERE strategy_id IN (${placeholders}) AND status = 'completed'
    )
    WHERE rn <= ?
    ORDER BY strategy_id ASC, created_at DESC
  `).all(...strategyIds, MAX_RUNS_PER_STRATEGY);

	const byStrategy = new Map();
	for (const row of rows) {
		const key = Number(row.strategy_id);
		if (!byStrategy.has(key)) byStrategy.set(key, []);
		byStrategy.get(key).push(row);
	}
	return byStrategy;
}

function loadVersionStatsByStrategy(db, strategyIds) {
	if (!strategyIds.length) return new Map();
	const placeholders = strategyIds.map(() => '?').join(', ');
	const rows = db.prepare(`
    SELECT
      sv.strategy_id,
      sv.id AS version_id,
      sv.version,
      COUNT(br.id) AS runs,
      MAX(br.created_at) AS last_run_at
    FROM strategy_versions sv
    LEFT JOIN backtest_runs br ON br.strategy_version_id = sv.id AND br.status = 'completed'
    WHERE sv.strategy_id IN (${placeholders})
    GROUP BY sv.id
    ORDER BY sv.strategy_id ASC, sv.version DESC
  `).all(...strategyIds);

	const byStrategy = new Map();
	for (const row of rows) {
		const key = Number(row.strategy_id);
		if (!byStrategy.has(key)) byStrategy.set(key, []);
		byStrategy.get(key).push(row);
	}
	return byStrategy;
}

function loadLatestVersionsByStrategy(db, strategyIds) {
	if (!strategyIds.length) return new Map();
	const placeholders = strategyIds.map(() => '?').join(', ');
	const rows = db.prepare(`
    SELECT sv.strategy_id, sv.id, sv.version
    FROM strategy_versions sv
    INNER JOIN (
      SELECT strategy_id, MAX(version) AS max_version
      FROM strategy_versions
      WHERE strategy_id IN (${placeholders})
      GROUP BY strategy_id
    ) latest ON latest.strategy_id = sv.strategy_id AND latest.max_version = sv.version
  `).all(...strategyIds);

	return new Map(rows.map((row) => [Number(row.strategy_id), row]));
}

export function getStrategyStats(db, strategyId) {
	const key = `id:${strategyId}`;
	const cached = cacheGet(key);
	if (cached) return cached;

	const runs = db.prepare(`
    SELECT id, strategy_version_id, summary_json, created_at
    FROM backtest_runs
    WHERE strategy_id = ? AND status = 'completed'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(strategyId, MAX_RUNS_PER_STRATEGY);

	const versionRows = db.prepare(`
    SELECT sv.id AS version_id, sv.version,
      COUNT(br.id) AS runs,
      MAX(br.created_at) AS last_run_at
    FROM strategy_versions sv
    LEFT JOIN backtest_runs br ON br.strategy_version_id = sv.id AND br.status = 'completed'
    WHERE sv.strategy_id = ?
    GROUP BY sv.id
    ORDER BY sv.version DESC
  `).all(strategyId);

	const result = buildStatsFromRuns(strategyId, runs, versionRows);
	cacheSet(key, result);
	return result;
}

export function listStrategiesWithStats(db, { trashed = false } = {}) {
	const key = trashed ? 'trash' : 'all';
	const cached = cacheGet(key);
	if (cached) return cached;

	const clause = trashed ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL';
	const strategies = db.prepare(`
    SELECT id, slug, name, status, pinned, default_version_id, updated_at, deleted_at
    FROM strategy_definitions
    WHERE ${clause}
    ORDER BY pinned DESC, updated_at DESC, id DESC
  `).all();

	if (!strategies.length) {
		cacheSet(key, []);
		return [];
	}

	const strategyIds = strategies.map((row) => Number(row.id));
	const runsByStrategy = loadRunsByStrategy(db, strategyIds);
	const versionsByStrategy = loadVersionStatsByStrategy(db, strategyIds);
	const latestByStrategy = loadLatestVersionsByStrategy(db, strategyIds);

	const result = strategies.map((row) => {
		const id = Number(row.id);
		const runs = runsByStrategy.get(id) || [];
		const stats = buildStatsFromRuns(id, runs, versionsByStrategy.get(id) || []);
		const latest = latestByStrategy.get(id);
		return {
			id,
			slug: row.slug,
			name: row.name,
			status: row.status,
			pinned: Boolean(row.pinned),
			default_version_id: row.default_version_id != null ? Number(row.default_version_id) : null,
			deleted_at: row.deleted_at ?? null,
			latest_version: latest?.version != null ? Number(latest.version) : null,
			latest_version_id: latest?.id != null ? Number(latest.id) : null,
			totals: stats.totals,
			sparkline: stats.sparkline,
			stats,
		};
	});

	cacheSet(key, result);
	return result;
}

export function listTrashedStrategiesWithStats(db) {
	return listStrategiesWithStats(db, { trashed: true });
}
