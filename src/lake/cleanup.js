import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { buildPartitionDirectory, resolveLakeActivePath } from './paths.js';

export function listActiveParquetRelativePaths(db, lakeRoot) {
  const rows = db.prepare(`
    SELECT active_path FROM lake_manifest
    WHERE active_path IS NOT NULL AND active_path != ''
  `).all();

  return new Set(rows.flatMap((row) => {
    const relative = activePathToRelative(row.active_path, lakeRoot);
    return relative ? [relative] : [];
  }));
}

export async function cleanupPartitionParquetFiles({ db, lakeRoot, partition, dryRun = false }) {
  const partitionDir = buildPartitionDirectory(lakeRoot, partition);
  const relativePath = path.relative(path.resolve(lakeRoot), partitionDir).replace(/\\/g, '/');
  return cleanupOrphanParquetFiles({ db, lakeRoot, relativePath, dryRun });
}

export async function cleanupOrphanParquetFiles({ db, lakeRoot, relativePath = '', dryRun = false }) {
  const root = path.resolve(lakeRoot);
  const scope = path.resolve(root, relativePath || '');
  if (scope !== root && !scope.startsWith(`${root}${path.sep}`)) {
    throw new Error('Cleanup path is outside lake root');
  }

  const activePaths = listActiveParquetRelativePaths(db, root);
  const files = await listParquetFiles(root, scope);
  const deleted = [];
  const kept = [];
  let bytesFreed = 0;

  for (const file of files) {
    if (activePaths.has(file.relativePath)) {
      kept.push(file);
      continue;
    }
    deleted.push(file);
    bytesFreed += file.size;
    if (!dryRun) await rm(file.absolutePath, { force: true });
  }

  return { dryRun, deleted, kept, bytesFreed };
}

async function listParquetFiles(root, scope) {
  const entries = [];
  await walk(scope);
  return entries;

  async function walk(currentPath) {
    let dirEntries;
    try {
      dirEntries = await readdir(currentPath, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }

    for (const entry of dirEntries) {
      if (entry.name === '.tmp') continue;
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.parquet')) continue;
      const fileStats = await stat(absolutePath);
      entries.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath).replace(/\\/g, '/'),
        size: fileStats.size,
      });
    }
  }
}

function activePathToRelative(activePath, lakeRoot) {
  const root = path.resolve(lakeRoot);
  const resolved = resolveLakeActivePath(root, activePath);
  if (!resolved) return null;
  const relative = path.relative(root, resolved).replace(/\\/g, '/');
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative;
}
