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
        const job = prepareRunner.enqueue({
          request,
          mode: body.mode || 'prepare',
          dryRun: body.dry_run !== false,
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
