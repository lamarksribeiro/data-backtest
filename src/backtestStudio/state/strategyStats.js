const STATS_CACHE_TTL_MS = 30_000;
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

export function getStrategyStats(db, strategyId) {
  const key = `id:${strategyId}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const runs = db.prepare(`
    SELECT id, strategy_version_id, summary_json, created_at
    FROM backtest_runs
    WHERE strategy_id = ? AND status = 'completed'
    ORDER BY created_at DESC
    LIMIT 200
  `).all(strategyId);

  const totals = aggregateRuns(runs);
  const byVersion = db.prepare(`
    SELECT sv.id AS version_id, sv.version,
      COUNT(br.id) AS runs,
      MAX(br.created_at) AS last_run_at
    FROM strategy_versions sv
    LEFT JOIN backtest_runs br ON br.strategy_version_id = sv.id AND br.status = 'completed'
    WHERE sv.strategy_id = ?
    GROUP BY sv.id
    ORDER BY sv.version DESC
  `).all(strategyId).map((row) => {
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

  const result = {
    strategy_id: Number(strategyId),
    totals,
    sparkline: runs.slice(0, 20).reverse().map((r) => Number(parseSummary(r).totalPnl ?? 0)),
    by_version: byVersion,
  };
  cacheSet(key, result);
  return result;
}

export function listStrategiesWithStats(db) {
  const key = 'all';
  const cached = cacheGet(key);
  if (cached) return cached;

  const strategies = db.prepare(`
    SELECT id, slug, name, status, pinned, updated_at
    FROM strategy_definitions
    ORDER BY pinned DESC, updated_at DESC, id DESC
  `).all();

  const result = strategies.map((row) => {
    const stats = getStrategyStats(db, row.id);
    return {
      id: Number(row.id),
      slug: row.slug,
      name: row.name,
      status: row.status,
      pinned: Boolean(row.pinned),
      totals: stats.totals,
      sparkline: stats.sparkline,
      stats,
    };
  });
  cacheSet(key, result);
  return result;
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
