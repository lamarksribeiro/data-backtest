import { el, mount } from '../utils/dom.js';
import { applyContextOptions, contextBarOptions, loadContext, saveContext, selectField } from '../utils/context.js';
import { fetchContextOptionsCached } from '../utils/contextOptionsCache.js';
import { formatPnl, shortId } from '../utils/format.js';
import { loadStrategyOptions, renderStrategyPicker, backtestPayloadFromPick, resolveInitialStrategyPick, saveLastStrategyPick, getStrategyGroupFromPick, invalidateStrategyPickerCache } from '../utils/strategyPicker.js';
import { MetricCard, Skeleton, StatusBadge } from '../components/Skeleton.js';
import { renderRunMetricsPanel, renderTimingSection, resetMetricsViewMode } from '../components/runMetrics.js';
import { computeMaxDrawdown } from '../utils/equityMetrics.js';
import { formatRunAssetMeta, formatIntervalLabel, intervalBadgeClass, renderRunContextBanner } from '../components/runContext.js';
import { renderNoEntryDiagnostic, partitionNoEntryEvents } from '../components/noEntryDiagnostic.js';
import {
  renderEventOverview,
  renderExecutionTimeline,
  renderDiagnosticsPanel,
  renderLogList,
} from '../components/executionTimeline.js';
import { renderEventChartWithMarkers } from '../components/eventChartMarkers.js';
import { connectSse, disconnectSse } from '../utils/sse.js';
import { cacheInvalidate, cachedFetch } from '../utils/apiCache.js';
import { notifyStudioCatalogChanged, notifyRunDataChanged, registerStudioRefresh } from '../utils/studioCatalogSync.js';
import { navigate as routerNavigate } from '../router.js';
import { renderUplotLine } from '../utils/uplotChart.js';
import { confirmDialog } from '../utils/confirm.js';

function formatPrice(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(3) : '-';
}

function formatEventTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function humanizeReason(value) {
  const raw = String(value || '').trim();
  if (!raw) return '—';
  const labels = {
    expiry_win: 'Acertou',
    expiry_loss: 'Errou',
    no_entry: 'Sem entrada',
    breakeven: 'Empate',
    closed: 'Fechado',
    stop_loss: 'Stop loss',
    take_profit: 'Take profit',
    reverse: 'Reversão',
  };
  if (labels[raw]) return labels[raw];
  return raw.replace(/_/g, ' ');
}

function resolveEventResult(ev) {
  if (ev.expiration_result === 'WIN' || ev.result === 'win' || ev.reason === 'expiry_win') {
    return { tone: 'ok', label: 'Acertou' };
  }
  if (ev.expiration_result === 'LOSS' || ev.result === 'loss' || ev.reason === 'expiry_loss') {
    return { tone: 'err', label: 'Errou' };
  }
  if (ev.result === 'breakeven' || ev.reason === 'breakeven') {
    return { tone: 'idle', label: 'Empate' };
  }
  if (ev.result === 'no_entry' || ev.reason === 'no_entry') {
    return { tone: 'idle', label: 'Sem entrada' };
  }
  const raw = ev.reason || ev.result || '';
  const label = humanizeReason(raw);
  const lower = raw.toLowerCase();
  let tone = 'idle';
  if (lower.includes('stop') || lower.includes('loss') || lower.includes('err')) tone = 'err';
  else if (lower.includes('win') || lower.includes('profit')) tone = 'ok';
  else if (lower.includes('warn')) tone = 'warn';
  return { tone, label };
}

function renderEventResultBadge(ev) {
  const { tone, label } = resolveEventResult(ev);
  return el('span', { class: 'col-result' }, [
    el('span', { class: `event-result-badge badge badge--compact badge--${tone}` }, label),
  ]);
}

function renderSideCell(side) {
  if (!side) return el('span', { class: 'col-side muted' }, '—');
  const tone = side === 'UP' ? 'up' : side === 'DOWN' ? 'down' : 'idle';
  return el('span', { class: 'col-side' }, [
    el('span', { class: `event-side-pill event-side-pill--${tone}` }, side),
  ]);
}

function formatDistPtb(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `$${num.toFixed(0)}` : '—';
}

function formatTimeRemaining(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `${Math.round(num)}s` : '—';
}

function chartSeriesIsUsable(series) {
  const base = series?.underlying || [];
  const valid = base.filter((point) => pointFiniteValue(point) != null);
  if (valid.length < 2) return false;
  const uniqueTs = new Set(valid.map((point) => String(pointTs(point))));
  return uniqueTs.size >= 2;
}

function pointTs(point) {
  if (Array.isArray(point)) return point[0];
  return point?.ts ?? point?.time ?? point?.t ?? point?.x;
}

function pointFiniteValue(point) {
  const value = Array.isArray(point)
    ? point[1]
    : point?.value ?? point?.y ?? point?.underlying_price ?? point?.underlyingPrice ?? point?.price_to_beat ?? point?.priceToBeat ?? point?.ptb ?? point?.price;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function enrichEventSummaryFromChart(event, chartPayload) {
  if (!event || !chartPayload) return;
  const summary = event.summary || (event.summary = {});
  const series = chartPayload.series || {};
  const ptbSeries = series.priceToBeat || series.price_to_beat || series.ptb || [];
  const ptbPoint = ptbSeries.find((p) => pointFiniteValue(p) != null);
  const spotPoints = (series.underlying || []).filter((p) => pointFiniteValue(p) != null);

  if (summary.priceToBeat == null && ptbPoint) summary.priceToBeat = pointFiniteValue(ptbPoint);

  const entryOrder = (event.orders || []).find((o) => !o?.type || o.type === 'entry');
  const entryTs = summary.entryTime || entryOrder?.ts || entryOrder?.createdAt;
  if (entryTs && spotPoints.length) {
    const entryMs = new Date(entryTs).getTime();
    if (summary.entryTimeRemaining == null && event.event_end) {
      const endMs = new Date(event.event_end).getTime();
      if (Number.isFinite(entryMs) && Number.isFinite(endMs)) {
        summary.entryTimeRemaining = Math.max(0, Math.round((endMs - entryMs) / 1000));
      }
    }
    if (summary.entryDistanceToPtb == null) {
      let bestSpot = null;
      let bestPtb = summary.priceToBeat;
      let bestDiff = Number.POSITIVE_INFINITY;
      for (let i = 0; i < spotPoints.length; i += 1) {
        const spot = spotPoints[i];
        const tsMs = new Date(pointTs(spot)).getTime();
        if (!Number.isFinite(tsMs)) continue;
        const diff = Math.abs(tsMs - entryMs);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestSpot = pointFiniteValue(spot);
          const ptb = ptbSeries[i];
          const ptbValue = pointFiniteValue(ptb);
          if (ptbValue != null) bestPtb = ptbValue;
        }
      }
      if (Number.isFinite(bestSpot) && Number.isFinite(bestPtb)) {
        summary.entryDistanceToPtb = Math.abs(bestSpot - bestPtb);
      }
    }
  }

  if (chartPayload.summary) {
    Object.assign(summary, {
      priceToBeat: summary.priceToBeat ?? chartPayload.summary.priceToBeat,
      entryDistanceToPtb: summary.entryDistanceToPtb ?? chartPayload.summary.entryDistanceToPtb,
      entryTimeRemaining: summary.entryTimeRemaining ?? chartPayload.summary.entryTimeRemaining,
      finalPnlBeforeFees: summary.finalPnlBeforeFees ?? chartPayload.summary.finalPnlBeforeFees,
    });
  }

  if (summary.finalPnlBeforeFees == null && event.final_pnl != null) {
    const fee = Number(summary.fees?.totalFee || 0);
    summary.finalPnlBeforeFees = fee > 0 ? Number(event.final_pnl) + fee : Number(event.final_pnl);
  }
}

function renderSelectedEventContainerPlaceholder() {
  const container = document.getElementById('studio-selected-event-container');
  if (!container) return;
  mount(container, el('div', { class: 'card card--compact studio-event-placeholder' }, [
    el('p', { class: 'muted text-center', style: { padding: '24px 0', margin: 0 } },
      'Selecione um evento na tabela abaixo para ver o gráfico e os detalhes da execução.'),
  ]));
}

const EVENTS_PAGE = 100;
const MAX_STUDIO_EVENTS = 500;

const studioState = {
  runs: [],
  selectedRunId: null,
  selectedRunMeta: null,
  selectedEventId: null,
  compareIds: [],
  events: [],
  eventsOffset: 0,
  eventsHasMore: false,
  eventIndex: 0,
  filterQ: '',
  filterResult: 'all_with_entries',
  filterSort: 'event_start:asc',
  runFilters: {
    status: 'all',
    sort: 'newest',
    strategyOnly: true,
    versionId: 'all',
    underlying: 'all',
    interval: 'all',
    pnl: 'all',
    groupByVersion: false,
  },
  strategyOptions: [],
  selectedStrategyPick: '',
  coverageUi: null,
  cancellingRunId: null,
  runFiltersAdvancedOpen: false,
};

let advancedPopoverDismissHandler = null;
let activeAdvancedPopover = null;

const EVENT_SORT_COLUMNS = [
  { key: 'event_start', label: 'Hora Evento', className: 'col-time', defaultDir: 'asc' },
  { key: 'side', label: 'Posição', className: 'col-side', defaultDir: 'asc' },
  { key: 'quantity', label: 'Contratos', className: 'col-qty', defaultDir: 'desc' },
  { key: 'cost', label: 'Custo', className: 'col-cost', defaultDir: 'desc' },
  { key: 'pnl', label: 'P&L (Líquido)', className: 'col-pnl', defaultDir: 'desc' },
  { key: 'dist', label: 'Dist PTB', className: 'col-dist', defaultDir: 'desc' },
  { key: 'trest', label: 'T.Rest', className: 'col-trest', defaultDir: 'desc' },
  { key: 'result', label: 'Resultado', className: 'col-result', defaultDir: 'desc' },
];

function parseEventSort(sort) {
  const raw = String(sort || 'default').trim();
  if (!raw || raw === 'default') return { column: 'event_start', dir: 'asc' };
  const legacy = {
    pnl_asc: { column: 'pnl', dir: 'asc' },
    pnl_desc: { column: 'pnl', dir: 'desc' },
    event_start: { column: 'event_start', dir: 'asc' },
    event_start_desc: { column: 'event_start', dir: 'desc' },
  };
  if (legacy[raw]) return legacy[raw];
  const [column, dir] = raw.split(':');
  return { column, dir: dir === 'asc' ? 'asc' : 'desc' };
}

function toggleEventColumnSort(column) {
  const current = parseEventSort(studioState.filterSort);
  if (current.column === column) {
    return `${column}:${current.dir === 'desc' ? 'asc' : 'desc'}`;
  }
  const meta = EVENT_SORT_COLUMNS.find((item) => item.key === column);
  return `${column}:${meta?.defaultDir || 'desc'}`;
}

function sortIndicator(column) {
  const current = parseEventSort(studioState.filterSort);
  if (current.column !== column) return '';
  return current.dir === 'asc' ? '↑' : '↓';
}

function isDefaultEventSort(sort) {
  const current = parseEventSort(sort);
  return current.column === 'event_start' && current.dir === 'asc';
}

function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

let sseHandler = null;
let studioCtx = null;
let openEventToken = 0;
let progressPollTimer = null;
let progressElapsedTimer = null;
let progressPollGeneration = 0;
let lastProgressSnapshot = null;
let lastProgressRunId = null;
let lastProgressReceivedAt = 0;
let progressLifecycleBound = false;

