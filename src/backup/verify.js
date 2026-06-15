import { resolveTelegramBackupConfig } from '../state/telegramBackupSettings.js';
import { createTelegramClient } from './telegramClient.js';
import { parseCatalogJson } from './catalog.js';
import { listBackupPartitions, loadPartitionFileInfo } from './export.js';
import { getTelegramBackupRun } from '../state/telegramBackup.js';

export async function verifyTelegramBackup({
  config,
  db,
  backupConfig,
  runId = null,
  masterFileId = null,
  underlying = null,
}) {
  const effective = backupConfig ?? resolveTelegramBackupConfig(config, db);
  if (!effective.botToken || !effective.chatId) {
    return { ok: false, code: 'NOT_CONFIGURED', message: 'Token do bot e chat_id são obrigatórios.' };
  }

  let fileId = masterFileId;
  if (!fileId && runId) {
    const run = getTelegramBackupRun(db, runId);
    fileId = run?.result?.master_catalog?.file_id;
  }
  if (!fileId) {
    return { ok: false, code: 'NO_CATALOG', message: 'Informe run-id ou master-file-id.' };
  }

  const client = createTelegramClient({
    botToken: effective.botToken,
    chatId: effective.chatId,
    rateLimitMs: effective.rateLimitMs,
  });
  const master = parseCatalogJson(await client.downloadFile(fileId));
  const mismatches = [];
  const missing = [];

  for (const asset of master.assets || []) {
    if (underlying && asset.underlying !== String(underlying).toUpperCase()) continue;
    if (!asset.catalog?.file_id) {
      missing.push({ underlying: asset.underlying, reason: 'no catalog ref' });
      continue;
    }
    const catalog = parseCatalogJson(await client.downloadFile(asset.catalog.file_id));
    const localByDt = new Map(
      listBackupPartitions(db, {
        underlying: asset.underlying,
        interval: asset.interval,
        bookDepth: asset.book_depth,
      }).map((row) => [row.dt, row]),
    );

    for (const part of catalog.partitions || []) {
      const local = localByDt.get(part.dt);
      if (!local) {
        missing.push({ underlying: asset.underlying, dt: part.dt, reason: 'not in local manifest' });
        continue;
      }
      try {
        const info = await loadPartitionFileInfo(config, local);
        if (info.sha256 !== part.sha256) {
          mismatches.push({
            underlying: asset.underlying,
            dt: part.dt,
            local_sha256: info.sha256,
            remote_sha256: part.sha256,
          });
        }
      } catch (err) {
        missing.push({ underlying: asset.underlying, dt: part.dt, reason: err.message });
      }
    }
  }

  return {
    ok: mismatches.length === 0 && missing.length === 0,
    mismatches,
    missing,
  };
}
