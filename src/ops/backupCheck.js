import { accessSync, constants } from 'node:fs';
import path from 'node:path';

import { getHealth } from '../health.js';
import { listManifest } from '../state/manifest.js';

export async function runBackupCheck(config, db) {
  const health = await getHealth(config, db);
  const partitions = listManifest(db, { limit: 1000 });
  const missingFiles = [];
  const checkedPaths = new Set();

  for (const partition of partitions) {
    if (!partition.active_path || partition.status !== 'valid') continue;
    const resolved = resolveActivePath(config.lakeRoot, partition.active_path);
    if (checkedPaths.has(resolved)) continue;
    checkedPaths.add(resolved);
    try {
      accessSync(resolved, constants.R_OK);
    } catch {
      missingFiles.push({ dt: partition.dt, active_path: partition.active_path, resolved });
    }
  }

  return {
    ok: health.status === 'ok' && missingFiles.length === 0,
    health,
    partitions_checked: checkedPaths.size,
    missing_active_paths: missingFiles,
    backup_ready: missingFiles.length === 0,
    notes: [
      'Backup consistente exige snapshot conjunto de /lake e /state.',
      'Este check valida health, storage e existencia dos active_path validos.',
    ],
  };
}

function resolveActivePath(lakeRoot, activePath) {
  const normalized = String(activePath).replace(/\\/g, '/');
  if (normalized.startsWith('/lake/')) {
    return path.join(lakeRoot, normalized.slice('/lake/'.length));
  }
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized)) {
    return path.resolve(normalized);
  }
  return path.resolve(lakeRoot, normalized);
}
