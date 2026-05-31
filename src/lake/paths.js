import path from 'node:path';

const DATASET_PATHS = new Map([
  ['scalars', 'scalars'],
  ['books', 'books'],
  ['backtest_ticks', 'backtest_ticks'],
  ['ohlc', 'ohlc'],
]);

export function buildPartitionDirectory(lakeRoot, partition) {
  const datasetPath = DATASET_PATHS.get(partition.dataset);
  if (!datasetPath) throw new Error(`Unsupported dataset: ${partition.dataset}`);

  const parts = [lakeRoot, datasetPath];
  if (partition.dataset === 'ohlc') parts.push(`resolution=${partition.resolution}`);
  parts.push(`underlying=${partition.underlying}`);
  parts.push(`interval=${partition.interval}`);
  if (partition.dataset === 'backtest_ticks') parts.push(`book_depth=${partition.bookDepth}`);
  parts.push(`dt=${partition.dt}`);
  return path.join(...parts);
}

export function buildFinalParquetPath(lakeRoot, partition, runId) {
  return path.join(buildPartitionDirectory(lakeRoot, partition), `part-${runId}.parquet`);
}

export function buildTempParquetPath(lakeRoot, dataset, runId) {
  return path.join(lakeRoot, '.tmp', dataset, runId, `part-${runId}.parquet`);
}

export function toPortablePath(filePath) {
  return filePath.split(path.sep).join('/');
}
