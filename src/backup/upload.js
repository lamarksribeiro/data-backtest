import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertNotCancelled, isBackupCancelledError } from './cancel.js';
import { runBackupCheck } from '../ops/backupCheck.js';
import { resolveTelegramBackupConfig } from '../state/telegramBackupSettings.js';
import {
  createTelegramBackupRun,
  buildSkippedPartitionCatalogEntry,
  cancelTelegramBackupRunRecord,
  deletePartitionArtifacts,
  getIncrementalBackupBaseline,
  getLastCompletedAssetCatalog,
  getLastCompletedMasterCatalog,
  getLatestFileShaForPartition,
  insertTelegramBackupArtifact,
  updateTelegramBackupRun,
} from '../state/telegramBackup.js';
import { createTelegramClient, telegramRefFromMessage } from './telegramClient.js';
import { discoverTelegramBackupCatalog, summarizeMasterCatalog } from './discover.js';
import { saveChannelCatalogDiscovery } from '../state/telegramBackupSettings.js';
import {
  buildAssetCatalog,
  buildCaption,
  buildMasterCatalog,
  buildPartitionSidecar,
  manifestRowToJson,
} from './catalog.js';
import { splitFile, withTempDir, sha256File } from './chunker.js';
import { listBackupPartitionGroups, listBackupPartitions, listEventExclusionsForAsset, loadPartitionFileInfo } from './export.js';

