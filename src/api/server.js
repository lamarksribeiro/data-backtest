import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAuthMiddleware } from '../middleware/auth.js';
import { getHealth } from '../health.js';
import { listBacktestContextOptions, listManifest, manifestStats } from '../state/manifest.js';
import { emptyContextOptions, mergeContextOptions } from '../state/contextOptions.js';
import { closeSourcePool, createSourcePool, listSourceContextOptions } from '../source/postgres.js';
import { getPrepareJob, listPrepareJobs } from '../state/prepareJobs.js';
import { checkDatasetAvailability } from '../query/availability.js';
import { resolveDataRequest } from '../query/dataMode.js';
import { datasetRequestFromObject, datasetRequestFromParams } from '../query/request.js';
import { createPrepareJobRunner } from '../prepare/runner.js';
import { runBacktest } from '../backtest/engine.js';
import { createBacktestRun, getBacktestRun, listBacktestRuns } from '../state/backtestRuns.js';
import { getChartData, getEventTrace, listEventTraces } from '../backtestStudio/state/eventTraces.js';
import {
  createStrategy,
  createStrategyVersion,
  deleteStrategy,
  deleteStrategyVersion,
  getStrategy,
  getStrategyVersion,
  listStrategies as listSavedStrategies,
  listStrategyVersions,
  updateStrategy,
  validateStrategySource,
} from '../backtestStudio/state/strategies.js';
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

