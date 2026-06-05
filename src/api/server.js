import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getHealth } from '../health.js';
import { listManifest, manifestStats } from '../state/manifest.js';
import { getPrepareJob, listPrepareJobs } from '../state/prepareJobs.js';
import { checkDatasetAvailability } from '../query/availability.js';
import { resolveDataRequest } from '../query/dataMode.js';
import { datasetRequestFromObject, datasetRequestFromParams } from '../query/request.js';
import { createPrepareJobRunner } from '../prepare/runner.js';
import { listStrategies, runBacktest } from '../backtest/engine.js';
import { createBacktestRun, listBacktestRuns } from '../state/backtestRuns.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const STATIC_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
]);

export function createApiHandler({ config, db, prepareRunner = createPrepareJobRunner({ config, db }) }) {
  return async function handleRequest(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(res, 200, await getHealth(config, db));
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
      if (req.method === 'GET' && url.pathname === '/api/backtest/strategies') {
        return sendJson(res, 200, { strategies: listStrategies() });
      }
      if (req.method === 'GET' && url.pathname === '/api/backtest/runs') {
        return sendJson(res, 200, { runs: listBacktestRuns(db, { limit: url.searchParams.get('limit') }) });
      }
      if (req.method === 'POST' && url.pathname === '/api/backtest/run') {
        const body = await readJson(req);
        const request = backtestRequestFromBody(body, config);
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
        const result = await runBacktest(db, request);
        const run = createBacktestRun(db, { request, result });
        return sendJson(res, 200, { run, result });
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
        const staticResponse = await tryServeStatic(url.pathname, res);
        if (staticResponse) return staticResponse;
      }
      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    } catch (err) {
      return sendJson(res, statusForError(err), { error: { code: 'REQUEST_FAILED', message: err.message } });
    }
  };
}

export function createApiServer(deps) {
  return http.createServer(createApiHandler(deps));
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
  if (/required|Invalid|must be|Unsupported|JSON/.test(err.message || '')) return 400;
  return 500;
}

function backtestRequestFromBody(body, config) {
  const dataRequest = datasetRequestFromObject({ dataset: 'backtest_ticks', ...body }, config);
  return {
    ...dataRequest,
    strategy: body.strategy ? String(body.strategy) : 'edge-sniper-v2',
    batchSize: positiveIntValue(body.batch_size ?? body.batchSize, 5000),
    params: parseParams(body.params),
  };
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
