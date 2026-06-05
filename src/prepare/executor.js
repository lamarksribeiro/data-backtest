import { exportScalarsPartition, listScalarPartitions } from '../sync/scalars.js';
import { exportBacktestTicksPartition, exportBooksPartition, listBookPartitions } from '../sync/bookDatasets.js';
import { exportOhlcFromScalarsPartition, listValidScalarManifestPartitions } from '../sync/ohlc.js';
import { closeSourcePool, createSourcePool } from '../source/postgres.js';

export async function executePreparationActions({ config, db, actions, dryRun = true }) {
  const results = [];
  for (const action of actions) {
    results.push(await executePreparationAction({ config, db, action, dryRun }));
  }
  return results;
}

async function executePreparationAction({ config, db, action, dryRun }) {
  const flags = flagsFromArgs(action.args || []);
  const range = {
    from: requiredFlag(flags, 'from'),
    to: requiredFlag(flags, 'to'),
    underlying: requiredFlag(flags, 'underlying').toUpperCase(),
    interval: requiredFlag(flags, 'interval'),
  };

  if (action.command === 'sync:backfill') {
    return withSourcePool(config, async (pool) => {
      const partitions = await listScalarPartitions(pool, range);
      const partitionsResult = [];
      for (const partition of partitions) {
        partitionsResult.push(await exportScalarsPartition({ config, db, pool, partition, dryRun }));
      }
      return { command: action.command, dryRun, partitions: partitionsResult };
    });
  }

  if (action.command === 'sync:backfill-books' || action.command === 'sync:backfill-backtest-ticks') {
    return withSourcePool(config, async (pool) => {
      const partitions = await listBookPartitions(pool, range);
      const partitionsResult = [];
      for (const partition of partitions) {
        if (action.command === 'sync:backfill-books') {
          partitionsResult.push(await exportBooksPartition({ config, db, pool, partition, dryRun }));
        } else {
          partitionsResult.push(await exportBacktestTicksPartition({
            config,
            db,
            pool,
            partition,
            dryRun,
            bookDepth: Number(flags['book-depth'] || flags.bookDepth || config.backtestBookDepth),
          }));
        }
      }
      return { command: action.command, dryRun, partitions: partitionsResult };
    });
  }

  if (action.command === 'sync:backfill-ohlc') {
    const scalarPartitions = listValidScalarManifestPartitions(db, range);
    const partitionsResult = [];
    for (const scalarPartition of scalarPartitions) {
      partitionsResult.push(await exportOhlcFromScalarsPartition({
        config,
        db,
        scalarPartition,
        resolution: requiredFlag(flags, 'resolution'),
        dryRun,
      }));
    }
    return { command: action.command, dryRun, partitions: partitionsResult };
  }

  throw new Error(`Unsupported preparation command: ${action.command}`);
}

async function withSourcePool(config, fn) {
  const pool = createSourcePool(config);
  try {
    return await fn(pool);
  } finally {
    await closeSourcePool(pool);
  }
}

function flagsFromArgs(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!String(arg).startsWith('--')) continue;
    const key = String(arg).slice(2);
    const value = args[i + 1];
    flags[key] = value;
    i += 1;
  }
  return flags;
}

function requiredFlag(flags, key) {
  if (!flags[key]) throw new Error(`Missing preparation arg: --${key}`);
  return String(flags[key]);
}