export function createApiHandler(deps) {
  const {
    config,
    db,
    authService,
    prepareRunner = createPrepareJobRunner({ config, db }),
  } = deps;
  const authMiddleware = deps.authMiddleware || createAuthMiddleware({ authService, config });

  return async function handleRequest(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/healthz') {
        return sendJson(res, 200, await getHealth(config, db));
      }

      if (req.method === 'GET' && pathname === '/login') {
        return serveStaticFile('login.html', res);
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

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const allowed = await authMiddleware.requirePageAuth(req, res);
        if (!allowed) return;
        return serveStaticFile('index.html', res);
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
      if (req.method === 'GET' && url.pathname === '/api/context-options') {
        const lake = listBacktestContextOptions(db);
        let source = emptyContextOptions();
        if (config.dataCollectorDatabaseUrl) {
          const pool = createSourcePool(config);
          try {
            source = await listSourceContextOptions(pool, config);
          } catch (error) {
            console.warn('[context-options] source query failed:', error.message);
          } finally {
            await closeSourcePool(pool);
          }
        }
        return sendJson(res, 200, { options: mergeContextOptions(lake, source, config) });
      }
      if (req.method === 'GET' && url.pathname === '/api/availability') {
        const request = datasetRequestFromParams(url.searchParams, config);
        return sendJson(res, 200, { availability: checkDatasetAvailability(db, request) });
      }
      if (req.method === 'GET' && url.pathname === '/api/prepare') {
        const request = datasetRequestFromParams(url.searchParams, config);
        const mode = url.searchParams.get('mode') || 'prepare';
        return sendJson(res, 200, { result: resolveDataRequest(db, request, mode) });
      }
      if (req.method === 'GET' && url.pathname === '/api/prepare/jobs') {
        return sendJson(res, 200, { jobs: listPrepareJobs(db, { limit: url.searchParams.get('limit') }) });
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
        }) });
      }
      const backtestRunRoute = matchBacktestRunRoute(url.pathname);
      if (backtestRunRoute) {
        const run = Number.isFinite(backtestRunRoute.runId) ? getBacktestRun(db, backtestRunRoute.runId) : null;
        if (!run) {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Backtest run not found' } });
        }
        if (req.method === 'GET' && backtestRunRoute.kind === 'detail') {
          return sendJson(res, 200, { run });
        }
        if (req.method === 'GET' && backtestRunRoute.kind === 'events') {
          return sendJson(res, 200, {
            events: listEventTraces(db, backtestRunRoute.runId, {
              result: url.searchParams.get('result') || undefined,
              limit: url.searchParams.get('limit') || undefined,
              offset: url.searchParams.get('offset') || undefined,
            }),
          });
        }
        if (req.method === 'GET' && backtestRunRoute.kind === 'event-detail') {
          const event = getEventTrace(db, backtestRunRoute.runId, backtestRunRoute.eventTraceId);
          return event
            ? sendJson(res, 200, { event: toEventDetailResponse(event) })
            : sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Event trace not found' } });
        }
        if (req.method === 'GET' && backtestRunRoute.kind === 'chart-data') {
          const conditionId = url.searchParams.get('condition_id');
          if (!conditionId) {
            return sendJson(res, 400, { error: { code: 'REQUEST_FAILED', message: 'condition_id is required' } });
          }
          const chartData = await getChartData(db, config, run, conditionId);
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
      if (req.method === 'GET' && url.pathname === '/api/strategies') {
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
          const strategy = deleteStrategy(db, strategyRoute.strategyId);
          return strategy
            ? sendJson(res, 200, { deleted: true, strategy })
            : sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Strategy not found' } });
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
          const version = deleteStrategyVersion(db, strategyRoute.strategyId, strategyRoute.versionId);
          return version
            ? sendJson(res, 200, { deleted: true, version })
            : sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Strategy version not found' } });
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
        const strict = resolveDataRequest(db, request, 'strict');
        if (!strict.ready) {
          const prepare = resolveDataRequest(db, request, 'prepare');
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
          const result = await runBacktest(db, request);
          const run = createBacktestRun(db, {
            request,
            result,
            strategyMeta: request.strategyMeta ?? null,
            durationMs: Date.now() - startedAt,
          });
          return sendJson(res, 200, { run, result });
        } catch (err) {
          const run = createBacktestRun(db, {
            request,
            result: {
              strategy: request.strategyLabel || request.strategy,
              source: 'lakehouse',
              underlying: request.underlying,
              interval: request.interval,
              bookDepth: request.bookDepth,
              from: new Date(request.from).toISOString(),
              to: new Date(request.to).toISOString(),
              ticks: 0,
              batches: 0,
              summary: {},
              events: [],
              equity: [],
              log: [],
            },
            strategyMeta: request.strategyMeta ?? null,
            status: 'failed_runtime',
            error: err.message,
            durationMs: Date.now() - startedAt,
          });
          return sendJson(res, 500, { error: { code: 'REQUEST_FAILED', message: err.message }, run });
        }
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/prepare/jobs/')) {
        const id = Number.parseInt(url.pathname.split('/').at(-1), 10);
        const job = Number.isFinite(id) ? getPrepareJob(db, id) : null;
        return job
          ? sendJson(res, 200, { job })
          : sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Job not found' } });
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
        const job = prepareRunner.enqueue({
          request,
          mode: body.mode || 'prepare',
          dryRun,
        });
        return sendJson(res, 202, { job });
      }
      if (req.method === 'GET') {
        const staticResponse = await tryServeStatic(pathname, res);
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

async function serveStaticFile(relative, res) {
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR)) return false;
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': STATIC_TYPES.get(path.extname(filePath)) || 'application/octet-stream',
      'content-length': body.length,
    });
    res.end(body);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function tryServeStatic(urlPath, res) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (!relative || relative.includes('..')) return false;
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR)) return false;

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': STATIC_TYPES.get(path.extname(filePath)) || 'application/octet-stream',
      'content-length': body.length,
    });
    res.end(body);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
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
    batchSize: positiveIntValue(body.batch_size ?? body.batchSize, 5000),
    params: parseParams(body.params),
  };

  const strategyId = positiveOptionalInt(body.strategy_id);
  const strategyVersionId = positiveOptionalInt(body.strategy_version_id);
  if (!strategyId || !strategyVersionId) {
    throw new Error('strategy_id and strategy_version_id are required');
  }

  if (strategyId && strategyVersionId) {
    const strategy = getStrategy(db, strategyId);
    if (!strategy) throw new Error('Strategy not found');
    const version = getStrategyVersion(db, strategyId, strategyVersionId);
    if (!version) throw new Error('Strategy version not found');
    if (!version.validation?.ok) throw new Error('Strategy version failed validation');
    return {
      ...base,
      strategy: `gls:${strategy.slug}`,
      strategyLabel: version.source_code.match(/strategy\s+"([^"]+)"/)?.[1] || strategy.name,
      glsAst: parse(version.source_code),
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

function matchBacktestRunRoute(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 4 || parts[0] !== 'api' || parts[1] !== 'backtest' || parts[2] !== 'runs') return null;
  const runId = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(runId)) return null;
  if (parts.length === 4) return { kind: 'detail', runId };
  if (parts[4] === 'events' && parts.length === 5) return { kind: 'events', runId };
  if (parts[4] === 'events' && parts.length === 6) {
    const eventTraceId = Number.parseInt(parts[5], 10);
    return Number.isFinite(eventTraceId) ? { kind: 'event-detail', runId, eventTraceId } : null;
  }
  if (parts[4] === 'chart-data' && parts.length === 5) return { kind: 'chart-data', runId };
  return null;
}

function matchStrategyRoute(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 3 || parts[0] !== 'api' || parts[1] !== 'strategies') return null;
  if (parts[2] === 'validate') return null;
  const strategyId = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(strategyId)) return null;
  if (parts.length === 3) return { kind: 'detail', strategyId };
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
