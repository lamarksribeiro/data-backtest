import { exportScalarsPartition, listScalarPartitions } from '../sync/scalars.js';
import { exportBacktestTicksPartition, exportBooksPartition, listBookPartitions } from '../sync/bookDatasets.js';
import { exportOhlcFromScalarsPartition, listValidScalarManifestPartitions } from '../sync/ohlc.js';
import { closeSourcePool, createSourcePool } from '../source/postgres.js';
import { PrepareJobCancelledError } from './errors.js';

export async function executePreparationActions({
  config,
  db,
  actions,
  dryRun = true,
  onProgress,
  shouldCancel,
}) {
  const results = [];
  for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
    assertNotCancelled(shouldCancel);
    const action = actions[actionIndex];
    onProgress?.({
      action_index: actionIndex,
      actions_total: actions.length,
      action_command: action.command,
    });
    results.push(await executePreparationAction({
      config,
      db,
      action,
      dryRun,
      actionIndex,
      actionsTotal: actions.length,
      onProgress,
      shouldCancel,
    }));
  }
  return results;
}

async function executePreparationAction({
  config,
  db,
  action,
  dryRun,
  actionIndex,
  actionsTotal,
  onProgress,
  shouldCancel,
}) {
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
      onProgress?.({ partitions_total: partitions.length, partitions_done: 0 });
      const partitionsResult = [];
      for (let partitionIndex = 0; partitionIndex < partitions.length; partitionIndex += 1) {
        assertNotCancelled(shouldCancel);
        const partition = partitions[partitionIndex];
        onProgress?.({
          action_index: actionIndex,
          actions_total: actionsTotal,
          action_command: action.command,
          partitions_total: partitions.length,
          partitions_done: partitionIndex,
          current: { dt: partition.dt, phase: 'starting', partition_index: partitionIndex + 1 },
        });
        const result = await exportScalarsPartition({
          config,
          db,
          pool,
          partition,
          dryRun,
          rebuild: Boolean(flags.rebuild),
          allowNeedsReview: Boolean(flags['allow-needs-review']),
          onProgress: (patch) => onProgress?.({
            action_index: actionIndex,
            actions_total: actionsTotal,
            action_command: action.command,
            partitions_total: partitions.length,
            partitions_done: partitionIndex,
            current: { dt: partition.dt, partition_index: partitionIndex + 1, ...patch.current },
            ...(patch.files ? { files: patch.files } : {}),
          }),
        });
        partitionsResult.push(result);
        appendFileProgress(onProgress, result, partitionIndex + 1, partitions.length, actionIndex, actionsTotal, action.command);
      }
      onProgress?.({ partitions_done: partitions.length, current: null });
      return { command: action.command, dryRun, partitions: partitionsResult };
    });
  }

  if (action.command === 'sync:backfill-books' || action.command === 'sync:backfill-backtest-ticks') {
    return withSourcePool(config, async (pool) => {
      const partitions = await listBookPartitions(pool, range);
      onProgress?.({ partitions_total: partitions.length, partitions_done: 0 });
      const partitionsResult = [];
      for (let partitionIndex = 0; partitionIndex < partitions.length; partitionIndex += 1) {
        assertNotCancelled(shouldCancel);
        const partition = partitions[partitionIndex];
        const exportFn = action.command === 'sync:backfill-books'
          ? exportBooksPartition
          : exportBacktestTicksPartition;
        const exportArgs = {
          config,
          db,
          pool,
          partition,
          dryRun,
          rebuild: Boolean(flags.rebuild),
          allowNeedsReview: Boolean(flags['allow-needs-review']),
          onProgress: (patch) => onProgress?.({
            action_index: actionIndex,
            actions_total: actionsTotal,
            action_command: action.command,
            partitions_total: partitions.length,
            partitions_done: partitionIndex,
            current: { dt: partition.dt, partition_index: partitionIndex + 1, ...patch.current },
          }),
        };
        if (action.command === 'sync:backfill-backtest-ticks') {
          exportArgs.bookDepth = Number(flags['book-depth'] || flags.bookDepth || config.backtestBookDepth);
        }
        onProgress?.({
          action_index: actionIndex,
          actions_total: actionsTotal,
          action_command: action.command,
          partitions_total: partitions.length,
          partitions_done: partitionIndex,
          current: { dt: partition.dt, phase: 'starting', partition_index: partitionIndex + 1 },
        });
        const result = await exportFn(exportArgs);
        partitionsResult.push(result);
        appendFileProgress(onProgress, result, partitionIndex + 1, partitions.length, actionIndex, actionsTotal, action.command);
      }
      onProgress?.({ partitions_done: partitions.length, current: null });
      return { command: action.command, dryRun, partitions: partitionsResult };
    });
  }

  if (action.command === 'sync:backfill-ohlc') {
    const scalarPartitions = listValidScalarManifestPartitions(db, range);
    onProgress?.({ partitions_total: scalarPartitions.length, partitions_done: 0 });
    const partitionsResult = [];
    for (let partitionIndex = 0; partitionIndex < scalarPartitions.length; partitionIndex += 1) {
      assertNotCancelled(shouldCancel);
      const scalarPartition = scalarPartitions[partitionIndex];
      onProgress?.({
        action_index: actionIndex,
        actions_total: actionsTotal,
        action_command: action.command,
        partitions_total: scalarPartitions.length,
        partitions_done: partitionIndex,
        current: { dt: scalarPartition.dt, phase: 'starting', partition_index: partitionIndex + 1 },
      });
      const result = await exportOhlcFromScalarsPartition({
        config,
        db,
        scalarPartition,
        resolution: requiredFlag(flags, 'resolution'),
        dryRun,
        rebuild: Boolean(flags.rebuild),
      });
      partitionsResult.push(result);
      appendFileProgress(onProgress, result, partitionIndex + 1, scalarPartitions.length, actionIndex, actionsTotal, action.command);
    }
    onProgress?.({ partitions_done: scalarPartitions.length, current: null });
    return { command: action.command, dryRun, partitions: partitionsResult };
  }

  throw new Error(`Unsupported preparation command: ${action.command}`);
}

function appendFileProgress(onProgress, result, partitionIndex, partitionsTotal, actionIndex, actionsTotal, actionCommand) {
  if (!onProgress || !result) return;
  const fileEntry = {
    dt: result.partition?.dt ?? null,
    path: result.activePath ?? result.active_path ?? null,
    rows: result.rows ?? result.expectedRows ?? null,
    status: result.status ?? (result.skipped ? 'skipped' : result.dryRun ? 'dry_run' : 'done'),
    skipped: Boolean(result.skipped),
    reason: result.reason ?? null,
  };
  onProgress({
    action_index: actionIndex,
    actions_total: actionsTotal,
    action_command: actionCommand,
    partitions_total: partitionsTotal,
    partitions_done: partitionIndex,
    current: { dt: fileEntry.dt, phase: 'done', partition_index: partitionIndex },
    files: [fileEntry],
  });
}

function assertNotCancelled(shouldCancel) {
  if (typeof shouldCancel === 'function' && shouldCancel()) {
    throw new PrepareJobCancelledError();
  }
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
    if (value == null || String(value).startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = value;
    i += 1;
  }
  return flags;
}

function requiredFlag(flags, key) {
  if (!flags[key]) throw new Error(`Missing preparation arg: --${key}`);
  return String(flags[key]);
}
