import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS lake_manifest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset TEXT NOT NULL,
  market_id TEXT,
  underlying TEXT NOT NULL,
  interval TEXT NOT NULL,
  resolution TEXT,
  book_depth INTEGER,
  dt TEXT NOT NULL,
  active_path TEXT,
  run_id TEXT,
  rows INTEGER NOT NULL DEFAULT 0,
  events_count INTEGER NOT NULL DEFAULT 0,
  min_ts TEXT,
  max_ts TEXT,
  coverage_min REAL,
  has_degraded INTEGER NOT NULL DEFAULT 0,
  quality_details_json TEXT,
  source_tick_count INTEGER,
  source_condition_count INTEGER,
  source_quality_recorded_at_max TEXT,
  source_fingerprint TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'missing', 'pending', 'writing', 'valid', 'accepted', 'invalid', 'needs_review', 'rebuilding', 'stale'
  )),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  verified_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS lake_manifest_status_idx ON lake_manifest(status);
CREATE INDEX IF NOT EXISTS lake_manifest_lookup_idx ON lake_manifest(dataset, underlying, interval, dt, status);
CREATE INDEX IF NOT EXISTS lake_manifest_source_fingerprint_idx ON lake_manifest(source_fingerprint);

CREATE UNIQUE INDEX IF NOT EXISTS lake_manifest_partition_uidx ON lake_manifest(
  dataset,
  COALESCE(market_id, ''),
  underlying,
  interval,
  COALESCE(resolution, ''),
  COALESCE(book_depth, -1),
  dt
);

CREATE TABLE IF NOT EXISTS prepare_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  mode TEXT NOT NULL DEFAULT 'prepare',
  dry_run INTEGER NOT NULL DEFAULT 1,
  request_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS prepare_jobs_status_idx ON prepare_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'lakehouse',
  underlying TEXT NOT NULL,
  interval TEXT NOT NULL,
  book_depth INTEGER,
  from_ts TEXT NOT NULL,
  to_ts TEXT NOT NULL,
  batch_size INTEGER NOT NULL,
  params_json TEXT NOT NULL,
  ticks INTEGER NOT NULL DEFAULT 0,
  batches INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  progress_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS backtest_runs_lookup_idx ON backtest_runs(strategy, underlying, interval, created_at);

CREATE TABLE IF NOT EXISTS backtest_event_traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES backtest_runs(id),
  condition_id TEXT NOT NULL,
  market_id TEXT,
  event_start TEXT NOT NULL,
  event_end TEXT NOT NULL,
  side TEXT,
  entries_count INTEGER NOT NULL DEFAULT 0,
  exits_count INTEGER NOT NULL DEFAULT 0,
  final_pnl REAL NOT NULL DEFAULT 0,
  result TEXT,
  reason TEXT,
  ticks_count INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}',
  orders_json TEXT NOT NULL DEFAULT '[]',
  marks_json TEXT NOT NULL DEFAULT '[]',
  logs_json TEXT NOT NULL DEFAULT '[]',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  chart_series_path TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS backtest_event_traces_run_idx ON backtest_event_traces(run_id, event_start);
CREATE INDEX IF NOT EXISTS backtest_event_traces_condition_idx ON backtest_event_traces(condition_id);
CREATE INDEX IF NOT EXISTS backtest_event_traces_pnl_idx ON backtest_event_traces(run_id, final_pnl);

CREATE TABLE IF NOT EXISTS strategy_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'validated', 'failed', 'archived')),
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS strategy_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL REFERENCES strategy_definitions(id),
  version INTEGER NOT NULL,
  language TEXT NOT NULL DEFAULT 'gls-v1',
  source_code TEXT NOT NULL,
  params_schema_json TEXT NOT NULL DEFAULT '{}',
  compiled_json TEXT,
  validation_json TEXT NOT NULL DEFAULT '{}',
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(strategy_id, version)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

const BACKTEST_RUNS_MIGRATIONS = [
  'ALTER TABLE backtest_runs ADD COLUMN strategy_id INTEGER NULL',
  'ALTER TABLE backtest_runs ADD COLUMN strategy_version_id INTEGER NULL',
  'ALTER TABLE backtest_runs ADD COLUMN strategy_snapshot_json TEXT NULL',
  'ALTER TABLE backtest_runs ADD COLUMN dataset_request_json TEXT NULL',
  'ALTER TABLE backtest_runs ADD COLUMN status TEXT NOT NULL DEFAULT \'completed\'',
  'ALTER TABLE backtest_runs ADD COLUMN error TEXT NULL',
  'ALTER TABLE backtest_runs ADD COLUMN duration_ms INTEGER NULL',
  'ALTER TABLE backtest_runs ADD COLUMN progress_json TEXT NULL',
];

