import { mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveLakeActivePath } from '../lake/paths.js';
import { upsertManifestPartition } from '../state/manifest.js';
import { addEventExclusion } from '../state/eventExclusions.js';
import { resolveTelegramBackupConfig } from '../state/telegramBackupSettings.js';
import { getTelegramBackupRun, listTelegramBackupRuns } from '../state/telegramBackup.js';
import { createTelegramClient } from './telegramClient.js';
import { assertNotCancelled } from './cancel.js';
import { parseCatalogJson } from './catalog.js';
import { mergeChunks, sha256Buffer, sha256File, withTempDir } from './chunker.js';

export async function restoreFromTelegram({
  config,
  db,
  backupConfig,
  masterFileId = null,
  catalogMessageId = null,
  runId = null,
  catalogPath = null,
  underlying = null,
  dryRun = false,
  onProgress = null,
  shouldCancel = () => false,
}) {
  const effective = backupConfig ?? resolveTelegramBackupConfig(config, db);
  if (!effective.botToken || !effective.chatId) {
    return { ok: false, code: 'NOT_CONFIGURED', message: 'Token do bot e chat_id são obrigatórios.' };
  }

  let master;
  if (catalogPath) {
    master = parseCatalogJson(await readFile(catalogPath));
  } else {
    const resolvedFileId = masterFileId
      || resolveMasterFileIdFromRun(db, { catalogMessageId, runId });
    if (!resolvedFileId) {
      return {
        ok: false,
        code: 'NO_CATALOG',
        message: 'Informe --master-file-id, --catalog-path, --run-id ou --catalog-message de um run local.',
      };
    }
    const client = createTelegramClient({
      botToken: effective.botToken,
      chatId: effective.chatId,
      rateLimitMs: effective.rateLimitMs,
    });
    const buf = await client.downloadFile(resolvedFileId);
    master = parseCatalogJson(buf);
  }

  if (master.kind !== 'master_catalog') {
    return { ok: false, code: 'INVALID_CATALOG', message: 'Arquivo não é um master_catalog.' };
  }

  const client = createTelegramClient({
    botToken: effective.botToken,
    chatId: effective.chatId,
    rateLimitMs: effective.rateLimitMs,
  });

  const restored = {
    partitions: 0,
    bytes: 0,
    exclusions: 0,
    errors: [],
  };

  const workItems = [];
  for (const asset of master.assets || []) {
    if (underlying && asset.underlying !== String(underlying).toUpperCase()) continue;
    workItems.push(asset);
  }

  let processed = 0;
  const totalPartitions = await countPartitions(client, workItems, { underlying, dryRun });

  onProgress?.({ phase: 'restore', processed: 0, total: totalPartitions, kind: 'restore' });

  for (const asset of workItems) {
    assertNotCancelled(shouldCancel);
    if (!asset.catalog?.file_id) {
      restored.errors.push({ underlying: asset.underlying, error: 'missing catalog file_id' });
      continue;
    }

    const catalogBuf = await client.downloadFile(asset.catalog.file_id);
    const catalog = parseCatalogJson(catalogBuf);

    if (dryRun) {
      restored.partitions += catalog.partitions?.length ?? 0;
      restored.exclusions += catalog.event_exclusions?.length ?? 0;
      processed += catalog.partitions?.length ?? 0;
      onProgress?.({
        phase: 'restore',
        processed,
        total: totalPartitions,
        underlying: asset.underlying,
        kind: 'restore',
      });
      continue;
    }

    for (const partition of catalog.partitions || []) {
      assertNotCancelled(shouldCancel);
      processed += 1;
      onProgress?.({
        phase: 'restore',
        processed,
        total: totalPartitions,
        underlying: asset.underlying,
        dt: partition.dt,
        kind: 'restore',
      });
      try {
        await restorePartition({ config, db, client, partition });
        restored.partitions += 1;
        restored.bytes += Number(partition.bytes || 0);
      } catch (err) {
        restored.errors.push({ dt: partition.dt, underlying: asset.underlying, error: err.message });
      }
    }

    for (const exc of catalog.event_exclusions || []) {
      addEventExclusion(db, {
        marketId: exc.market_id,
        conditionId: exc.condition_id,
        eventStart: exc.event_start,
        dt: exc.dt,
        underlying: exc.underlying,
        interval: exc.interval,
        reason: exc.reason || 'restored',
        notes: exc.notes,
        excludedBy: exc.excluded_by || 'telegram-restore',
      });
      restored.exclusions += 1;
    }
  }

  return {
    ok: restored.errors.length === 0,
    dry_run: dryRun,
    restored,
  };
}

