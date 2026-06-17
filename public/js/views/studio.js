import { el, mount } from '../utils/dom.js';
import { applyContextOptions, contextBarOptions, loadContext, saveContext, selectField } from '../utils/context.js';
import { fetchContextOptionsCached } from '../utils/contextOptionsCache.js';
import { formatPnl, shortId } from '../utils/format.js';
import { loadStrategyOptions, renderStrategyPicker, backtestPayloadFromPick, resolveInitialStrategyPick, saveLastStrategyPick, getStrategyGroupFromPick, invalidateStrategyPickerCache } from '../utils/strategyPicker.js';
import { MetricCard, Skeleton, StatusBadge } from '../components/Skeleton.js';
import { renderRunMetricsPanel, renderTimingSection, resetMetricsViewMode } from '../components/runMetrics.js';
import { formatRunAssetMeta, renderRunContextBanner } from '../components/runContext.js';
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
    return { tone: 'ok', label: 'Acertou', icon: 'fa-check' };
  }
  if (ev.expiration_result === 'LOSS' || ev.result === 'loss' || ev.reason === 'expiry_loss') {
    return { tone: 'err', label: 'Errou', icon: 'fa-xmark' };
  }
  if (ev.result === 'breakeven' || ev.reason === 'breakeven') {
    return { tone: 'idle', label: 'Empate', icon: 'fa-minus' };
  }
  if (ev.result === 'no_entry' || ev.reason === 'no_entry') {
    return { tone: 'idle', label: 'Sem entrada', icon: 'fa-ban' };
  }
  const raw = ev.reason || ev.result || '';
  const label = humanizeReason(raw);
  const lower = raw.toLowerCase();
  let tone = 'idle';
  if (lower.includes('stop') || lower.includes('loss') || lower.includes('err')) tone = 'err';
  else if (lower.includes('win') || lower.includes('profit')) tone = 'ok';
  else if (lower.includes('warn')) tone = 'warn';
  return { tone, label, icon: 'fa-circle-dot' };
}

