import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PACKAGE_VERSION = (() => {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const CATALOG_VERSION = 1;
export const SCHEMA_REF = 'backtest_ticks@v1';

export function buildBacktestTicksColumnList(bookDepth) {
  const cols = [
    'market_id', 'underlying', 'interval', 'condition_id', 'event_start', 'event_end', 'ts',
    'underlying_price', 'price_to_beat', 'up_price', 'down_price',
    'up_best_bid', 'up_best_ask', 'down_best_bid', 'down_best_ask',
    'coverage', 'degraded', 'book_depth',
  ];
  for (const side of ['up_ask', 'up_bid', 'down_ask', 'down_bid']) {
    for (let i = 1; i <= bookDepth; i += 1) {
      cols.push(`${side}_px_${i}`, `${side}_sz_${i}`);
    }
  }
  return cols;
}

export function manifestRowToJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    dataset: row.dataset,
    market_id: row.market_id,
    underlying: row.underlying,
    interval: row.interval,
    resolution: row.resolution,
    book_depth: row.book_depth,
    dt: row.dt,
    active_path: row.active_path,
    run_id: row.run_id,
    rows: row.rows,
    events_count: row.events_count,
    min_ts: row.min_ts,
    max_ts: row.max_ts,
    coverage_min: row.coverage_min,
    has_degraded: row.has_degraded,
    quality_details_json: row.quality_details_json,
    source_tick_count: row.source_tick_count,
    source_condition_count: row.source_condition_count,
    source_quality_recorded_at_max: row.source_quality_recorded_at_max,
    source_fingerprint: row.source_fingerprint,
    status: row.status,
    created_at: row.created_at,
    verified_at: row.verified_at,
    error: row.error,
  };
}

export function buildPartitionSidecar({
  manifestRow,
  sha256,
  bytes,
  chunkIndex = 0,
  chunkCount = 1,
  chunkSha256 = null,
}) {
  return {
    v: CATALOG_VERSION,
    kind: 'lake_partition',
    dataset: 'backtest_ticks',
    underlying: manifestRow.underlying,
    interval: manifestRow.interval,
    book_depth: manifestRow.book_depth,
    dt: manifestRow.dt,
    active_path: manifestRow.active_path,
    run_id: manifestRow.run_id,
    manifest_row: manifestRowToJson(manifestRow),
    sha256,
    bytes,
    chunk_index: chunkIndex,
    chunk_count: chunkCount,
    chunk_sha256: chunkSha256,
    app_version: PACKAGE_VERSION,
    schema_ref: SCHEMA_REF,
  };
}

export function buildAssetCatalog({
  underlying,
  interval,
  bookDepth,
  backupRunId,
  lakeRootHint,
  partitions,
  eventExclusions,
}) {
  const bytes = partitions.reduce((sum, p) => sum + Number(p.bytes || 0), 0);
  return {
    v: CATALOG_VERSION,
    kind: 'asset_catalog',
    underlying,
    interval,
    book_depth: bookDepth,
    backup_run_id: backupRunId,
    created_at: new Date().toISOString(),
    lake_root_hint: lakeRootHint,
    schema_ref: SCHEMA_REF,
    schema_columns: buildBacktestTicksColumnList(bookDepth),
    partitions,
    event_exclusions: eventExclusions,
    stats: {
      partitions: partitions.length,
      bytes,
    },
  };
}

export function buildMasterCatalog({ backupRunId, assets, lakeRootHint, bookDepthDefault }) {
  return {
    v: CATALOG_VERSION,
    kind: 'master_catalog',
    backup_run_id: backupRunId,
    created_at: new Date().toISOString(),
    lake_root_hint: lakeRootHint,
    schema_ref: SCHEMA_REF,
    book_depth_default: bookDepthDefault,
    assets,
  };
}

export function parseCatalogJson(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const data = JSON.parse(text);
  if (!data?.v || !data?.kind) throw new Error('Invalid catalog: missing v/kind');
  return data;
}

export function partitionKey(row) {
  return `${row.underlying}|${row.interval}|${row.book_depth}|${row.dt}`;
}

export function buildCaption({ underlying, dt, chunkIndex = 0, chunkCount = 1 }) {
  const part = chunkCount > 1 ? ` #part${chunkIndex}of${chunkCount}` : ' #part0of1';
  return `#GLBackup #${underlying} #dt${dt}${part}`;
}