async function restorePartition({ config, db, client, partition }) {
  let manifestRow = partition.manifest_row;
  if (!manifestRow && partition.sidecar?.file_id) {
    const sidecarBuf = await client.downloadFile(partition.sidecar.file_id);
    const sidecar = parseCatalogJson(sidecarBuf);
    manifestRow = sidecar.manifest_row;
  }
  if (!manifestRow?.active_path) {
    throw new Error(`Partition ${partition.dt} missing manifest active_path`);
  }

  const targetPath = resolveLakeActivePath(config.lakeRoot, manifestRow.active_path);
  await mkdir(path.dirname(targetPath), { recursive: true });

  if (partition.chunks?.length) {
    await withTempDir('tg-restore', async (tmpDir) => {
      const paths = [];
      for (const chunk of [...partition.chunks].sort((a, b) => a.chunk_index - b.chunk_index)) {
        const buf = await client.downloadFile(chunk.telegram.file_id);
        const chunkPath = path.join(tmpDir, `chunk-${chunk.chunk_index}`);
        await writeFile(chunkPath, buf);
        paths.push(chunkPath);
      }
      await mergeChunks(paths, targetPath, { expectedSha256: partition.sha256 });
    });
  } else if (partition.telegram?.file_id) {
    const buf = await client.downloadFile(partition.telegram.file_id);
    await writeFile(targetPath, buf);
    const hash = await sha256Buffer(buf);
    if (partition.sha256 && hash !== partition.sha256) {
      throw new Error(`sha256 mismatch for ${partition.dt}`);
    }
  } else {
    throw new Error(`Partition ${partition.dt} has no telegram file reference`);
  }

  const diskHash = await sha256File(targetPath);
  if (partition.sha256 && diskHash !== partition.sha256) {
    throw new Error(`sha256 mismatch on disk for ${partition.dt}`);
  }

  upsertManifestPartition(db, {
    dataset: manifestRow.dataset || 'backtest_ticks',
    marketId: manifestRow.market_id,
    underlying: manifestRow.underlying,
    interval: manifestRow.interval,
    resolution: manifestRow.resolution,
    bookDepth: manifestRow.book_depth,
    dt: manifestRow.dt,
    activePath: manifestRow.active_path,
    runId: manifestRow.run_id,
    rows: manifestRow.rows,
    eventsCount: manifestRow.events_count,
    minTs: manifestRow.min_ts,
    maxTs: manifestRow.max_ts,
    coverageMin: manifestRow.coverage_min,
    hasDegraded: Boolean(manifestRow.has_degraded),
    qualityDetails: parseMaybeJson(manifestRow.quality_details_json),
    sourceTickCount: manifestRow.source_tick_count,
    sourceConditionCount: manifestRow.source_condition_count,
    sourceQualityRecordedAtMax: manifestRow.source_quality_recorded_at_max,
    sourceFingerprint: manifestRow.source_fingerprint,
    status: manifestRow.status,
    verifiedAt: manifestRow.verified_at,
    error: manifestRow.error,
  });
}

function resolveMasterFileIdFromRun(db, { catalogMessageId, runId }) {
  if (runId) {
    const run = getTelegramBackupRun(db, runId);
    return run?.result?.master_catalog?.file_id ?? null;
  }
  if (catalogMessageId) {
    const runs = listTelegramBackupRuns(db, { limit: 100 });
    const match = runs.find((run) => run.result?.master_catalog?.message_id === Number(catalogMessageId));
    return match?.result?.master_catalog?.file_id ?? null;
  }
  return null;
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

async function countPartitions(client, assets, { dryRun }) {
  let total = 0;
  for (const asset of assets) {
    if (!asset.catalog?.file_id) continue;
    try {
      const catalogBuf = await client.downloadFile(asset.catalog.file_id);
      const catalog = parseCatalogJson(catalogBuf);
      total += catalog.partitions?.length ?? 0;
    } catch {
      // counted during restore
    }
  }
  return total;
}
