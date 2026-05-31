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
  source_tick_count INTEGER,
  source_condition_count INTEGER,
  source_quality_recorded_at_max TEXT,
  source_fingerprint TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'missing', 'pending', 'writing', 'valid', 'invalid', 'needs_review', 'rebuilding', 'stale'
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
`;

export function openStateDatabase(stateDbPath) {
  mkdirSync(path.dirname(stateDbPath), { recursive: true });
  const db = new DatabaseSync(stateDbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  return db;
}

export function closeStateDatabase(db) {
  db.close();
}