function clearProgressPoll() {
  progressPollGeneration += 1;
  if (progressPollTimer) {
    clearInterval(progressPollTimer);
    progressPollTimer = null;
  }
  if (progressElapsedTimer) {
    clearInterval(progressElapsedTimer);
    progressElapsedTimer = null;
  }
  lastProgressSnapshot = null;
  lastProgressRunId = null;
  lastProgressReceivedAt = 0;
}

function resumeProgressTracking(ctx = studioCtx) {
  if (!ctx || !isStudioRouteActive()) return;
  const runId = studioState.selectedRunId;
  if (!runId || !document.getElementById('studio-progress-fill')) return;
  if (!progressPollTimer) startProgressPoll(ctx, runId);
  else void fetchRunProgressOnce(ctx, runId);
}

function bindProgressLifecycle() {
  if (progressLifecycleBound) return;
  progressLifecycleBound = true;
  const onResume = () => {
    if (document.visibilityState === 'visible') resumeProgressTracking();
  };
  document.addEventListener('visibilitychange', onResume);
  window.addEventListener('pageshow', onResume);
  window.addEventListener('focus', onResume);
}

function formatProgressPhase(phase, progress = null) {
  const step = progress?.loading_step ?? progress?.loadingStep;
  switch (String(phase || '').toLowerCase()) {
    case 'loading':
      if (step === 'merge') return 'Montando janela';
      return 'Carregando dados';
    case 'processing':
      if (!progress?.ticks && (progress?.processing_elapsed_ms ?? 0) > 4000) return 'Iniciando motor';
      return 'Processando';
    case 'finalizing': return 'Finalizando';
    case 'queued': return 'Na fila';
    default: return phase || 'Aguardando';
  }
}

function resolveProgressElapsedMs(progress) {
  if (!progress) return null;
  if (progress.phase === 'queued') return null;

  const base = progress.elapsed_ms ?? progress.elapsedMs;
  const updated = progress.updated_at ?? progress.updatedAt;
  if (base != null && Number.isFinite(Number(base)) && updated) {
    const updatedMs = new Date(updated).getTime();
    if (Number.isFinite(updatedMs)) {
      const drift = lastProgressReceivedAt > 0 ? Math.max(0, Date.now() - lastProgressReceivedAt) : 0;
      return Math.max(0, Number(base) + drift);
    }
  }

  const startedAt = progress.started_at ?? progress.startedAt;
  if (startedAt) {
    const started = new Date(startedAt).getTime();
    if (Number.isFinite(started)) return Math.max(0, Date.now() - started);
  }
  return null;
}

function startProgressElapsedTicker() {
  if (progressElapsedTimer) return;
  progressElapsedTimer = setInterval(() => {
    if (!lastProgressSnapshot || lastProgressSnapshot.phase === 'queued') return;
    applyProgressUi(lastProgressSnapshot, { skipSnapshot: true });
  }, 500);
}

function formatDurationMs(ms, fallback = 'Calculando...') {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return fallback;
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min}m ${rem}s` : `${min}m`;
}

function formatProgressRemaining(progress) {
  const ms = progress?.eta_ms ?? (progress?.eta != null ? Number(progress.eta) * 1000 : null);
  if (ms != null && Number.isFinite(ms) && ms > 0) return `~${formatDurationMs(ms)}`;
  if (progress?.phase === 'queued') return 'Aguardando';
  if (progress?.phase === 'loading') {
    if (progress?.loading_step === 'merge' || progress?.loadingStep === 'merge') return 'Unindo dias';
    return 'Após carregar';
  }
  if (progress?.phase === 'processing' && !progress?.ticks) {
    const elapsed = progress?.processing_elapsed_ms ?? progress?.elapsed_ms ?? 0;
    if (elapsed > 4000) return 'Primeiro evento…';
    return 'Calculando...';
  }
  return 'Calculando...';
}

function formatProgressElapsed(progress) {
  if (progress?.phase === 'queued') return 'Na fila';
  return formatDurationMs(resolveProgressElapsedMs(progress), '0s');
}

function applyProgressUi(progress, { skipSnapshot = false, runId = null } = {}) {
  if (!progress) return;
  if (runId != null && runId !== lastProgressRunId) {
    lastProgressRunId = runId;
    lastProgressSnapshot = null;
    lastProgressReceivedAt = 0;
  }
  const percent = progress.percent != null ? Number(progress.percent) : 0;
  const previousPercent = lastProgressSnapshot?.percent != null ? Number(lastProgressSnapshot.percent) : 0;
  const displayPercent = Math.max(previousPercent, percent);
  if (!skipSnapshot) {
    lastProgressReceivedAt = Date.now();
    lastProgressSnapshot = {
      ...progress,
      percent: displayPercent,
      ...(runId != null ? { runId } : {}),
    };
    startProgressElapsedTicker();
  }
  const fill = document.getElementById('studio-progress-fill');
  if (fill) fill.style.width = `${Math.min(100, Math.max(0, displayPercent))}%`;
  const bar = document.querySelector('.studio-progress-bar');
  if (bar) bar.setAttribute('aria-valuenow', String(Math.round(displayPercent)));
  const pct = document.getElementById('studio-progress-pct');
  if (pct) pct.textContent = `${displayPercent.toFixed(0)}%`;
  const phase = document.getElementById('studio-progress-phase');
  if (phase) phase.textContent = formatProgressPhase(progress.phase, progress);
  const ticks = document.getElementById('studio-progress-ticks');
  if (ticks) {
    ticks.textContent = `${progress.ticks || 0}${progress.total_ticks ? ` / ${progress.total_ticks}` : ''}`;
  }
  const eta = document.getElementById('studio-progress-eta');
  if (eta) eta.textContent = formatProgressRemaining(progress);
  const elapsed = document.getElementById('studio-progress-elapsed');
  if (elapsed) elapsed.textContent = formatProgressElapsed(progress);
  const depends = document.getElementById('studio-progress-depends');
  if (depends) {
    if (progress.depends_on_job) {
      depends.textContent = `Aguardando job #${progress.depends_on_job}`;
      depends.hidden = false;
    } else {
      depends.hidden = true;
    }
  }
}

function updateRunListProgress(runId, status, progress) {
  const item = document.getElementById(`run-item-${runId}`);
  const pnlEl = item?.querySelector('.studio-run-item__pnl');
  if (!pnlEl) return;
  if (status === 'queued') pnlEl.textContent = progress?.depends_on_job ? 'Aguardando' : 'Fila';
  else if (status === 'running') pnlEl.textContent = `${Number(progress?.percent || 0).toFixed(0)}%`;
  else if (status === 'cancelled') pnlEl.textContent = 'Cancelado';
}

function showStudioEmptyMain(main) {
  mount(main, el('div', { class: 'studio-empty' }, [
    el('h2', { class: 'studio-empty__title' }, 'Pronto para analisar'),
    el('p', { class: 'studio-empty__text' }, 'Selecione um backtest no histórico à direita para ver métricas, curva de patrimônio e eventos — ou configure os parâmetros e rode um novo.'),
    el('p', { class: 'studio-empty__hint muted' }, [
      'Atalho: ',
      el('kbd', { class: 'studio-kbd' }, '⌘'),
      el('kbd', { class: 'studio-kbd' }, '↵'),
      ' para rodar novo backtest',
    ]),
  ]));
}

async function exitRunSelection(ctx) {
  clearProgressPoll();
  studioState.cancellingRunId = null;
  studioState.selectedRunId = null;
  studioState.selectedEventId = null;
  studioState.compareIds = [];
  pushStudioQuery({ run: null, event: null, compare: [] });
  const main = document.getElementById('studio-main');
  if (main) showStudioEmptyMain(main);
  await refreshRuns(ctx);
}

async function cancelRunFromStudio(ctx, run) {
  const ok = await confirmDialog({
    title: 'Cancelar backtest',
    message: `Cancelar o backtest #${run.id}?`,
    detail: 'O processamento será interrompido. Runs já concluídos não são afetados.',
    confirmLabel: 'Cancelar backtest',
    cancelLabel: 'Continuar',
    tone: 'danger',
  });
  if (!ok) return;

  clearProgressPoll();
  studioState.cancellingRunId = run.id;
  const cancelBtn = document.querySelector('.studio-progress-card .btn--danger');
  if (cancelBtn) {
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Cancelando…';
  }

  let cancelRes;
  try {
    cancelRes = await ctx.api.post(`/api/backtest/runs/${run.id}/cancel`);
  } catch (err) {
    cancelRes = { ok: false, error: { message: err?.message || 'Falha ao cancelar' } };
  } finally {
    studioState.cancellingRunId = null;
  }

  if (cancelRes.ok && cancelRes.data?.run) {
    cacheInvalidate('runs');
    ctx.toast.ok('Backtest cancelado');
    await refreshRuns(ctx);
    if (studioState.selectedRunId === run.id) await loadRunDetail(ctx, run.id);
    return;
  }

  if (cancelRes.status === 409) {
    cacheInvalidate('runs');
    const detail = await ctx.api.get(`/api/backtest/runs/${run.id}?slim=1`);
    if (detail.ok && !['running', 'queued'].includes(detail.data.run.status)) {
      ctx.toast.ok('Backtest já finalizado');
      await refreshRuns(ctx);
      if (studioState.selectedRunId === run.id) await loadRunDetail(ctx, run.id);
      return;
    }
  }

  ctx.toast.err(cancelRes.error?.message || 'Falha ao cancelar');
  if (studioState.selectedRunId === run.id) {
    await loadRunDetail(ctx, run.id);
  }
}

async function fetchRunProgressOnce(ctx, runId, { generation = progressPollGeneration } = {}) {
  if (generation !== progressPollGeneration) return false;
  if (!isStudioRouteActive() || studioState.cancellingRunId === runId) return false;
  if (studioState.selectedRunId !== runId) {
    clearProgressPoll();
    return false;
  }
  const res = await ctx.api.get(`/api/backtest/runs/${runId}?slim=1`);
  if (generation !== progressPollGeneration) return false;
  if (!res.ok) return false;
  const run = res.data.run;
  if (run.status !== 'running' && run.status !== 'queued') {
    clearProgressPoll();
    cacheInvalidate('runs');
    await refreshRuns(ctx);
    if (studioState.selectedRunId === runId) {
      await loadRunDetail(ctx, runId);
    }
    return false;
  }
  if (run.progress) applyProgressUi(run.progress, { runId: run.id });
  updateRunListProgress(runId, run.status, run.progress);
  return true;
}

function startProgressPoll(ctx, runId) {
  clearProgressPoll();
  const generation = progressPollGeneration;
  const pollOnce = () => {
    if (generation !== progressPollGeneration) return;
    if (!isStudioRouteActive()) return;
    void fetchRunProgressOnce(ctx, runId, { generation });
  };
  pollOnce();
  // Poll complementa SSE (Cloudflare/buffer e runs rápidos podem perder eventos).
  progressPollTimer = setInterval(pollOnce, 1000);
}

function parseStudioQuery() {
  const hash = location.hash.replace(/^#\/?/, '');
  const q = hash.includes('?') ? hash.split('?')[1] : '';
  const params = new URLSearchParams(q);
  return {
    run: params.get('run') ? Number(params.get('run')) : null,
    event: params.get('event') ? Number(params.get('event')) : null,
    strategy: params.get('strategy') ? Number(params.get('strategy')) : null,
    version: params.get('version') ? Number(params.get('version')) : null,
    compare: (params.get('compare') || '').split(',').map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0),
  };
}

