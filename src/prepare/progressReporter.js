import { computePrepareJobPercent } from './progress.js';
import { updatePrepareJobProgress } from '../state/prepareJobs.js';

const MAX_RECENT_FILES = 5;

function sumFileBytes(files = []) {
  return files.reduce((sum, file) => sum + (Number(file.bytes) || 0), 0);
}

export function mergeProgressFiles(progress, patchFiles = []) {
  if (!patchFiles.length) {
    return {
      files: progress.files || [],
      files_count: progress.files_count ?? (progress.files?.length || 0),
      bytes_total: progress.bytes_total ?? sumFileBytes(progress.files),
    };
  }
  const files_count = (progress.files_count ?? progress.files?.length ?? 0) + patchFiles.length;
  const bytes_total = (progress.bytes_total ?? sumFileBytes(progress.files)) + sumFileBytes(patchFiles);
  const files = [...(progress.files || []), ...patchFiles].slice(-MAX_RECENT_FILES);
  return { files, files_count, bytes_total };
}

export function createProgressReporter(db, job, emitEvent) {
  const startedAt = job.started_at || new Date().toISOString();
  let progress = {
    started_at: startedAt,
    updated_at: startedAt,
    actions_total: job.plan?.preparation?.length || 0,
    action_index: 0,
    partitions_total: 0,
    partitions_done: 0,
    files: [],
    files_count: 0,
    bytes_total: 0,
    current: null,
  };

  let lastPersistMs = 0;
  return (patch) => {
    const fileMerge = patch.files
      ? mergeProgressFiles(progress, patch.files)
      : {
        files: progress.files || [],
        files_count: progress.files_count ?? (progress.files?.length || 0),
        bytes_total: progress.bytes_total ?? sumFileBytes(progress.files),
      };
    progress = {
      ...progress,
      ...patch,
      files: fileMerge.files,
      files_count: fileMerge.files_count,
      bytes_total: fileMerge.bytes_total,
      current: patch.current === undefined ? progress.current : patch.current,
      updated_at: new Date().toISOString(),
    };
    progress.percent = computePrepareJobPercent(progress);
    const now = Date.now();
    const force = Boolean(patch.files?.length)
      || patch.current?.phase === 'done'
      || patch.current === null
      || patch.partitions_done != null && patch.current == null;
    if (!force && now - lastPersistMs < 1000) return;
    lastPersistMs = now;
    updatePrepareJobProgress(db, job.id, progress);
    emitEvent?.({ type: 'job:progress', jobId: job.id, status: 'running', progress });
  };
}
