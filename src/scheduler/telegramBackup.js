import { listBackupPartitionGroups } from '../backup/export.js';
import { resolveTelegramBackupConfig, markTelegramBackupScheduleRan } from '../state/telegramBackupSettings.js';
import { enqueueTelegramBackup, isTelegramBackupRunning } from '../backup/runner.js';
import {
  isDailyScheduleDue,
  localDateKey,
  resolveSchedulerTimezone,
} from './scheduleTime.js';

const DEFAULT_POLL_MS = 60_000;

export function createTelegramBackupScheduler({ config, db, pollMs = DEFAULT_POLL_MS, autoStart = false, now = () => new Date() }) {
  let timer = null;
  let ticking = false;

  async function tick() {
    if (ticking || isTelegramBackupRunning()) return;
    ticking = true;
    try {
      const backupConfig = resolveTelegramBackupConfig(config, db);
      if (!backupConfig.enabled) return;

      const current = now();
      if (backupConfig.autoScheduleEnabled) {
        await maybeRunDailySchedule({ config, db, backupConfig, current });
      }
    } catch (err) {
      console.warn('[telegram-backup-scheduler] tick failed:', err.message);
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => void tick(), pollMs);
    timer.unref?.();
    queueMicrotask(() => void tick());
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  if (autoStart) start();

  return { start, stop, tick };
}

async function maybeRunDailySchedule({ config, db, backupConfig, current }) {
  const timeZone = resolveSchedulerTimezone(config);
  const today = localDateKey(current, timeZone);
  if (backupConfig.lastScheduleRunDate === today) return;

  if (!isDailyScheduleDue(backupConfig.autoScheduleTimeUtc || '04:00', current, timeZone)) return;

  const groups = listBackupPartitionGroups(db);
  if (!groups.length) return;

  enqueueTelegramBackup({
    config,
    db,
    backupConfig,
    request: {
      allUnderlyings: true,
      incremental: backupConfig.incrementalDefault,
      continueOnError: true,
    },
  });
  markTelegramBackupScheduleRan(db, today);
}

export function enqueueTelegramBackupAfterAssetSync({ config, db, underlying, interval, bookDepth }) {
  const backupConfig = resolveTelegramBackupConfig(config, db);
  if (!backupConfig.enabled || !backupConfig.autoAfterAssetSync) {
    return { ok: false, code: 'SKIPPED', message: 'Auto backup após sync desabilitado.' };
  }
  if (isTelegramBackupRunning()) {
    return { ok: false, code: 'BUSY', message: 'Backup já em execução.' };
  }
  return enqueueTelegramBackup({
    config,
    db,
    backupConfig,
    request: {
      underlying,
      interval,
      bookDepth,
      incremental: true,
      continueOnError: true,
    },
  });
}