function buildStudioPath(patch) {
  const cur = parseStudioQuery();
  const next = { ...cur, ...patch };
  const params = new URLSearchParams();
  if (next.run) params.set('run', String(next.run));
  if (next.event) params.set('event', String(next.event));
  if (next.strategy) params.set('strategy', String(next.strategy));
  if (next.version) params.set('version', String(next.version));
  if (next.compare?.length) params.set('compare', next.compare.join(','));
  const qs = params.toString();
  return `studio${qs ? `?${qs}` : ''}`;
}

/** Atualiza query string sem re-montar a rota (evita loop com openEventDrawer). */
function pushStudioQuery(patch) {
  const path = buildStudioPath(patch);
  const current = location.hash.replace(/^#\/?/, '');
  if (current === path) return;
  history.replaceState(null, '', `#/${path}`);
}

let shortcutsBound = false;

/** Libera listeners, SSE do estúdio e estado pesado ao sair da rota. */
export function leaveStudio() {
  openEventToken += 1;
  clearProgressPoll();
  if (sseHandler) {
    disconnectSse(sseHandler);
    sseHandler = null;
  }
  studioState.events = [];
  studioState.eventsOffset = 0;
  studioState.eventsHasMore = false;
  closeAdvancedPopover({ silent: true });
  registerStudioRefresh(null);
  const drawer = document.getElementById('studio-drawer');
  if (drawer) {
    drawer.hidden = true;
    mount(drawer, []);
  }
}

function switchMobileTab(tab) {
  const layout = document.getElementById('studio-layout-el');
  if (!layout) return;
  layout.className = `studio-layout show-${tab}`;
  
  document.querySelectorAll('.studio-mobile-tab-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.id === `tab-btn-${tab}`);
  });
}

export async function renderStudio(ctx) {
  const routeToken = ctx.getRouteToken?.() ?? 0;
  studioCtx = ctx;
  bindProgressLifecycle();
  clearProgressPoll();
  ctx.setBreadcrumb('studio', 'Estúdio');
  ctx.renderContextBar?.();

  registerStudioRefresh(async () => {
    if (!document.getElementById('studio-runs')) return;
    studioState.strategyOptions = await loadStrategyOptions(ctx.api, { includeArchived: false, force: true });
    mountStudioStrategyPicker(ctx);
    await refreshRuns(ctx, { force: true });
  });

  const query = parseStudioQuery();
  studioState.selectedRunId = query.run;
  studioState.selectedEventId = query.event;
  studioState.compareIds = query.compare;

  mount(ctx.contentEl, el('div', { class: 'studio-container', style: { marginTop: '12px' } }, [
    el('div', { class: 'studio-mobile-tabs' }, [
      el('button', {
        class: 'studio-mobile-tab-btn',
        id: 'tab-btn-config',
        onclick: () => switchMobileTab('config')
      }, 'Parâmetros'),
      el('button', {
        class: 'studio-mobile-tab-btn is-active',
        id: 'tab-btn-main',
        onclick: () => switchMobileTab('main')
      }, 'Resultados'),
      el('button', {
        class: 'studio-mobile-tab-btn',
        id: 'tab-btn-runs',
        onclick: () => switchMobileTab('runs')
      }, 'Histórico')
    ]),
    el('div', { class: 'studio-layout show-main', id: 'studio-layout-el' }, [
      el('section', { class: 'studio-config', id: 'studio-config' }, Skeleton({ lines: 6 })),
      el('section', { class: 'studio-main', id: 'studio-main' }, Skeleton({ lines: 8 })),
      el('aside', { class: 'studio-runs', id: 'studio-runs' }, Skeleton({ lines: 5 })),
      el('div', { class: 'studio-drawer', id: 'studio-drawer', hidden: true }),
    ])
  ]));

  try {
    const [apiOptions, strategyOptions] = await Promise.all([
      fetchContextOptionsCached(ctx.api),
      loadStrategyOptions(ctx.api, { includeArchived: false, force: true }),
    ]);
    const fieldOptions = contextBarOptions(apiOptions);
    const formCtx = applyContextOptions(loadContext(), fieldOptions);
    studioState.strategyOptions = strategyOptions;
    if (query.strategy && query.version) {
      studioState.selectedStrategyPick = `js:${query.strategy}:${query.version}`;
    } else {
      studioState.selectedStrategyPick = resolveInitialStrategyPick(strategyOptions, {
        strategyId: query.strategy,
        versionId: query.version,
      });
    }
    if (studioState.selectedStrategyPick) {
      saveLastStrategyPick(studioState.selectedStrategyPick);
    }

    renderConfigPanel(ctx, { formCtx, fieldOptions });
    void refreshCoverageIndicator(ctx, formCtx);

    const runsPromise = refreshRuns(ctx, { force: true });
    if (studioState.selectedRunId) {
      await Promise.all([runsPromise, loadRunDetail(ctx, studioState.selectedRunId, { routeToken })]);
    } else {
      await runsPromise;
      if ((ctx.getRouteToken?.() ?? routeToken) !== routeToken) return;
      showStudioEmptyMain(document.getElementById('studio-main'));
    }
    if ((ctx.getRouteToken?.() ?? routeToken) !== routeToken) return;
    bindSse(ctx);
    if (!shortcutsBound) {
      bindShortcuts(ctx);
      shortcutsBound = true;
    }
  } catch (err) {
    console.error('renderStudio failed:', err);
    mount(ctx.contentEl, el('section', { class: 'card card--error' }, [
      el('h2', { class: 'card__title' }, 'Falha ao carregar o Estúdio'),
      el('p', {}, err?.message || String(err)),
    ]));
  }
}

function renderConfigPanel(ctx, { formCtx, fieldOptions }) {
  const wrap = document.getElementById('studio-config');
  if (!wrap) return;
  mount(wrap, el('div', { class: 'card studio-config-card' }, [
    el('div', { class: 'card__header' }, [
      el('div', {}, [
        el('h2', { class: 'card__title' }, 'Configurar'),
        el('p', { class: 'card__sub' }, 'Parâmetros do backtest'),
      ]),
    ]),
    el('form', { id: 'studio-form', class: 'studio-form' }, [
      el('div', { class: 'studio-form__scroll' }, [
        el('div', { id: 'studio-strategy-pick' }),
        el('div', { class: 'studio-form__grid' }, [
          el('label', { class: 'field' }, [
            el('div', { class: 'field__label-row' }, [
              el('span', { class: 'field__label' }, 'De'),
              el('span', { id: 'studio-coverage-indicator', class: 'studio-coverage-slot' }),
            ]),
            el('input', { type: 'date', name: 'from', value: formCtx.from, class: 'field__input', onchange: () => refreshCoverageIndicator(ctx, formFromDom()) }),
          ]),
          el('label', { class: 'field' }, [
            el('span', { class: 'field__label' }, 'Até'),
            el('input', { type: 'date', name: 'to', value: formCtx.to, class: 'field__input', onchange: () => refreshCoverageIndicator(ctx, formFromDom()) }),
          ]),
        ]),
        el('div', { class: 'studio-form__grid' }, [
          el('label', { class: 'field' }, [
            el('span', { class: 'field__label' }, 'Ativo'),
            selectField('underlying', fieldOptions.underlyings || [formCtx.underlying], formCtx.underlying),
          ]),
          el('label', { class: 'field' }, [
            el('span', { class: 'field__label' }, 'Intervalo'),
            selectField('interval', fieldOptions.intervals || [formCtx.interval], formCtx.interval),
          ]),
        ]),
        renderConfigExtraFields({ formCtx, fieldOptions }),
      ]),
      el('div', { class: 'studio-form__actions' }, [
        el('button', { class: 'btn btn--primary studio-run-btn', type: 'submit' }, 'Rodar backtest'),
        el('button', { class: 'btn btn--ghost studio-fix-cta', type: 'button', id: 'studio-fix-btn' }, 'Corrigir dados'),
      ]),
    ]),
  ]));

  mountStudioStrategyPicker(ctx);

  document.getElementById('studio-form')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    runBacktest(ctx, ev.target);
  });
  document.getElementById('studio-fix-btn')?.addEventListener('click', () => fixDataFromStudio(ctx));

}

function mountStudioStrategyPicker(ctx) {
  const strategyPickWrap = document.getElementById('studio-strategy-pick');
  if (!strategyPickWrap) return;

  const pinBtn = el('button', {
    type: 'button',
    class: 'studio-strategy-pin',
    id: 'studio-strategy-pin',
    title: 'Fixar versão padrão',
    'aria-label': 'Fixar versão padrão',
    onclick: (event) => {
      event.preventDefault();
      event.stopPropagation();
      void pinStudioStrategyVersion(ctx);
    },
  }, el('i', { class: 'fa-regular fa-star', 'aria-hidden': 'true' }));
  pinBtn.addEventListener('mousedown', (event) => event.preventDefault());

  strategyPickWrap.querySelector('.studio-strategy-picker')
    ?.dispatchEvent(new CustomEvent('studio-strategy-picker:destroy'));

  strategyPickWrap.replaceChildren(renderStrategyPicker(
    studioState.strategyOptions,
    studioState.selectedStrategyPick,
    (value) => {
      studioState.selectedStrategyPick = value;
      saveLastStrategyPick(value);
      const [, sid, vid] = String(value).split(':');
      pushStudioQuery({ strategy: Number(sid) || null, version: Number(vid) || null });
      updateStudioPinState();
      refreshRuns(ctx);
    },
    pinBtn,
  ));

  updateStudioPinState();
}

function updateStudioPinState() {
  const pinBtn = document.getElementById('studio-strategy-pin');
  if (!pinBtn) return;

  const pick = studioState.selectedStrategyPick
    || document.querySelector('#studio-form [name="strategy_pick"]')?.value;
  const group = getStrategyGroupFromPick(studioState.strategyOptions, pick);
  const [, , vid] = String(pick || '').split(':');
  const version = group?.versions.find((v) => String(v.versionId) === String(vid));

  if (!group || !version) {
    pinBtn.disabled = true;
    pinBtn.classList.remove('is-active');
    pinBtn.setAttribute('aria-pressed', 'false');
    return;
  }

  const isDefault = String(group.defaultVersionId) === String(version.versionId);
  pinBtn.disabled = false;
  pinBtn.classList.toggle('is-active', isDefault);
  pinBtn.setAttribute('aria-pressed', isDefault ? 'true' : 'false');
  pinBtn.title = isDefault ? 'Versão padrão fixada' : 'Fixar esta versão como padrão';
  const icon = pinBtn.querySelector('i');
  if (icon) icon.className = isDefault ? 'fa-solid fa-star' : 'fa-regular fa-star';
}

async function pinStudioStrategyVersion(ctx) {
  const pick = studioState.selectedStrategyPick
    || document.querySelector('#studio-form [name="strategy_pick"]')?.value;
  const [, sid, vid] = String(pick || '').split(':');
  const strategyId = Number(sid);
  const versionId = Number(vid);
  if (!Number.isFinite(strategyId) || !Number.isFinite(versionId)) {
    return ctx.toast.warn('Selecione uma estratégia e versão');
  }

  const res = await ctx.api.patch(`/api/strategies/${strategyId}`, { default_version_id: versionId });
  if (!res.ok) return ctx.toast.err(res.error?.message || 'Falha ao fixar versão');

  studioState.selectedStrategyPick = `js:${strategyId}:${versionId}`;
  saveLastStrategyPick(studioState.selectedStrategyPick);
  notifyStudioCatalogChanged();
  ctx.toast.ok('Versão fixada como padrão');
}

