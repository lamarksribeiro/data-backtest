#!/usr/bin/env node
import 'dotenv/config';

import { loadConfig } from './config.js';
import { openStateDatabase, closeStateDatabase } from './state/sqlite.js';
import { listManifest, manifestStats } from './state/manifest.js';
import { checkLakeStorage } from './lake/storage.js';
import { getHealth } from './health.js';
import { closeSourcePool, createSourcePool } from './source/postgres.js';
import {
  exportScalarsPartition,
  incrementalRange,
  listScalarPartitions,
  markScalarsPartitionStale,
  reconcileScalarsPartition,
} from './sync/scalars.js';
import { exportBacktestTicksPartition, exportBooksPartition, listBookPartitions } from './sync/bookDatasets.js';
import { exportBacktestTicksLitePartition, listValidBacktestTicksManifestPartitions } from './sync/backtestTicksLite.js';
import { exportOhlcFromScalarsPartition, listValidScalarManifestPartitions, normalizeOhlcResolutions } from './sync/ohlc.js';
import { checkDatasetAvailability } from './query/availability.js';
import { resolveDataRequest } from './query/dataMode.js';
import { queryCandles, queryTicks } from './query/duckdbQuery.js';
import { getTicksForBacktestBatch } from './legacy/polymarketTestAdapter.js';
import { runBacktest } from './backtest/engine.js';
import { runBackupCheck } from './ops/backupCheck.js';
import { getStrategy, getStrategyVersion } from './backtestStudio/state/strategies.js';
import { parse } from './backtestStudio/gls/parser.js';
import { warmupDatasetDiskCache } from './backtest/datasetDiskLoader.js';
import { clearDatasetDiskCache, scanDatasetDiskCache } from './backtest/datasetDiskStore.js';

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return { command, flags };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log(`data-backtest CLI

Usage:
  npm run health
  npm run storage:check
  npm run ops:check
  npm run manifest:list -- --status valid --limit 50

Commands:
  health          Checks state DB, manifest and lake storage
  storage:check   Ensures lake folders exist and are writable
  ops:check       Validates health, storage and manifest active_path files for backup readiness
  manifest:list   Lists manifest partitions
  manifest:stats  Prints manifest aggregate counts
  manifest:mark-stale Marks a scalars partition stale locally
  query:availability Checks manifest availability for strict queries
  query:resolve Resolves strict/prepare mode for a dataset request
  query:ticks Reads scalars/backtest_ticks through DuckDB using manifest active_path
  query:candles Reads OHLC candles through DuckDB using manifest active_path
  legacy:smoke Reads one polymarket-test compatible backtest batch
  backtest:run Runs a versioned strategy over lakehouse ticks
  sync:partitions Lists sealed source partitions available for sync
  sync:backfill   Exports sealed scalars partitions to Parquet
  sync:backfill-books Exports raw books partitions to Parquet
  sync:backfill-backtest-ticks Exports flattened backtest tick partitions to Parquet
  sync:backfill-backtest-ticks-lite Derives scalar-only backtest_ticks_lite from valid backtest_ticks
  sync:backfill-ohlc Exports OHLC candles from valid scalars Parquet
  sync:incremental Exports recent sealed scalars partitions using SYNC_MARGIN_MINUTES
  sync:reconcile-scalars Recomputes source fingerprints and marks changed scalars stale
  cache:dataset     Materializes daily ColumnSet cache on disk for a date window
  cache:dataset:stats Shows disk cache usage summary
  cache:dataset:clear Clears disk cache (optional filters)

Sync examples:
  node src/cli.js sync:partitions --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m
  node src/cli.js sync:backfill --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --dry-run
  node src/cli.js sync:backfill-books --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --dry-run
  node src/cli.js sync:backfill-backtest-ticks --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10 --dry-run
  node src/cli.js sync:backfill-backtest-ticks-lite --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10 --dry-run
  node src/cli.js sync:backfill-ohlc --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --resolution 1m --dry-run
  node src/cli.js sync:incremental --lookback-days 2 --underlying BTC --interval 5m
  node src/cli.js sync:reconcile-scalars --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --dry-run
  node src/cli.js query:availability --dataset backtest_ticks --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10
  node src/cli.js query:resolve --mode prepare --dataset backtest_ticks --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10
  node src/cli.js query:ticks --dataset backtest_ticks --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10 --limit 10
  node src/cli.js legacy:smoke --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10 --limit 10
  node src/cli.js backtest:run --strategy-id 1 --strategy-version-id 1 --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10 --batch-size 5000
`);
}

function requiredFlag(flags, key) {
  const value = flags[key];
  if (!value || value === true) throw new Error(`--${key} is required`);
  return String(value);
}

