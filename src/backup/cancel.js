export class BackupCancelledError extends Error {
  constructor(message = 'Backup cancelado pelo usuário') {
    super(message);
    this.name = 'BackupCancelledError';
    this.code = 'CANCELLED';
  }
}

export function assertNotCancelled(shouldCancel) {
  if (typeof shouldCancel === 'function' && shouldCancel()) {
    throw new BackupCancelledError();
  }
}

export function isBackupCancelledError(err) {
  return err instanceof BackupCancelledError || err?.code === 'CANCELLED';
}