function formFromDom() {
  const form = document.getElementById('studio-form');
  if (!form) return loadContext();
  const fd = new FormData(form);
  return {
    from: fd.get('from'),
    to: fd.get('to'),
    underlying: fd.get('underlying'),
    interval: fd.get('interval'),
    book_depth: fd.get('book_depth'),
  };
}

async function refreshCoverageIndicator(ctx, formCtx) {
  const elWrap = document.getElementById('studio-coverage-indicator');
  if (!elWrap) return;
  const q = new URLSearchParams({
    underlying: formCtx.underlying,
    interval: formCtx.interval,
    book_depth: formCtx.book_depth,
    from: formCtx.from,
    to: formCtx.to,
  });
  const res = await ctx.api.get(`/api/data/coverage?${q}`);
  if (!res.ok) {
    mount(elWrap, renderCoverageStatus('idle', 'idle', {
      icon: 'fa-circle-question',
      label: '—',
      title: 'Cobertura indisponível',
    }));
    return;
  }
  const summary = res.data.coverage?.summary || {};
  studioState.coverageUi = res.data.coverage;
  let state = 'ready';
  if (summary.attention > 0) state = 'attention';
  else if (summary.processing > 0) state = 'processing';
  const tone = state === 'ready' ? 'ok' : (state === 'processing' ? 'warn' : 'err');
  const meta = {
    ready: { icon: 'fa-circle-check', label: 'Pronto', title: 'Dados prontos para o período' },
    processing: { icon: 'fa-spinner fa-spin', label: 'Sync', title: 'Sincronizando dados do período' },
    attention: { icon: 'fa-triangle-exclamation', label: 'Atenção', title: 'Há dias que precisam de correção' },
    idle: { icon: 'fa-circle-question', label: '—', title: 'Cobertura indisponível' },
  }[state];
  mount(elWrap, [
    renderCoverageStatus(state, tone, meta),
    state === 'attention'
      ? el('button', {
        type: 'button',
        class: 'studio-coverage-fix',
        title: 'Corrigir dados do período',
        'aria-label': 'Corrigir dados do período',
        onclick: () => fixDataFromStudio(ctx),
      }, el('i', { class: 'fa-solid fa-wrench', 'aria-hidden': 'true' }))
      : null,
  ]);
}

function renderCoverageStatus(state, tone, { icon, label, title }) {
  return el('span', {
    class: `studio-coverage-status studio-coverage-status--${tone}`,
    title,
    'aria-label': title,
  }, [
    el('i', { class: `fa-solid ${icon}`, 'aria-hidden': 'true' }),
    el('span', { class: 'studio-coverage-status__label' }, label),
  ]);
}

async function fixDataFromStudio(ctx) {
  const form = document.getElementById('studio-form');
  const fd = new FormData(form);
  const request = {
    dataset: 'backtest_ticks',
    from: fd.get('from'),
    to: fd.get('to'),
    underlying: fd.get('underlying'),
    interval: fd.get('interval'),
    book_depth: Number(fd.get('book_depth')),
  };
  const preview = await ctx.api.post('/api/data/fix', { request, dry_run: true });
  if (!preview.ok) return ctx.toast.err(preview.error?.message || 'Erro');
  const lines = preview.data.summary_lines || [];
  const ok = await confirmDialog({
    title: 'Corrigir dados',
    message: lines.length ? 'Revisar o plano antes de executar.' : 'Executar correção?',
    detail: lines.length ? lines.join('\n') : undefined,
    confirmLabel: 'Executar',
    tone: 'primary',
  });
  if (!ok) return;
  const fix = await ctx.api.post('/api/data/fix', { request, confirm_rebuild: preview.data.needs_rebuild_confirm || undefined });
  if (!fix.ok) return ctx.toast.err(fix.error?.message || 'Falha');
  ctx.toast.ok(fix.data.job ? `Job #${fix.data.job.id} criado` : 'Dados prontos');
  await refreshCoverageIndicator(ctx, formFromDom());
}

async function runBacktest(ctx, form) {
  const fd = new FormData(form);
  const pick = studioState.selectedStrategyPick
    || fd.get('strategy_pick')
    || form.querySelector('[name="strategy_pick"]')?.value;
  if (!pick) return ctx.toast.warn('Selecione uma estratégia');

  const ctxSaved = saveContext({
    from: fd.get('from'),
    to: fd.get('to'),
    underlying: fd.get('underlying'),
    interval: fd.get('interval'),
    book_depth: fd.get('book_depth'),
    batch_size: fd.get('batch_size'),
  });
  const payload = backtestPayloadFromPick(pick, ctxSaved, {
    fast_run: fd.get('fast_run') === '1',
    async: true,
  });
  if (!payload?.strategy_id || !payload?.strategy_version_id) {
    return ctx.toast.warn('Selecione uma estratégia e versão válidas');
  }
  const res = await ctx.api.post('/api/backtest/run', payload);
  if (!res.ok) {
    if (res.data?.availability) {
      const fix = await confirmDialog({
        title: 'Dados não prontos',
        message: 'Corrigir e enfileirar o backtest?',
        confirmLabel: 'Corrigir e enfileirar',
        tone: 'primary',
      });
      if (fix) {
        const fixRes = await ctx.api.post('/api/data/fix', { request: {
          dataset: 'backtest_ticks', ...ctxSaved, book_depth: Number(ctxSaved.book_depth),
        }});
        if (fixRes.ok && fixRes.data.job) {
          const retry = await ctx.api.post('/api/backtest/run', { ...payload, depends_on_job: fixRes.data.job.id });
          if (retry.ok) {
            studioState.selectedRunId = retry.data.run.id;
            pushStudioQuery({ run: studioState.selectedRunId, event: null });
            await refreshRuns(ctx);
            await loadRunDetail(ctx, studioState.selectedRunId);
            switchMobileTab('main');
            return ctx.toast.ok('Backtest aguardando dados');
          }
        }
      }
    }
    return ctx.toast.err(res.error?.message || 'Falha ao rodar');
  }
  cacheInvalidate('runs');
  studioState.selectedRunId = res.data.run.id;
  pushStudioQuery({ run: studioState.selectedRunId, event: null });
  await refreshRuns(ctx);
  await loadRunDetail(ctx, studioState.selectedRunId);
  switchMobileTab('main');
  ctx.toast.ok('Backtest enfileirado');
}

function computeRunStats(runs, strategyId) {
  const filtered = runs.filter((r) => !strategyId || Number(r.strategy_id) === Number(strategyId));
  const completed = filtered.filter((r) => (r.status || 'completed') === 'completed');
  const profitable = completed.filter((r) => Number(r.summary?.totalPnl ?? 0) > 0);
  const totalPnl = completed.reduce((s, r) => s + Number(r.summary?.totalPnl ?? 0), 0);
  const bestPnl = completed.length ? Math.max(...completed.map((r) => Number(r.summary?.totalPnl ?? 0))) : 0;
  const winRate = filtered.length ? Math.round((profitable.length / filtered.length) * 100) : 0;
  return { total: filtered.length, totalPnl, bestPnl, winRate };
}

const RUN_STATUS_LABELS = {
  all: 'Todos',
  running: 'Rodando',
  completed: 'Concluído',
  failed_runtime: 'Falhou',
  cancelled: 'Cancelado',
  partial: 'Parcial',
  queued: 'Na fila',
};

const RUN_SORT_LABELS = {
  newest: 'Mais recentes',
  best_pnl: 'Melhor PnL',
  worst_pnl: 'Pior PnL',
};

const RUN_PNL_LABELS = {
  all: 'Qualquer PnL',
  positive: 'Lucrativos',
  negative: 'Prejuízo',
  zero: 'Zero',
};

function countAdvancedRunFilters() {
  const f = studioState.runFilters;
  let count = 0;
  if (f.versionId !== 'all') count += 1;
  if (!f.strategyOnly) count += 1;
  if (f.underlying !== 'all') count += 1;
  if (f.interval !== 'all') count += 1;
  if (f.status !== 'all') count += 1;
  if (f.pnl !== 'all') count += 1;
  if (f.groupByVersion) count += 1;
  return count;
}

function resetAdvancedRunFilters() {
  studioState.runFilters.versionId = 'all';
  studioState.runFilters.strategyOnly = true;
  studioState.runFilters.underlying = 'all';
  studioState.runFilters.interval = 'all';
  studioState.runFilters.status = 'all';
  studioState.runFilters.pnl = 'all';
  studioState.runFilters.groupByVersion = false;
}

function renderActiveFilterChips() {
  const f = studioState.runFilters;
  const chips = [];
  if (f.versionId !== 'all') {
    const label = f.versionId === 'selected' ? 'Versão atual' : `Versão ${f.versionId}`;
    chips.push(label);
  }
  if (!f.strategyOnly) chips.push('Estratégias ativas');
  if (f.underlying !== 'all') chips.push(f.underlying);
  if (f.interval !== 'all') chips.push(formatIntervalLabel(f.interval));
  if (f.status !== 'all') chips.push(RUN_STATUS_LABELS[f.status] || f.status);
  if (f.pnl !== 'all') chips.push(RUN_PNL_LABELS[f.pnl] || f.pnl);
  if (f.groupByVersion) chips.push('Agrupado');
  if (!chips.length) return null;
  return el('div', { class: 'studio-run-filters__chips' }, chips.map((label) => (
    el('span', { class: 'studio-runs-chip' }, label)
  )));
}