export async function runTelegramBackup({
  config,
  db,
  backupConfig,
  request = {},
  runId = `br-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  onProgress = null,
  shouldCancel = () => false,
}) {
  const effective = backupConfig ?? resolveTelegramBackupConfig(config, db);
  if (!request.force && !effective.enabled && !request.cli) {
    return { ok: false, code: 'DISABLED', message: 'Backup Telegram desabilitado nas configurações.' };
  }
  if (!effective.botToken || !effective.chatId) {
    return { ok: false, code: 'NOT_CONFIGURED', message: 'Token do bot e chat_id são obrigatórios.' };
  }

  if (!request.dryRun && !request.skipCheck) {
    const check = await runBackupCheck(config, db);
    if (!check.backup_ready) {
      return { ok: false, code: 'BACKUP_NOT_READY', message: 'Lake não está pronto para backup.', check };
    }
  }

  const mode = request.incremental ? 'incremental' : 'full';
  const baseline = getIncrementalBackupBaseline(db);
  const plan = resolveBackupPlan(request, baseline);
  createTelegramBackupRun(db, {
    id: runId,
    status: 'queued',
    mode: plan.incremental ? 'incremental' : 'full',
    underlying: request.underlying ?? null,
    requestJson: { ...request, incremental: plan.incremental, baseline_snapshot: baseline },
  });

  updateTelegramBackupRun(db, runId, {
    status: 'running',
    startedAt: new Date().toISOString(),
    progressJson: { phase: 'starting' },
  });

  const client = createTelegramClient({
    botToken: effective.botToken,
    chatId: effective.chatId,
    rateLimitMs: effective.rateLimitMs,
  });

  const stats = {
    uploaded: 0,
    skipped: 0,
    errors: 0,
    bytes: 0,
  };

  try {
    assertNotCancelled(shouldCancel);
    const groups = selectGroups(db, request);
    if (!groups.length) {
      throw new Error('Nenhuma partição backtest_ticks válida encontrada para backup.');
    }

    const assetCatalogs = [];
    const partitionErrors = [];
    let processed = 0;
    const totalPartitions = groups.reduce((sum, g) => sum + g.partitions.length, 0);

    for (const group of groups) {
      assertNotCancelled(shouldCancel);
      const partitionEntries = [];
      let groupUploaded = 0;
      const exclusions = listEventExclusionsForAsset(db, {
        underlying: group.underlying,
        interval: group.interval,
      });

      for (const manifestRow of group.partitions) {
        assertNotCancelled(shouldCancel);
        processed += 1;
        onProgress?.({
          phase: 'upload',
          processed,
          total: totalPartitions,
          underlying: group.underlying,
          dt: manifestRow.dt,
        });
        updateTelegramBackupRun(db, runId, {
          progressJson: {
            phase: 'upload',
            processed,
            total: totalPartitions,
            underlying: group.underlying,
            dt: manifestRow.dt,
            stats,
          },
        });

        try {
          const entry = await uploadPartition({
            config,
            db,
            client,
            effective,
            runId,
            manifestRow,
            request: { ...request, incremental: plan.incremental },
            stats,
          });
          if (entry.skipped) stats.skipped += 1;
          else {
            stats.uploaded += 1;
            groupUploaded += 1;
          }
          partitionEntries.push(entry);
        } catch (err) {
          stats.errors += 1;
          const errorEntry = {
            dt: manifestRow.dt,
            error: err.message,
            manifest_row: manifestRowToJson(manifestRow),
          };
          partitionErrors.push(errorEntry);
          partitionEntries.push(errorEntry);
          if (!request.continueOnError) throw err;
        }
      }

      const validPartitions = partitionEntries.filter((p) => !p.error);
      const groupHasErrors = partitionEntries.some((p) => p.error);
      const shouldPublishAssetCatalog = request.dryRun
        || plan.forceCatalogPublish
        || groupUploaded > 0
        || groupHasErrors
        || !getLastCompletedAssetCatalog(db, group.underlying);

      if (!request.dryRun && shouldPublishAssetCatalog) {
        assertNotCancelled(shouldCancel);
        await publishAssetCatalog({
          client,
          effective,
          config,
          db,
          runId,
          group,
          validPartitions,
          exclusions,
          assetCatalogs,
          onProgress,
          processed,
          totalPartitions,
          stats,
        });
      } else if (!request.dryRun) {
        const previous = getLastCompletedAssetCatalog(db, group.underlying);
        if (previous) {
          assetCatalogs.push({
            ...previous,
            reused: true,
          });
        } else {
          await publishAssetCatalog({
            client,
            effective,
            config,
            db,
            runId,
            group,
            validPartitions,
            exclusions,
            assetCatalogs,
            onProgress,
            processed,
            totalPartitions,
            stats,
          });
        }
      } else {
        const catalog = buildAssetCatalog({
          underlying: group.underlying,
          interval: group.interval,
          bookDepth: group.bookDepth,
          backupRunId: runId,
          lakeRootHint: config.lakeRoot,
          partitions: validPartitions,
          eventExclusions: exclusions,
        });
        assetCatalogs.push({
          underlying: group.underlying,
          interval: group.interval,
          book_depth: group.bookDepth,
          dry_run: true,
          partitions: catalog.stats.partitions,
          bytes: catalog.stats.bytes,
        });
      }
    }

    let masterRef = null;
    const anyCatalogPublished = assetCatalogs.some((asset) => asset.published);
    if (!request.dryRun && anyCatalogPublished) {
      assertNotCancelled(shouldCancel);
      onProgress?.({ phase: 'master_catalog', processed, total: totalPartitions, stats });
      const master = buildMasterCatalog({
        backupRunId: runId,
        lakeRootHint: config.lakeRoot,
        bookDepthDefault: config.backtestBookDepth,
        assets: assetCatalogs,
      });
      const masterMessage = await client.sendDocumentBuffer(Buffer.from(JSON.stringify(master, null, 2), 'utf8'), {
        filename: 'master_catalog.json',
        caption: '#GLBackup #master_catalog',
        disableNotification: effective.silentUploads,
      });
      masterRef = telegramRefFromMessage(masterMessage);
      if (effective.pinMasterCatalog && masterRef.message_id) {
        await client.pinChatMessage(masterRef.message_id);
      }
      saveChannelCatalogDiscovery(db, {
        ok: true,
        master_file_id: masterRef.file_id,
        message_id: masterRef.message_id,
        file_name: masterRef.file_name,
        source: effective.pinMasterCatalog ? 'pinned' : 'backup',
        discovered_at: new Date().toISOString(),
        ...summarizeMasterCatalog(master),
      });
      const summary = [
        `Backup ${runId} concluído`,
        `uploaded=${stats.uploaded} skipped=${stats.skipped} errors=${stats.errors}`,
        `bytes=${stats.bytes}`,
        masterRef.message_id ? `master_catalog message_id=${masterRef.message_id}` : '',
      ].filter(Boolean).join('\n');
      await client.sendMessage(summary, { disableNotification: effective.silentUploads });
    } else if (!request.dryRun) {
      masterRef = getLastCompletedMasterCatalog(db);
    }

    const result = {
      ok: stats.errors === 0,
      run_id: runId,
      dry_run: Boolean(request.dryRun),
      stats: {
        ...stats,
        catalogs_published: assetCatalogs.filter((asset) => asset.published).length,
        catalogs_reused: assetCatalogs.filter((asset) => asset.reused).length,
      },
      asset_catalogs: assetCatalogs,
      master_catalog: masterRef,
      partition_errors: partitionErrors,
      baseline,
      plan: {
        incremental: plan.incremental,
        force_catalog_publish: plan.forceCatalogPublish,
      },
    };

    assertNotCancelled(shouldCancel);
    const finalStatus = stats.errors > 0 ? 'failed' : 'completed';
    updateTelegramBackupRun(db, runId, {
      status: finalStatus,
      completedAt: new Date().toISOString(),
      resultJson: result,
      progressJson: { phase: finalStatus === 'failed' ? 'failed' : 'done', stats },
      error: stats.errors > 0 ? summarizePartitionErrors(partitionErrors) : null,
    });

    return result;
  } catch (err) {
    if (isBackupCancelledError(err)) {
      cancelTelegramBackupRunRecord(db, runId, { phase: 'cancelled', stats });
      return {
        ok: false,
        code: 'CANCELLED',
        message: err.message,
        run_id: runId,
        stats,
      };
    }
    updateTelegramBackupRun(db, runId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: err.message,
      progressJson: { phase: 'failed', stats },
    });
    return { ok: false, code: 'BACKUP_FAILED', message: err.message, run_id: runId, stats };
  }
}

async function uploadPartition({
  config,
  db,
  client,
  effective,
  runId,
  manifestRow,
  request,
  stats,
}) {
  const fileInfo = await loadPartitionFileInfo(config, manifestRow);
  const latestSha = getLatestFileShaForPartition(db, {
    underlying: manifestRow.underlying,
    dataset: 'backtest_ticks',
    interval: manifestRow.interval,
    bookDepth: manifestRow.book_depth,
    dt: manifestRow.dt,
  });

  if (request.incremental && !request.force && latestSha === fileInfo.sha256) {
    const skippedEntry = buildSkippedPartitionCatalogEntry(db, manifestRow, fileInfo);
    if (skippedEntry) {
      if (!request.dryRun) {
        insertTelegramBackupArtifact(db, {
          runId,
          underlying: manifestRow.underlying,
          dataset: 'backtest_ticks',
          interval: manifestRow.interval,
          bookDepth: manifestRow.book_depth,
          dt: manifestRow.dt,
          sha256: fileInfo.sha256,
          fileSha256: fileInfo.sha256,
          bytes: fileInfo.bytes,
          skipped: true,
        });
      }
      return skippedEntry;
    }
  }

  if (request.dryRun) {
    return {
      dt: manifestRow.dt,
      sha256: fileInfo.sha256,
      bytes: fileInfo.bytes,
      dry_run: true,
      would_chunk: fileInfo.bytes > effective.maxChunkBytes,
    };
  }

  deletePartitionArtifacts(db, {
    underlying: manifestRow.underlying,
    dataset: 'backtest_ticks',
    interval: manifestRow.interval,
    bookDepth: manifestRow.book_depth,
    dt: manifestRow.dt,
  });

  return withTempDir('tg-backup', async (tmpDir) => {
    const chunks = fileInfo.bytes > effective.maxChunkBytes
      ? await splitFile(fileInfo.resolvedPath, effective.maxChunkBytes, {
        outDir: tmpDir,
        baseName: path.basename(fileInfo.resolvedPath),
      })
      : null;

    const chunkCount = chunks?.chunkCount ?? 1;
    const fileSha256 = chunks?.fileSha256 ?? fileInfo.sha256;
    const uploadedChunks = [];

    if (chunks) {
      for (const chunk of chunks.chunks) {
        const sidecar = buildPartitionSidecar({
          manifestRow,
          sha256: fileSha256,
          bytes: fileInfo.bytes,
          chunkIndex: chunk.index,
          chunkCount,
          chunkSha256: chunk.sha256,
        });
        const sidecarPath = path.join(tmpDir, `sidecar-${manifestRow.dt}-${chunk.index}.json`);
        await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2));
        const sidecarMsg = await client.sendDocument(sidecarPath, {
          caption: buildCaption({
            underlying: manifestRow.underlying,
            dt: manifestRow.dt,
            chunkIndex: chunk.index,
            chunkCount,
          }),
          disableNotification: effective.silentUploads,
        });
        const dataMsg = await client.sendDocument(chunk.path, {
          caption: buildCaption({
            underlying: manifestRow.underlying,
            dt: manifestRow.dt,
            chunkIndex: chunk.index,
            chunkCount,
          }),
          filename: path.basename(chunk.path),
          disableNotification: effective.silentUploads,
        });
        uploadedChunks.push({
          chunk_index: chunk.index,
          sha256: chunk.sha256,
          telegram: telegramRefFromMessage(dataMsg),
          sidecar: telegramRefFromMessage(sidecarMsg),
        });
        insertTelegramBackupArtifact(db, {
          runId,
          underlying: manifestRow.underlying,
          dataset: 'backtest_ticks',
          interval: manifestRow.interval,
          bookDepth: manifestRow.book_depth,
          dt: manifestRow.dt,
          sha256: chunk.sha256,
          fileSha256: chunk.index === 0 ? fileSha256 : null,
          bytes: chunk.bytes,
          chunkIndex: chunk.index,
          chunkCount,
          telegramMessageId: dataMsg.message_id,
          telegramFileId: dataMsg.document?.file_id,
        });
        stats.bytes += chunk.bytes;
      }
    } else {
      const sidecar = buildPartitionSidecar({
        manifestRow,
        sha256: fileInfo.sha256,
        bytes: fileInfo.bytes,
        chunkIndex: 0,
        chunkCount: 1,
      });
      const sidecarPath = path.join(tmpDir, `sidecar-${manifestRow.dt}.json`);
      await mkdir(tmpDir, { recursive: true });
      await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2));
      const sidecarMsg = await client.sendDocument(sidecarPath, {
        caption: buildCaption({ underlying: manifestRow.underlying, dt: manifestRow.dt }),
        disableNotification: effective.silentUploads,
      });
      const dataMsg = await client.sendDocument(fileInfo.resolvedPath, {
        caption: buildCaption({ underlying: manifestRow.underlying, dt: manifestRow.dt }),
        disableNotification: effective.silentUploads,
      });
      uploadedChunks.push({
        chunk_index: 0,
        sha256: fileInfo.sha256,
        telegram: telegramRefFromMessage(dataMsg),
        sidecar: telegramRefFromMessage(sidecarMsg),
      });
      insertTelegramBackupArtifact(db, {
        runId,
        underlying: manifestRow.underlying,
        dataset: 'backtest_ticks',
        interval: manifestRow.interval,
        bookDepth: manifestRow.book_depth,
        dt: manifestRow.dt,
        sha256: fileInfo.sha256,
        fileSha256: fileInfo.sha256,
        bytes: fileInfo.bytes,
        chunkIndex: 0,
        chunkCount: 1,
        telegramMessageId: dataMsg.message_id,
        telegramFileId: dataMsg.document?.file_id,
      });
      stats.bytes += fileInfo.bytes;
    }

    return {
      dt: manifestRow.dt,
      sha256: fileSha256,
      bytes: fileInfo.bytes,
      manifest_row: manifestRowToJson(manifestRow),
      telegram: uploadedChunks.length === 1 ? uploadedChunks[0].telegram : null,
      sidecar: uploadedChunks.length === 1 ? uploadedChunks[0].sidecar : null,
      chunks: uploadedChunks.length > 1 ? uploadedChunks : [],
    };
  });
}

function selectGroups(db, request) {
  if (request.allUnderlyings) {
    const combos = listBackupPartitionGroups(db);
    return combos.map((combo) => ({
      underlying: combo.underlying,
      interval: combo.interval,
      bookDepth: combo.bookDepth,
      partitions: listBackupPartitions(db, {
        underlying: combo.underlying,
        interval: combo.interval,
        bookDepth: combo.bookDepth,
        fromDt: request.from ?? null,
        toDt: request.to ?? null,
      }),
    })).filter((g) => g.partitions.length > 0);
  }

  const underlying = String(request.underlying || '').toUpperCase();
  if (!underlying) throw new Error('underlying ou --all-underlyings é obrigatório');
  const interval = request.interval || '5m';
  const bookDepth = request.bookDepth ?? request.book_depth ?? null;

  const partitions = listBackupPartitions(db, {
    underlying,
    interval,
    bookDepth: bookDepth != null ? Number(bookDepth) : null,
    fromDt: request.from ?? null,
    toDt: request.to ?? null,
  });

  if (!partitions.length) return [];

  const resolvedBookDepth = partitions[0].book_depth;
  return [{
    underlying,
    interval,
    bookDepth: resolvedBookDepth,
    partitions,
  }];
}

function resolveBackupPlan(request, baseline) {
  const wantsIncremental = Boolean(request.incremental) && !request.force;
  const incremental = wantsIncremental && baseline.ready;
  return {
    incremental,
    forceCatalogPublish: !incremental,
  };
}

async function publishAssetCatalog({
  client,
  effective,
  config,
  runId,
  group,
  validPartitions,
  exclusions,
  assetCatalogs,
  onProgress,
  processed,
  totalPartitions,
  stats,
}) {
  const catalog = buildAssetCatalog({
    underlying: group.underlying,
    interval: group.interval,
    bookDepth: group.bookDepth,
    backupRunId: runId,
    lakeRootHint: config.lakeRoot,
    partitions: validPartitions,
    eventExclusions: exclusions,
  });
  onProgress?.({
    phase: 'catalog',
    underlying: group.underlying,
    processed,
    total: totalPartitions,
    stats,
  });
  const catalogJson = JSON.stringify(catalog, null, 2);
  const catalogBuffer = Buffer.from(catalogJson, 'utf8');
  const catalogMessage = await client.sendDocumentBuffer(catalogBuffer, {
    filename: `catalog-${group.underlying}.json`,
    caption: `#GLBackup #catalog #${group.underlying}`,
    disableNotification: effective.silentUploads,
  });
  const catalogRef = telegramRefFromMessage(catalogMessage);
  assetCatalogs.push({
    underlying: group.underlying,
    interval: group.interval,
    book_depth: group.bookDepth,
    catalog: catalogRef,
    partitions: catalog.stats.partitions,
    bytes: catalog.stats.bytes,
    published: true,
  });
}

function summarizePartitionErrors(partitionErrors) {
  if (!partitionErrors.length) return null;
  const sample = partitionErrors.slice(0, 3).map((entry) => `${entry.dt}: ${entry.error}`).join(' · ');
  const suffix = partitionErrors.length > 3 ? ` · +${partitionErrors.length - 3} outras` : '';
  return `${partitionErrors.length} partição(ões) com falha — ${sample}${suffix}`;
}

export async function testTelegramBackupConnection(backupConfig, { db = null } = {}) {
  const client = createTelegramClient({
    botToken: backupConfig.botToken,
    chatId: backupConfig.chatId,
    rateLimitMs: backupConfig.rateLimitMs,
  });
  const message = await client.sendMessage(
    `GoldenLens backup test OK — ${new Date().toISOString()}`,
    { disableNotification: true },
  );
  const discovery = await discoverTelegramBackupCatalog({ backupConfig });
  if (db) {
    saveChannelCatalogDiscovery(db, discovery.ok ? discovery : { ok: false });
  }
  return { ok: true, message_id: message.message_id, discovery };
}
