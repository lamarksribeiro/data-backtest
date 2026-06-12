import { acceptEligibleReviewPartitions } from '../state/manifest.js';
import { checkDatasetAvailability, partitionDatesForRange } from '../query/availability.js';
import { resolveDataRequest } from '../query/dataMode.js';
import { datasetRequestFromObject, inclusiveEndDateFromExclusive } from '../query/request.js';

export function buildDataFixPlan(db, request, config) {
  const normalized = datasetRequestFromObject(request, config);
  const dates = partitionDatesForRange(normalized.from, normalized.to);
  const accepted = acceptEligibleReviewPartitions(db, {
    dataset: normalized.dataset,
    underlying: normalized.underlying,
    interval: normalized.interval,
    resolution: normalized.resolution ?? null,
    bookDepth: normalized.bookDepth ?? null,
    fromDt: dates[0],
    toDt: dates.at(-1),
  }, config.syncAcceptCountMismatchRatio ?? 0.02);

  const strict = resolveDataRequest(db, normalized, 'strict');
  if (strict.ready && !normalized.rebuild) {
    return {
      ready: true,
      summary: 'Período já está pronto para backtest.',
      auto_accepted: accepted,
      rebuild_required: false,
      preparation: [],
      availability: strict.availability,
    };
  }

  const prepare = resolveDataRequest(db, normalized, 'prepare');
  const unavailable = prepare.availability.unavailable || [];
  const usablePartitions = (prepare.availability.partitions || []).filter((p) => p.usable);
  const rebuildRequired = normalized.rebuild
    ? usablePartitions.length > 0
    : unavailable.some((p) => p.status === 'valid');
  const missing = prepare.availability.missing?.length ?? 0;
  const syncDays = new Set([
    ...(prepare.availability.missing || []),
    ...unavailable.map((p) => p.dt),
    ...(normalized.rebuild ? usablePartitions.map((p) => p.dt) : []),
  ]);

  const lines = [];
  if (accepted.length) lines.push(`${accepted.length} partição(ões) aceita(s) automaticamente.`);
  if (normalized.rebuild && usablePartitions.length) {
    lines.push(`${usablePartitions.length} dia(s) prontos serão reprocessados (--rebuild).`);
  }
  if (syncDays.size) lines.push(`${syncDays.size} dia(s) serão re-sincronizados.`);
  if (missing && !syncDays.size) lines.push(`${missing} dia(s) sem dados na origem.`);
  if (!lines.length) lines.push('Nenhuma ação necessária após auto-aceite.');

  return {
    ready: false,
    summary: lines.join(' '),
    auto_accepted: accepted,
    rebuild_required: rebuildRequired,
    preparation: prepare.preparation,
    availability: prepare.availability,
    request: normalized,
  };
}

function actionDateLabel(action, field) {
  const direct = action?.[field];
  if (direct) {
    return field === 'to'
      ? inclusiveEndDateFromExclusive(direct)
      : String(direct).slice(0, 10);
  }
  const args = action?.args || [];
  const flag = field === 'from' ? '--from' : '--to';
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1]) {
    const value = args[idx + 1];
    return field === 'to' ? inclusiveEndDateFromExclusive(value) : String(value).slice(0, 10);
  }
  return '?';
}

export function describeFixActions(preparation = []) {
  return preparation.map((action) => {
    const from = actionDateLabel(action, 'from');
    const to = actionDateLabel(action, 'to');
    const cmd = action.command || '';
    if (cmd.includes('scalars') || cmd === 'sync:backfill') return `Re-exportar scalars de ${from} a ${to}`;
    if (cmd.includes('books')) return `Sincronizar books de ${from} a ${to}`;
    if (cmd.includes('backtest-ticks')) return `Gerar backtest_ticks de ${from} a ${to}`;
    if (cmd.includes('ohlc')) return `Gerar OHLC de ${from} a ${to}`;
    return `Preparar ${from} → ${to}`;
  });
}

export function windowUiStateFromAvailability(availability) {
  if (!availability) return 'attention';
  if (availability.ok) return 'ready';
  const statuses = (availability.partitions || []).map((p) => p.status);
  if (statuses.some((s) => ['pending', 'writing', 'rebuilding'].includes(s))) return 'processing';
  return 'attention';
}

export function runDataFix(db, config, { body, prepareRunner, dryRun = false }) {
  const request = body.request || body;
  const plan = buildDataFixPlan(db, request, config);
  const summary_lines = describeFixActions(plan.preparation);
  if (plan.summary && summary_lines.length === 0) {
    summary_lines.push(plan.summary);
  }

  if (dryRun) {
    return {
      ok: true,
      ready: plan.ready,
      summary: plan.summary,
      summary_lines,
      needs_rebuild_confirm: plan.rebuild_required,
      auto_accepted: plan.auto_accepted,
      preparation_count: plan.preparation.length,
    };
  }

  if (plan.rebuild_required && body.confirm_rebuild !== true) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      message: 'Rebuild de partição valid exige confirmação explícita.',
      needs_rebuild_confirm: true,
      summary_lines,
      summary: plan.summary,
    };
  }

  if (plan.ready) {
    return { ok: true, ready: true, summary: plan.summary, summary_lines };
  }

  const job = prepareRunner.enqueue({
    request: plan.request,
    mode: 'prepare',
    dryRun: false,
  });
  return { ok: true, ready: false, job, summary: plan.summary, summary_lines };
}