function selectedConfigVersionId() {
  const [, , vid] = String(studioState.selectedStrategyPick || '').split(':');
  const parsed = Number(vid);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function shortVersionNotes(notes) {
  const text = String(notes || '').trim();
  if (!text) return '';
  return text.replace(/^Preset\s+v\d+:\s*/i, '').slice(0, 32);
}

function versionBadgeLabel(run) {
  if (run.strategy_snapshot?.version != null) return `v${run.strategy_snapshot.version}`;
  if (run.strategy_version_id) return `#${run.strategy_version_id}`;
  return '—';
}

function versionFilterLabel(entry) {
  if (entry.notes) {
    const short = shortVersionNotes(entry.notes);
    return short ? `v${entry.versionNum} · ${short}` : `v${entry.versionNum}`;
  }
  return `v${entry.versionNum}`;
}

function collectVersionFilterOptions(runs, strategyGroup) {
  const options = [{ value: 'all', label: 'Todas versões' }];
  const selectedVid = selectedConfigVersionId();
  if (selectedVid) {
    const current = strategyGroup?.versions?.find((v) => Number(v.versionId) === selectedVid);
    options.push({
      value: 'selected',
      label: current?.versionNum != null ? `Versão atual (v${current.versionNum})` : 'Versão atual',
    });
  }

  const versionMap = new Map();
  if (strategyGroup) {
    for (const version of strategyGroup.versions) {
      versionMap.set(Number(version.versionId), {
        versionId: Number(version.versionId),
        versionNum: version.versionNum,
        notes: version.notes,
      });
    }
  } else {
    for (const opt of studioState.strategyOptions) {
      const vid = Number(opt.versionId);
      if (!Number.isFinite(vid) || vid <= 0 || versionMap.has(vid)) continue;
      versionMap.set(vid, {
        versionId: vid,
        versionNum: opt.versionNum ?? vid,
        notes: opt.notes ?? null,
      });
    }
  }

  const sorted = [...versionMap.values()].sort((a, b) => (b.versionNum ?? 0) - (a.versionNum ?? 0));
  for (const entry of sorted) {
    options.push({ value: String(entry.versionId), label: versionFilterLabel(entry) });
  }
  return options;
}

function collectRunFacetOptions(runs, key) {
  const values = new Set();
  for (const run of runs) {
    const value = run[key];
    if (value) values.add(String(value));
  }
  return [{ value: 'all', label: key === 'underlying' ? 'Todos ativos' : 'Todos intervalos' }, ...[...values].sort().map((value) => ({
    value,
    label: key === 'interval' ? formatIntervalLabel(value) : value,
  }))];
}

function formatRunPeriodShort(from, to) {
  const fmt = (iso) => {
    if (!iso) return '?';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(5, 10);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  };
  return `${fmt(from)} – ${fmt(to)}`;
}

function buildPickerLinkage(strategyOptions) {
  const strategyIds = new Set();
  const versionIds = new Set();
  for (const opt of strategyOptions) {
    const sid = Number(opt.strategyId);
    const vid = Number(opt.versionId);
    if (Number.isFinite(sid) && sid > 0) strategyIds.add(sid);
    if (Number.isFinite(vid) && vid > 0) versionIds.add(vid);
  }
  return { strategyIds, versionIds };
}

function isPickerLinkedRun(run, linkage) {
  const sid = run.strategy_id != null ? Number(run.strategy_id) : NaN;
  const vid = run.strategy_version_id != null ? Number(run.strategy_version_id) : NaN;
  if (!Number.isFinite(sid) || !Number.isFinite(vid)) return false;
  return linkage.strategyIds.has(sid) && linkage.versionIds.has(vid);
}

function filterRuns(runs) {
  const pick = studioState.strategyOptions.find((o) => o.value === studioState.selectedStrategyPick);
  const selectedVid = selectedConfigVersionId();
  const f = studioState.runFilters;
  const linkage = buildPickerLinkage(studioState.strategyOptions);

  return runs.filter((run) => {
    if (!isPickerLinkedRun(run, linkage)) return false;
    if (f.strategyOnly && pick?.strategyId && Number(run.strategy_id) !== Number(pick.strategyId)) return false;
    if (f.status !== 'all' && (run.status || 'completed') !== f.status) return false;
    if (f.underlying !== 'all' && run.underlying !== f.underlying) return false;
    if (f.interval !== 'all' && run.interval !== f.interval) return false;
    if (f.pnl === 'positive' && Number(run.summary?.totalPnl ?? 0) <= 0) return false;
    if (f.pnl === 'negative' && Number(run.summary?.totalPnl ?? 0) >= 0) return false;
    if (f.pnl === 'zero' && Number(run.summary?.totalPnl ?? 0) !== 0) return false;
    if (f.versionId === 'selected') {
      if (selectedVid && Number(run.strategy_version_id) !== selectedVid) return false;
    } else if (f.versionId !== 'all' && Number(run.strategy_version_id) !== Number(f.versionId)) {
      return false;
    }
    return true;
  }).sort((a, b) => {
    if (f.sort === 'best_pnl') return Number(b.summary?.totalPnl ?? 0) - Number(a.summary?.totalPnl ?? 0);
    if (f.sort === 'worst_pnl') return Number(a.summary?.totalPnl ?? 0) - Number(b.summary?.totalPnl ?? 0);
    return Number(b.id) - Number(a.id);
  });
}

function strategyName(run) {
  return run.strategy_snapshot?.name || run.strategy || '-';
}

async function refreshRuns(ctx, { force = false } = {}) {
  if (force) cacheInvalidate('runs');
  const runs = await cachedFetch('runs:list', async () => {
    const res = await ctx.api.get('/api/backtest/runs?limit=100');
    return res.ok ? res.data.runs : [];
  }, 15_000);
  const linkage = buildPickerLinkage(studioState.strategyOptions);
  const linkedRuns = runs.filter((run) => isPickerLinkedRun(run, linkage));
  studioState.runs = linkedRuns;
  const panel = document.getElementById('studio-runs');
  if (!panel) return;

  const strategyGroup = getStrategyGroupFromPick(studioState.strategyOptions, studioState.selectedStrategyPick);
  const stats = computeRunStats(linkedRuns, studioState.runFilters.strategyOnly ? strategyGroup?.strategyId : null);
  const scopedRuns = studioState.runFilters.strategyOnly && strategyGroup?.strategyId
    ? linkedRuns.filter((run) => Number(run.strategy_id) === Number(strategyGroup.strategyId))
    : linkedRuns;
  const filtered = filterRuns(linkedRuns);
  const versionOptions = collectVersionFilterOptions(scopedRuns, strategyGroup);
  if (!versionOptions.some((opt) => opt.value === studioState.runFilters.versionId)) {
    studioState.runFilters.versionId = 'all';
  }

  mount(panel, el('div', { class: 'studio-runs-card' }, [
    el('header', { class: 'studio-runs-card__header' }, [
      el('div', { class: 'studio-runs-card__top' }, [
        el('h3', { class: 'studio-runs-card__title' }, 'Histórico'),
        el('span', { class: 'studio-runs-card__count' }, `${filtered.length}${filtered.length !== linkedRuns.length ? ` / ${linkedRuns.length}` : ''}`),
      ]),
      el('div', { class: 'studio-runs-kpis' }, [
        el('span', { class: 'studio-runs-kpi' }, [
          el('strong', {}, String(stats.total)),
          ' runs',
        ]),
        el('span', { class: 'studio-runs-kpi' }, [
          el('strong', { class: stats.totalPnl >= 0 ? 'pnl-good' : 'pnl-bad' }, formatPnl(stats.totalPnl)),
          ' PnL',
        ]),
        el('span', { class: 'studio-runs-kpi' }, [
          el('strong', {}, `${stats.winRate}%`),
          ' WR',
        ]),
      ]),
    ]),
    renderRunFiltersPanel(ctx, { versionOptions, scopedRuns }),
    el('div', { class: 'studio-runs-scroll' }, [
      filtered.length
        ? renderRunList(filtered, ctx)
        : el('p', { class: 'studio-run-list-empty muted' }, 'Nenhum run corresponde aos filtros.'),
    ]),
  ]));
  if (studioState.runFiltersAdvancedOpen) {
    requestAnimationFrame(() => bindAdvancedPopoverDismiss('runs'));
  }
}

function unbindAdvancedPopoverDismiss() {
  if (!advancedPopoverDismissHandler) return;
  document.removeEventListener('click', advancedPopoverDismissHandler, true);
  document.removeEventListener('keydown', advancedPopoverDismissHandler);
  advancedPopoverDismissHandler = null;
}

function closeAdvancedPopover({ silent = false } = {}) {
  const which = activeAdvancedPopover;
  if (which === 'runs') studioState.runFiltersAdvancedOpen = false;
  activeAdvancedPopover = null;
  unbindAdvancedPopoverDismiss();
  document.querySelectorAll('.studio-advanced-popover.is-open').forEach((node) => node.classList.remove('is-open'));
  document.querySelectorAll('.studio-advanced-trigger.is-active').forEach((node) => node.classList.remove('is-active'));
  if (!silent && which) {
    document.getElementById(`studio-${which}-advanced-trigger`)?.focus();
  }
}

function toggleAdvancedPopover(which, ctx) {
  const isOpen = studioState.runFiltersAdvancedOpen;
  if (isOpen && activeAdvancedPopover === which) {
    closeAdvancedPopover();
    return;
  }
  closeAdvancedPopover({ silent: true });
  activeAdvancedPopover = which;
  studioState.runFiltersAdvancedOpen = true;
  document.getElementById(`studio-${which}-advanced-popover`)?.classList.add('is-open');
  document.getElementById(`studio-${which}-advanced-trigger`)?.classList.add('is-active');
  bindAdvancedPopoverDismiss(which);
}

function bindAdvancedPopoverDismiss(which) {
  unbindAdvancedPopoverDismiss();
  activeAdvancedPopover = which;
  advancedPopoverDismissHandler = (event) => {
    if (!activeAdvancedPopover) return;
    if (event.type === 'keydown') {
      if (event.key !== 'Escape') return;
      closeAdvancedPopover();
      return;
    }
    const anchor = document.getElementById(`studio-${activeAdvancedPopover}-advanced-anchor`);
    if (!anchor || anchor.contains(event.target)) return;
    closeAdvancedPopover();
  };
  setTimeout(() => {
    if (!activeAdvancedPopover) return;
    document.addEventListener('click', advancedPopoverDismissHandler, true);
    document.addEventListener('keydown', advancedPopoverDismissHandler);
  }, 0);
}

function renderConfigExtraFields({ formCtx, fieldOptions }) {
  return el('div', { class: 'studio-config-extra' }, [
    el('div', { class: 'studio-form__grid' }, [
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Book'),
        selectField('book_depth', fieldOptions.book_depths || [formCtx.book_depth], formCtx.book_depth),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Batch size'),
        el('input', {
          type: 'number',
          name: 'batch_size',
          min: '1',
          value: formCtx.batch_size || 5000,
          class: 'field__input',
        }),
      ]),
    ]),
    el('label', { class: 'switch-field studio-config-extra__switch' }, [
      el('input', { type: 'checkbox', name: 'fast_run', value: '1', class: 'switch-field__input' }),
      el('span', { class: 'switch-field__slider' }),
      ' Modo rápido',
    ]),
  ]);
}

function buildRunsAdvancedFilterFields(ctx, { versionOptions, underlyingOptions, intervalOptions, advancedCount }) {
  const f = studioState.runFilters;
  return [
    filterSelect('Versão', f.versionId, versionOptions, (v) => {
      studioState.runFilters.versionId = v;
      refreshRuns(ctx);
    }),
    el('label', { class: 'field field--checkbox' }, [
      el('input', {
        type: 'checkbox',
        checked: f.strategyOnly,
        onchange: (e) => {
          studioState.runFilters.strategyOnly = e.target.checked;
          if (!e.target.checked) studioState.runFilters.groupByVersion = false;
          refreshRuns(ctx);
        },
      }),
      ' Só esta estratégia',
    ]),
    filterSelect('Ativo', f.underlying, underlyingOptions, (v) => {
      studioState.runFilters.underlying = v;
      refreshRuns(ctx);
    }),
    filterSelect('Intervalo', f.interval, intervalOptions, (v) => {
      studioState.runFilters.interval = v;
      refreshRuns(ctx);
    }),
    filterSelect('Status', f.status, [
      { value: 'all', label: RUN_STATUS_LABELS.all },
      { value: 'running', label: RUN_STATUS_LABELS.running },
      { value: 'queued', label: RUN_STATUS_LABELS.queued },
      { value: 'completed', label: RUN_STATUS_LABELS.completed },
      { value: 'failed_runtime', label: RUN_STATUS_LABELS.failed_runtime },
      { value: 'cancelled', label: RUN_STATUS_LABELS.cancelled },
    ], (v) => {
      studioState.runFilters.status = v;
      refreshRuns(ctx);
    }),
    filterSelect('PnL', f.pnl, [
      { value: 'all', label: RUN_PNL_LABELS.all },
      { value: 'positive', label: RUN_PNL_LABELS.positive },
      { value: 'negative', label: RUN_PNL_LABELS.negative },
      { value: 'zero', label: RUN_PNL_LABELS.zero },
    ], (v) => {
      studioState.runFilters.pnl = v;
      refreshRuns(ctx);
    }),
    el('label', { class: 'field field--checkbox' }, [
      el('input', {
        type: 'checkbox',
        checked: f.groupByVersion,
        disabled: !f.strategyOnly,
        onchange: (e) => {
          studioState.runFilters.groupByVersion = e.target.checked;
          refreshRuns(ctx);
        },
      }),
      ' Agrupar por versão',
    ]),
    advancedCount > 0
      ? el('div', { class: 'studio-advanced-popover__footer' }, [
        el('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm',
          onclick: () => {
            resetAdvancedRunFilters();
            refreshRuns(ctx);
          },
        }, 'Limpar filtros'),
      ])
      : null,
  ];
}

