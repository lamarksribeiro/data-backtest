import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatasetCacheStats } from './backtest/datasetCache.js';
import { getDirectorySizeBytes, getSqliteBundleSizeBytes } from './fs/diskSize.js';
import { manifestStats } from './state/manifest.js';
import { checkLakeStorage } from './lake/storage.js';

const STORAGE_STATS_TTL_MS = 60_000;
/** @type {{ at: number, data: { lake_bytes: number, state_db_bytes: number } } | null} */
let storageStatsCache = null;

const APP_VERSION = (() => {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version || null;
  } catch {
    return null;
  }
})();

async function getStorageStats(config) {
  const now = Date.now();
  if (storageStatsCache && now - storageStatsCache.at < STORAGE_STATS_TTL_MS) {
    return storageStatsCache.data;
  }

  const [lake_bytes, state_db_bytes] = await Promise.all([
    getDirectorySizeBytes(config.lakeRoot),
    getSqliteBundleSizeBytes(config.stateDbPath),
  ]);

  const data = { lake_bytes, state_db_bytes };
  storageStatsCache = { at: now, data };
  return data;
}

export async function getHealth(config, db) {
  const storage = await checkLakeStorage(config.lakeRoot);
  const diskStats = await getStorageStats(config);
  const manifest = manifestStats(db);
  const fingerprintRow = db.prepare(`
    SELECT COUNT(DISTINCT source_fingerprint) AS distinct_fps
    FROM lake_manifest
    WHERE source_fingerprint IS NOT NULL AND source_fingerprint != ''
  `).get();
  const mem = process.memoryUsage();
  return {
    status: 'ok',
    app_version: APP_VERSION,
    uptime_sec: process.uptime(),
    lake_root: storage.lake_root,
    lake_size_bytes: diskStats.lake_bytes,
    state_db_path: config.stateDbPath,
    state_db_size_bytes: diskStats.state_db_bytes,
    backtest_data_mode: config.backtestDataMode,
    lake_fingerprint: Number(fingerprintRow?.distinct_fps || 0) > 0
      ? `${fingerprintRow.distinct_fps} fingerprints distintos`
      : null,
    manifest,
    runtime: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      dataset_cache: getDatasetCacheStats(),
      backtest_engine: config.backtestEngine,
      dataset_cache_max_mb: config.datasetCacheMaxMb,
      duckdb_threads: Number.parseInt(process.env.DUCKDB_THREADS || '4', 10) || 4,
    },
  };
}
