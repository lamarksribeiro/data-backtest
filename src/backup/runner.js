import { restoreFromTelegram } from './restore.js';
import { runTelegramBackup } from './upload.js';
import {
  cancelAllTelegramRunControls,
  listActiveTelegramRunControlIds,
  registerTelegramRunControl,
  releaseTelegramRunControl,
  requestCancelTelegramRun,
} from './runControl.js';
import {
  cancelTelegramBackupRunRecord,
  createTelegramBackupRun,
  getTelegramBackupRun,
  listActiveTelegramBackupRuns,
  updateTelegramBackupRun,
} from '../state/telegramBackup.js';

const activeRuns = new Map();

function backupSlotBusy(db) {
  return activeRuns.size > 0 || listActiveTelegramBackupRuns(db).length > 0;
}

function reserveBackupSlot(db, runId) {
  if (activeRuns.size > 0) {
    return { ok: false, code: 'BACKUP_BUSY', message: 'Já existe um backup ou restore em andamento neste servidor.', run_id: runId };
  }
  const dbActive = listActiveTelegramBackupRuns(db);
  if (dbActive.length > 0 && !dbActive.some((run) => run.id === runId)) {
    return {
      ok: false,
      code: 'BACKUP_BUSY',
      message: `Outro run ainda está ativo (${dbActive[0].id}). Cancele antes de iniciar outro.`,
      run_id: dbActive[0].id,
    };
  }
  return { ok: true };
}

export function enqueueTelegramBackup({ config, db, backupConfig, request }) {
  const runId = request.runId || `br-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (activeRuns.has(runId)) {
    return { ok: false, code: 'ALREADY_RUNNING', message: 'Backup já em execução.', run_id: runId };
  }
  const slot = reserveBackupSlot(db, runId);
  if (!slot.ok) return slot;

  const control = registerTelegramRunControl(runId);
  const promise = runTelegramBackup({
    config,
    db,
    backupConfig,
    request: { ...request, runId },
    runId,
    shouldCancel: () => control.isCancelled(),
    onProgress: (progress) => {
      updateTelegramBackupRun(db, runId, { progressJson: progress });
    },
  }).finally(() => {
    activeRuns.delete(runId);
    releaseTelegramRunControl(runId);
  });

  activeRuns.set(runId, promise);
  return { ok: true, run_id: runId, status: 'queued' };
}

export function enqueueTelegramRestore({ config, db, backupConfig, request }) {
  const runId = request.runId || `br-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (activeRuns.has(runId)) {
    return { ok: false, code: 'ALREADY_RUNNING', message: 'Restore já em execução.', run_id: runId };
  }
  const slot = reserveBackupSlot(db, runId);
  if (!slot.ok) return slot;

  createTelegramBackupRun(db, {
    id: runId,
    status: 'queued',
    mode: 'full',
    underlying: request.underlying ?? null,
    requestJson: { kind: 'restore', ...request },
  });

  const control = registerTelegramRunControl(runId);
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
        shouldCancel: () => control.isCancelled(),
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
      if (err?.code === 'CANCELLED') {
        return finalizeCancelledRun(db, runId, { kind: 'restore' });
      }
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
    releaseTelegramRunControl(runId);
  });

  activeRuns.set(runId, promise);
  return { ok: true, run_id: runId, status: 'queued' };
}

export function cancelTelegramBackupRun(db, runId) {
  const run = getTelegramBackupRun(db, runId);
  if (!run) {
    return { ok: false, code: 'NOT_FOUND', message: 'Run não encontrado.' };
  }
  if (!['queued', 'running'].includes(run.status)) {
    return {
      ok: false,
      code: 'NOT_CANCELLABLE',
      message: `Run não pode ser cancelado no status ${run.status}.`,
      run_id: runId,
    };
  }

  requestCancelTelegramRun(runId);
  cancelTelegramBackupRunRecord(db, runId, run.progress);
  return { ok: true, run_id: runId, status: 'cancelled' };
}

export function cancelAllActiveTelegramBackupRuns(db) {
  cancelAllTelegramRunControls();
  const active = listActiveTelegramBackupRuns(db);
  const cancelled = [];
  for (const run of active) {
    const result = cancelTelegramBackupRun(db, run.id);
    if (result.ok) cancelled.push(run.id);
  }
  for (const runId of listActiveTelegramRunControlIds()) {
    if (!cancelled.includes(runId)) {
      requestCancelTelegramRun(runId);
      cancelled.push(runId);
    }
  }
  return { ok: true, cancelled_run_ids: cancelled };
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

export function isTelegramBackupBusy(db) {
  return backupSlotBusy(db);
}

function finalizeCancelledRun(db, runId, extraProgress = {}) {
  const run = getTelegramBackupRun(db, runId);
  if (run?.status !== 'cancelled') {
    cancelTelegramBackupRunRecord(db, runId, { ...(run?.progress || {}), ...extraProgress });
  }
  return { ok: false, code: 'CANCELLED', message: 'Cancelado pelo usuário.' };
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