function renderRunsAdvancedPopover(ctx, { versionOptions, underlyingOptions, intervalOptions, advancedCount }) {
  const open = studioState.runFiltersAdvancedOpen;
  return el('div', { class: 'studio-advanced-anchor', id: 'studio-runs-advanced-anchor' }, [
    el('button', {
      type: 'button',
      id: 'studio-runs-advanced-trigger',
      class: `btn btn--ghost btn--sm studio-advanced-trigger${open ? ' is-active' : ''}${advancedCount > 0 ? ' has-filters' : ''}`,
      'aria-expanded': open ? 'true' : 'false',
      'aria-controls': 'studio-runs-advanced-popover',
      onclick: (event) => {
        event.stopPropagation();
        toggleAdvancedPopover('runs', ctx);
      },
    }, advancedCount > 0 ? `Avançado · ${advancedCount}` : 'Avançado'),
    el('div', {
      id: 'studio-runs-advanced-popover',
      class: `studio-advanced-popover studio-advanced-popover--runs${open ? ' is-open' : ''}`,
      role: 'dialog',
      'aria-label': 'Filtros avançados do histórico',
      onclick: (event) => event.stopPropagation(),
    }, [
      el('div', { class: 'studio-advanced-popover__head' }, [
        el('strong', {}, 'Filtros avançados'),
        el('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm',
          onclick: () => closeAdvancedPopover(),
        }, 'Fechar'),
      ]),
      el('div', { class: 'studio-advanced-popover__body studio-form studio-advanced-popover__body--grid' },
        buildRunsAdvancedFilterFields(ctx, { versionOptions, underlyingOptions, intervalOptions, advancedCount })),
    ]),
  ]);
}

function renderRunFiltersPanel(ctx, { versionOptions, scopedRuns }) {
  const underlyingOptions = collectRunFacetOptions(scopedRuns, 'underlying');
  const intervalOptions = collectRunFacetOptions(scopedRuns, 'interval');
  const advancedCount = countAdvancedRunFilters();
  const f = studioState.runFilters;

  return el('section', { class: 'studio-runs-toolbar studio-form' }, [
    filterSelect('Ordem', f.sort, [
      { value: 'newest', label: RUN_SORT_LABELS.newest },
      { value: 'best_pnl', label: RUN_SORT_LABELS.best_pnl },
      { value: 'worst_pnl', label: RUN_SORT_LABELS.worst_pnl },
    ], (v) => {
      studioState.runFilters.sort = v;
      refreshRuns(ctx);
    }),
    renderRunsAdvancedPopover(ctx, { versionOptions, underlyingOptions, intervalOptions, advancedCount }),
    renderActiveFilterChips(),
  ]);
}

function renderRunList(runs, ctx) {
  if (!studioState.runFilters.groupByVersion) {
    return el('div', { class: 'studio-run-list' }, runs.map((run) => runListItem(run, ctx)));
  }

  const groups = new Map();
  for (const run of runs) {
    const key = versionBadgeLabel(run);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }

  const sortedGroups = [...groups.entries()].sort((left, right) => {
    const leftNum = Number(String(left[0]).replace(/[^\d]/g, '')) || 0;
    const rightNum = Number(String(right[0]).replace(/[^\d]/g, '')) || 0;
    return rightNum - leftNum;
  });

  return el('div', { class: 'studio-run-list studio-run-list--grouped' }, sortedGroups.map(([label, groupRuns]) => el('section', { class: 'studio-run-group' }, [
    el('div', { class: 'studio-run-group__head' }, [
      el('span', { class: 'studio-run-group__version' }, label),
      el('span', { class: 'studio-run-group__count muted' }, `${groupRuns.length} run${groupRuns.length === 1 ? '' : 's'}`),
    ]),
    el('div', { class: 'studio-run-group__items' }, groupRuns.map((run) => runListItem(run, ctx))),
  ])));
}

function filterSelect(label, value, options, onChange) {
  const normalized = options.map((opt) => (
    typeof opt === 'string' ? { value: opt, label: opt } : opt
  ));
  return el('label', { class: 'field' }, [
    el('span', { class: 'field__label' }, label),
    el('select', {
      class: 'field__select',
      onchange: (e) => onChange(e.target.value),
    }, normalized.map((opt) => el('option', { value: opt.value, selected: opt.value === value }, opt.label))),
  ]);
}

function runListItem(run, ctx) {
  const active = studioState.selectedRunId === run.id;
  const compareOn = studioState.compareIds.includes(run.id);
  const pnlVal = Number(run.summary?.totalPnl ?? 0);
  const pnlTone = run.status === 'completed' || run.status === 'partial'
    ? (pnlVal > 0 ? 'good' : pnlVal < 0 ? 'bad' : 'idle')
    : 'idle';
  let pnlText = formatPnl(run.summary?.totalPnl);
  if (run.status === 'running') pnlText = `${run.progress?.percent?.toFixed(0) || 0}%`;
  else if (run.status === 'queued') pnlText = run.progress?.depends_on_job ? 'Aguardando' : 'Fila';
  else if (run.status === 'cancelled') pnlText = 'Cancelado';

  const versionText = versionBadgeLabel(run);
  const versionNotes = shortVersionNotes(run.strategy_snapshot?.notes);
  const showStrategyName = !studioState.runFilters.strategyOnly;
  const interval = run.interval || '—';

  return el('button', {
    type: 'button',
    id: `run-item-${run.id}`,
    class: `studio-run-item${active ? ' is-active' : ''}${compareOn ? ' is-compare' : ''}`,
    title: `${strategyName(run)} ${versionText} · ${formatRunAssetMeta(run)} · ${formatRunPeriodShort(run.from, run.to)}`,
    onclick: (ev) => {
      if (ev.shiftKey) toggleCompare(run.id);
      else selectRun(ctx, run.id);
    },
  }, [
    el('div', { class: 'studio-run-item__accent' }),
    el('div', { class: 'studio-run-item__body' }, [
      el('div', { class: 'studio-run-item__row studio-run-item__row--head' }, [
        el('span', { class: 'studio-run-item__version', title: versionNotes || versionText }, versionText),
        el('span', { class: 'studio-run-item__id' }, `#${run.id}`),
        StatusBadge({ status: run.status }),
        el('span', { class: `studio-run-item__pnl pnl-${pnlTone}` }, pnlText),
      ]),
      el('div', { class: 'studio-run-item__row studio-run-item__row--meta' }, [
        el('span', { class: 'studio-run-item__asset' }, run.underlying || '—'),
        el('span', { class: `interval-badge interval-badge--sm ${intervalBadgeClass(interval)}` }, formatIntervalLabel(interval)),
        showStrategyName
          ? el('span', { class: 'studio-run-item__strategy muted' }, strategyName(run))
          : el('span', { class: 'studio-run-item__period muted' }, formatRunPeriodShort(run.from, run.to)),
      ]),
    ]),
  ]);
}

function toggleCompare(id) {
  const set = new Set(studioState.compareIds);
  if (set.has(id)) set.delete(id);
  else if (set.size < 4) set.add(id);
  studioState.compareIds = [...set];
  pushStudioQuery({ compare: studioState.compareIds });
  if (studioCtx && studioState.selectedRunId) {
    loadRunDetail(studioCtx, studioState.selectedRunId);
    refreshRuns(studioCtx);
  }
}

async function selectRun(ctx, id) {
  studioState.selectedRunId = id;
  studioState.selectedEventId = null;
  studioState.eventsOffset = 0;
  pushStudioQuery({ run: id, event: null });
  await Promise.all([refreshRuns(ctx), loadRunDetail(ctx, id)]);
  switchMobileTab('main');
}

async function loadRunDetail(ctx, runId, { routeToken = ctx.getRouteToken?.() ?? 0, generation = null } = {}) {
  const main = document.getElementById('studio-main');
  if (!main) return;
  if (generation != null && generation !== progressPollGeneration) return;
  if ((ctx.getRouteToken?.() ?? routeToken) !== routeToken) return;
  resetMetricsViewMode();
  clearProgressPoll();

  if (studioState.compareIds.length >= 2) {
    const res = await ctx.api.get(`/api/backtest/compare?ids=${studioState.compareIds.join(',')}`);
    if (res.ok) return renderCompare(main, res.data);
  }

  const runRes = await ctx.api.get(`/api/backtest/runs/${runId}?slim=1&equity=1`);
  if ((ctx.getRouteToken?.() ?? routeToken) !== routeToken) return;
  if (!runRes.ok) return mount(main, el('p', { class: 'muted' }, 'Run não encontrado'));
  const run = runRes.data.run;
  studioState.selectedRunMeta = {
    underlying: run.underlying,
    interval: run.interval,
  };

  if (run.status === 'queued' || run.status === 'running') {
    renderProgressPanel(main, run, ctx);
    return;
  }
  if (run.status === 'cancelled') {
    renderCancelledPanel(main, run, ctx);
    return;
  }
  if (run.status === 'failed_runtime' || run.status === 'failed') {
    renderFailedRunPanel(main, run, ctx);
    return;
  }

  const summary = run.summary || {};
  mount(main, el('div', { class: 'studio-result' }, [
    renderRunContextBanner(run),
    renderRunMetricsPanel(summary, { cardId: 'studio-metrics-card', equity: run.equity }),
    el('div', { class: 'card card--compact studio-equity-card' }, [
      el('div', { class: 'card__header studio-equity-card__title-row' }, [
        el('h2', { class: 'card__title' }, 'Curva de patrimônio'),
        run.equity?.length
          ? el('span', { class: 'studio-equity-card__caption muted' }, equityDrawdownCaption(run.equity))
          : null,
      ]),
      el('div', { class: 'studio-equity', id: 'studio-equity-chart', style: { padding: '16px 8px' } }),
    ]),
    el('div', { id: 'studio-selected-event-container', class: 'studio-selected-event-container' }),
    renderNoEntryDiagnostic(summary, studioState.events),
    el('div', { class: 'card studio-events-card' }, [
      el('div', { class: 'card__header' }, [
        el('h2', { class: 'card__title' }, 'Eventos executados'),
      ]),
      el('div', { style: { padding: '0 20px 20px 20px' } }, [
        el('div', { class: 'studio-tabs', style: { marginTop: '0', marginBottom: '12px' } }, [
          el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => showAnalysisTab(ctx, runId, run, summary) }, 'Análise'),
          el('button', { class: 'btn btn--ghost is-active', type: 'button' }, 'Eventos'),
        ]),
        el('div', { class: 'studio-events-filter-bar', style: { marginTop: '0', marginBottom: '16px' } }, buildEventFilters(ctx, runId)),
        el('div', { id: 'studio-events-table-container' }),
      ]),
    ]),
  ]));

  if (run.equity?.length) {
    renderUplotLine(
      document.getElementById('studio-equity-chart'),
      run.equity.map((p) => [new Date(p.ts).getTime(), p.pnl]),
      [],
      { primaryLabel: 'PnL', primaryColor: '#34d399', height: 220 },
    );
  }
  
  renderSelectedEventContainerPlaceholder();

  studioState.eventsOffset = 0;
  const eventsContainer = document.getElementById('studio-events-table-container');
  if (eventsContainer) mount(eventsContainer, Skeleton({ lines: 4 }));
  void loadEvents(ctx, runId, { append: false }).then(() => {
    if (studioState.selectedEventId && studioState.selectedRunId === runId) {
      const idx = studioState.events.findIndex((ev) => ev.id === studioState.selectedEventId);
      selectEventAndRenderInline(ctx, runId, studioState.selectedEventId, idx >= 0 ? idx : 0, { syncUrl: false });
    }
  });
}

