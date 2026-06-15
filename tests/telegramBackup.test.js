import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildAssetCatalog, buildMasterCatalog, buildPartitionSidecar, parseCatalogJson } from '../src/backup/catalog.js';
import { mergeChunks, sha256Buffer, splitFile, withTempDir } from '../src/backup/chunker.js';
import { maskBotToken, resolveTelegramBackupConfig, validateTelegramBackupSettingsInput } from '../src/state/telegramBackupSettings.js';
import { openStateDatabase, closeStateDatabase } from '../src/state/sqlite.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe('telegram backup settings', () => {
  it('masks bot token', () => {
    assert.equal(maskBotToken('123456:ABCDEFgh'), '123456:••••EFgh');
  });

  it('validates chat_id and token', () => {
    const bad = validateTelegramBackupSettingsInput({ chat_id: '', bot_token: 'bad' });
    assert.equal(bad.ok, false);
    const ok = validateTelegramBackupSettingsInput({ chat_id: '-100123', bot_token: '123:abcDEF' });
    assert.equal(ok.ok, true);
  });

  it('resolves config from env bootstrap', () => {
    const dbPath = path.join(tmpdir(), `tg-backup-settings-${Date.now()}.db`);
    const db = openStateDatabase(dbPath);
    try {
      const effective = resolveTelegramBackupConfig({
        telegramBackupBotToken: '123:TOKEN',
        telegramBackupChatId: '-1001',
        telegramBackupEnabled: 'true',
        telegramBackupMaxChunkBytes: 50331648,
        telegramBackupRateLimitMs: 3000,
      }, db);
      assert.equal(effective.botToken, '123:TOKEN');
      assert.equal(effective.enabled, true);
    } finally {
      closeStateDatabase(db);
    }
  });
});

describe('telegram backup catalog', () => {
  it('builds sidecar and master catalog', () => {
    const row = {
      underlying: 'BTC',
      interval: '5m',
      book_depth: 25,
      dt: '2026-01-01',
      active_path: 'backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-01-01/part-x.parquet',
      run_id: 'x',
      dataset: 'backtest_ticks',
    };
    const sidecar = buildPartitionSidecar({ manifestRow: row, sha256: 'abc', bytes: 10 });
    assert.equal(sidecar.kind, 'lake_partition');
    const catalog = buildAssetCatalog({
      underlying: 'BTC',
      interval: '5m',
      bookDepth: 25,
      backupRunId: 'br-1',
      lakeRootHint: '/lake',
      partitions: [{ dt: '2026-01-01', sha256: 'abc', bytes: 10 }],
      eventExclusions: [],
    });
    const master = buildMasterCatalog({
      backupRunId: 'br-1',
      lakeRootHint: '/lake',
      bookDepthDefault: 25,
      assets: [{ underlying: 'BTC', catalog: { file_id: 'f1' } }],
    });
    assert.equal(parseCatalogJson(Buffer.from(JSON.stringify(master))).kind, 'master_catalog');
    assert.equal(catalog.partitions.length, 1);
  });
});

describe('telegram backup chunker', () => {
  it('splits and merges with matching sha256', async () => {
    await withTempDir('chunk-test', async (dir) => {
      const filePath = path.join(dir, 'big.bin');
      const payload = Buffer.alloc(1024 * 1024 + 100, 7);
      await writeFile(filePath, payload);
      const originalSha = await sha256Buffer(payload);
      const split = await splitFile(filePath, 512 * 1024, { outDir: path.join(dir, 'chunks'), baseName: 'big.bin' });
      assert.equal(split.chunkCount, 3);
      const outPath = path.join(dir, 'merged.bin');
      await mergeChunks(split.chunks.map((c) => c.path), outPath, { expectedSha256: originalSha });
      assert.equal(await sha256Buffer(await import('node:fs/promises').then((m) => m.readFile(outPath))), originalSha);
    });
  });
});