function optionalIntFlag(flags, key) {
  if (flags[key] == null || flags[key] === true) return null;
  const value = Number.parseInt(String(flags[key]), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function optionalBoolFlag(flags, key) {
  return Boolean(flags[key]);
}

function toRange(flags) {
  const from = parseDateStart(requiredFlag(flags, 'from'));
  const to = parseDateEnd(requiredFlag(flags, 'to'));
  if (to <= from) throw new Error('--to must be after --from');
  return { from: from.toISOString(), to: to.toISOString() };
}

function parseDateStart(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00.000Z`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function parseDateEnd(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath);

  try {
    if (command === 'health') {
      printJson(await getHealth(config, db));
      return;
    }

    if (command === 'storage:check') {
      printJson(await checkLakeStorage(config.lakeRoot));
      return;
    }

    if (command === 'ops:check') {
      printJson(await runBackupCheck(config, db));
      return;
    }

    if (command === 'manifest:list') {
      printJson({ partitions: listManifest(db, flags) });
      return;
    }

    if (command === 'manifest:stats') {
      printJson(manifestStats(db));
      return;
    }

    if (command === 'manifest:mark-stale') {
      const dataset = flags.dataset ? String(flags.dataset) : 'scalars';
      if (dataset !== 'scalars') throw new Error('manifest:mark-stale currently supports dataset=scalars only');
      const partition = {
        marketId: flags['market-id'] ? String(flags['market-id']) : null,
        underlying: requiredFlag(flags, 'underlying').toUpperCase(),
        interval: requiredFlag(flags, 'interval'),
        dt: requiredFlag(flags, 'dt'),
      };
      const result = markScalarsPartitionStale(db, partition, flags.reason ? String(flags.reason) : 'manual stale mark');
      printJson({ partition, ...result });
      return;
    }

    if (command === 'query:availability') {
      const range = toRange(flags);
      const dataset = flags.dataset ? String(flags.dataset) : 'backtest_ticks';
      const request = buildQueryRequest(flags, range, dataset);
      printJson(checkDatasetAvailability(db, request));
      return;
    }

    if (command === 'query:resolve') {
      const range = toRange(flags);
      const dataset = flags.dataset ? String(flags.dataset) : 'backtest_ticks';
      const request = buildQueryRequest(flags, range, dataset);
      const mode = flags.mode ? String(flags.mode) : config.backtestDataMode;
      printJson(resolveDataRequest(db, request, mode));
      return;
    }

    if (command === 'query:ticks') {
      const range = toRange(flags);
      const dataset = flags.dataset ? String(flags.dataset) : 'backtest_ticks';
      const request = buildQueryRequest(flags, range, dataset);
      printJson({ rows: await queryTicks(db, request) });
      return;
    }

    if (command === 'query:candles') {
      const range = toRange(flags);
      const request = buildQueryRequest(flags, range, 'ohlc');
      printJson({ rows: await queryCandles(db, request) });
      return;
    }

    if (command === 'legacy:smoke') {
      const range = toRange(flags);
      const rows = await getTicksForBacktestBatch(db, {
        ...range,
        underlying: requiredFlag(flags, 'underlying').toUpperCase(),
        interval: requiredFlag(flags, 'interval'),
        bookDepth: optionalIntFlag(flags, 'book-depth') ?? config.backtestBookDepth,
        limit: optionalIntFlag(flags, 'limit') ?? 10,
      });
      printJson({ rows_count: rows.length, first_row: rows[0] ?? null });
      return;
    }

    if (command === 'backtest:run') {
      const range = toRange(flags);
      const strategyId = optionalIntFlag(flags, 'strategy-id');
      const strategyVersionId = optionalIntFlag(flags, 'strategy-version-id');
      if (!strategyId || !strategyVersionId) throw new Error('--strategy-id and --strategy-version-id are required');
      const strategy = getStrategy(db, strategyId);
      if (!strategy) throw new Error('Strategy not found');
      const version = getStrategyVersion(db, strategyId, strategyVersionId);
      if (!version) throw new Error('Strategy version not found');
      if (!version.validation?.ok) throw new Error('Strategy version failed validation');
      const result = await runBacktest(db, {
        ...range,
        strategy: `gls:${strategy.slug}`,
        strategyLabel: version.source_code.match(/strategy\s+"([^"]+)"/)?.[1] || strategy.name,
        glsAst: parse(version.source_code),
        strategyMeta: {
          strategy_id: strategyId,
          strategy_version_id: strategyVersionId,
          slug: strategy.slug,
          name: strategy.name,
          version: version.version,
          language: version.language,
          source_code: version.source_code,
          params_schema: version.params_schema,
          checksum: version.checksum,
        },
        underlying: requiredFlag(flags, 'underlying').toUpperCase(),
        interval: requiredFlag(flags, 'interval'),
        bookDepth: optionalIntFlag(flags, 'book-depth') ?? config.backtestBookDepth,
        batchSize: optionalIntFlag(flags, 'batch-size') ?? optionalIntFlag(flags, 'limit') ?? 5000,
        params: parseJsonFlag(flags, 'params') ?? {},
      });
      printJson(result);
      return;
    }

    if (command === 'sync:partitions') {
      const range = toRange(flags);
      const pool = createSourcePool(config);
      try {
        const partitions = await listScalarPartitions(pool, {
          ...range,
          underlying: flags.underlying ? String(flags.underlying).toUpperCase() : null,
          interval: flags.interval ? String(flags.interval) : null,
          limit: optionalIntFlag(flags, 'limit'),
        });
        printJson({ partitions });
      } finally {
        await closeSourcePool(pool);
      }
      return;
    }

    if (command === 'sync:backfill') {
      const range = toRange(flags);
      const pool = createSourcePool(config);
      try {
        const partitions = await listScalarPartitions(pool, {
          ...range,
          underlying: flags.underlying ? String(flags.underlying).toUpperCase() : null,
          interval: flags.interval ? String(flags.interval) : null,
          limit: optionalIntFlag(flags, 'limit'),
        });
        const results = [];
        for (const partition of partitions) {
          results.push(await exportScalarsPartition({
            config,
            db,
            pool,
            partition,
            dryRun: Boolean(flags['dry-run']),
            rebuild: Boolean(flags.rebuild),
            allowNeedsReview: Boolean(flags['allow-needs-review']),
          }));
        }
        printJson({ partitions: results });
      } finally {
        await closeSourcePool(pool);
      }
      return;
    }

    if (command === 'sync:backfill-books' || command === 'sync:backfill-backtest-ticks') {
      const range = toRange(flags);
      const pool = createSourcePool(config);
      try {
        const partitions = await listBookPartitions(pool, {
          ...range,
          underlying: flags.underlying ? String(flags.underlying).toUpperCase() : null,
          interval: flags.interval ? String(flags.interval) : null,
          limit: optionalIntFlag(flags, 'limit'),
        });
        const results = [];
        for (const partition of partitions) {
          if (command === 'sync:backfill-books') {
            results.push(await exportBooksPartition({
              config,
              db,
              pool,
              partition,
              dryRun: optionalBoolFlag(flags, 'dry-run'),
              rebuild: optionalBoolFlag(flags, 'rebuild'),
              allowNeedsReview: optionalBoolFlag(flags, 'allow-needs-review'),
            }));
          } else {
            const bookDepth = optionalIntFlag(flags, 'book-depth') ?? config.backtestBookDepth;
            const tickResult = await exportBacktestTicksPartition({
              config,
              db,
              pool,
              partition,
              dryRun: optionalBoolFlag(flags, 'dry-run'),
              rebuild: optionalBoolFlag(flags, 'rebuild'),
              allowNeedsReview: optionalBoolFlag(flags, 'allow-needs-review'),
              bookDepth,
            });
            results.push(tickResult);
            if (!optionalBoolFlag(flags, 'dry-run') && !tickResult?.skipped) {
              results.push(await exportBacktestTicksLitePartition({
                config,
                db,
                partition: { ...partition, bookDepth },
                dryRun: false,
                rebuild: optionalBoolFlag(flags, 'rebuild'),
              }));
            }
          }
        }
        printJson({ partitions: results });
      } finally {
        await closeSourcePool(pool);
      }
      return;
    }

    if (command === 'sync:backfill-backtest-ticks-lite') {
      const range = toRange(flags);
      const bookDepth = optionalIntFlag(flags, 'book-depth') ?? config.backtestBookDepth;
      const partitions = listValidBacktestTicksManifestPartitions(db, {
        ...range,
        underlying: flags.underlying ? String(flags.underlying).toUpperCase() : null,
        interval: flags.interval ? String(flags.interval) : null,
        bookDepth,
      });
      const results = [];
      for (const row of partitions) {
        results.push(await exportBacktestTicksLitePartition({
          config,
          db,
          partition: {
            underlying: row.underlying,
            interval: row.interval,
            bookDepth: row.book_depth,
            dt: row.dt,
          },
          dryRun: optionalBoolFlag(flags, 'dry-run'),
          rebuild: optionalBoolFlag(flags, 'rebuild'),
        }));
      }
      printJson({ partitions: results });
      return;
    }

    if (command === 'sync:backfill-ohlc') {
      const range = toRange(flags);
      const scalarPartitions = listValidScalarManifestPartitions(db, {
        ...range,
        underlying: flags.underlying ? String(flags.underlying).toUpperCase() : null,
        interval: flags.interval ? String(flags.interval) : null,
        limit: optionalIntFlag(flags, 'limit'),
      });
      const resolutions = normalizeOhlcResolutions(flags.resolution || 'all');
      const results = [];
      for (const scalarPartition of scalarPartitions) {
        for (const resolution of resolutions) {
          results.push(await exportOhlcFromScalarsPartition({
            config,
            db,
            scalarPartition,
            resolution,
            dryRun: optionalBoolFlag(flags, 'dry-run'),
            rebuild: optionalBoolFlag(flags, 'rebuild'),
          }));
        }
      }
      printJson({ partitions: results });
      return;
    }

    if (command === 'sync:incremental') {
      const lookbackDays = optionalIntFlag(flags, 'lookback-days') ?? 2;
      const range = incrementalRange({
        lookbackDays,
        marginMinutes: config.syncMarginMinutes,
        from: flags.from && flags.from !== true ? String(flags.from) : null,
        to: flags.to && flags.to !== true ? String(flags.to) : null,
      });
      const pool = createSourcePool(config);
      try {
        const partitions = await listScalarPartitions(pool, {
          ...range,
          underlying: flags.underlying ? String(flags.underlying).toUpperCase() : null,
          interval: flags.interval ? String(flags.interval) : null,
          limit: optionalIntFlag(flags, 'limit'),
        });
        const results = [];
        for (const partition of partitions) {
          results.push(await exportScalarsPartition({
            config,
            db,
            pool,
            partition,
            dryRun: optionalBoolFlag(flags, 'dry-run'),
            rebuild: optionalBoolFlag(flags, 'rebuild'),
            allowNeedsReview: optionalBoolFlag(flags, 'allow-needs-review'),
          }));
        }
        printJson({ range, partitions: results });
      } finally {
        await closeSourcePool(pool);
      }
      return;
    }

    if (command === 'sync:reconcile-scalars') {
      const range = toRange(flags);
      const pool = createSourcePool(config);
      try {
        const partitions = await listScalarPartitions(pool, {
          ...range,
          underlying: flags.underlying ? String(flags.underlying).toUpperCase() : null,
          interval: flags.interval ? String(flags.interval) : null,
          limit: optionalIntFlag(flags, 'limit'),
        });
        const results = [];
        for (const partition of partitions) {
          results.push(await reconcileScalarsPartition({
            config,
            db,
            pool,
            partition,
            markStale: !optionalBoolFlag(flags, 'dry-run'),
          }));
        }
        printJson({ partitions: results });
      } finally {
        await closeSourcePool(pool);
      }
      return;
    }

    if (command === 'cache:dataset') {
      const range = toRange(flags);
      const warmed = await warmupDatasetDiskCache(db, {
        dataset: flags.dataset ? String(flags.dataset) : 'backtest_ticks',
        underlying: requiredFlag(flags, 'underlying').toUpperCase(),
        interval: requiredFlag(flags, 'interval'),
        bookDepth: optionalIntFlag(flags, 'book-depth') ?? config.backtestBookDepth,
        from: range.from,
        to: range.to,
      }, { config });
      printJson(warmed);
      return;
    }

    if (command === 'cache:dataset:stats') {
      printJson(scanDatasetDiskCache(config));
      return;
    }

    if (command === 'cache:dataset:clear') {
      const result = clearDatasetDiskCache(config, {
        underlying: flags.underlying ? String(flags.underlying).toUpperCase() : undefined,
        interval: flags.interval ? String(flags.interval) : undefined,
        dataset: flags.dataset ? String(flags.dataset) : undefined,
        bookDepth: flags['book-depth'] != null ? optionalIntFlag(flags, 'book-depth') : undefined,
      });
      printJson({ ok: true, ...result });
      return;
    }

    printHelp();
    process.exitCode = 1;
  } finally {
    closeStateDatabase(db);
  }
}

function buildQueryRequest(flags, range, dataset) {
  const request = {
    dataset,
    from: range.from,
    to: range.to,
    underlying: requiredFlag(flags, 'underlying').toUpperCase(),
    interval: requiredFlag(flags, 'interval'),
    limit: optionalIntFlag(flags, 'limit') ?? 1000,
  };

  if (dataset === 'backtest_ticks') request.bookDepth = optionalIntFlag(flags, 'book-depth') ?? loadConfig().backtestBookDepth;
  if (dataset === 'ohlc') request.resolution = requiredFlag(flags, 'resolution');
  return request;
}

function parseJsonFlag(flags, key) {
  if (flags[key] == null || flags[key] === true) return null;
  try {
    return JSON.parse(String(flags[key]));
  } catch (error) {
    throw new Error(`--${key} must be valid JSON: ${error.message}`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
