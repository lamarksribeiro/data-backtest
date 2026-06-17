import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export async function getFileSizeBytes(filePath) {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile() ? fileStat.size : 0;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}

export async function getSqliteBundleSizeBytes(dbPath) {
  const candidates = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  const sizes = await Promise.all(candidates.map((candidate) => getFileSizeBytes(candidate)));
  return sizes.reduce((sum, size) => sum + size, 0);
}

export async function getDirectorySizeBytes(dirPath) {
  let total = 0;

  async function walk(currentPath) {
    let entries;
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const fileStat = await stat(fullPath);
      total += fileStat.size;
    }
  }

  await walk(path.resolve(dirPath));
  return total;
}
