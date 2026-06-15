import { runTelegramBackup } from './upload.js';
import { getTelegramBackupRun, updateTelegramBackupRun } from '../state/telegramBackup.js';

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
