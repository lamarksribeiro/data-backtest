import path from 'node:path';

import { normalizeAcceptCountMismatchRatio } from './sync/qualityPolicy.js';

const VALID_DATA_MODES = new Set(['strict', 'prepare', 'hybrid']);

function resolvePath(value, fallback) {
  const raw = value && String(value).trim() ? String(value).trim() : fallback;
  return path.resolve(raw);
}

export function loadConfig(env = process.env) {
  const backtestDataMode = String(env.BACKTEST_DATA_MODE || 'strict').trim().toLowerCase();
  if (!VALID_DATA_MODES.has(backtestDataMode)) {
    throw new Error(`Invalid BACKTEST_DATA_MODE: ${backtestDataMode}`);
  }

  const testMode = String(env.TEST_MODE || '').trim().toLowerCase() === 'true'
    || String(env.NODE_ENV || '').trim().toLowerCase() === 'test';

  return {
    lakeRoot: resolvePath(env.LAKE_ROOT, './lake'),
    stateDbPath: resolvePath(env.STATE_DB_PATH, './state/data-backtest.db'),
    backtestDataMode,
    dataCollectorDatabaseUrl: env.DATA_COLLECTOR_DATABASE_URL || env.SOURCE_DATABASE_URL || '',
    dataCollectorApiUrl: env.DATA_COLLECTOR_API_URL || '',
    dataCollectorArchiveApiKey: env.DATA_COLLECTOR_ARCHIVE_API_KEY || '',
    syncBatchSize: Math.max(Number.parseInt(String(env.SYNC_BATCH_SIZE || '50000'), 10) || 50000, 1),
    syncMaxPool: Math.min(Math.max(Number.parseInt(String(env.SYNC_MAX_POOL || '2'), 10) || 2, 1), 16),
    syncStatementTimeoutMs: Math.max(Number.parseInt(String(env.SYNC_STATEMENT_TIMEOUT_MS || '120000'), 10) || 120000, 1000),
    syncMarginMinutes: Math.max(Number.parseInt(String(env.SYNC_MARGIN_MINUTES || '2'), 10) || 2, 0),
    syncAcceptCountMismatchRatio: normalizeAcceptCountMismatchRatio(env.SYNC_ACCEPT_COUNT_MISMATCH_RATIO),
    syncNormalizeOmitEventRatio: clampRatio(env.SYNC_NORMALIZE_OMIT_EVENT_RATIO, 0.5),
    syncNormalizeDayOmitRatio: clampRatio(env.SYNC_NORMALIZE_DAY_OMIT_RATIO, 0.5),
    syncNormalizeMinStaleSec: Math.max(Number.parseInt(String(env.SYNC_NORMALIZE_MIN_STALE_SEC || '30'), 10) || 30, 1),
    syncNormalizeMinPtb: Math.max(Number.parseFloat(String(env.SYNC_NORMALIZE_MIN_PTB || '1000')) || 1000, 1),
    syncNormalizeMinUnderlyingMove: parseOptionalPositiveFloat(env.SYNC_NORMALIZE_MIN_UNDERLYING_MOVE),
    syncNormalizeQuietUnderlyingMax: parseOptionalPositiveFloat(env.SYNC_NORMALIZE_QUIET_UNDERLYING_MAX),
    syncNormalizeMinQuoteMove: parseOptionalPositiveFloat(env.SYNC_NORMALIZE_MIN_QUOTE_MOVE),
    backtestBookDepth: Math.max(Number.parseInt(String(env.BACKTEST_BOOK_DEPTH || '25'), 10) || 25, 1),
    apiPort: Math.max(Number.parseInt(String(env.DATA_BACKTEST_PORT || env.PORT || '3100'), 10) || 3100, 1),
    NODE_ENV: env.NODE_ENV || 'development',
    SESSION_SECRET: env.SESSION_SECRET || (testMode ? 'test-session-secret' : ''),
    SESSION_MAX_AGE_SEC: Math.max(Number.parseInt(String(env.SESSION_MAX_AGE_SEC || '86400'), 10) || 86400, 300),
    INITIAL_ADMIN_USERNAME: String(env.INITIAL_ADMIN_USERNAME || 'admin').trim(),
    INITIAL_ADMIN_PASSWORD: String(env.INITIAL_ADMIN_PASSWORD || '').trim(),
    TEST_MODE: testMode,
    glsExecution: normalizeGlsExecution(env.GLS_EXECUTION),
    backtestEngine: normalizeBacktestEngine(env.BACKTEST_ENGINE),
    backtestWorkers: Math.max(Number.parseInt(String(env.BACKTEST_WORKERS || '1'), 10) || 1, 1),
    sweepMaxVariants: Math.max(Number.parseInt(String(env.SWEEP_MAX_VARIANTS || '500'), 10) || 500, 1),
    maxConcurrentBacktests: Math.max(Number.parseInt(String(env.MAX_CONCURRENT_BACKTESTS || '1'), 10) || 1, 1),
    datasetCacheMaxMb: resolveDatasetCacheMaxMb(env),
    prepareMaxConcurrent: Math.max(Number.parseInt(String(env.PREPARE_MAX_CONCURRENT || '2'), 10) || 2, 1),
  };
}

function parseOptionalPositiveFloat(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function clampRatio(value, fallback = 0.5) {
  const parsed = Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), 1);
}

function normalizeGlsExecution(value) {
  const mode = String(value || 'compiled').trim().toLowerCase();
  if (mode === 'interpreter') return 'interpreter';
  if (mode === 'compiled-soa') return 'compiled-soa';
  return 'compiled';
}

function normalizeBacktestEngine(value) {
  const mode = String(value || 'soa').trim().toLowerCase();
  return mode === 'rows' ? 'rows' : 'soa';
}

/**
 * Cache LRU de ColumnSet: usa DATASET_CACHE_MAX_MB se definido; senão ~20% do heap Node
 * (NODE_OPTIONS --max-old-space-size), entre 512 MB e 2048 MB.
 */
function resolveDatasetCacheMaxMb(env) {
  const raw = env.DATASET_CACHE_MAX_MB;
  if (raw != null && String(raw).trim() !== '') {
    return Math.max(Number.parseInt(String(raw), 10) || 0, 0);
  }
  const match = String(env.NODE_OPTIONS || '').match(/--max-old-space-size=(\d+)/);
  if (match) {
    const heapMb = Number.parseInt(match[1], 10);
    if (Number.isFinite(heapMb) && heapMb > 0) {
      return Math.min(2048, Math.max(512, Math.floor(heapMb * 0.2)));
    }
  }
  return 512;
}

export function requireSourceDatabaseUrl(config) {
  if (!config.dataCollectorDatabaseUrl) {
    throw new Error('DATA_COLLECTOR_DATABASE_URL is required for sync commands');
  }
  return config.dataCollectorDatabaseUrl;
}

export { VALID_DATA_MODES };
