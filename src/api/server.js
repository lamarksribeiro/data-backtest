import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { cleanupOrphanParquetFiles, listActiveParquetRelativePaths } from '../lake/cleanup.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { getHealth } from '../health.js';
import { acceptManifestPartition, listBacktestContextOptions, listManifest, manifestStats, revokeAcceptedManifestPartition } from '../state/manifest.js';
import { emptyContextOptions, mergeContextOptions } from '../state/contextOptions.js';
import { createSourcePool, listSourceContextOptions } from '../source/postgres.js';
import { getPrepareJob, listPrepareJobs } from '../state/prepareJobs.js';
import {
  createAssetUpdateSchedule,
  deleteAssetUpdateSchedule,
  finishAssetUpdateRunByJobId,
  getAssetUpdateSchedule,
  listAssetUpdateSchedules,
  updateAssetUpdateSchedule,
} from '../state/assetUpdateSchedules.js';
import { checkDatasetAvailability } from '../query/availability.js';
import { resolveDataRequest } from '../query/dataMode.js';
import { datasetRequestFromObject, datasetRequestFromParams } from '../query/request.js';
import { createPrepareJobRunner } from '../prepare/runner.js';
import { createAssetUpdateScheduler, lastClosedUtcDate } from '../scheduler/assetUpdates.js';
import { createTelegramBackupScheduler, enqueueTelegramBackupAfterAssetSync } from '../scheduler/telegramBackup.js';
import { enqueueTelegramBackup, enqueueTelegramRestore, getTelegramBackupRunStatus, isTelegramBackupRunning } from '../backup/runner.js';
import { testTelegramBackupConnection } from '../backup/upload.js';
import { discoverTelegramBackupCatalog } from '../backup/discover.js';
import { listTelegramBackupRuns, getLastCompletedTelegramBackupRun, clearTelegramBackupLocalRecords } from '../state/telegramBackup.js';
import {
  resolveTelegramBackupConfig,
  toPublicTelegramBackupSettings,
  getStoredChannelCatalog,
  saveChannelCatalogDiscovery,
  updateTelegramBackupSettings,
  validateTelegramBackupSettingsInput,
} from '../state/telegramBackupSettings.js';
import { compareBacktestRuns, getRunAnalysis } from '../backtest/analysis.js';
import { createBacktestQueue } from '../backtest/queue.js';
import { clearDatasetDiskCache, scanDatasetDiskCache } from '../backtest/datasetDiskStore.js';
import { warmupDatasetDiskCache } from '../backtest/datasetDiskLoader.js';
import { analyzeStrategyColumns } from '../backtestStudio/gls/compiler.js';
import { availabilityRequestForBacktest } from '../backtest/engine.js';
import { parseSweepVariants } from '../backtest/sweep.js';
import { addSseClient, broadcastSse } from './sseHub.js';
import {
  cancelBacktestRun,
  deleteBacktestRun,
  failBacktestRun,
  getBacktestRun,
  listBacktestRuns,
} from '../state/backtestRuns.js';
import { getChartData, getEventTrace, listEventTraces } from '../backtestStudio/state/eventTraces.js';
import {
  createStrategy,
  createStrategyVersion,
  deleteStrategyVersion,
  forkStrategy,
  getStrategy,
  getStrategyVersion,
  listStrategies as listSavedStrategies,
  listStrategiesForPicker,
  listStrategyVersions,
  listTrashedStrategies,
  permanentlyDeleteStrategy,
  restoreStrategy,
  trashStrategy,
  updateStrategy,
  validateStrategySource,
} from '../backtestStudio/state/strategies.js';
import { getStrategyStats, invalidateStrategyStatsCache, listStrategiesWithStats, listTrashedStrategiesWithStats } from '../backtestStudio/state/strategyStats.js';
import { getDataCoverage, invalidateCoverageCache } from '../query/coverageUi.js';
import { invalidateDayEventsCache } from '../api/qualityHandlers.js';
import { runDataFix } from '../data/fixPipeline.js';
import {
  handleQualityDayEvents,
  handleQualityEventPreview,
  handleQualityExclude,
  handleQualityListExclusions,
  handleQualityRestore,
} from './qualityHandlers.js';
import { parse } from '../backtestStudio/gls/parser.js';
import { listBlockSignatures } from '../backtestStudio/gls/blocks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const STATIC_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);
const VERSION_PARAM = 'v';
const NO_STORE = 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0';
const REVALIDATE = 'no-cache, must-revalidate';
const IMMUTABLE = 'public, max-age=31536000, immutable';