function buildEventFilters(ctx, runId) {
  return [
    el('div', { class: 'field' }, [
      el('span', { class: 'field__label' }, 'Buscar'),
      el('input', {
        type: 'text',
        class: 'field__input',
        value: studioState.filterQ,
        oninput: debounce((ev) => { studioState.filterQ = ev.target.value; studioState.eventsOffset = 0; loadEvents(ctx, runId); }, 250),
      }),
    ]),
    el('div', { class: 'field' }, [
      el('span', { class: 'field__label' }, 'Resultado'),
      el('select', {
        class: 'field__input',
        onchange: (ev) => { studioState.filterResult = ev.target.value; studioState.eventsOffset = 0; loadEvents(ctx, runId); },
      }, [
        { value: 'all_with_entries', label: 'Todos com Entrada' },
        { value: 'all', label: 'Todos os Eventos' },
        { value: 'win', label: 'Ganho' },
        { value: 'loss', label: 'Perda' },
        { value: 'breakeven', label: 'Empate' },
        { value: 'no_entry', label: 'Sem Entrada (Oculto)' }
      ].map((item) => el('option', { value: item.value, selected: studioState.filterResult === item.value }, item.label))),
    ]),
    el('button', {
      type: 'button',
      class: 'btn btn--ghost',
      onclick: () => {
        const params = new URLSearchParams({ format: 'csv', limit: '5000', q: studioState.filterQ, result: studioState.filterResult, sort: studioState.filterSort });
        window.open(`/api/backtest/runs/${runId}/events?${params}`, '_blank');
      },
    }, 'Exportar CSV'),
  ];
}

async function loadEvents(ctx, runId, { append = false } = {}) {
  const q = new URLSearchParams();
  q.set('limit', String(EVENTS_PAGE));
  q.set('offset', String(append ? studioState.eventsOffset : 0));
  if (studioState.filterQ) q.set('q', studioState.filterQ);
  if (studioState.filterResult !== 'all') q.set('result', studioState.filterResult);
  if (studioState.filterSort) q.set('sort', studioState.filterSort);

  const res = await ctx.api.get(`/api/backtest/runs/${runId}/events?${q.toString()}`);
  const page = res.ok ? res.data.events : [];
  if (append) {
    const room = Math.max(0, MAX_STUDIO_EVENTS - studioState.events.length);
    studioState.events.push(...page.slice(0, room));
  } else {
    studioState.events = page.slice(0, MAX_STUDIO_EVENTS);
  }
  studioState.eventsOffset = studioState.events.length;
  studioState.eventsHasMore = page.length === EVENTS_PAGE && studioState.events.length < MAX_STUDIO_EVENTS;

  const tableContainer = document.getElementById('studio-events-table-container');
  if (!tableContainer) return;
  mount(tableContainer, el('div', {}, [
    renderVirtualEventTable(studioState.events, ctx, runId),
    studioState.eventsHasMore ? el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--sm',
      onclick: () => loadEvents(ctx, runId, { append: true }),
    }, 'Carregar mais eventos') : null,
  ]));
}

async function showAnalysisTab(ctx, runId, run, summary) {
  const main = document.getElementById('studio-main');
  mount(main, el('div', { class: 'studio-analysis' }, [
    renderRunContextBanner(run, { showStatus: false }),
    renderTimingSection(run, summary),
    el('p', { class: 'muted', id: 'studio-analysis-loading' }, 'Carregando análise…'),
    el('div', { id: 'studio-analysis-content' }),
    el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => loadRunDetail(ctx, runId) }, '← Voltar ao resultado'),
  ]));
  const analysisRes = await ctx.api.get(`/api/backtest/runs/${runId}/analysis`);
  const a = analysisRes.ok ? analysisRes.data.analysis : {};
  const content = document.getElementById('studio-analysis-content');
  const loading = document.getElementById('studio-analysis-loading');
  if (loading) loading.remove();
  if (!content) return;
  mount(content, el('div', {}, [
    el('h3', {}, 'Piores eventos'),
    el('ul', {}, (a.worst_events || []).map((ev) => el('li', {}, [
      el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => openEventDrawer(ctx, runId, ev.id) },
        `${ev.condition_id} · ${formatPnl(ev.final_pnl)}`),
    ]))),
  ]));
}

function renderProgressPanel(container, run, ctx) {
  const progress = run.progress || { phase: 'queued', ticks: 0, total_ticks: null, percent: 0 };
  const percentVal = progress.percent != null ? Number(progress.percent) : 0;
  mount(container, el('div', { class: 'studio-progress-panel' }, [
    el('div', { class: 'studio-progress-card' }, [
      renderRunContextBanner(run, { compact: true }),
      el('p', { class: 'muted', id: 'studio-progress-depends', hidden: !progress.depends_on_job }, progress.depends_on_job ? `Aguardando job #${progress.depends_on_job}` : ''),
      el('div', { class: 'studio-progress-metrics' }, [
        el('div', { class: 'studio-progress-metric' }, [
          el('span', { class: 'studio-progress-metric__label' }, 'Progresso'),
          el('div', { class: 'studio-progress-metric__value', id: 'studio-progress-pct' }, `${percentVal.toFixed(0)}%`),
        ]),
        el('div', { class: 'studio-progress-metric' }, [
          el('span', { class: 'studio-progress-metric__label' }, 'Fase'),
          el('div', { class: 'studio-progress-metric__value', id: 'studio-progress-phase' }, formatProgressPhase(progress.phase, progress)),
        ]),
        el('div', { class: 'studio-progress-metric' }, [
          el('span', { class: 'studio-progress-metric__label' }, 'Ticks Processados'),
          el('div', { class: 'studio-progress-metric__value', id: 'studio-progress-ticks' }, `${progress.ticks || 0}${progress.total_ticks ? ` / ${progress.total_ticks}` : ''}`),
        ]),
        el('div', { class: 'studio-progress-metric' }, [
          el('span', { class: 'studio-progress-metric__label' }, 'Tempo restante'),
          el('div', { class: 'studio-progress-metric__value', id: 'studio-progress-eta' }, formatProgressRemaining(progress)),
        ]),
        el('div', { class: 'studio-progress-metric' }, [
          el('span', { class: 'studio-progress-metric__label' }, 'Tempo decorrido'),
          el('div', { class: 'studio-progress-metric__value', id: 'studio-progress-elapsed' }, formatProgressElapsed(progress)),
        ]),
      ]),
      el('div', { class: 'studio-progress-bar', role: 'progressbar', 'aria-valuenow': String(Math.round(percentVal)), 'aria-valuemin': '0', 'aria-valuemax': '100' }, [
        el('span', { class: 'studio-progress-fill', id: 'studio-progress-fill', style: { width: `${Math.min(100, Math.max(0, percentVal))}%` } }),
      ]),
      el('button', {
        type: 'button',
        class: 'btn btn--danger btn--sm',
        disabled: studioState.cancellingRunId === run.id,
        onclick: () => cancelRunFromStudio(ctx, run),
      }, studioState.cancellingRunId === run.id ? 'Cancelando…' : 'Cancelar'),
    ]),
  ]));
  if (run.status === 'running' || run.status === 'queued') startProgressPoll(ctx, run.id);
  applyProgressUi(progress, { runId: run.id });
}

function renderFailedRunPanel(container, run, ctx) {
  const summaryError = run.summary?.error || run.summary?.failed?.error;
  mount(container, el('div', { class: 'studio-progress-panel' }, [
    el('div', { class: 'studio-progress-card' }, [
      renderRunContextBanner(run, { compact: true }),
      el('p', { class: 'status-badge status-badge--err' }, RUN_STATUS_LABELS[run.status] || 'Falhou'),
      el('p', { class: 'muted' }, run.error || summaryError || 'O backtest falhou em runtime.'),
      run.duration_ms ? el('p', { class: 'muted' }, `Duração: ${formatDurationMs(run.duration_ms)}`) : null,
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        onclick: () => exitRunSelection(ctx),
      }, 'Voltar para seleção'),
    ]),
  ]));
}

function renderCancelledPanel(container, run, ctx) {
  mount(container, el('div', { class: 'studio-progress-panel' }, [
    el('div', { class: 'studio-progress-card' }, [
      renderRunContextBanner(run, { compact: true }),
      el('p', { class: 'muted' }, run.error || 'Backtest cancelado pelo operador.'),
      run.duration_ms ? el('p', { class: 'muted' }, `Duração até o cancelamento: ${formatDurationMs(run.duration_ms)}`) : null,
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        onclick: () => exitRunSelection(ctx),
      }, 'Voltar para seleção'),
    ]),
  ]));
}

function renderSortableColumnHeader(ctx, runId, { key, label, className }) {
  const active = parseEventSort(studioState.filterSort).column === key;
  return el('button', {
    type: 'button',
    class: `studio-col-sort ${className}${active ? ' is-active' : ''}`,
    title: 'Clique para ordenar',
    onclick: (ev) => {
      ev.stopPropagation();
      studioState.filterSort = toggleEventColumnSort(key);
      studioState.eventsOffset = 0;
      loadEvents(ctx, runId);
    },
  }, [
    label,
    active ? el('span', { class: 'studio-col-sort__arrow', 'aria-hidden': 'true' }, sortIndicator(key)) : null,
  ]);
}

function renderVirtualEventTable(events, ctx, runId) {
  const rowH = 40;
  const wrap = el('div', { class: 'studio-events-wrap' }, [
    el('div', { class: 'studio-table-header-row' }, [
      el('button', {
        type: 'button',
        class: `studio-col-sort col-index${isDefaultEventSort(studioState.filterSort) ? ' is-active' : ''}`,
        title: 'Ordenar por data (mais antigo primeiro)',
        onclick: (ev) => {
          ev.stopPropagation();
          studioState.filterSort = 'event_start:asc';
          studioState.eventsOffset = 0;
          loadEvents(ctx, runId);
        },
      }, '#'),
      ...EVENT_SORT_COLUMNS.map((col) => renderSortableColumnHeader(ctx, runId, col)),
    ]),
  ]);
  const viewport = el('div', { class: 'studio-events-viewport', style: { maxHeight: '360px', overflow: 'auto' } });
  const spacer = el('div', { style: { height: `${events.length * rowH}px`, position: 'relative' } });
  const body = el('div', { class: 'studio-events-body', style: { position: 'absolute', top: '0', left: '0', right: '0' } });
  spacer.appendChild(body);
  viewport.appendChild(spacer);

  function renderSlice() {
    const scrollTop = viewport.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / rowH) - 5);
    const visible = Math.ceil(viewport.clientHeight / rowH) + 10;
    const slice = events.slice(start, start + visible);
    body.style.transform = `translateY(${start * rowH}px)`;
    mount(body, slice.map((ev, i) => eventRow(ev, ctx, runId, start + i)));
  }

  viewport.addEventListener('scroll', renderSlice);
  renderSlice();
  wrap.appendChild(viewport);
  return wrap;
}

