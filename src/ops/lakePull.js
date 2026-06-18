import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { upsertManifestPartition } from '../state/manifest.js';

const DEFAULT_DATASETS = ['backtest_ticks'];
const DEFAULT_STATUSES = ['valid', 'accepted'];
const DATASET_ALLOWLIST = new Set([
  'scalars',
  'books',
  'backtest_ticks',
  'backtest_ticks_lite',
  'ohlc',
]);

export function activePathToLakeRelative(activePath, lakeRoot = '') {
  const raw = String(activePath || '').replace(/\\/g, '/');
  if (!raw) return null;

  if (raw.startsWith('/lake/')) {
    return raw.slice('/lake/'.length);
  }

  if (lakeRoot) {
    const root = path.resolve(lakeRoot);
    const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
    const relative = path.relative(root, absolute).replace(/\\/g, '/');
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative;
    }
  }

  if (!path.isAbsolute(raw) && !/^[a-zA-Z]:\//.test(raw)) {
    return raw.replace(/^\/+/, '');
  }

  return null;
}

export function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function buildManifestQuery(filters) {
  const clauses = ['active_path IS NOT NULL', "active_path != ''"];

  if (filters.from) clauses.push(`dt >= ${sqlLiteral(filters.from)}`);
  if (filters.to) clauses.push(`dt <= ${sqlLiteral(filters.to)}`);
  if (filters.underlying) clauses.push(`underlying = ${sqlLiteral(filters.underlying)}`);
  if (filters.interval) clauses.push(`interval = ${sqlLiteral(filters.interval)}`);
  if (filters.bookDepth != null) clauses.push(`book_depth = ${Number(filters.bookDepth)}`);

  const datasets = filters.datasets?.length ? filters.datasets : DEFAULT_DATASETS;
  for (const dataset of datasets) {
    if (!DATASET_ALLOWLIST.has(dataset)) {
      throw new Error(`Unsupported dataset: ${dataset}`);
    }
  }
  clauses.push(`dataset IN (${datasets.map(sqlLiteral).join(', ')})`);

  const statuses = filters.statuses?.length ? filters.statuses : DEFAULT_STATUSES;
  clauses.push(`status IN (${statuses.map(sqlLiteral).join(', ')})`);

  return `SELECT * FROM lake_manifest WHERE ${clauses.join(' AND ')} ORDER BY dt ASC, dataset ASC`;
}

export function manifestRowToEntry(row) {
  let qualityDetails = null;
  if (row.quality_details_json) {
    try {
      qualityDetails = JSON.parse(row.quality_details_json);
    } catch {
      qualityDetails = null;
    }
  }

  return {
    dataset: row.dataset,
    marketId: row.market_id ?? null,
    underlying: row.underlying,
    interval: row.interval,
    resolution: row.resolution ?? null,
    bookDepth: row.book_depth ?? null,
    dt: row.dt,
    activePath: row.active_path ?? null,
    runId: row.run_id ?? null,
    rows: Number(row.rows || 0),
    eventsCount: Number(row.events_count || 0),
    minTs: row.min_ts ?? null,
    maxTs: row.max_ts ?? null,
    coverageMin: row.coverage_min ?? null,
    hasDegraded: Boolean(row.has_degraded),
    qualityDetails,
    sourceTickCount: row.source_tick_count ?? null,
    sourceConditionCount: row.source_condition_count ?? null,
    sourceQualityRecordedAtMax: row.source_quality_recorded_at_max ?? null,
    sourceFingerprint: row.source_fingerprint ?? null,
    status: row.status,
    verifiedAt: row.verified_at ?? null,
    error: row.error ?? null,
  };
}

export function planLakePull({ rows, remoteLakeRoot, localLakeRoot }) {
  const files = [];
  const seen = new Set();

  for (const row of rows) {
    const relativePath = activePathToLakeRelative(row.active_path, localLakeRoot);
    if (!relativePath || seen.has(relativePath)) continue;
    seen.add(relativePath);
    files.push({
      relativePath,
      remoteAbsolutePath: path.posix.join(remoteLakeRoot.replace(/\\/g, '/'), relativePath),
      localAbsolutePath: path.join(localLakeRoot, ...relativePath.split('/')),
      partition: {
        dataset: row.dataset,
        dt: row.dt,
        underlying: row.underlying,
        interval: row.interval,
        status: row.status,
      },
    });
  }

  return {
    partitions: rows.length,
    files,
    bytesEstimate: null,
  };
}

export function parseRemoteManifestJson(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error('Unexpected remote manifest response');
  }
  return parsed;
}

function buildRemoteNodeManifestScript(dbPath, query) {
  const queryB64 = Buffer.from(query, 'utf8').toString('base64');
  return `
import { DatabaseSync } from 'node:sqlite';
const query = Buffer.from('${queryB64}', 'base64').toString('utf8');
const db = new DatabaseSync(${JSON.stringify(dbPath)}, { readOnly: true });
try {
  console.log(JSON.stringify(db.prepare(query).all()));
} finally {
  db.close();
}
`.trim();
}