export function createApiHandler(deps) {
  const {
    config,
    db,
    authService,
    prepareRunner,
  } = deps;
  const authMiddleware = deps.authMiddleware || createAuthMiddleware({ authService, config });
  const activeBacktestWorkers = new Map();
  let backtestQueue;
  const onSseEvent = (event) => {
    broadcastSse(event);
    if (event.type === 'job:completed') {
      const assetRun = finishAssetUpdateRunByJobId(db, event.jobId, event.status, event.status === 'cancelled' ? 'job cancelled' : null);
      invalidateCoverageCache();
      invalidateDayEventsCache();
      if (event.status === 'completed') {
        backtestQueue?.releaseWaitingRuns?.(event.jobId);
        if (assetRun?.status === 'completed') {
          const schedule = getAssetUpdateSchedule(db, assetRun.schedule_id);
          if (schedule) {
            enqueueTelegramBackupAfterAssetSync({
              config,
              db,
              underlying: schedule.underlying,
              interval: schedule.interval,
              bookDepth: schedule.book_depth,
            });
          }
        }
      }
    }
    if (event.type === 'job:failed') {
      finishAssetUpdateRunByJobId(db, event.jobId, 'failed', event.error || 'job failed');
    }
    if (event.type === 'data:stale') {
      broadcastSse(event);
    }
  };
  const resolvedPrepareRunner = prepareRunner ?? createPrepareJobRunner({ config, db, onEvent: onSseEvent });
  const assetUpdateScheduler = createAssetUpdateScheduler({
    config,
    db,
    prepareRunner: resolvedPrepareRunner,
    autoStart: deps.startScheduler === true,
  });
  const telegramBackupScheduler = createTelegramBackupScheduler({
    config,
    db,
    autoStart: deps.startScheduler === true,
  });
  backtestQueue = createBacktestQueue({
    config,
    db,
    onEvent: onSseEvent,
  });

  let sharedSourcePool = null;
  function getSourcePool() {
    if (!config.dataCollectorDatabaseUrl) return null;
    if (!sharedSourcePool) sharedSourcePool = createSourcePool(config);
    return sharedSourcePool;
  }

  const CONTEXT_OPTIONS_TTL_MS = 60_000;
  let contextOptionsCache = null;
  async function getContextOptions() {
    const now = Date.now();
    if (contextOptionsCache && now - contextOptionsCache.at < CONTEXT_OPTIONS_TTL_MS) {
      return contextOptionsCache.value;
    }
    const lake = listBacktestContextOptions(db);
    let source = emptyContextOptions();
    const pool = getSourcePool();
    if (pool) {
      try {
        source = await listSourceContextOptions(pool, config);
      } catch (error) {
        console.warn('[context-options] source query failed:', error.message);
      }
    }
    const value = mergeContextOptions(lake, source, config);
    contextOptionsCache = { at: now, value };
    return value;
  }

  return async function handleRequest(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/healthz') {
        return sendJson(res, 200, await getHealth(config, db));
      }

      if (req.method === 'GET' && pathname === '/login') {
        return serveStaticFile('login.html', req, res);
      }

      if (req.method === 'POST' && pathname === '/api/login') {
        const body = await readJson(req);
        const result = await authService.login(body.username, body.password);
        if (!result) {
          return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
        }
        res.setHeader('set-cookie', authService.formatSetCookie(
          authService.cookieName,
          result.cookie,
          authService.cookieOptions(),
        ));
        return sendJson(res, 200, { user: { id: result.userId, username: result.username } });
      }

      if (req.method === 'POST' && pathname === '/api/logout') {
        res.setHeader('set-cookie', authService.formatClearCookie(authService.cookieName));
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'GET' && pathname === '/api/me') {
        await authMiddleware.attachPrincipal(req);
        if (!req.principal) {
          return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
        }
        return sendJson(res, 200, { principal: req.principal });
      }

      if (pathname.startsWith('/api/')) {
        const allowed = await authMiddleware.requireApiAuth(req, res, pathname);
        if (!allowed) return;
      }

      if (req.method === 'GET' && pathname === '/api/stream') {
        return addSseClient(res);
      }

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const allowed = await authMiddleware.requirePageAuth(req, res);
        if (!allowed) return;
        return serveStaticFile('index.html', req, res);
      }
      if (req.method === 'GET' && url.pathname === '/api/manifest') {
        return sendJson(res, 200, {
          stats: manifestStats(db),
          partitions: listManifest(db, {
            status: url.searchParams.get('status') || undefined,
            limit: url.searchParams.get('limit') || undefined,
          }),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/manifest/accept') {
        const body = await readJson(req);
        const result = acceptManifestPartition(db, manifestPartitionFromBody(body), body.reason);
        return result.ok
          ? sendJson(res, 200, result)
          : sendJson(res, 409, { error: { code: 'ACCEPT_FAILED', message: manifestActionError(result) } });
      }
      if (req.method === 'POST' && url.pathname === '/api/manifest/revoke-acceptance') {
        const body = await readJson(req);
        const result = revokeAcceptedManifestPartition(db, manifestPartitionFromBody(body), body.reason);
        return result.ok
          ? sendJson(res, 200, result)
          : sendJson(res, 409, { error: { code: 'REVOKE_ACCEPTANCE_FAILED', message: manifestActionError(result) } });
      }
      if (req.method === 'GET' && url.pathname === '/api/context-options') {
        return sendJson(res, 200, { options: await getContextOptions() });
      }
      if (req.method === 'GET' && url.pathname === '/api/settings/asset-update-schedules') {
        return sendJson(res, 200, {
          schedules: listAssetUpdateSchedules(db),
          target_to_date: lastClosedUtcDate(),
          scheduler_timezone: config.schedulerTimezone,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/settings/asset-update-schedules') {
        const body = await readJson(req);
        const schedule = createAssetUpdateSchedule(db, body, { config });
        return sendJson(res, 201, {
          schedule,
          target_to_date: lastClosedUtcDate(),
          scheduler_timezone: config.schedulerTimezone,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/settings/dataset-cache') {
        const stats = scanDatasetDiskCache(config);
        return sendJson(res, 200, {
          enabled: config.datasetDiskCacheEnabled,
          cache_dir: config.datasetDiskCacheDir,
          max_gb: config.datasetDiskCacheMaxGb,
          ...stats,
        });
      }
      if (req.method === 'DELETE' && url.pathname === '/api/settings/dataset-cache') {
        const filters = {
          underlying: url.searchParams.get('underlying') || undefined,
          interval: url.searchParams.get('interval') || undefined,
          dataset: url.searchParams.get('dataset') || undefined,
        };
        const bookDepthRaw = url.searchParams.get('book_depth');
        if (bookDepthRaw != null && bookDepthRaw !== '') {
          filters.bookDepth = bookDepthRaw === 'none' ? null : Number.parseInt(bookDepthRaw, 10);
        }
        const result = clearDatasetDiskCache(config, filters);
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (req.method === 'POST' && url.pathname === '/api/settings/dataset-cache/warmup') {
        const body = await readJson(req);
        const dataRequest = datasetRequestFromObject({ dataset: 'backtest_ticks', ...body }, config);
        const warmupRequest = {
          ...dataRequest,
          bookDepth: positiveOptionalInt(body.book_depth ?? body.bookDepth) ?? config.backtestBookDepth,
          selectColumns: body.select_columns ?? body.selectColumns,
        };
        const warmed = await warmupDatasetDiskCache(db, warmupRequest, { config });
        return sendJson(res, 200, warmed);
      }
      if (req.method === 'GET' && url.pathname === '/api/settings/telegram-backup') {
        const effective = resolveTelegramBackupConfig(config, db);
        const lastRun = getLastCompletedTelegramBackupRun(db);
        const channelCatalog = getStoredChannelCatalog(db);
        return sendJson(res, 200, {
          settings: toPublicTelegramBackupSettings(effective),
          scheduler_timezone: config.schedulerTimezone,
          last_run: lastRun,
          channel_catalog: channelCatalog,
        });
      }
      if (req.method === 'PUT' && url.pathname === '/api/settings/telegram-backup') {
        const body = await readJson(req);
        const validated = validateTelegramBackupSettingsInput(body);
        if (!validated.ok) {
          return sendJson(res, 400, { error: { code: 'VALIDATION_FAILED', message: validated.message } });
        }
        updateTelegramBackupSettings(db, validated.patch, { updatedBy: req.user?.username ?? null });
        const effective = resolveTelegramBackupConfig(config, db);
        return sendJson(res, 200, { settings: toPublicTelegramBackupSettings(effective), scheduler_timezone: config.schedulerTimezone });
      }
      if (req.method === 'POST' && url.pathname === '/api/settings/telegram-backup/test') {
        const effective = resolveTelegramBackupConfig(config, db);
        if (!effective.botToken || !effective.chatId) {
          return sendJson(res, 400, { error: { code: 'NOT_CONFIGURED', message: 'Configure token e chat_id antes de testar.' } });
        }
        const result = await testTelegramBackupConnection(effective, { db });
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && url.pathname === '/api/backup/telegram/discover') {
        const backupConfig = resolveTelegramBackupConfig(config, db);
        if (!backupConfig.configured) {
          return sendJson(res, 400, { error: { code: 'NOT_CONFIGURED', message: 'Token e chat_id são obrigatórios.' } });
        }
        if (isTelegramBackupRunning()) {
          return sendJson(res, 409, { error: { code: 'BACKUP_BUSY', message: 'Aguarde o backup ou restore em andamento terminar.' } });
        }
        const discovery = await discoverTelegramBackupCatalog({ backupConfig });
        const channelCatalog = saveChannelCatalogDiscovery(db, discovery);
        return sendJson(res, 200, { ok: discovery.ok, discovery: channelCatalog ?? discovery });
      }
      if (req.method === 'GET' && url.pathname === '/api/backup/telegram/runs') {
        const limit = positiveOptionalInt(url.searchParams.get('limit')) ?? 20;
        return sendJson(res, 200, { runs: listTelegramBackupRuns(db, { limit }) });
      }
      const telegramBackupRunRoute = matchTelegramBackupRunRoute(url.pathname);
      if (telegramBackupRunRoute?.kind === 'detail' && req.method === 'GET') {
        const run = getTelegramBackupRunStatus(db, telegramBackupRunRoute.runId);
        if (!run) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Run not found' } });
        return sendJson(res, 200, { run });
      }
      if (req.method === 'POST' && url.pathname === '/api/backup/telegram/runs') {
        const body = await readJson(req);
        const backupConfig = resolveTelegramBackupConfig(config, db);
        if (!backupConfig.enabled && !body.force) {
          return sendJson(res, 403, { error: { code: 'DISABLED', message: 'Backup Telegram desabilitado nas configurações.' } });
        }
        if (!backupConfig.configured) {
          return sendJson(res, 400, { error: { code: 'NOT_CONFIGURED', message: 'Token e chat_id são obrigatórios.' } });
        }
        const result = enqueueTelegramBackup({
          config,
          db,
          backupConfig,
          request: {
            underlying: body.underlying ? String(body.underlying).toUpperCase() : null,
            interval: body.interval ? String(body.interval) : '5m',
            bookDepth: positiveOptionalInt(body.book_depth ?? body.bookDepth),
            allUnderlyings: body.all_underlyings === true,
            incremental: body.incremental != null ? Boolean(body.incremental) : backupConfig.incrementalDefault,
            dryRun: body.dry_run === true,
            force: body.force === true,
            from: body.from ? String(body.from) : null,
            to: body.to ? String(body.to) : null,
            continueOnError: true,
          },
        });
        return sendJson(res, 202, result);
      }
      if (req.method === 'POST' && url.pathname === '/api/backup/telegram/restore') {
        const body = await readJson(req);
        if (body.confirm !== true) {
          return sendJson(res, 400, { error: { code: 'CONFIRM_REQUIRED', message: 'Envie confirm: true para restaurar.' } });
        }
        const backupConfig = resolveTelegramBackupConfig(config, db);
        if (!backupConfig.configured) {
          return sendJson(res, 400, { error: { code: 'NOT_CONFIGURED', message: 'Token e chat_id são obrigatórios.' } });
        }
        const result = enqueueTelegramRestore({
          config,
          db,
          backupConfig,
          request: {
            masterFileId: body.master_file_id ? String(body.master_file_id) : null,
            catalogMessageId: body.catalog_message_id ? Number.parseInt(String(body.catalog_message_id), 10) : null,
            sourceRunId: body.run_id ? String(body.run_id) : null,
            catalogPath: body.catalog_path ? String(body.catalog_path) : null,
            underlying: body.underlying ? String(body.underlying).toUpperCase() : null,
            dryRun: body.dry_run === true,
          },
        });
        if (!result.ok) {
          const status = result.code === 'ALREADY_RUNNING' ? 409 : 400;
          return sendJson(res, status, { error: { code: result.code, message: result.message }, ...result });
        }
        return sendJson(res, 202, result);
      }
      if (req.method === 'POST' && url.pathname === '/api/backup/telegram/clear-local') {
        const body = await readJson(req);
        if (body.confirm !== true) {
          return sendJson(res, 400, { error: { code: 'CONFIRM_REQUIRED', message: 'Envie confirm: true para limpar o histórico local.' } });
        }
        if (isTelegramBackupRunning()) {
          return sendJson(res, 409, { error: { code: 'BACKUP_BUSY', message: 'Aguarde o backup ou restore em andamento terminar.' } });
        }
        const cleared = clearTelegramBackupLocalRecords(db);
        return sendJson(res, 200, { ok: true, ...cleared });
      }
      const assetScheduleRoute = matchAssetUpdateScheduleRoute(url.pathname);
      if (assetScheduleRoute) {
        const schedule = getAssetUpdateSchedule(db, assetScheduleRoute.scheduleId);
        if (!schedule) {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Schedule not found' } });
        }
        if (req.method === 'GET' && assetScheduleRoute.kind === 'detail') {
          return sendJson(res, 200, { schedule, target_to_date: lastClosedUtcDate() });
        }
        if (req.method === 'PATCH' && assetScheduleRoute.kind === 'detail') {
          const body = await readJson(req);
          const updated = updateAssetUpdateSchedule(db, assetScheduleRoute.scheduleId, body, { config });
          return sendJson(res, 200, { schedule: updated, target_to_date: lastClosedUtcDate() });
        }
        if (req.method === 'DELETE' && assetScheduleRoute.kind === 'detail') {
          deleteAssetUpdateSchedule(db, assetScheduleRoute.scheduleId);
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'POST' && assetScheduleRoute.kind === 'run') {
          const result = await assetUpdateScheduler.runNow(assetScheduleRoute.scheduleId);
          if (!result.ok) {
            const status = result.code === 'ALREADY_RUNNING' ? 409 : 400;
            return sendJson(res, status, { error: { code: result.code || 'RUN_FAILED', message: result.message }, ...result });
          }
          return sendJson(res, result.job ? 202 : 200, result);
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/availability') {
        const request = datasetRequestFromParams(url.searchParams, config);
        return sendJson(res, 200, { availability: checkDatasetAvailability(db, request) });
      }
      if (req.method === 'GET' && url.pathname === '/api/data/coverage') {
        const coverage = getDataCoverage(db, url.searchParams, config);
        return sendJson(res, 200, { coverage });
      }
      if (req.method === 'POST' && url.pathname === '/api/data/fix') {
        const body = await readJson(req);
        const dryRun = body.dry_run === true;
        const result = runDataFix(db, config, { body, prepareRunner: resolvedPrepareRunner, dryRun });
        if (!result.ok) {
          return sendJson(res, 400, { error: { code: result.code || 'FIX_FAILED', message: result.message }, ...result });
        }
        return sendJson(res, result.job ? 202 : 200, result);
      }
      if (url.pathname.startsWith('/api/quality/')) {
        const pool = getSourcePool();
        if (!pool) {
          return sendJson(res, 503, { error: { code: 'SOURCE_UNAVAILABLE', message: 'DATA_COLLECTOR_DATABASE_URL is not configured' } });
        }
        if (req.method === 'GET' && url.pathname === '/api/quality/day-events') {
          const result = await handleQualityDayEvents(pool, db, config, url.searchParams);
          return sendJson(res, result.status, result.body);
        }
        if (req.method === 'GET' && url.pathname === '/api/quality/event-preview') {
          const result = await handleQualityEventPreview(pool, db, config, url.searchParams);
          return sendJson(res, result.status, result.body);
        }
        if (req.method === 'GET' && url.pathname === '/api/quality/exclusions') {
          const result = handleQualityListExclusions(db, url.searchParams);
          return sendJson(res, result.status, result.body);
        }
        if (req.method === 'POST' && url.pathname === '/api/quality/exclude') {
          const body = await readJson(req);
          const result = await handleQualityExclude(db, config, resolvedPrepareRunner, pool, body, req.user?.username ?? null);
          return sendJson(res, result.status, result.body);
        }
        if (req.method === 'POST' && url.pathname === '/api/quality/restore') {
          const body = await readJson(req);
          const result = await handleQualityRestore(db, config, resolvedPrepareRunner, pool, body);
          return sendJson(res, result.status, result.body);
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/prepare') {
        const request = datasetRequestFromParams(url.searchParams, config);
        const mode = url.searchParams.get('mode') || 'prepare';
        return sendJson(res, 200, { result: resolveDataRequest(db, request, mode) });
      }
      if (req.method === 'GET' && url.pathname === '/api/lake/files') {
        const relativePath = url.searchParams.get('path') || '';
        const safePath = path.resolve(config.lakeRoot, relativePath);
        if (!safePath.startsWith(config.lakeRoot)) {
          return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
        try {
          const entries = await readdir(safePath, { withFileTypes: true });
          const activePaths = listActiveParquetRelativePaths(db, config.lakeRoot);
          const list = [];
          for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const entryPath = path.join(safePath, entry.name);
            const entryRelative = path.relative(config.lakeRoot, entryPath).replace(/\\/g, '/');
            const entryStats = await stat(entryPath);
            const isActive = !entry.isDirectory() && activePaths.has(entryRelative);
            list.push({
              name: entry.name,
              path: entryRelative,
              isDir: entry.isDirectory(),
              isActive,
              isObsolete: !entry.isDirectory() && entry.name.endsWith('.parquet') && !isActive,
              size: entryStats.size,
              mtime: entryStats.mtime,
            });
          }
          return sendJson(res, 200, { files: list, currentPath: relativePath.replace(/\\/g, '/') });
        } catch (err) {
          if (err.code === 'ENOENT') {
            return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Directory not found' } });
          }
          throw err;
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/lake/cleanup') {
        const body = await readJson(req);
        const result = await cleanupOrphanParquetFiles({
          db,
          lakeRoot: config.lakeRoot,
          relativePath: body.path || '',
          dryRun: Boolean(body.dry_run),
        });
        return sendJson(res, 200, {
          dryRun: result.dryRun,
          deleted: result.deleted.map((file) => ({ path: file.relativePath, size: file.size })),
          kept: result.kept.length,
          bytesFreed: result.bytesFreed,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/lake/download') {
        const relativePath = url.searchParams.get('path') || '';
        if (!relativePath) {
          return sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'path parameter is required' } });
        }
        const safePath = path.resolve(config.lakeRoot, relativePath);
        if (!safePath.startsWith(config.lakeRoot)) {
          return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
        try {
          const entryStats = await stat(safePath);
          if (entryStats.isDirectory()) {
            return sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'Cannot download a directory' } });
          }
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename="${path.basename(safePath)}"`,
            'content-length': entryStats.size
          });
          const stream = createReadStream(safePath);
          stream.pipe(res);
          return;
        } catch (err) {
          if (err.code === 'ENOENT') {
            return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'File not found' } });
          }
          throw err;
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/prepare/jobs') {
        const slim = url.searchParams.get('slim') !== '0';
        return sendJson(res, 200, {
          jobs: listPrepareJobs(db, { limit: url.searchParams.get('limit'), slim }),
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/backtest/compare') {
        const ids = String(url.searchParams.get('ids') || '')
          .split(',')
          .map((v) => Number.parseInt(v.trim(), 10))
          .filter((v) => Number.isFinite(v));
        if (ids.length < 2) {
          return sendJson(res, 400, { error: { code: 'REQUEST_FAILED', message: 'ids must list at least 2 run ids' } });
        }
        return sendJson(res, 200, compareBacktestRuns(db, ids.slice(0, 4)));
      }
      if (req.method === 'GET' && url.pathname === '/api/backtest/runs') {
        return sendJson(res, 200, { runs: listBacktestRuns(db, {
          limit: url.searchParams.get('limit'),
          strategy_id: url.searchParams.get('strategy_id'),
          strategy_version_id: url.searchParams.get('strategy_version_id'),
          status: url.searchParams.get('status'),
          underlying: url.searchParams.get('underlying'),
          interval: url.searchParams.get('interval'),
          pnl: url.searchParams.get('pnl'),
          include_orphans: url.searchParams.get('include_orphans') === '1',
        }) });
      }
      const backtestRunRoute = matchBacktestRunRoute(url.pathname);
      if (backtestRunRoute) {
        const run = Number.isFinite(backtestRunRoute.runId)
          ? getBacktestRun(db, backtestRunRoute.runId, { includeEquity: false })
          : null;
        if (!run) {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Backtest run not found' } });
        }
        if (req.method === 'GET' && backtestRunRoute.kind === 'detail') {
          const full = url.searchParams.get('full') === '1';
          const slim = url.searchParams.get('slim') === '1';
          const wantEquity = url.searchParams.get('equity') === '1';
          const slimRun = getBacktestRun(db, backtestRunRoute.runId, {
            includeResult: full,
            includeEquity: wantEquity || (!full && !slim),
          });
          return sendJson(res, 200, { run: slimRun ?? run });
        }
        if (req.method === 'DELETE' && backtestRunRoute.kind === 'detail') {
          if (['running', 'queued'].includes(run.status)) {
            return sendJson(res, 400, { error: { code: 'DELETE_FAILED', message: 'Cannot delete a running or queued backtest' } });
          }
          const deleted = deleteBacktestRun(db, backtestRunRoute.runId);
          invalidateStrategyStatsCache();
          return sendJson(res, 200, { deleted: true, run: deleted });
        }
        if (req.method === 'POST' && backtestRunRoute.kind === 'cancel') {
          if (!['running', 'queued'].includes(run.status)) {
            return sendJson(res, 409, {
              error: { code: 'CANCEL_FAILED', message: `Backtest cannot be cancelled while ${run.status}` },
            });
          }
          const cancelled = cancelBacktestRun(db, backtestRunRoute.runId);
          if (!cancelled) {
            return sendJson(res, 409, {
              error: { code: 'CANCEL_FAILED', message: 'Backtest could not be cancelled' },
            });
          }
          backtestQueue.cancel(backtestRunRoute.runId);
          const worker = activeBacktestWorkers.get(backtestRunRoute.runId);
          if (worker) worker.terminate();
          onSseEvent({ type: 'run:cancelled', runId: backtestRunRoute.runId, run: cancelled });
          return sendJson(res, 200, { ok: true, run: cancelled });
        }
        if (req.method === 'GET' && backtestRunRoute.kind === 'analysis') {
          return sendJson(res, 200, { analysis: getRunAnalysis(db, backtestRunRoute.runId) });
        }
        if (req.method === 'GET' && backtestRunRoute.kind === 'events') {
          const listOpts = {
            result: url.searchParams.get('filter[result]') || url.searchParams.get('result') || undefined,
            reason: url.searchParams.get('filter[reason]') || undefined,
            q: url.searchParams.get('q') || undefined,
            sort: url.searchParams.get('sort') || undefined,
            limit: url.searchParams.get('limit') || undefined,
            offset: url.searchParams.get('offset') || undefined,
          };
          const events = listEventTraces(db, backtestRunRoute.runId, listOpts);
          if (url.searchParams.get('format') === 'csv') {
            res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
            res.end(eventsToCsv(events));
            return;
          }
          return sendJson(res, 200, { events });
        }
        if (req.method === 'GET' && backtestRunRoute.kind === 'event-detail') {
          const event = getEventTrace(db, backtestRunRoute.runId, backtestRunRoute.eventTraceId);
          return event
            ? sendJson(res, 200, { event: toEventDetailResponse(event) })
            : sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Event trace not found' } });
        }
        if (req.method === 'GET' && backtestRunRoute.kind === 'chart-data') {
          const conditionId = url.searchParams.get('condition_id');
          const eventTraceId = positiveOptionalInt(url.searchParams.get('event_id'));
          if (!conditionId && !eventTraceId) {
            return sendJson(res, 400, { error: { code: 'REQUEST_FAILED', message: 'condition_id or event_id is required' } });
          }
          const chartData = await getChartData(db, config, run, conditionId, { eventTraceId });
          return chartData
            ? sendJson(res, 200, chartData)
            : sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Event trace not found for condition_id' } });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/strategies/validate') {
        const body = await readJson(req);
        return sendJson(res, 200, { validation: validateStrategySource(body) });
      }
      if (req.method === 'GET' && url.pathname === '/api/strategy-blocks') {
        return sendJson(res, 200, { blocks: listBlockSignatures() });
      }
      if (req.method === 'GET' && url.pathname === '/api/strategies/trash') {
        if (url.searchParams.get('stats') === '1') {
          return sendJson(res, 200, { strategies: listTrashedStrategiesWithStats(db) });
        }
        return sendJson(res, 200, { strategies: listTrashedStrategies(db) });
      }
      if (req.method === 'GET' && url.pathname === '/api/strategies') {
        if (url.searchParams.get('picker') === '1') {
          return sendJson(res, 200, { options: listStrategiesForPicker(db) });
        }
        if (url.searchParams.get('stats') === '1') {
          return sendJson(res, 200, { strategies: listStrategiesWithStats(db) });
        }
        return sendJson(res, 200, { strategies: listSavedStrategies(db) });
      }
      if (req.method === 'POST' && url.pathname === '/api/strategies') {
        const body = await readJson(req);
        const strategy = createStrategy(db, body);
        return sendJson(res, 200, { strategy });
      }
      const strategyRoute = matchStrategyRoute(url.pathname);
      if (strategyRoute) {
        if (req.method === 'GET' && strategyRoute.kind === 'detail') {
          const strategy = getStrategy(db, strategyRoute.strategyId);
          return strategy
            ? sendJson(res, 200, { strategy })
            : sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Strategy not found' } });
        }
        if (req.method === 'PATCH' && strategyRoute.kind === 'detail') {
          const body = await readJson(req);
          const strategy = updateStrategy(db, strategyRoute.strategyId, body);
          return strategy
            ? sendJson(res, 200, { strategy })
            : sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Strategy not found' } });
        }
        if (req.method === 'DELETE' && strategyRoute.kind === 'detail') {
          const strategy = trashStrategy(db, strategyRoute.strategyId);
          return strategy
            ? sendJson(res, 200, { trashed: true, strategy })
            : sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Strategy not found' } });
        }
        if (req.method === 'POST' && strategyRoute.kind === 'restore') {
          const strategy = restoreStrategy(db, strategyRoute.strategyId);
          return strategy
            ? sendJson(res, 200, { restored: true, strategy })
            : sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Strategy not found in trash' } });
        }
        if (req.method === 'DELETE' && strategyRoute.kind === 'permanent') {
          const deleteRuns = url.searchParams.get('delete_runs') === '1' || url.searchParams.get('delete_runs') === 'true';
          try {
            const strategy = permanentlyDeleteStrategy(db, strategyRoute.strategyId, { deleteRuns });
            return strategy
              ? sendJson(res, 200, { deleted: true, strategy, delete_runs: deleteRuns })
              : sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Strategy not found in trash' } });
          } catch (err) {
            return sendJson(res, 400, { error: { code: 'REQUEST_FAILED', message: err.message } });
          }
        }
        if (req.method === 'GET' && strategyRoute.kind === 'stats') {
          const strategy = getStrategy(db, strategyRoute.strategyId);
          if (!strategy) {
            return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Strategy not found' } });
          }
          return sendJson(res, 200, { stats: getStrategyStats(db, strategyRoute.strategyId) });
        }
        if (req.method === 'POST' && strategyRoute.kind === 'fork') {
          try {
            const body = await readJson(req);
            const strategy = forkStrategy(db, strategyRoute.strategyId, body);
            return strategy
              ? sendJson(res, 200, { strategy })
              : sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Strategy not found' } });
          } catch (err) {
            return sendJson(res, 400, { error: { code: 'REQUEST_FAILED', message: err.message } });
          }
        }
        if (req.method === 'GET' && strategyRoute.kind === 'versions') {
          const strategy = getStrategy(db, strategyRoute.strategyId);
          if (!strategy) {
            return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Strategy not found' } });
          }
          return sendJson(res, 200, { versions: listStrategyVersions(db, strategyRoute.strategyId) });
        }
        if (req.method === 'POST' && strategyRoute.kind === 'versions') {
          const strategy = getStrategy(db, strategyRoute.strategyId);
          if (!strategy) {
            return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Strategy not found' } });
          }
          const body = await readJson(req);
          const version = createStrategyVersion(db, strategyRoute.strategyId, body);
          return sendJson(res, 200, { version });
        }
        if (req.method === 'GET' && strategyRoute.kind === 'version-detail') {
          const version = getStrategyVersion(db, strategyRoute.strategyId, strategyRoute.versionId);
          return version
            ? sendJson(res, 200, { version })
            : sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Strategy version not found' } });
        }
        if (req.method === 'DELETE' && strategyRoute.kind === 'version-detail') {
          const strategy = getStrategy(db, strategyRoute.strategyId);
          if (!strategy) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Strategy not found' } });
          const deleteRuns = url.searchParams.get('delete_runs') === '1' || url.searchParams.get('delete_runs') === 'true';
          try {
            const version = deleteStrategyVersion(db, strategyRoute.strategyId, strategyRoute.versionId, { deleteRuns });
            return version
              ? sendJson(res, 200, { deleted: true, version })
              : sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Strategy version not found' } });
          } catch (err) {
            return sendJson(res, 400, { error: { code: 'DELETE_FAILED', message: err.message } });
          }
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/backtest/run') {
        const body = await readJson(req);
        const startedAt = Date.now();
        let request;
        try {
          request = backtestRequestFromBody(body, config, db);
        } catch (err) {
          return sendJson(res, 400, { error: { code: 'REQUEST_FAILED', message: err.message } });
        }
        const dataRequest = availabilityRequestForBacktest(
          request,
          request.columnAnalysis ?? (request.glsAst ? analyzeStrategyColumns(request.glsAst, request.bookDepth ?? 25) : null),
        );
        const strict = resolveDataRequest(db, dataRequest, 'strict');
        if (!strict.ready) {
          const prepare = resolveDataRequest(db, dataRequest, 'prepare');
          return sendJson(res, 409, {
            error: {
              code: 'DATA_NOT_READY',
              message: 'Backtest data is not ready for strict execution',
            },
            availability: strict.availability,
            preparation: prepare.preparation,
          });
        }
        const estimatedTicks = estimateTicks(strict.availability);
        request.estimatedTicks = estimatedTicks;
        const enqueueParams = {
          request,
          strategyMeta: request.strategyMeta ?? null,
          totalTicks: estimatedTicks,
          startedAt,
          dependsOnJob: body.depends_on_job ?? body.wait_for_job ?? null,
        };

        if (body.async === false) {
          try {
            const run = await backtestQueue.enqueueAndWait(enqueueParams);
            const fullRun = getBacktestRun(db, run.id, { includeResult: true, includeEquity: false });
            const result = fullRun?.result;
            if (['failed', 'failed_runtime', 'partial'].includes(fullRun?.status)) {
              return sendJson(res, 500, {
                error: { code: 'REQUEST_FAILED', message: fullRun?.error || 'backtest failed' },
                run: fullRun,
              });
            }
            return sendJson(res, 200, {
              run: fullRun,
              result: result ? {
                strategy: result.strategy,
                ticks: result.ticks,
                batches: result.batches,
                summary: result.summary,
              } : null,
            });
          } catch (err) {
            return sendJson(res, 500, { error: { code: 'REQUEST_FAILED', message: err.message } });
          }
        }

        const run = backtestQueue.enqueue(enqueueParams);
        return sendJson(res, 202, { run, queuePosition: run.queuePosition ?? null });
      }
      if (req.method === 'POST' && url.pathname === '/api/backtest/sweep') {
        const body = await readJson(req);
        let request;
        let variants;
        try {
          request = backtestRequestFromBody(body, config, db);
          variants = parseSweepVariants(body, config.sweepMaxVariants);
        } catch (err) {
          return sendJson(res, 400, { error: { code: 'REQUEST_FAILED', message: err.message } });
        }
        const dataRequest = availabilityRequestForBacktest(
          request,
          request.columnAnalysis ?? analyzeStrategyColumns(request.glsAst, request.bookDepth ?? 25),
        );
        const strict = resolveDataRequest(db, dataRequest, 'strict');
        if (!strict.ready) {
          const prepare = resolveDataRequest(db, dataRequest, 'prepare');
          return sendJson(res, 409, {
            error: {
              code: 'DATA_NOT_READY',
              message: 'Backtest data is not ready for strict execution',
            },
            availability: strict.availability,
            preparation: prepare.preparation,
          });
        }
        try {
          const sweep = await runSweepInWorker(config, request, variants);
          return sendJson(res, 200, { sweep });
        } catch (err) {
          return sendJson(res, 500, { error: { code: 'SWEEP_FAILED', message: err.message } });
        }
      }
      const prepareJobRoute = matchPrepareJobRoute(url.pathname);
      if (prepareJobRoute) {
        const job = getPrepareJob(db, prepareJobRoute.jobId);
        if (!job) {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Job not found' } });
        }
        if (req.method === 'GET' && prepareJobRoute.kind === 'detail') {
          return sendJson(res, 200, { job });
        }
        if (req.method === 'POST' && prepareJobRoute.kind === 'cancel') {
          const result = resolvedPrepareRunner.cancel(prepareJobRoute.jobId);
          if (!result.ok) {
            return sendJson(res, 409, {
              error: {
                code: 'CANCEL_FAILED',
                message: result.reason === 'not_found' ? 'Job not found' : `Job cannot be cancelled while ${result.status}`,
              },
            });
          }
          if (result.status === 'cancelled') {
            finishAssetUpdateRunByJobId(db, prepareJobRoute.jobId, 'cancelled', 'job cancelled');
          }
          const updated = getPrepareJob(db, prepareJobRoute.jobId);
          return sendJson(res, 200, { ok: true, status: result.status, job: updated });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/prepare/run') {
        const body = await readJson(req);
        const request = datasetRequestFromObject(body.request || body, config);
        const dryRun = body.dry_run !== false;
        if (!dryRun && request.rebuild && body.confirm_rebuild !== 'REBUILD_PARTITIONS') {
          return sendJson(res, 400, {
            error: {
              code: 'CONFIRMATION_REQUIRED',
              message: 'confirm_rebuild must be REBUILD_PARTITIONS for real rebuild jobs',
            },
          });
        }
        const job = resolvedPrepareRunner.enqueue({
          request,
          mode: body.mode || 'prepare',
          dryRun,
        });
        return sendJson(res, 202, { job });
      }
      if (req.method === 'GET') {
        const staticResponse = await tryServeStatic(pathname, req, res);
        if (staticResponse) return staticResponse;
      }
      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    } catch (err) {
      return sendJson(res, statusForError(err), { error: { code: 'REQUEST_FAILED', message: err.message } });
    }
  };
}

export function createApiServer(deps) {
  const authMiddleware = createAuthMiddleware({
    authService: deps.authService,
    config: deps.config,
  });
  return http.createServer(createApiHandler({ ...deps, authMiddleware }));
}

async function serveStaticFile(relative, req, res) {
  return serveStaticAsset(relative, req, res);
}

async function tryServeStatic(urlPath, req, res) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  return serveStaticAsset(relative, req, res);
}

const assetCache = new Map();

async function serveStaticAsset(relative, req, res) {
  if (!isSafePublicRelative(relative)) return false;

  let asset;
  try {
    asset = await loadVersionedAsset(relative);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }

  const { isHtml, version, contentType, versionedBuffer: body } = asset;
  const requestedVersion = new URL(req.url || '/', 'http://localhost').searchParams.get(VERSION_PARAM);
  const etag = version ? `"${version}"` : null;
  const headers = {
    'content-type': contentType,
    'cache-control': cacheControlForAsset({ isHtml, version, requestedVersion }),
  };

  if (etag) headers.etag = etag;

  if (!isHtml && req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  res.end(body);
  return true;
}

function cacheControlForAsset({ isHtml, version, requestedVersion }) {
  if (isHtml) return NO_STORE;
  return version && requestedVersion === version ? IMMUTABLE : REVALIDATE;
}

/**
 * Resolve (and version) a static asset, caching the result in module scope.
 * The cached entry is reused while the asset and every transitive dependency
 * keep the same mtime, avoiding per-request file reads and SHA-256 hashing.
 */
async function loadVersionedAsset(relative) {
  const normalized = toPublicRelative(relative);
  const selfMtime = await fileMtimeMs(normalized);
  const cached = assetCache.get(normalized);
  if (cached && cached.selfMtime === selfMtime && await depsFresh(cached.deps)) {
    return cached;
  }

  const memo = new Map();
  const deps = new Map();
  const built = await resolveVersionedAsset(normalized, memo, deps, new Set());
  const extension = path.posix.extname(normalized);
  const isHtml = extension === '.html';
  const entry = {
    isHtml,
    contentType: STATIC_TYPES.get(extension) || 'application/octet-stream',
    version: isHtml ? null : built.version,
    versionedBuffer: built.versionedBuffer,
    selfMtime,
    deps: [...deps.entries()],
  };
  assetCache.set(normalized, entry);
  return entry;
}

async function fileMtimeMs(normalized) {
  const stats = await stat(publicFilePath(normalized));
  return stats.mtimeMs;
}

async function depsFresh(deps) {
  for (const [depPath, depMtime] of deps) {
    let current;
    try {
      current = await fileMtimeMs(depPath);
    } catch {
      return false;
    }
    if (current !== depMtime) return false;
  }
  return true;
}

async function resolveVersionedAsset(normalized, memo, deps, stack) {
  const cached = memo.get(normalized);
  if (cached) return cached;

  const stats = await stat(publicFilePath(normalized));
  deps.set(normalized, stats.mtimeMs);
  const body = await readFile(publicFilePath(normalized));

  if (stack.has(normalized)) {
    return { version: hashBuffer(body), versionedBuffer: body };
  }
  stack.add(normalized);

  const extension = path.posix.extname(normalized);
  let versionedBuffer;
  if (extension === '.html') {
    versionedBuffer = Buffer.from(await versionHtml(body.toString('utf8'), memo, deps, stack), 'utf8');
  } else if (extension === '.js') {
    versionedBuffer = Buffer.from(await versionJsModule(normalized, body.toString('utf8'), memo, deps, stack), 'utf8');
  } else {
    versionedBuffer = body;
  }

  stack.delete(normalized);
  const result = { version: hashBuffer(versionedBuffer), versionedBuffer };
  memo.set(normalized, result);
  return result;
}

async function versionHtml(html, memo, deps, stack) {
  return replaceAsync(html, /\b(href|src)=(['"])(\/[^'"?#]+)(?:\?[^'"]*)?\2/g, async (match, attr, quote, urlPath) => {
    const versioned = await versionedAbsoluteUrl(urlPath, memo, deps, stack);
    return versioned ? `${attr}=${quote}${versioned}${quote}` : match;
  });
}

async function versionJsModule(relative, source, memo, deps, stack) {
  return replaceAsync(source, /\b(from\s+['"]|import\s*['"])(\.{1,2}\/[^'"]+)(['"])/g, async (match, prefix, specifier, suffix) => {
    const [specifierPath] = specifier.split('?');
    if (path.posix.extname(specifierPath) !== '.js') return match;

    const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifierPath));
    if (!isSafePublicRelative(dependency)) return match;

    const { version } = await resolveVersionedAsset(dependency, memo, deps, stack);
    return `${prefix}${specifierPath}?${VERSION_PARAM}=${version}${suffix}`;
  });
}

async function versionedAbsoluteUrl(urlPath, memo, deps, stack) {
  const relative = urlPath.replace(/^\/+/, '');
  if (!isSafePublicRelative(relative)) return null;
  if (!STATIC_TYPES.has(path.posix.extname(relative))) return null;

  try {
    const { version } = await resolveVersionedAsset(toPublicRelative(relative), memo, deps, stack);
    return `${urlPath}?${VERSION_PARAM}=${version}`;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function replaceAsync(value, regex, replacer) {
  const matches = [...value.matchAll(regex)];
  let result = '';
  let offset = 0;

  for (const match of matches) {
    const replacement = await replacer(...match);
    result += value.slice(offset, match.index) + replacement;
    offset = match.index + match[0].length;
  }

  return result + value.slice(offset);
}

function hashBuffer(body) {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

function publicFilePath(relative) {
  return path.resolve(PUBLIC_DIR, toPublicRelative(relative));
}

function toPublicRelative(relative) {
  return relative.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isSafePublicRelative(relative) {
  const normalized = toPublicRelative(relative);
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) return false;
  const filePath = publicFilePath(normalized);
  return filePath === PUBLIC_DIR || filePath.startsWith(`${PUBLIC_DIR}${path.sep}`);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function statusForError(err) {
  if (err instanceof SyntaxError) return 400;
  if (/required|Invalid|must be|Unsupported|JSON|Cannot|unchanged/.test(err.message || '')) return 400;
  return 500;
}

function backtestRequestFromBody(body, config, db) {
  const dataRequest = datasetRequestFromObject({ dataset: 'backtest_ticks', ...body }, config);
  const base = {
    ...dataRequest,
    batchSize: positiveIntValue(body.batch_size ?? body.batchSize, 10_000),
    params: parseParams(body.params),
    fastRun: body.fast_run === true || body.fastRun === true,
    variantWorkers: positiveOptionalInt(body.variant_workers ?? body.variantWorkers),
  };

  const strategyId = positiveOptionalInt(body.strategy_id);
  const strategyVersionId = positiveOptionalInt(body.strategy_version_id);
  if (!strategyId || !strategyVersionId) {
    throw new Error('strategy_id and strategy_version_id are required');
  }

  const strategy = getStrategy(db, strategyId);
  if (!strategy) throw new Error('Strategy not found');
  const version = getStrategyVersion(db, strategyId, strategyVersionId);
  if (!version) throw new Error('Strategy version not found');
  if (!version.validation?.ok) throw new Error('Strategy version failed validation');
  const glsAst = parse(version.source_code);
  const columnAnalysis = analyzeStrategyColumns(glsAst, dataRequest.bookDepth ?? 25);
  const glsExecution = normalizeOptionalGlsExecution(body.gls_execution ?? body.glsExecution);
  return {
    ...base,
    feeOptions: {
      category: body.polymarketFeeCategory || body.feeCategory,
      feeRate: body.polymarketFeeRate ?? body.feeRate,
      enabled: body.applyPolymarketFees !== false,
    },
    strategy: `gls:${strategy.slug}`,
    strategyLabel: version.source_code.match(/strategy\s+"([^"]+)"/)?.[1] || strategy.name,
    glsAst,
    columnAnalysis,
    glsExecution,
    strategyMeta: {
      strategy_id: strategyId,
      strategy_version_id: strategyVersionId,
      slug: strategy.slug,
      name: strategy.name,
      version: version.version,
      language: version.language,
      source_code: version.source_code,
      params_schema: version.params_schema,
      checksum: version.checksum,
    },
  };
}

function normalizeOptionalGlsExecution(value) {
  if (value == null || value === '') return undefined;
  const mode = String(value).trim().toLowerCase();
  if (mode === 'compiled' || mode === 'interpreter' || mode === 'compiled-soa') return mode;
  throw new Error('gls_execution must be compiled, compiled-soa, or interpreter');
}

function runSweepInWorker(config, request, variants) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../backtest/sweepWorker.js', import.meta.url), {
      workerData: {
        stateDbPath: config.stateDbPath,
        request,
        variants,
      },
    });
    worker.on('message', (msg) => {
      if (msg?.ok) resolve(msg.sweep);
      else reject(new Error(msg?.error || 'sweep failed'));
    });
    worker.on('error', reject);
    worker.unref();
  });
}

function startBacktestWorker({ config, db, runId, request, startedAt, activeBacktestWorkers }) {
  const worker = new Worker(new URL('../backtest/worker.js', import.meta.url), {
    workerData: {
      stateDbPath: config.stateDbPath,
      runId,
      request,
      startedAt,
      fastRun: Boolean(request.fastRun),
    },
  });
  activeBacktestWorkers?.set(runId, worker);
  worker.on('error', (err) => {
    const failedResult = {
      strategy: request.strategyLabel || request.strategy,
      source: 'lakehouse',
      underlying: request.underlying,
      interval: request.interval,
      bookDepth: request.bookDepth,
      from: new Date(request.from).toISOString(),
      to: new Date(request.to).toISOString(),
      ticks: 0,
      batches: 0,
      summary: { failed: true, error: err.message },
      events: [],
      equity: [],
      log: [],
    };
    failBacktestRun(db, runId, {
      request,
      result: failedResult,
      strategyMeta: request.strategyMeta ?? null,
      error: err.message,
      startedAt,
    });
  });
  worker.on('exit', () => activeBacktestWorkers?.delete(runId));
  worker.unref();
  return worker;
}

function estimateTicks(availability) {
  const rows = availability?.partitions || [];
  const total = rows
    .filter((partition) => partition.usable)
    .reduce((sum, partition) => sum + Number(partition.rows || 0), 0);
  return total > 0 ? total : null;
}

function manifestPartitionFromBody(body) {
  return {
    dataset: String(body.dataset || '').trim(),
    marketId: body.market_id ?? body.marketId ?? null,
    underlying: String(body.underlying || '').trim().toUpperCase(),
    interval: String(body.interval || '').trim(),
    resolution: body.resolution || null,
    bookDepth: positiveOptionalInt(body.book_depth ?? body.bookDepth),
    dt: String(body.dt || '').trim(),
  };
}

function manifestActionError(result) {
  if (result.reason === 'not_found') return 'Partition not found in manifest';
  if (result.reason === 'missing_active_path') return 'Partition has no active parquet file to accept';
  if (result.reason === 'unsupported_status') return `Partition status ${result.status} cannot be changed by this action`;
  return result.reason || 'Manifest action failed';
}

function positiveOptionalInt(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('strategy_id and strategy_version_id must be positive integers');
  return parsed;
}

function positiveIntValue(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('batch_size must be a positive integer');
  return parsed;
}

function parseParams(value) {
  if (value == null || value === '') return {};
  if (typeof value === 'string') return JSON.parse(value);
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  throw new Error('params must be a JSON object');
}

function matchPrepareJobRoute(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 4 || parts[0] !== 'api' || parts[1] !== 'prepare' || parts[2] !== 'jobs') return null;
  const jobId = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(jobId)) return null;
  if (parts.length === 4) return { kind: 'detail', jobId };
  if (parts.length === 5 && parts[4] === 'cancel') return { kind: 'cancel', jobId };
  return null;
}

function matchAssetUpdateScheduleRoute(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 4 || parts[0] !== 'api' || parts[1] !== 'settings' || parts[2] !== 'asset-update-schedules') return null;
  const scheduleId = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(scheduleId)) return null;
  if (parts.length === 4) return { kind: 'detail', scheduleId };
  if (parts.length === 5 && parts[4] === 'run') return { kind: 'run', scheduleId };
  return null;
}

function matchTelegramBackupRunRoute(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 5 && parts[0] === 'api' && parts[1] === 'backup' && parts[2] === 'telegram' && parts[3] === 'runs') {
    return { kind: 'detail', runId: parts[4] };
  }
  return null;
}

function matchBacktestRunRoute(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 4 || parts[0] !== 'api' || parts[1] !== 'backtest' || parts[2] !== 'runs') return null;
  const runId = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(runId)) return null;
  if (parts.length === 4) return { kind: 'detail', runId };
  if (parts.length === 5 && parts[4] === 'cancel') return { kind: 'cancel', runId };
  if (parts[4] === 'events' && parts.length === 5) return { kind: 'events', runId };
  if (parts[4] === 'events' && parts.length === 6) {
    const eventTraceId = Number.parseInt(parts[5], 10);
    return Number.isFinite(eventTraceId) ? { kind: 'event-detail', runId, eventTraceId } : null;
  }
  if (parts[4] === 'chart-data' && parts.length === 5) return { kind: 'chart-data', runId };
  if (parts[4] === 'analysis' && parts.length === 5) return { kind: 'analysis', runId };
  return null;
}

function eventsToCsv(events) {
  const header = 'id,event_start,side,quantity,cost,final_pnl,entry_distance_ptb,entry_time_remaining,result,reason,condition_id';
  const rows = (events || []).map((e) => [
    e.id,
    e.event_start,
    e.side ?? '',
    e.quantity ?? '',
    e.cost ?? '',
    e.final_pnl,
    e.entry_distance_ptb ?? '',
    e.entry_time_remaining ?? '',
    e.result ?? '',
    e.reason ?? '',
    e.condition_id,
  ].map(csvEscape).join(','));
  return `${header}\n${rows.join('\n')}\n`;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

function matchStrategyRoute(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 3 || parts[0] !== 'api' || parts[1] !== 'strategies') return null;
  if (parts[2] === 'validate') return null;
  const strategyId = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(strategyId)) return null;
  if (parts.length === 3) return { kind: 'detail', strategyId };
  if (parts[3] === 'stats' && parts.length === 4) return { kind: 'stats', strategyId };
  if (parts[3] === 'restore' && parts.length === 4) return { kind: 'restore', strategyId };
  if (parts[3] === 'permanent' && parts.length === 4) return { kind: 'permanent', strategyId };
  if (parts[3] === 'fork' && parts.length === 4) return { kind: 'fork', strategyId };
  if (parts[3] === 'versions' && parts.length === 4) return { kind: 'versions', strategyId };
  if (parts[3] === 'versions' && parts.length === 5) {
    const versionId = Number.parseInt(parts[4], 10);
    return Number.isFinite(versionId) ? { kind: 'version-detail', strategyId, versionId } : null;
  }
  return null;
}

function toEventDetailResponse(event) {
  return event;
}
