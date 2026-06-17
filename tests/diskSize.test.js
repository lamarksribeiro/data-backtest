import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import { getDirectorySizeBytes, getSqliteBundleSizeBytes } from '../src/fs/diskSize.js';

test('diskSize sums files in a directory tree', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'disk-size-dir-'));
  try {
    await mkdir(path.join(dir, 'nested'), { recursive: true });
    await writeFile(path.join(dir, 'a.txt'), '12345');
    await writeFile(path.join(dir, 'nested', 'b.txt'), '12');

    assert.equal(await getDirectorySizeBytes(dir), 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('diskSize includes sqlite wal and shm sidecars', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'disk-size-sqlite-'));
  const dbPath = path.join(dir, 'state.db');
  try {
    await writeFile(dbPath, '1234');
    await writeFile(`${dbPath}-wal`, '56');
    await writeFile(`${dbPath}-shm`, '7');

    assert.equal(await getSqliteBundleSizeBytes(dbPath), 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
