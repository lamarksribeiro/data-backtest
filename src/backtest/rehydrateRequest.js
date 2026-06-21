import { getStrategyVersion } from '../backtestStudio/state/strategies.js';
import { resolveVersionForBacktest } from '../backtestStudio/strategyJs/resolveVersion.js';
import { bindStrategyLibraryDatabase } from '../backtestStudio/nativeLibrary/registry.js';
import {
  extractDefaultParamsFromSchema,
  getStrategyPreset,
  mergePresetParams,
} from '../backtestStudio/state/strategyPresets.js';

function isLiveDatabase(db) {
  return Boolean(db && typeof db.prepare === 'function');
}

function backfillRequestFromRunRow(db, request, runId) {
  if (!Number.isFinite(Number(runId)) || Number(runId) <= 0) return request;
  if (request.from && request.to && request.underlying && request.interval) return request;

  const row = db.prepare(`
    SELECT from_ts, to_ts, underlying, interval, book_depth, batch_size, params_json
    FROM backtest_runs
    WHERE id = ?
  `).get(Number(runId));
  if (!row) return request;

  let params = request.params;
  if (params == null && row.params_json) {
    try {
      params = JSON.parse(row.params_json);
    } catch {
      params = {};
    }
  }

  return {
    ...request,
    from: request.from ?? row.from_ts,
    to: request.to ?? row.to_ts,
    underlying: request.underlying ?? row.underlying,
    interval: request.interval ?? row.interval,
    bookDepth: request.bookDepth ?? row.book_depth ?? 25,
    batchSize: request.batchSize ?? row.batch_size ?? 10_000,
    params: params ?? {},
  };
}

export function rehydrateBacktestRequest(db, request = {}, { runId = null } = {}) {
  const meta = request.strategyMeta ?? {};
  const strategyId = Number(meta.strategy_id ?? request.strategy_id);
  const strategyVersionId = Number(meta.strategy_version_id ?? request.strategy_version_id);
  const bookDepth = request.bookDepth ?? 25;
  const liveDb = isLiveDatabase(request.db) ? request.db : db;
  if (liveDb) bindStrategyLibraryDatabase(liveDb);

  const next = backfillRequestFromRunRow(db, {
    ...request,
    db: liveDb,
  }, runId);

  if (!Number.isFinite(strategyId) || !Number.isFinite(strategyVersionId)) {
    return next;
  }

  const version = getStrategyVersion(db, strategyId, strategyVersionId);
  if (!version) {
    throw new Error(`Strategy version not found: ${strategyId}/${strategyVersionId}`);
  }
  if (!version.validation?.ok) {
    throw new Error(version.validation?.errors?.[0]?.message || 'Strategy version failed validation');
  }

  const resolved = resolveVersionForBacktest(version, { bookDepth, db });
  const defaultParams = extractDefaultParamsFromSchema(version.params_schema || {});

  let presetParams = {};
  const presetId = Number(meta.preset_id ?? request.preset_id);
  if (Number.isFinite(presetId) && presetId > 0) {
    const preset = getStrategyPreset(db, strategyId, presetId);
    if (preset) presetParams = preset.params || {};
  }

  return {
    ...next,
    glsAst: resolved.glsAst,
    columnAnalysis: resolved.columnAnalysis,
    extensionLibraries: resolved.extensionLibraries,
    generatedSource: resolved.generatedSource,
    runnerLibrary: resolved.runnerLibrary,
    embeddedRunner: resolved.embeddedRunner,
    embeddedModels: resolved.embeddedModels,
    strategySourceCode: resolved.strategySourceCode,
    params: mergePresetParams(defaultParams, presetParams, request.params ?? {}),
    strategyMeta: {
      ...meta,
      ...resolved.strategyMeta,
      strategy_id: strategyId,
      strategy_version_id: strategyVersionId,
      slug: meta.slug ?? version.slug,
      version: meta.version ?? version.version,
      language: meta.language ?? version.language,
      source_code: meta.source_code ?? version.source_code,
      checksum: meta.checksum ?? version.checksum,
    },
  };
}