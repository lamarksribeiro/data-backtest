import { restoreFromTelegram } from './restore.js';
import { runTelegramBackup } from './upload.js';
import {
  createTelegramBackupRun,
  getTelegramBackupRun,
  updateTelegramBackupRun,
} from '../state/telegramBackup.js';

const activeRuns = new Map();

export function enqueueTelegramBackup({ config, db, backupConfig, request }) {
  const runId = request.runId || `br-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (activeRuns.has(runId)) {
    return { ok: false, code: 'ALREADY_RUNNING', message: 'Backup já em execução.', run_id: runId };
  }

  const promise = runTelegramBackup({
    config,
    db,
    backupConfig,
    request: { ...request, runId },
    runId,
    onProgress: (progress) => {
      updateTelegramBackupRun(db, runId, { progressJson: progress });
    },
  }).finally(() => {
    activeRuns.delete(runId);
  });

  activeRuns.set(runId, promise);
  return { ok: true, run_id: runId, status: 'queued' };
}

export function enqueueTelegramRestore({ config, db, backupConfig, request }) {
  const runId = request.runId || `br-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (activeRuns.has(runId)) {
    return { ok: false, code: 'ALREADY_RUNNING', message: 'Restore já em execução.', run_id: runId };
  }

  createTelegramBackupRun(db, {
    id: runId,
    status: 'queued',
    mode: 'full',
    underlying: request.underlying ?? null,
    requestJson: { kind: 'restore', ...request },
  });

  const promise = (async () => {
    updateTelegramBackupRun(db, runId, {
      status: 'running',
      startedAt: new Date().toISOString(),
      progressJson: { phase: 'starting', kind: 'restore' },
    });
    try {
      const result = await restoreFromTelegram({
        config,
        db,
        backupConfig,
        masterFileId: request.masterFileId ?? null,
        catalogMessageId: request.catalogMessageId ?? null,
        runId: request.sourceRunId ?? null,
        catalogPath: request.catalogPath ?? null,
        underlying: request.underlying ?? null,
        dryRun: request.dryRun === true,
        onProgress: (progress) => {
          updateTelegramBackupRun(db, runId, { progressJson: { ...progress, kind: 'restore' } });
        },
      });
      updateTelegramBackupRun(db, runId, {
        status: result.ok ? 'completed' : 'failed',
        completedAt: new Date().toISOString(),
        resultJson: result,
        error: result.ok ? null : summarizeRestoreFailure(result),
        progressJson: { phase: result.ok ? 'done' : 'failed', kind: 'restore', restored: result.restored },
      });
      return result;
    } catch (err) {
      updateTelegramBackupRun(db, runId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: err.message,
        progressJson: { phase: 'failed', kind: 'restore' },
      });
      throw err;
    }
  })().finally(() => {
    activeRuns.delete(runId);
  });

  activeRuns.set(runId, promise);
  return { ok: true, run_id: runId, status: 'queued' };
}

export async function waitTelegramBackupRun(runId) {
  const promise = activeRuns.get(runId);
  if (!promise) {
    return null;
  }
  return promise;
}

export function getTelegramBackupRunStatus(db, runId) {
  return getTelegramBackupRun(db, runId);
}

export function isTelegramBackupRunning() {
  return activeRuns.size > 0;
}

function summarizeRestoreFailure(result) {
  if (result.message) return result.message;
  const errors = result.restored?.errors ?? [];
  if (!errors.length) return 'Restore falhou';
  const tooBig = errors.filter((e) => /file is too big/i.test(String(e.error)));
  if (tooBig.length > 0) {
    return `${tooBig.length} partição(ões) acima do limite de download do Telegram (~20 MB). `
      + 'Rode um novo backup com chunk ≤18 MB e force reenvio (--force) das partições grandes.';
  }
  return `Restore falhou (${errors.length} erro(s) em partições)`;
}