function renderEventResultBadge(ev) {
  const { tone, label, icon } = resolveEventResult(ev);
  return el('span', { class: 'col-result' }, [
    el('span', { class: `event-result-badge badge badge--compact badge--${tone}` }, [
      el('i', { class: `fa-solid ${icon}`, 'aria-hidden': 'true' }),
      label,
    ]),
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
    el('p', { class: 'muted text-center', style: { padding: '24px 0', margin: 0 } }, [
      el('i', { class: 'fa-solid fa-circle-info', style: { marginRight: '8px', color: 'var(--accent)' } }),
      'Selecione um evento na tabela de resultados abaixo para visualizar o gráfico de preços e a tradução textual de sua execução.'
    ])
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
  filterSort: 'default',
  runFilters: { status: 'all', sort: 'newest', strategyOnly: true },
  strategyOptions: [],
  selectedStrategyPick: '',
  coverageUi: null,
  cancellingRunId: null,
};

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
let lastProgressSnapshot = null;
let lastProgressRunId = null;
let lastProgressReceivedAt = 0;

function clearProgressPoll() {
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
  if (status === 'queued') pnlEl.textContent = progress?.depends_on_job ? 'Aguardando dados' : 'Fila';
  else if (status === 'running') pnlEl.textContent = `Rodando (${Number(progress?.percent || 0).toFixed(0)}%)`;
  else if (status === 'cancelled') pnlEl.textContent = 'Cancelado';
}

function showStudioEmptyMain(main) {
  mount(main, el('div', { class: 'card' }, [
    el('p', { class: 'muted' }, 'Selecione um run à direita ou rode um novo backtest (⌘↵).'),
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

function startProgressPoll(ctx, runId) {
  clearProgressPoll();
  const pollOnce = async () => {
    if (studioState.cancellingRunId === runId) return;
    if (studioState.selectedRunId !== runId) {
      clearProgressPoll();
      return;
    }
    const res = await ctx.api.get(`/api/backtest/runs/${runId}?slim=1`);
    if (!res.ok) return;
    const run = res.data.run;
    if (run.status !== 'running' && run.status !== 'queued') {
      clearProgressPoll();
      cacheInvalidate('runs');
      await refreshRuns(ctx);
      await loadRunDetail(ctx, runId);
      return;
    }
    if (run.progress) applyProgressUi(run.progress, { runId: run.id });
    updateRunListProgress(runId, run.status, run.progress);
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
  studioCtx = ctx;
  clearProgressPoll();
  ctx.setBreadcrumb('studio', 'Estúdio');
  ctx.renderContextBar?.();

  const query = parseStudioQuery();
  studioState.selectedRunId = query.run;
  studioState.selectedEventId = query.event;
  studioState.compareIds = query.compare;

  mount(ctx.contentEl, el('div', { class: 'studio-container' }, [
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
      loadStrategyOptions(ctx.api, { includeArchived: false }),
    ]);
    const fieldOptions = contextBarOptions(apiOptions);
    const formCtx = applyContextOptions(loadContext(), fieldOptions);
    studioState.strategyOptions = strategyOptions;
    if (query.strategy && query.version) {
      studioState.selectedStrategyPick = `gls:${query.strategy}:${query.version}`;
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

    const runsPromise = refreshRuns(ctx);
    if (studioState.selectedRunId) {
      await Promise.all([runsPromise, loadRunDetail(ctx, studioState.selectedRunId)]);
    } else {
      await runsPromise;
      showStudioEmptyMain(document.getElementById('studio-main'));
    }
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
  mount(wrap, el('div', { class: 'card' }, [
    el('h2', { class: 'card__title' }, 'Configurar'),
    el('form', { id: 'studio-form', class: 'studio-form' }, [
      el('div', { class: 'field studio-strategy-field' }, [
        el('div', { id: 'studio-strategy-pick' }),
      ]),
      el('div', { class: 'row row--wrap', id: 'studio-coverage-indicator' }),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'De'),
        el('input', { type: 'date', name: 'from', value: formCtx.from, class: 'field__input', onchange: () => refreshCoverageIndicator(ctx, formFromDom()) }),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Até (incluso)'),
        el('input', { type: 'date', name: 'to', value: formCtx.to, class: 'field__input', onchange: () => refreshCoverageIndicator(ctx, formFromDom()) }),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Ativo'),
        selectField('underlying', fieldOptions.underlyings || [formCtx.underlying], formCtx.underlying),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Intervalo'),
        selectField('interval', fieldOptions.intervals || [formCtx.interval], formCtx.interval),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Book'),
        selectField('book_depth', fieldOptions.book_depths || [formCtx.book_depth], formCtx.book_depth),
      ]),
      el('label', { class: 'switch-field' }, [
        el('input', { type: 'checkbox', name: 'fast_run', value: '1', class: 'switch-field__input' }),
        el('span', { class: 'switch-field__slider' }),
        ' Modo rápido',
      ]),
      el('details', { class: 'advanced-settings-details' }, [
        el('summary', {}, 'Avançado'),
        el('label', { class: 'field' }, [
          'Batch size ',
          el('input', { type: 'number', name: 'batch_size', min: '1', value: formCtx.batch_size || 5000, class: 'field__input' }),
        ]),
      ]),
      el('button', { class: 'btn btn--primary', type: 'submit' }, 'Rodar backtest'),
      el('button', { class: 'btn btn--ghost', type: 'button', id: 'studio-fix-btn' }, 'Corrigir dados'),
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

  invalidateStrategyPickerCache();
  studioState.strategyOptions = await loadStrategyOptions(ctx.api, { force: true });
  studioState.selectedStrategyPick = `gls:${strategyId}:${versionId}`;
  saveLastStrategyPick(studioState.selectedStrategyPick);
  mountStudioStrategyPicker(ctx);
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
    mount(elWrap, el('span', { class: 'badge badge--idle' }, 'Cobertura indisponível'));
    return;
  }
  const summary = res.data.coverage?.summary || {};
  studioState.coverageUi = res.data.coverage;
  let state = 'ready';
  if (summary.attention > 0) state = 'attention';
  else if (summary.processing > 0) state = 'processing';
  const labels = { ready: 'Dados prontos', processing: 'Sincronizando…', attention: 'Atenção nos dados' };
  mount(elWrap, [
    el('span', { class: `badge badge--${state === 'ready' ? 'ok' : 'warn'}` }, labels[state]),
    state === 'attention' ? el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--sm',
      onclick: () => fixDataFromStudio(ctx),
    }, 'Corrigir agora') : null,
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

function filterRuns(runs) {
  const pick = studioState.strategyOptions.find((o) => o.value === studioState.selectedStrategyPick);
  return runs.filter((run) => {
    if (studioState.runFilters.strategyOnly && pick?.strategyId && Number(run.strategy_id) !== Number(pick.strategyId)) return false;
    if (studioState.runFilters.status !== 'all' && (run.status || 'completed') !== studioState.runFilters.status) return false;
    return true;
  }).sort((a, b) => {
    if (studioState.runFilters.sort === 'best_pnl') return Number(b.summary?.totalPnl ?? 0) - Number(a.summary?.totalPnl ?? 0);
    if (studioState.runFilters.sort === 'worst_pnl') return Number(a.summary?.totalPnl ?? 0) - Number(b.summary?.totalPnl ?? 0);
    return Number(b.id) - Number(a.id);
  });
}

function strategyName(run) {
  return run.strategy_snapshot?.name || run.strategy || '-';
}

function versionLabel(run) {
  return run.strategy_snapshot?.version != null ? `v${run.strategy_snapshot.version}` : (run.strategy_version_id ? `#${run.strategy_version_id}` : '-');
}

async function refreshRuns(ctx) {
  const runs = await cachedFetch('runs:list', async () => {
    const res = await ctx.api.get('/api/backtest/runs?limit=50');
    return res.ok ? res.data.runs : [];
  }, 15_000);
  studioState.runs = runs;
  const panel = document.getElementById('studio-runs');
  if (!panel) return;

  const pick = studioState.strategyOptions.find((o) => o.value === studioState.selectedStrategyPick);
  const stats = computeRunStats(runs, studioState.runFilters.strategyOnly ? pick?.strategyId : null);
  const filtered = filterRuns(runs);

  mount(panel, el('div', { class: 'card studio-runs-card' }, [
    el('details', { class: 'studio-run-stats', open: false }, [
      el('summary', { class: 'studio-run-stats__summary' }, [
        el('span', {}, `${stats.total} runs`),
        el('span', {}, formatPnl(stats.totalPnl)),
        el('span', {}, `${stats.winRate}% WR`),
        el('span', {}, `best ${formatPnl(stats.bestPnl)}`),
      ]),
    ]),
    el('div', { class: 'studio-run-filters' }, [
      filterSelect('Status', studioState.runFilters.status, ['all', 'running', 'completed', 'failed_runtime', 'cancelled'], (v) => {
        studioState.runFilters.status = v;
        refreshRuns(ctx);
      }),
      filterSelect('Ordem', studioState.runFilters.sort, ['newest', 'best_pnl', 'worst_pnl'], (v) => {
        studioState.runFilters.sort = v;
        refreshRuns(ctx);
      }),
      el('label', { class: 'switch-field' }, [
        el('input', {
          type: 'checkbox',
          checked: studioState.runFilters.strategyOnly,
          class: 'switch-field__input',
          onchange: (e) => { studioState.runFilters.strategyOnly = e.target.checked; refreshRuns(ctx); },
        }),
        el('span', { class: 'switch-field__slider' }),
        ' Só esta estratégia',
      ]),
    ]),
    el('div', { class: 'studio-run-list' }, filtered.map((run) => runListItem(run, ctx))),
  ]));
}

function filterSelect(label, value, options, onChange) {
  return el('label', { class: 'field field--inline' }, [
    el('span', { class: 'muted' }, label),
    el('select', {
      class: 'field__input field__input--sm',
      onchange: (e) => onChange(e.target.value),
    }, options.map((opt) => el('option', { value: opt, selected: opt === value }, opt))),
  ]);
}

function runListItem(run, ctx) {
  const active = studioState.selectedRunId === run.id;
  const compareOn = studioState.compareIds.includes(run.id);
  let pnlText = formatPnl(run.summary?.totalPnl);
  if (run.status === 'running') pnlText = `Rodando (${run.progress?.percent?.toFixed(0) || 0}%)`;
  else if (run.status === 'queued') pnlText = run.progress?.depends_on_job ? 'Aguardando dados' : 'Fila';
  else if (run.status === 'cancelled') pnlText = 'Cancelado';

  return el('button', {
    type: 'button',
    id: `run-item-${run.id}`,
    class: `studio-run-item${active ? ' is-active' : ''}${compareOn ? ' is-compare' : ''}`,
    onclick: (ev) => {
      if (ev.shiftKey) toggleCompare(run.id);
      else selectRun(ctx, run.id);
    },
  }, [
    el('span', { class: 'studio-run-item__id' }, `#${run.id}`),
    StatusBadge({ status: run.status }),
    el('span', { class: 'studio-run-item__meta muted' }, `${formatRunAssetMeta(run)} · ${versionLabel(run)} · ${run.from?.slice(5, 10) || ''}–${run.to?.slice(5, 10) || ''}`),
    el('span', { class: 'studio-run-item__pnl' }, pnlText),
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

async function loadRunDetail(ctx, runId) {
  const main = document.getElementById('studio-main');
  if (!main) return;
  resetMetricsViewMode();
  clearProgressPoll();

  if (studioState.compareIds.length >= 2) {
    const res = await ctx.api.get(`/api/backtest/compare?ids=${studioState.compareIds.join(',')}`);
    if (res.ok) return renderCompare(main, res.data);
  }

  const runRes = await ctx.api.get(`/api/backtest/runs/${runId}?slim=1&equity=1`);
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

  const summary = run.summary || {};
  mount(main, el('div', { class: 'studio-result' }, [
    renderRunContextBanner(run),
    renderRunMetricsPanel(summary, { cardId: 'studio-metrics-card' }),
    el('div', { class: 'studio-equity', id: 'studio-equity-chart' }),
    el('div', { id: 'studio-selected-event-container', class: 'studio-selected-event-container' }),
    renderNoEntryDiagnostic(summary, studioState.events),
    el('div', { class: 'studio-tabs' }, [
      el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => showAnalysisTab(ctx, runId, run, summary) }, 'Análise'),
      el('button', { class: 'btn btn--ghost is-active', type: 'button' }, 'Eventos'),
    ]),
    el('div', { class: 'studio-events-filter-bar' }, buildEventFilters(ctx, runId)),
    el('div', { id: 'studio-events-table-container' }),
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
    el('div', { class: 'field' }, [
      el('span', { class: 'field__label' }, 'Ordenar'),
      el('select', {
        class: 'field__input',
        onchange: (ev) => { studioState.filterSort = ev.target.value; studioState.eventsOffset = 0; loadEvents(ctx, runId); },
      }, ['default', 'pnl_desc', 'pnl_asc', 'event_start_desc', 'event_start'].map((v) => el('option', { value: v, selected: studioState.filterSort === v }, v))),
    ]),
    el('button', {
      type: 'button',
      class: 'btn btn--ghost',
      onclick: () => {
        const params = new URLSearchParams({ format: 'csv', limit: '5000', q: studioState.filterQ, result: studioState.filterResult, sort: studioState.filterSort });
        window.open(`/api/backtest/runs/${runId}/events?${params}`, '_blank');
      },
    }, [el('i', { class: 'fa-solid fa-file-arrow-down', 'aria-hidden': 'true' }), 'CSV']),
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

function renderVirtualEventTable(events, ctx, runId) {
  const rowH = 40;
  const wrap = el('div', { class: 'studio-events-wrap' }, [
    el('div', { class: 'studio-table-header-row' }, [
      el('span', { class: 'col-index' }, '#'),
      el('span', { class: 'col-time' }, 'Hora Evento'),
      el('span', { class: 'col-side' }, 'Posição'),
      el('span', { class: 'col-qty' }, 'Contratos'),
      el('span', { class: 'col-cost' }, 'Custo'),
      el('span', { class: 'col-pnl' }, 'P&L (Líquido)'),
      el('span', { class: 'col-dist' }, 'Dist PTB'),
      el('span', { class: 'col-trest' }, 'T.Rest'),
      el('span', { class: 'col-result' }, 'Resultado'),
    ])
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
  const result = resolveEventResult(ev);
  const rowTone = result.tone === 'ok' ? 'win' : result.tone === 'err' ? 'loss' : '';
  const quantity = ev.quantity;
  const cost = ev.cost;

  return el('button', {
    type: 'button',
    class: `studio-event-row${isSelected ? ' is-selected' : ''}${rowTone ? ` studio-event-row--${rowTone}` : ''}`,
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
    { id: 'chart', label: 'Gráfico', icon: 'fa-chart-line' },
    { id: 'timeline', label: 'Linha do Tempo', icon: 'fa-clock-rotate-left' },
    { id: 'diagnostics', label: 'Diagnóstico', icon: 'fa-circle-nodes' },
    { id: 'logs', label: 'Tradução do Gráfico (Logs)', icon: 'fa-terminal' },
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
          }, [el('i', { class: 'fa-solid fa-arrow-left' }), ' Anterior']),
          el('button', {
            type: 'button',
            class: 'btn btn--ghost btn--sm',
            disabled: index >= studioState.events.length - 1,
            onclick: () => {
              const nextIndex = index + 1;
              const nextEvent = studioState.events[nextIndex];
              if (nextEvent) selectEventAndRenderInline(ctx, runId, nextEvent.id, nextIndex);
            }
          }, ['Próximo ', el('i', { class: 'fa-solid fa-arrow-right' })]),
          el('button', {
            type: 'button',
            class: 'btn btn--ghost btn--sm',
            onclick: () => {
              studioState.selectedEventId = null;
              pushStudioQuery({ event: null });
              renderSelectedEventContainerPlaceholder();
              document.querySelectorAll('.studio-event-row').forEach(r => r.classList.remove('is-selected'));
            }
          }, [el('i', { class: 'fa-solid fa-xmark', style: { marginRight: '4px' } }), 'Limpar']),
        ])
      ]),
      renderEventOverview(event),
      el('div', { class: 'drawer-tabs' }, tabs.map((t) => el('button', {
        type: 'button',
        class: `drawer-tab-link${activeTab === t.id ? ' is-active' : ''}`,
        onclick: () => { studioState.activeEventTab = t.id; renderEventDetailContent(); },
      }, [
        el('i', { class: `fa-solid ${t.icon}`, style: { marginRight: '6px' } }),
        t.label
      ]))),
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
      cacheInvalidate('runs');
      refreshRuns(ctx);
      if (event.runId === studioState.selectedRunId) loadRunDetail(ctx, event.runId);
    }
    if (event.type === 'run:completed' || event.type === 'run:failed') {
      cacheInvalidate('runs');
      refreshRuns(ctx);
      if (event.runId === studioState.selectedRunId) loadRunDetail(ctx, event.runId);
    }
    if (event.type === 'job:completed') refreshCoverageIndicator(ctx, formFromDom());
  };
  connectSse(sseHandler);
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