const PREPARE_JOBS_MIGRATIONS = [
  'ALTER TABLE prepare_jobs ADD COLUMN progress_json TEXT NULL',
];

const STRATEGY_V3_MIGRATIONS = [
  'ALTER TABLE strategy_definitions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE strategy_versions ADD COLUMN notes TEXT NULL',
];

const BACKTEST_RUNS_V3_INDEXES = [
  'CREATE INDEX IF NOT EXISTS backtest_runs_strategy_stats_idx ON backtest_runs(strategy_id, strategy_version_id, created_at)',
];

const LAKE_MANIFEST_MIGRATIONS = [
  'ALTER TABLE lake_manifest ADD COLUMN quality_details_json TEXT NULL',
];

const BACKTEST_RUNS_V3_COLUMNS = [
  'ALTER TABLE backtest_runs ADD COLUMN depends_on_job_id INTEGER NULL',
];

export function openStateDatabase(stateDbPath) {
  mkdirSync(path.dirname(stateDbPath), { recursive: true });
  const db = new DatabaseSync(stateDbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  migrateLakeManifest(db);
  migrateBacktestRuns(db);
  migratePrepareJobs(db);
  migrateStrategyV3(db);
  migrateStrategyDefinitions(db);
  migrateBacktestRunsV3Indexes(db);
  applyColumnMigrations(db, 'backtest_runs', BACKTEST_RUNS_V3_COLUMNS);
  return db;
}

function migrateStrategyV3(db) {
  applyColumnMigrations(db, 'strategy_definitions', STRATEGY_V3_MIGRATIONS.filter((s) => s.includes('strategy_definitions')));
  applyColumnMigrations(db, 'strategy_versions', STRATEGY_V3_MIGRATIONS.filter((s) => s.includes('strategy_versions')));
}

function migrateBacktestRunsV3Indexes(db) {
  for (const sql of BACKTEST_RUNS_V3_INDEXES) {
    try {
      db.exec(sql);
    } catch {
      // index may already exist
    }
  }
}

function migrateLakeManifest(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lake_manifest'").get();
  if (!table?.sql) return;

  if (!table.sql.includes("'accepted'")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      ALTER TABLE lake_manifest RENAME TO lake_manifest_old;
      ${SCHEMA_SQL.split('CREATE INDEX IF NOT EXISTS lake_manifest_status_idx')[0]}
      INSERT INTO lake_manifest (
        id, dataset, market_id, underlying, interval, resolution, book_depth, dt,
        active_path, run_id, rows, events_count, min_ts, max_ts, coverage_min,
        has_degraded, quality_details_json, source_tick_count, source_condition_count,
        source_quality_recorded_at_max, source_fingerprint, status, created_at, verified_at, error
      )
      SELECT
        id, dataset, market_id, underlying, interval, resolution, book_depth, dt,
        active_path, run_id, rows, events_count, min_ts, max_ts, coverage_min,
        has_degraded, NULL, source_tick_count, source_condition_count,
        source_quality_recorded_at_max, source_fingerprint, status, created_at, verified_at, error
      FROM lake_manifest_old;
      DROP TABLE lake_manifest_old;
      PRAGMA foreign_keys = ON;
    `);
  }
  applyColumnMigrations(db, 'lake_manifest', LAKE_MANIFEST_MIGRATIONS);
  db.exec(SCHEMA_SQL);
}

function migrateStrategyDefinitions(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'strategy_definitions'").get();
  if (!table?.sql) return;

  if (!table.sql.includes("'failed'")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      ALTER TABLE strategy_definitions RENAME TO strategy_definitions_old;
      
      CREATE TABLE strategy_definitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'validated', 'failed', 'archived')),
        tags_json TEXT NOT NULL DEFAULT '[]',
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      INSERT INTO strategy_definitions (
        id, slug, name, description, status, tags_json, pinned, created_at, updated_at
      )
      SELECT
        id, slug, name, description, status, tags_json, pinned, created_at, updated_at
      FROM strategy_definitions_old;

      DROP TABLE strategy_definitions_old;
      PRAGMA foreign_keys = ON;
    `);
  }
}

function migrateBacktestRuns(db) {
  applyColumnMigrations(db, 'backtest_runs', BACKTEST_RUNS_MIGRATIONS);
}

function migratePrepareJobs(db) {
  applyColumnMigrations(db, 'prepare_jobs', PREPARE_JOBS_MIGRATIONS);
}

function applyColumnMigrations(db, table, migrations) {
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  for (const sql of migrations) {
    const column = sql.match(/ADD COLUMN (\w+)/)?.[1];
    if (column && !cols.has(column)) {
      try {
        db.exec(sql);
        cols.add(column);
      } catch {
        // column may already exist in race/migration retries
      }
    }
  }
}

export function closeStateDatabase(db) {
  db.close();
}
