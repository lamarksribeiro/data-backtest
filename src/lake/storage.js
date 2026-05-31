import { mkdir, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';

export async function ensureLakeLayout(lakeRoot) {
  const dirs = ['scalars', 'books', 'backtest_ticks', 'ohlc', 'features', 'manifests', '.tmp'];
  await mkdir(lakeRoot, { recursive: true });
  await Promise.all(dirs.map((dir) => mkdir(path.join(lakeRoot, dir), { recursive: true })));
}

export async function checkLakeStorage(lakeRoot) {
  await ensureLakeLayout(lakeRoot);
  await access(lakeRoot);
  const probePath = path.join(lakeRoot, '.tmp', `storage-check-${process.pid}-${Date.now()}.tmp`);
  await writeFile(probePath, 'ok', { encoding: 'utf8' });
  await rm(probePath, { force: true });
  return { ok: true, lake_root: lakeRoot };
}
