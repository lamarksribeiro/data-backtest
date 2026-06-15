import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildAssetCatalog, buildMasterCatalog, buildPartitionSidecar, parseCatalogJson } from '../src/backup/catalog.js';
import { mergeChunks, sha256Buffer, splitFile, withTempDir } from '../src/backup/chunker.js';
import { discoverTelegramBackupCatalog, isMasterCatalogMessage, summarizeMasterCatalog } from '../src/backup/discover.js';
import { clampTelegramChunkBytes, TELEGRAM_DEFAULT_CHUNK_BYTES, TELEGRAM_MAX_CHUNK_BYTES } from '../src/backup/telegramLimits.js';
import { maskBotToken, resolveTelegramBackupConfig, validateTelegramBackupSettingsInput } from '../src/state/telegramBackupSettings.js';
import {
  clearTelegramBackupLocalRecords,
  countTelegramBackupLocalRecords,
  createTelegramBackupRun,
  insertTelegramBackupArtifact,
} from '../src/state/telegramBackup.js';
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

describe('telegram backup local records', () => {
  it('clears runs and artifacts', () => {
    const dbPath = path.join(tmpdir(), `tg-backup-clear-${Date.now()}.db`);
    const db = openStateDatabase(dbPath);
    try {
      createTelegramBackupRun(db, { id: 'br-test', status: 'completed', mode: 'full' });
      insertTelegramBackupArtifact(db, {
        runId: 'br-test',
        underlying: 'BTC',
        dataset: 'backtest_ticks',
        interval: '5m',
        bookDepth: 10,
        dt: '2026-01-01',
        sha256: 'abc',
        bytes: 100,
      });
      assert.equal(countTelegramBackupLocalRecords(db).runs, 1);
      const cleared = clearTelegramBackupLocalRecords(db);
      assert.equal(cleared.runs_removed, 1);
      assert.equal(cleared.artifacts_removed, 1);
      assert.equal(countTelegramBackupLocalRecords(db).runs, 0);
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

describe('telegram backup discover', () => {
  it('detects master catalog from pinned message', async () => {
    const master = buildMasterCatalog({
      backupRunId: 'br-remote',
      lakeRootHint: '/lake',
      bookDepthDefault: 10,
      assets: [{ underlying: 'BTC', partitions: 12, catalog: { file_id: 'cat1' } }],
    });
    const masterJson = JSON.stringify(master);

    const fetchImpl = async (url) => {
      if (url.includes('/getChat')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: {
              title: 'Backup Channel',
              pinned_message: {
                message_id: 99,
                document: { file_id: 'MASTER_FID', file_name: 'master_catalog.json' },
                caption: '#GLBackup #master_catalog',
              },
            },
          }),
        };
      }
      if (url.includes('/getFile')) {
        return {
          ok: true,
          json: async () => ({ ok: true, result: { file_path: 'documents/master.json' } }),
        };
      }
      if (url.includes('/file/bot')) {
        return new Response(masterJson, { status: 200 });
      }
      return { ok: false, json: async () => ({ ok: false }) };
    };

    const result = await discoverTelegramBackupCatalog({
      backupConfig: { botToken: '123:TOKEN', chatId: '-1001', rateLimitMs: 0 },
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.master_file_id, 'MASTER_FID');
    assert.equal(result.backup_run_id, 'br-remote');
    assert.equal(result.partition_count, 12);
  });

  it('recognizes master catalog messages', () => {
    assert.equal(isMasterCatalogMessage({
      document: { file_id: 'x', file_name: 'master_catalog.json' },
    }), true);
    assert.equal(isMasterCatalogMessage({
      document: { file_id: 'x', file_name: 'other.json' },
      caption: '#GLBackup #master_catalog',
    }), true);
    assert.equal(isMasterCatalogMessage({ document: { file_id: 'x', file_name: 'nope.json' } }), false);
  });

  it('summarizes master catalog assets', () => {
    const summary = summarizeMasterCatalog({
      backup_run_id: 'br-1',
      assets: [{ underlying: 'BTC', partitions: 3 }, { underlying: 'ETH', partitions: 2 }],
    });
    assert.equal(summary.partition_count, 5);
    assert.deepEqual(summary.underlyings, ['BTC', 'ETH']);
  });
});

describe('telegram backup limits', () => {
  it('clamps chunk size to bot download limit', () => {
    assert.equal(TELEGRAM_DEFAULT_CHUNK_BYTES, 18 * 1024 * 1024);
    assert.equal(clampTelegramChunkBytes(50331648), TELEGRAM_MAX_CHUNK_BYTES);
    assert.equal(clampTelegramChunkBytes(1024 * 1024), 1024 * 1024);
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
