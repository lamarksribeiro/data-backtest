import path from 'node:path';

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

  return {
    lakeRoot: resolvePath(env.LAKE_ROOT, './lake'),
    stateDbPath: resolvePath(env.STATE_DB_PATH, './state/data-backtest.db'),
    backtestDataMode,
    dataCollectorDatabaseUrl: env.DATA_COLLECTOR_DATABASE_URL || env.SOURCE_DATABASE_URL || '',
    dataCollectorApiUrl: env.DATA_COLLECTOR_API_URL || '',
    dataCollectorArchiveApiKey: env.DATA_COLLECTOR_ARCHIVE_API_KEY || '',
    syncBatchSize: Math.max(Number.parseInt(String(env.SYNC_BATCH_SIZE || '50000'), 10) || 50000, 1),
    syncStatementTimeoutMs: Math.max(Number.parseInt(String(env.SYNC_STATEMENT_TIMEOUT_MS || '120000'), 10) || 120000, 1000),
    syncMarginMinutes: Math.max(Number.parseInt(String(env.SYNC_MARGIN_MINUTES || '2'), 10) || 2, 0),
    backtestBookDepth: Math.max(Number.parseInt(String(env.BACKTEST_BOOK_DEPTH || '10'), 10) || 10, 1),
  };
}

export function requireSourceDatabaseUrl(config) {
  if (!config.dataCollectorDatabaseUrl) {
    throw new Error('DATA_COLLECTOR_DATABASE_URL is required for sync commands');
  }
  return config.dataCollectorDatabaseUrl;
}

export { VALID_DATA_MODES };
