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
    backtestBookDepth: Math.max(Number.parseInt(String(env.BACKTEST_BOOK_DEPTH || '25'), 10) || 25, 1),
    apiPort: Math.max(Number.parseInt(String(env.DATA_BACKTEST_PORT || env.PORT || '3100'), 10) || 3100, 1),
    NODE_ENV: env.NODE_ENV || 'development',
    SESSION_SECRET: env.SESSION_SECRET || (testMode ? 'test-session-secret' : ''),
    SESSION_MAX_AGE_SEC: Math.max(Number.parseInt(String(env.SESSION_MAX_AGE_SEC || '86400'), 10) || 86400, 300),
    INITIAL_ADMIN_USERNAME: String(env.INITIAL_ADMIN_USERNAME || 'admin').trim(),
    INITIAL_ADMIN_PASSWORD: String(env.INITIAL_ADMIN_PASSWORD || '').trim(),
    TEST_MODE: testMode,
  };
}

export function requireSourceDatabaseUrl(config) {
  if (!config.dataCollectorDatabaseUrl) {
    throw new Error('DATA_COLLECTOR_DATABASE_URL is required for sync commands');
  }
  return config.dataCollectorDatabaseUrl;
}

export { VALID_DATA_MODES };