async function readJsonFile(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function getRemoteFileMtime({ remoteHost, remotePath, runCommand }) {
  const stdout = await runCommand('ssh', [remoteHost, 'stat', '-c', '%Y', remotePath]);
  const mtime = Number.parseInt(String(stdout).trim(), 10);
  if (!Number.isFinite(mtime)) {
    throw new Error(`Could not read remote mtime for ${remotePath}`);
  }
  return mtime;
}

export async function resolveRemoteContainerTarget({
  remoteHost,
  remoteContainer,
  remoteStateInContainer = '/state/data-backtest.db',
  cachePath,
  runCommand,
  log = console.log,
}) {
  if (remoteContainer) {
    return { containerId: remoteContainer, statePath: remoteStateInContainer };
  }

  const cached = cachePath ? await readJsonFile(cachePath) : null;
  if (cached?.containerId) {
    return {
      containerId: cached.containerId,
      statePath: cached.statePath || remoteStateInContainer,
    };
  }

  log('[lake:pull] descobrindo container data-backtest no Brutus...');
  const stdout = await runCommand('ssh', [
    remoteHost,
    'docker ps -q | while read id; do if docker inspect -f "{{range .Config.Env}}{{println .}}{{end}}" "$id" | grep -q "^STATE_DB_PATH="; then echo "$id"; break; fi; done',
  ]);
  const containerId = String(stdout).trim();
  if (!containerId) {
    throw new Error('Container data-backtest nao encontrado no host remoto');
  }

  const target = { containerId, statePath: remoteStateInContainer };
  if (cachePath) {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify({ ...target, discoveredAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  }
  return target;
}

async function fetchRemoteManifestRowsViaRemoteNode({
  remoteHost,
  remoteContainer,
  remoteStateInContainer,
  containerCachePath,
  query,
  runCommand,
  log,
}) {
  const target = await resolveRemoteContainerTarget({
    remoteHost,
    remoteContainer,
    remoteStateInContainer,
    cachePath: containerCachePath,
    runCommand,
    log,
  });
  const script = buildRemoteNodeManifestScript(target.statePath, query);
  const scriptB64 = Buffer.from(script, 'utf8').toString('base64');
  log(`[lake:pull] consultando manifest remoto via docker exec (${target.containerId.slice(0, 12)})...`);
  const stdout = await runCommand('ssh', [
    remoteHost,
    `echo ${scriptB64} | base64 -d | docker exec -i ${target.containerId} node --input-type=module`,
  ]);
  return parseRemoteManifestJson(stdout);
}

async function fetchRemoteManifestRowsViaSqlite3({
  remoteHost,
  remoteStatePath,
  query,
  runCommand,
}) {
  const stdout = await runCommand('ssh', [remoteHost, 'sqlite3', '-json', remoteStatePath, query]);
  return parseRemoteManifestJson(stdout);
}

async function readManifestRowsFromLocalDb(dbPath, query) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(query).all();
  } finally {
    db.close();
  }
}

async function fetchRemoteManifestRowsViaScp({
  remoteHost,
  remoteStatePath,
  query,
  runCommand,
  cachePath,
  cacheMetaPath,
  log,
}) {
  let dbPath = cachePath;
  let usedCache = false;

  if (cachePath && cacheMetaPath) {
    const remoteMtime = await getRemoteFileMtime({ remoteHost, remotePath: remoteStatePath,  runCommand });
    const meta = await readJsonFile(cacheMetaPath);
    try {
      if (meta?.remoteMtime === remoteMtime) {
        await stat(cachePath);
        usedCache = true;
        log('[lake:pull] reutilizando cache local do state remoto');
      }
    } catch {
      usedCache = false;
    }

    if (!usedCache) {
      log('[lake:pull] baixando state remoto via scp (~280MB, pode demorar)...');
      await mkdir(path.dirname(cachePath), { recursive: true });
      await runCommand('scp', [`${remoteHost}:${remoteStatePath}`, cachePath]);
      await writeFile(cacheMetaPath, `${JSON.stringify({ remoteMtime, fetchedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    }
  } else {
    dbPath = path.join(os.tmpdir(), `data-backtest-pull-${process.pid}-${Date.now()}.db`);
    log('[lake:pull] baixando state remoto via scp (~280MB, pode demorar)...');
    await runCommand('scp', [`${remoteHost}:${remoteStatePath}`, dbPath]);
  }

  try {
    return await readManifestRowsFromLocalDb(dbPath, query);
  } finally {
    if (!cachePath) {
      await rm(dbPath, { force: true });
    }
  }
}

export async function fetchRemoteManifestRows({
  remoteHost,
  remoteStatePath,
  query,
  runCommand,
  log = console.log,
  remoteContainer = null,
  remoteStateInContainer = '/state/data-backtest.db',
  containerCachePath = null,
  stateCachePath = null,
  stateCacheMetaPath = null,
}) {
  try {
    return await fetchRemoteManifestRowsViaRemoteNode({
      remoteHost,
      remoteContainer,
      remoteStateInContainer,
      containerCachePath,
      query,
      runCommand,
      log,
    });
  } catch (err) {
    log(`[lake:pull] docker exec indisponivel, tentando sqlite3 no host: ${err.message}`);
  }

  try {
    log('[lake:pull] consultando manifest remoto via ssh+sqlite3...');
    return await fetchRemoteManifestRowsViaSqlite3({
      remoteHost,
      remoteStatePath,
      query,
      runCommand,
    });
  } catch (err) {
    log(`[lake:pull] sqlite3 remoto indisponivel, fallback scp: ${err.message}`);
  }

  return fetchRemoteManifestRowsViaScp({
    remoteHost,
    remoteStatePath,
    query,
    runCommand,
    cachePath: stateCachePath,
    cacheMetaPath: stateCacheMetaPath,
    log,
  });
}

export async function runLakePull({
  config,
  db,
  remoteHost,
  remoteLakeRoot,
  remoteStatePath,
  filters = {},
  full = false,
  fullState = false,
  dryRun = false,
  skipCheck = false,
  runCommand,
  log = console.log,
}) {
  if (!remoteHost) throw new Error('remoteHost is required');
  if (!remoteLakeRoot) throw new Error('remoteLakeRoot is required');
  if (!remoteStatePath) throw new Error('remoteStatePath is required');
  if (!runCommand) throw new Error('runCommand is required');

  await mkdir(config.lakeRoot, { recursive: true });
  await mkdir(path.dirname(config.stateDbPath), { recursive: true });

  if (full) {
    log(`[lake:pull] modo completo: ${remoteHost}:${remoteLakeRoot} -> ${config.lakeRoot}`);
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        mode: 'full',
        wouldCopyLake: true,
        wouldCopyState: fullState,
      };
    }

    if (fullState) {
      const backupPath = `${config.stateDbPath}.bak-${formatBackupStamp()}`;
      try {
        await copyFile(config.stateDbPath, backupPath);
        log(`[lake:pull] backup do state local: ${backupPath}`);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      await runCommand('scp', [`${remoteHost}:${remoteStatePath}`, config.stateDbPath]);
      log(`[lake:pull] state remoto copiado para ${config.stateDbPath}`);
    }

    await runCommand('scp', ['-r', `${remoteHost}:${remoteLakeRoot}/.`, config.lakeRoot]);
    log(`[lake:pull] lake remoto copiado para ${config.lakeRoot}`);

    const check = skipCheck ? null : await import('./backupCheck.js').then((m) => m.runBackupCheck(config, db));
    return {
      ok: check ? check.ok : true,
      dryRun: false,
      mode: 'full',
      fullState,
      check,
    };
  }

  if (!filters.from || !filters.to) {
    throw new Error('--from and --to are required unless --full is used');
  }

  const query = buildManifestQuery(filters);
  const stateDir = path.dirname(config.stateDbPath);
  const rows = await fetchRemoteManifestRows({
    remoteHost,
    remoteStatePath,
    query,
    runCommand,
    log,
    remoteContainer: filters.remoteContainer ?? null,
    remoteStateInContainer: filters.remoteStateInContainer ?? '/state/data-backtest.db',
    containerCachePath: path.join(stateDir, '.lake-pull-remote-container.json'),
    stateCachePath: path.join(stateDir, '.lake-pull-remote-state-cache.db'),
    stateCacheMetaPath: path.join(stateDir, '.lake-pull-remote-state-cache.json'),
  });
  if (!rows.length) {
    return {
      ok: false,
      dryRun,
      mode: 'selective',
      partitions: 0,
      files: [],
      error: 'Nenhuma particao encontrada no manifest remoto para os filtros informados',
    };
  }

  const plan = planLakePull({
    rows,
    remoteLakeRoot: remoteLakeRoot.replace(/\/$/, ''),
    localLakeRoot: config.lakeRoot,
  });

  log(`[lake:pull] ${plan.partitions} particoes, ${plan.files.length} arquivos parquet`);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      mode: 'selective',
      partitions: plan.partitions,
      files: plan.files.map((file) => ({
        relativePath: file.relativePath,
        remote: `${remoteHost}:${file.remoteAbsolutePath}`,
        local: file.localAbsolutePath,
        partition: file.partition,
      })),
      manifestRows: rows.length,
    };
  }

  let copied = 0;
  for (const file of plan.files) {
    await mkdir(path.dirname(file.localAbsolutePath), { recursive: true });
    await runCommand('scp', [`${remoteHost}:${file.remoteAbsolutePath}`, file.localAbsolutePath]);
    copied += 1;
    log(`[lake:pull] copiado (${copied}/${plan.files.length}): ${file.relativePath}`);
  }

  let merged = 0;
  for (const row of rows) {
    upsertManifestPartition(db, manifestRowToEntry(row));
    merged += 1;
  }

  const check = skipCheck ? null : await import('./backupCheck.js').then((m) => m.runBackupCheck(config, db));
  return {
    ok: check ? check.ok : true,
    dryRun: false,
    mode: 'selective',
    partitions: plan.partitions,
    filesCopied: copied,
    manifestMerged: merged,
    check,
  };
}

function formatBackupStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