function eventRow(ev, ctx, runId, index) {
  const isSelected = studioState.selectedEventId === ev.id;
  const pnlVal = Number(ev.final_pnl || 0);
  const pnlTone = pnlVal > 0 ? 'good' : pnlVal < 0 ? 'bad' : 'idle';
  const quantity = ev.quantity;
  const cost = ev.cost;

  return el('button', {
    type: 'button',
    class: `studio-event-row${isSelected ? ' is-selected' : ''}`,
    'data-event-id': String(ev.id),
    title: `${formatEventTime(ev.event_start)} · ${ev.condition_id || ''}`,
    onclick: () => selectEventAndRenderInline(ctx, runId, ev.id, index),
  }, [
    el('span', { class: 'col-index muted' }, String(index + 1)),
    el('span', { class: 'col-time' }, formatEventTime(ev.event_start)),
    renderSideCell(ev.side),
    el('span', { class: 'col-qty' }, quantity != null ? String(quantity) : '—'),
    el('span', { class: 'col-cost' }, cost != null ? formatPnl(cost) : '—'),
    el('span', { class: `col-pnl pnl-${pnlTone}` }, formatPnl(pnlVal)),
    el('span', { class: 'col-dist muted' }, formatDistPtb(ev.entry_distance_ptb)),
    el('span', { class: 'col-trest muted' }, formatTimeRemaining(ev.entry_time_remaining)),
    renderEventResultBadge(ev),
  ]);
}

async function selectEventAndRenderInline(ctx, runId, eventId, index = 0, { syncUrl = true } = {}) {
  const token = ++openEventToken;
  studioState.selectedEventId = eventId;
  studioState.eventIndex = index;
  studioState.activeEventTab = studioState.activeEventTab || 'chart';
  
  if (syncUrl) pushStudioQuery({ run: runId, event: eventId });
  const container = document.getElementById('studio-selected-event-container');
  if (!container) return;
  mount(container, Skeleton({ lines: 4 }));

  const res = await ctx.api.get(`/api/backtest/runs/${runId}/events/${eventId}`);
  if (token !== openEventToken) return;
  if (!res.ok) return mount(container, el('p', {}, 'Evento não encontrado'));
  const event = res.data.event;

  let chartData = event.series && chartSeriesIsUsable(event.series)
    ? {
      event,
      series: event.series,
      series_meta: event.series_meta,
      summary: event.summary,
      exits: event.summary?.exits ?? [],
      orders: event.orders,
      marks: event.marks,
      logs: event.logs,
      metrics: event.metrics,
    }
    : null;
  let chartLoading = Boolean((event.condition_id || event.id) && !chartData);
  const assetSymbol = studioState.selectedRunMeta?.underlying || 'BTC';
  if (chartData) enrichEventSummaryFromChart(event, chartData);

  const tabs = [
    { id: 'chart', label: 'Gráfico' },
    { id: 'timeline', label: 'Linha do tempo' },
    { id: 'diagnostics', label: 'Diagnóstico' },
    { id: 'logs', label: 'Logs' },
  ];

  function renderEventDetailContent() {
    const activeTab = studioState.activeEventTab || 'chart';
    mount(container, el('div', { class: 'card card--compact studio-selected-event-card' }, [
      el('header', { class: 'studio-selected-event__head row row--between' }, [
        el('div', { class: 'row' }, [
          el('strong', { class: 'studio-selected-event__title' }, `Evento ${formatEventTime(event.event_start)} · ${event.side || 'N/A'}`),
          event.condition_id
            ? el('span', {
              class: 'muted mono studio-selected-event__condition-id',
              title: event.condition_id,
            }, shortId(event.condition_id))
            : null,
          el('span', { class: `badge badge--${event.result === 'win' ? 'ok' : event.result === 'loss' ? 'err' : 'idle'}` }, event.result || ''),
        ]),
        el('div', { class: 'btn-group' }, [
          el('button', {
            type: 'button',
            class: 'btn btn--ghost btn--sm',
            disabled: index <= 0,
            onclick: () => {
              const prevIndex = index - 1;
              const prevEvent = studioState.events[prevIndex];
              if (prevEvent) selectEventAndRenderInline(ctx, runId, prevEvent.id, prevIndex);
            }
          }, 'Anterior'),
          el('button', {
            type: 'button',
            class: 'btn btn--ghost btn--sm',
            disabled: index >= studioState.events.length - 1,
            onclick: () => {
              const nextIndex = index + 1;
              const nextEvent = studioState.events[nextIndex];
              if (nextEvent) selectEventAndRenderInline(ctx, runId, nextEvent.id, nextIndex);
            }
          }, 'Próximo'),
          el('button', {
            type: 'button',
            class: 'btn btn--ghost btn--sm',
            onclick: () => {
              studioState.selectedEventId = null;
              pushStudioQuery({ event: null });
              renderSelectedEventContainerPlaceholder();
              document.querySelectorAll('.studio-event-row').forEach(r => r.classList.remove('is-selected'));
            }
          }, 'Limpar'),
        ])
      ]),
      renderEventOverview(event),
      el('div', { class: 'drawer-tabs' }, tabs.map((t) => el('button', {
        type: 'button',
        class: `drawer-tab-link${activeTab === t.id ? ' is-active' : ''}`,
        onclick: () => { studioState.activeEventTab = t.id; renderEventDetailContent(); },
      }, t.label))),
      el('div', { class: `drawer-tab-panel${activeTab === 'chart' ? ' is-active' : ''}` }, [
        el('div', { id: 'studio-event-chart', class: 'studio-event-chart' }),
      ]),
      el('div', { class: `drawer-tab-panel${activeTab === 'timeline' ? ' is-active' : ''}` }, [
        renderExecutionTimeline(event),
      ]),
      el('div', { class: `drawer-tab-panel${activeTab === 'diagnostics' ? ' is-active' : ''}` }, [
        renderDiagnosticsPanel(event),
      ]),
      el('div', { class: `drawer-tab-panel${activeTab === 'logs' ? ' is-active' : ''}` }, [
        renderLogList(event.logs || [], event),
      ]),
    ]));

    if (activeTab === 'chart') {
      const containerChart = document.getElementById('studio-event-chart');
      const payload = chartData?.series ? chartData : null;
      if (chartLoading && containerChart) {
        mount(containerChart, Skeleton({ lines: 3 }));
      } else if (payload?.series && chartSeriesIsUsable(payload.series)) {
        void renderEventChartWithMarkers(containerChart, event, payload, { assetSymbol });
      } else if (containerChart) {
        mount(containerChart, el('p', { class: 'muted text-center', style: { padding: '24px 0' } }, 'Série de preços indisponível para este evento.'));
      }
    }
  }

  renderEventDetailContent();

  if (chartLoading && (event.condition_id || event.id)) {
    const chartParams = new URLSearchParams();
    if (event.condition_id) chartParams.set('condition_id', event.condition_id);
    if (event.id) chartParams.set('event_id', String(event.id));
    void ctx.api.get(`/api/backtest/runs/${runId}/chart-data?${chartParams.toString()}`)
      .then((chartRes) => {
        if (token !== openEventToken) return;
        chartLoading = false;
        chartData = chartRes.ok ? chartRes.data : null;
        if (chartData) enrichEventSummaryFromChart(event, chartData);
        renderEventDetailContent();
      });
  }

  // Sincroniza destaque na tabela
  document.querySelectorAll('.studio-event-row').forEach((row) => {
    const rowEventId = Number(row.getAttribute('data-event-id'));
    if (rowEventId === eventId) {
      row.classList.add('is-selected');
    } else {
      row.classList.remove('is-selected');
    }
  });
}

function renderCompare(main, data) {
  mount(main, el('div', { class: 'studio-compare' }, [
    el('h3', {}, 'Comparador'),
    el('div', { class: 'studio-kpis' }, (data.runs || []).map((r) => MetricCard({
      label: `#${r.id} · ${formatRunAssetMeta(r)}`,
      value: formatPnl(r.summary?.totalPnl),
      tone: (r.summary?.totalPnl || 0) >= 0 ? 'ok' : 'err',
    }))),
    el('div', { class: 'studio-equity', id: 'studio-compare-chart' }),
  ]));
  const series = (data.runs || []).filter((r) => r.equity?.length).map((r) => ({
    label: `#${r.id}`,
    data: r.equity.map((p) => [new Date(p.ts).getTime(), p.pnl]),
  }));
  if (series.length) renderUplotLine(document.getElementById('studio-compare-chart'), series[0].data, series.slice(1));
}

function isStudioRouteActive() {
  const top = location.hash.replace(/^#\/?/, '').split('?')[0].split('/')[0];
  return top === 'studio';
}

function bindSse(ctx) {
  if (sseHandler) disconnectSse(sseHandler);
  sseHandler = (event) => {
    if (!isStudioRouteActive()) return;
    if (event.type === 'run:progress' && event.runId === studioState.selectedRunId) {
      applyProgressUi(event.progress, { runId: event.runId });
      updateRunListProgress(event.runId, 'running', event.progress);
    }
    if (event.type === 'run:cancelled') {
      notifyRunDataChanged();
      if (event.runId === studioState.selectedRunId) loadRunDetail(ctx, event.runId);
    }
    if (event.type === 'run:completed' || event.type === 'run:failed') {
      notifyRunDataChanged();
      if (event.runId === studioState.selectedRunId) loadRunDetail(ctx, event.runId);
    }
    if (event.type === 'job:completed') refreshCoverageIndicator(ctx, formFromDom());
  };
  connectSse(sseHandler);
  resumeProgressTracking(ctx);
}

function equityDrawdownCaption(equity) {
  const maxDrawdown = computeMaxDrawdown(equity);
  if (!Number.isFinite(maxDrawdown) || maxDrawdown <= 0) return 'Drawdown máx. acumulado: 0.00';
  return `Drawdown máx. acumulado: -${formatPnl(maxDrawdown)}`;
}

function bindShortcuts(ctx) {
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      studioState.selectedEventId = null;
      pushStudioQuery({ event: null });
      renderSelectedEventContainerPlaceholder();
      document.querySelectorAll('.studio-event-row').forEach(r => r.classList.remove('is-selected'));
    }
    if (ev.key === 'j' || ev.key === 'k') {
      const delta = ev.key === 'j' ? 1 : -1;
      const next = studioState.eventIndex + delta;
      if (next >= 0 && next < studioState.events.length && studioState.selectedRunId) {
        selectEventAndRenderInline(ctx, studioState.selectedRunId, studioState.events[next].id, next);
      }
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      document.getElementById('studio-form')?.requestSubmit();
    }
  });
}

export function redirectLegacyBacktestRoute(params) {
  if (params.eventId) routerNavigate(`studio?run=${params.id}&event=${params.eventId}`);
  else routerNavigate(`studio?run=${params.id}`);
}
