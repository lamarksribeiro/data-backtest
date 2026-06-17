import { persistEventTraces, mergeResultIntoEventTraces } from '../backtestStudio/state/eventTraces.js';
import { invalidateStrategyStatsCache } from '../backtestStudio/state/strategyStats.js';
import { downsamplePoints } from '../utils/downsample.js';

export function createBacktestRun(db, { request, result, strategyMeta = null, status = 'completed', error = null, durationMs = null, startedAt = null }) {
  const meta = strategyMeta ?? result?.strategyMeta ?? null;
  const storageStartedAt = Date.now();
  result.summary = {
    ...(result.summary || {}),
    timings: {
      ...(result.summary?.timings || result.timings || {}),
      sqliteWriteMs: null,
    },
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    const inserted = db.prepare(`
      INSERT INTO backtest_runs (
        strategy, source, underlying, interval, book_depth, from_ts, to_ts, batch_size,
        params_json, ticks, batches, summary_json, result_json,
        strategy_id, strategy_version_id, strategy_snapshot_json, dataset_request_json,
        status, error, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.strategy,
      result.source,
      result.underlying,
      result.interval,
      result.bookDepth ?? null,
      result.from,
      result.to,
      request.batchSize,
      JSON.stringify(request.params ?? {}),
      result.ticks,
      result.batches,
      JSON.stringify(result.summary ?? {}),
      JSON.stringify(slimResultForStorage(result)),
      meta?.strategy_id ?? null,
      meta?.strategy_version_id ?? null,
      meta ? JSON.stringify(meta) : null,
      JSON.stringify(stripRequestForSnapshot(request)),
      status,
      error,
      durationMs,
    );
    const runId = inserted.lastInsertRowid;
    persistEventTraces(db, runId, result, { transaction: false });
    result.summary.timings.sqliteWriteMs = Date.now() - storageStartedAt;
    const finalDurationMs = durationMs ?? (startedAt ? Date.now() - startedAt : null);
    db.prepare(`
      UPDATE backtest_runs
      SET summary_json = ?, result_json = ?, duration_ms = ?
      WHERE id = ?
    `).run(
      JSON.stringify(result.summary ?? {}),
      JSON.stringify(slimResultForStorage(result)),
      finalDurationMs,
      runId,
    );
    db.exec('COMMIT');
    if (status === 'completed') invalidateStrategyStatsCache();
    return getBacktestRun(db, runId, { includeResult: false, includeEquity: false });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function createQueuedBacktestRun(db, { request, strategyMeta = null, totalTicks = null, dependsOnJob = null }) {
  return insertBacktestRunRow(db, {
    request,
    strategyMeta,
    totalTicks,
    status: 'queued',
    phase: 'queued',
    dependsOnJob,
  });
}

export function createRunningBacktestRun(db, { request, strategyMeta = null, totalTicks = null }) {
  return insertBacktestRunRow(db, {
    request,
    strategyMeta,
    totalTicks,
    status: 'running',
    phase: 'queued',
  });
}

export function markBacktestRunRunning(db, id, { startedAt = Date.now() } = {}) {
  const existing = db.prepare('SELECT progress_json FROM backtest_runs WHERE id = ?').get(id);
  const prev = existing?.progress_json ? JSON.parse(existing.progress_json) : {};
  const startedIso = new Date(startedAt).toISOString();
  const nowProgress = {
    ...prev,
    phase: 'loading',
    ticks: 0,
    batches: 0,
    queued_at: prev.queued_at ?? null,
    started_at: startedIso,
    elapsed_ms: 0,
    processing_elapsed_ms: null,
    processing_started_at: null,
    eta_ms: null,
    updated_at: startedIso,
  };
  const changes = db.prepare(`
    UPDATE backtest_runs
    SET status = 'running', progress_json = ?
    WHERE id = ? AND status = 'queued'
  `).run(JSON.stringify(nowProgress), id).changes;
  return changes ? getBacktestRun(db, id, { includeResult: false, includeEquity: false }) : null;
}

export function listQueuedBacktestRuns(db) {
  return db.prepare(`
    SELECT * FROM backtest_runs
    WHERE status = 'queued'
    ORDER BY id ASC
  `).all().map((row) => toApiRun(row));
}

export function listBacktestRunsWaitingForJob(db, jobId) {
  const rows = db.prepare(`
    SELECT * FROM backtest_runs WHERE status = 'queued' ORDER BY id ASC
  `).all();
  return rows
    .filter((row) => {
      const progress = row.progress_json ? JSON.parse(row.progress_json) : {};
      return Number(progress.depends_on_job) === Number(jobId);
    })
    .map((row) => toApiRun(row));
}

export function clearRunJobDependency(db, runId) {
  const row = db.prepare('SELECT progress_json FROM backtest_runs WHERE id = ?').get(runId);
  if (!row?.progress_json) return null;
  const progress = JSON.parse(row.progress_json);
  if (!progress.depends_on_job) return null;
  delete progress.depends_on_job;
  progress.updated_at = new Date().toISOString();
  db.prepare('UPDATE backtest_runs SET progress_json = ? WHERE id = ?').run(JSON.stringify(progress), runId);
  return getBacktestRun(db, runId, { includeResult: false, includeEquity: false });
}

function insertBacktestRunRow(db, { request, strategyMeta, totalTicks, status, phase, dependsOnJob = null }) {
  const meta = strategyMeta ?? request.strategyMeta ?? null;
  const nowIso = new Date().toISOString();
  const nowProgress = {
    phase,
    ticks: 0,
    batches: 0,
    total_ticks: totalTicks,
    percent: phase === 'queued' ? 0 : null,
    queued_at: status === 'queued' ? nowIso : null,
    started_at: status === 'running' ? nowIso : null,
    updated_at: nowIso,
    eta_ms: null,
    ...(dependsOnJob != null ? { depends_on_job: Number(dependsOnJob) } : {}),
  };
  const result = minimalResultForRequest(request, { summary: { timings: {}, progress: nowProgress } });
  const inserted = db.prepare(`
    INSERT INTO backtest_runs (
      strategy, source, underlying, interval, book_depth, from_ts, to_ts, batch_size,
      params_json, ticks, batches, summary_json, result_json,
      strategy_id, strategy_version_id, strategy_snapshot_json, dataset_request_json,
      status, error, duration_ms, progress_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.strategy,
    result.source,
    result.underlying,
    result.interval,
    result.bookDepth ?? null,
    result.from,
    result.to,
    request.batchSize,
    JSON.stringify(request.params ?? {}),
    0,
    0,
    JSON.stringify(result.summary ?? {}),
    JSON.stringify(slimResultForStorage(result)),
    meta?.strategy_id ?? null,
    meta?.strategy_version_id ?? null,
    meta ? JSON.stringify(meta) : null,
    JSON.stringify(stripRequestForSnapshot(request)),
    status,
    null,
    null,
    JSON.stringify(nowProgress),
  );
  return getBacktestRun(db, inserted.lastInsertRowid, { includeResult: false, includeEquity: false });
}

export function updateBacktestRunProgress(db, id, progress) {
  const existing = db.prepare('SELECT progress_json FROM backtest_runs WHERE id = ?').get(id);
  const prev = existing?.progress_json ? JSON.parse(existing.progress_json) : {};
  const nextPercent = Number(progress.percent);
  const prevPercent = Number(prev.percent);
  const merged = {
    ...progress,
    queued_at: progress.queued_at ?? prev.queued_at ?? null,
    started_at: progress.started_at ?? prev.started_at ?? null,
    total_ticks: progress.total_ticks ?? prev.total_ticks ?? null,
    percent: progress.percent == null
      ? (prev.percent ?? null)
      : Math.max(Number.isFinite(prevPercent) ? prevPercent : 0, Number.isFinite(nextPercent) ? nextPercent : 0),
  };
  db.prepare(`
    UPDATE backtest_runs
    SET ticks = ?, batches = ?, progress_json = ?
    WHERE id = ? AND status = 'running'
  `).run(
    Number(progress.ticks || 0),
    Number(progress.batches || 0),
    JSON.stringify(merged),
    id,
  );
}

export function cancelBacktestRun(db, id, { error = 'Backtest cancelled by user', startedAt = null } = {}) {
  const durationMs = startedAt ? Date.now() - startedAt : null;
  const changes = db.prepare(`
    UPDATE backtest_runs
    SET status = 'cancelled', error = ?, duration_ms = COALESCE(duration_ms, ?), progress_json = NULL,
        summary_json = json_set(COALESCE(summary_json, '{}'), '$.cancelled', 1, '$.error', ?),
        result_json = json_set(COALESCE(result_json, '{}'), '$.summary.cancelled', 1, '$.summary.error', ?)
    WHERE id = ? AND status IN ('running', 'queued')
  `).run(error, durationMs, error, error, id).changes;
  if (changes) invalidateStrategyStatsCache();
  return changes ? getBacktestRun(db, id, { includeResult: false, includeEquity: false }) : null;
}

export function completeBacktestRun(db, id, { request, result, strategyMeta = null, startedAt = null }) {
  return finishExistingBacktestRun(db, id, { request, result, strategyMeta, status: 'completed', error: null, startedAt });
}

export function failBacktestRun(db, id, { request, result, strategyMeta = null, error, startedAt = null, partial = false }) {
  const status = partial ? 'partial' : 'failed_runtime';
  return finishExistingBacktestRun(db, id, { request, result, strategyMeta, status, error, startedAt });
}

function finishExistingBacktestRun(db, id, { request, result, strategyMeta = null, status, error, startedAt = null }) {
  const existing = getBacktestRun(db, id, { includeResult: false, includeEquity: false });
  if (!existing || existing.status !== 'running') return existing;
  const meta = strategyMeta
    ?? result?.strategyMeta
    ?? existing.strategy_snapshot
    ?? null;
  const storageStartedAt = Date.now();
  result.summary = {
    ...(result.summary || {}),
    timings: {
      ...(result.summary?.timings || result.timings || {}),
      sqliteWriteMs: null,
    },
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    const existingTraces = db.prepare('SELECT COUNT(*) AS c FROM backtest_event_traces WHERE run_id = ?').get(id);
    if (!existingTraces?.c) {
      persistEventTraces(db, id, result, { transaction: false });
    } else {
      mergeResultIntoEventTraces(db, id, result, { transaction: false });
    }
    result.summary.timings.sqliteWriteMs = Date.now() - storageStartedAt;
    const durationMs = startedAt ? Date.now() - startedAt : null;
    db.prepare(`
      UPDATE backtest_runs
      SET strategy = ?, source = ?, underlying = ?, interval = ?, book_depth = ?, from_ts = ?, to_ts = ?, batch_size = ?,
          params_json = ?, ticks = ?, batches = ?, summary_json = ?, result_json = ?,
          strategy_id = ?, strategy_version_id = ?, strategy_snapshot_json = ?, dataset_request_json = ?,
          status = ?, error = ?, duration_ms = ?, progress_json = ?
      WHERE id = ?
    `).run(
      result.strategy,
      result.source,
      result.underlying,
      result.interval,
      result.bookDepth ?? null,
      result.from,
      result.to,
      request.batchSize,
      JSON.stringify(request.params ?? {}),
      result.ticks,
      result.batches,
      JSON.stringify(result.summary ?? {}),
      JSON.stringify(slimResultForStorage(result)),
      meta?.strategy_id ?? existing.strategy_id ?? null,
      meta?.strategy_version_id ?? existing.strategy_version_id ?? null,
      meta ? JSON.stringify(meta) : (existing.strategy_snapshot ? JSON.stringify(existing.strategy_snapshot) : null),
      JSON.stringify(stripRequestForSnapshot(request)),
      status,
      error,
      durationMs,
      null,
      id,
    );
    db.exec('COMMIT');
    invalidateStrategyStatsCache();
    return getBacktestRun(db, id, { includeResult: false, includeEquity: false });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getBacktestRun(db, id, { includeResult = false, includeEquity = true } = {}) {
  const row = db.prepare('SELECT * FROM backtest_runs WHERE id = ?').get(id);
  return row ? toApiRun(row, { includeResult, includeEquity }) : null;
}

export function listBacktestRuns(db, {
  limit = 20,
  strategy_id: strategyId,
  strategy_version_id: strategyVersionId,
  status,
  underlying,
  interval,
  pnl,
  include_orphans: includeOrphans = false,
} = {}) {
  const RUNS = 'backtest_runs';
  const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 20, 1), 100);
  const filters = [];
  const params = [];

  addNumberFilter(filters, params, `${RUNS}.strategy_id`, strategyId);
  addNumberFilter(filters, params, `${RUNS}.strategy_version_id`, strategyVersionId);
  addTextFilter(filters, params, `${RUNS}.status`, status);
  addTextFilter(filters, params, `${RUNS}.underlying`, underlying);
  addTextFilter(filters, params, `${RUNS}.interval`, interval);
  if (pnl === 'positive') filters.push(`CAST(json_extract(${RUNS}.summary_json, '$.totalPnl') AS REAL) > 0`);
  if (pnl === 'negative') filters.push(`CAST(json_extract(${RUNS}.summary_json, '$.totalPnl') AS REAL) < 0`);
  if (pnl === 'zero') filters.push(`COALESCE(CAST(json_extract(${RUNS}.summary_json, '$.totalPnl') AS REAL), 0) = 0`);

  const hasExplicitStrategy = strategyId != null
    && strategyId !== ''
    && strategyId !== 'all'
    && Number.parseInt(String(strategyId), 10) > 0;

  if (!includeOrphans && !hasExplicitStrategy) {
    for (const clause of linkedBacktestRunSqlFilters(RUNS)) {
      filters.push(clause);
    }
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return db.prepare(`SELECT ${RUNS}.* FROM ${RUNS} ${where} ORDER BY ${RUNS}.id DESC LIMIT ?`).all(...params, safeLimit).map((row) => toApiRun(row));
}

/** Runs visíveis no Estúdio: estratégia ativa (não lixeira/arquivada) + versão existente. */
export function linkedBacktestRunSqlFilters(runsAlias = 'backtest_runs') {
  return [
    `${runsAlias}.strategy_id IS NOT NULL`,
    `${runsAlias}.strategy_version_id IS NOT NULL`,
    `EXISTS (
      SELECT 1 FROM strategy_definitions sd
      WHERE sd.id = ${runsAlias}.strategy_id
        AND sd.deleted_at IS NULL
        AND sd.status != 'archived'
    )`,
    `EXISTS (
      SELECT 1 FROM strategy_versions sv
      WHERE sv.id = ${runsAlias}.strategy_version_id
        AND sv.strategy_id = ${runsAlias}.strategy_id
    )`,
  ];
}

function addNumberFilter(filters, params, column, value) {
  if (value == null || value === '' || value === 'all') return;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return;
  filters.push(`${column} = ?`);
  params.push(parsed);
}

function addTextFilter(filters, params, column, value) {
  if (value == null || value === '' || value === 'all') return;
  filters.push(`${column} = ?`);
  params.push(String(value));
}

const MAX_STORED_EQUITY_POINTS = 1500;

function toApiRun(row, { includeResult = false, includeEquity = false } = {}) {
  const run = {
    id: Number(row.id),
    strategy: row.strategy,
    source: row.source,
    underlying: row.underlying,
    interval: row.interval,
    bookDepth: row.book_depth,
    from: row.from_ts,
    to: row.to_ts,
    batchSize: row.batch_size,
    params: JSON.parse(row.params_json),
    ticks: row.ticks,
    batches: row.batches,
    summary: JSON.parse(row.summary_json),
    created_at: row.created_at,
    strategy_id: row.strategy_id != null ? Number(row.strategy_id) : null,
    strategy_version_id: row.strategy_version_id != null ? Number(row.strategy_version_id) : null,
    strategy_snapshot: row.strategy_snapshot_json ? JSON.parse(row.strategy_snapshot_json) : null,
    status: row.status ?? 'completed',
    error: row.error ?? null,
    duration_ms: row.duration_ms ?? null,
    progress: row.progress_json ? JSON.parse(row.progress_json) : null,
  };
  if (includeResult) {
    run.result = JSON.parse(row.result_json);
  } else if (includeEquity && row.result_json) {
    run.equity = extractEquityFromResultJson(row.result_json);
  }
  return run;
}

function stripRequestForSnapshot(request) {
  const { glsAst, strategyMeta, ...rest } = request;
  return rest;
}

function minimalResultForRequest(request, { summary = {} } = {}) {
  return {
    strategy: request.strategyLabel || request.strategy,
    source: 'lakehouse',
    underlying: request.underlying,
    interval: request.interval,
    bookDepth: request.bookDepth,
    from: new Date(request.from).toISOString(),
    to: new Date(request.to).toISOString(),
    ticks: 0,
    batches: 0,
    summary,
    events: [],
    equity: [],
    log: [],
    strategyMeta: request.strategyMeta ?? null,
  };
}

function slimResultForStorage(result) {
  const { events, log, ...rest } = result;
  if (Array.isArray(rest.equity) && rest.equity.length > MAX_STORED_EQUITY_POINTS) {
    const points = rest.equity.map((p) => ({ ts: p.ts, value: p.pnl }));
    rest.equity = downsamplePoints(points, { maxPoints: MAX_STORED_EQUITY_POINTS })
      .map((p) => ({ ts: p.ts, pnl: p.value }));
  }
  return rest;
}

/** Extrai só o array equity sem parsear o JSON inteiro do result. */
export function extractEquityFromResultJson(json) {
  if (!json) return [];
  const key = '"equity":';
  const start = json.indexOf(key);
  if (start < 0) {
    try {
      const parsed = JSON.parse(json);
      return Array.isArray(parsed.equity) ? parsed.equity : [];
    } catch {
      return [];
    }
  }
  let i = start + key.length;
  while (i < json.length && /\s/.test(json[i])) i += 1;
  if (json[i] !== '[') return [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = i; j < json.length; j += 1) {
    const ch = json[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          const equity = JSON.parse(json.slice(i, j + 1));
          return Array.isArray(equity) ? equity : [];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

export function deleteBacktestRun(db, id) {
  const run = db.prepare('SELECT * FROM backtest_runs WHERE id = ?').get(id);
  if (!run) return null;

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM backtest_event_traces WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM backtest_runs WHERE id = ?').run(id);
    db.exec('COMMIT');
    invalidateStrategyStatsCache();
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return toApiRun(run);
}
