import { el, mount } from '../utils/dom.js';
import { applyContextOptions, contextBarOptions, loadContext, saveContext, selectField } from '../utils/context.js';
import { fetchContextOptionsCached } from '../utils/contextOptionsCache.js';
import { formatPnl } from '../utils/format.js';
import { loadStrategyOptions, renderStrategyPicker, backtestPayloadFromPick } from '../utils/strategyPicker.js';
import { MetricCard, Skeleton, StatusBadge } from '../components/Skeleton.js';
import { renderRunMetricsPanel, renderTimingSection, resetMetricsViewMode } from '../components/runMetrics.js';
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

const EVENTS_PAGE = 100;

const studioState = {
  runs: [],
  selectedRunId: null,
  selectedEventId: null,
  compareIds: [],
  events: [],
  eventsOffset: 0,
  eventsHasMore: false,
  eventIndex: 0,
  filterQ: '',
  filterResult: 'all',
  filterSort: 'default',
  runFilters: { status: 'all', sort: 'newest', strategyOnly: true },
  strategyOptions: [],
  selectedStrategyPick: '',
  coverageUi: null,
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

function parseStudioQuery() {
  const hash = location.hash.replace(/^#\/?/, '');
  const q = hash.includes('?') ? hash.split('?')[1] : '';
  const params = new URLSearchParams(q);
  return {
    run: params.get('run') ? Number(params.get('run')) : null,
    event: params.get('event') ? Number(params.get('event')) : null,
    strategy: params.get('strategy') ? Number(params.get('strategy')) : null,
    version: params.get('version') ? Number(params.get('version')) : null,
    compare: (params.get('compare') || '').split(',').map((v) => Number(v)).filter((n) => Number.isFinite(n)),
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

export async function renderStudio(ctx) {
  studioCtx = ctx;
  ctx.setBreadcrumb('studio', 'Estúdio');
  ctx.renderContextBar?.();

  const query = parseStudioQuery();
  studioState.selectedRunId = query.run;
  studioState.selectedEventId = query.event;

  mount(ctx.contentEl, el('div', { class: 'studio-layout' }, [
    el('section', { class: 'studio-config', id: 'studio-config' }, Skeleton({ lines: 6 })),
    el('section', { class: 'studio-main', id: 'studio-main' }, Skeleton({ lines: 8 })),
    el('aside', { class: 'studio-runs', id: 'studio-runs' }, Skeleton({ lines: 5 })),
    el('div', { class: 'studio-drawer', id: 'studio-drawer', hidden: true }),
  ]));

  try {
    const apiOptions = await fetchContextOptionsCached(ctx.api);
    const fieldOptions = contextBarOptions(apiOptions);
    const formCtx = applyContextOptions(loadContext(), fieldOptions);
    studioState.strategyOptions = await loadStrategyOptions(ctx.api, { includeArchived: false });
    if (query.strategy && query.version) {
      studioState.selectedStrategyPick = `gls:${query.strategy}:${query.version}`;
    } else if (!studioState.selectedStrategyPick && studioState.strategyOptions[0]) {
      studioState.selectedStrategyPick = studioState.strategyOptions[0].value;
    }

    renderConfigPanel(ctx, { formCtx, fieldOptions });
    await refreshCoverageIndicator(ctx, formCtx);
    await refreshRuns(ctx);
    if (studioState.selectedRunId) await loadRunDetail(ctx, studioState.selectedRunId);
    else mount(document.getElementById('studio-main'), el('div', { class: 'card' }, [
      el('p', { class: 'muted' }, 'Selecione um run à direita ou rode um novo backtest (⌘↵).'),
    ]));
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
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Estratégia'),
        el('div', { id: 'studio-strategy-pick' }),
      ]),
      el('div', { class: 'row row--wrap', id: 'studio-coverage-indicator' }),
      el('label', { class: 'field' }, ['De ', el('input', { type: 'date', name: 'from', value: formCtx.from, class: 'field__input', onchange: () => refreshCoverageIndicator(ctx, formFromDom()) })]),
      el('label', { class: 'field' }, ['Até ', el('input', { type: 'date', name: 'to', value: formCtx.to, class: 'field__input', onchange: () => refreshCoverageIndicator(ctx, formFromDom()) })]),
      el('label', { class: 'field' }, ['Ativo ', selectField('underlying', fieldOptions.underlyings || [formCtx.underlying], formCtx.underlying)]),
      el('label', { class: 'field' }, ['Intervalo ', selectField('interval', fieldOptions.intervals || [formCtx.interval], formCtx.interval)]),
      el('label', { class: 'field' }, ['Book ', selectField('book_depth', fieldOptions.book_depths || [formCtx.book_depth], formCtx.book_depth)]),
      el('label', { class: 'field field--checkbox' }, [
        el('input', { type: 'checkbox', name: 'fast_run', value: '1' }),
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

  const strategyPickWrap = document.getElementById('studio-strategy-pick');
  if (strategyPickWrap) {
    strategyPickWrap.innerHTML = '';
    strategyPickWrap.appendChild(renderStrategyPicker(studioState.strategyOptions, studioState.selectedStrategyPick, (value) => {
      studioState.selectedStrategyPick = value;
      const [, sid, vid] = String(value).split(':');
      pushStudioQuery({ strategy: Number(sid) || null, version: Number(vid) || null });
      refreshRuns(ctx);
    }));
  }

  document.getElementById('studio-form')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    runBacktest(ctx, ev.target);
  });
  document.getElementById('studio-fix-btn')?.addEventListener('click', () => fixDataFromStudio(ctx));
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
  const msg = (preview.data.summary_lines || []).join('\n') || 'Executar correção?';
  if (!confirm(msg)) return;
  const fix = await ctx.api.post('/api/data/fix', { request, confirm_rebuild: preview.data.needs_rebuild_confirm || undefined });
  if (!fix.ok) return ctx.toast.err(fix.error?.message || 'Falha');
  ctx.toast.ok(fix.data.job ? `Job #${fix.data.job.id} criado` : 'Dados prontos');
  await refreshCoverageIndicator(ctx, formFromDom());
}

async function runBacktest(ctx, form) {
  const fd = new FormData(form);
  const ctxSaved = saveContext({
    from: fd.get('from'),
    to: fd.get('to'),
    underlying: fd.get('underlying'),
    interval: fd.get('interval'),
    book_depth: fd.get('book_depth'),
    batch_size: fd.get('batch_size'),
  });
  const pick = studioState.selectedStrategyPick || form.querySelector('[name="strategy_pick"]')?.value;
  const payload = backtestPayloadFromPick(pick, ctxSaved, {
    fast_run: fd.get('fast_run') === '1',
    async: true,
  });
  if (!payload) return ctx.toast.warn('Selecione uma estratégia');
  const res = await ctx.api.post('/api/backtest/run', payload);
  if (!res.ok) {
    if (res.data?.availability) {
      const fix = confirm('Dados não prontos. Corrigir e enfileirar o backtest?');
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
  ctx.toast.ok('Backtest enfileirado');
}

function computeRunStats(runs, strategyName) {
  const filtered = runs.filter((r) => !strategyName || strategyName(r) === strategyName);
  const completed = filtered.filter((r) => (r.status || 'completed') === 'completed');
  const profitable = completed.filter((r) => Number(r.summary?.totalPnl ?? 0) > 0);
  const totalPnl = completed.reduce((s, r) => s + Number(r.summary?.totalPnl ?? 0), 0);
  const bestPnl = completed.length ? Math.max(...completed.map((r) => Number(r.summary?.totalPnl ?? 0))) : 0;
  const winRate = filtered.length ? Math.round((profitable.length / filtered.length) * 100) : 0;
  return { total: filtered.length, totalPnl, bestPnl, winRate };
}

function filterRuns(runs) {
  const pick = studioState.strategyOptions.find((o) => o.value === studioState.selectedStrategyPick);
  const strategyLabel = pick?.label?.split(' · ')[0];
  return runs.filter((run) => {
    if (studioState.runFilters.strategyOnly && strategyLabel && strategyName(run) !== strategyLabel) return false;
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
  const stats = computeRunStats(runs, studioState.runFilters.strategyOnly ? pick?.label?.split(' · ')[0] : null);
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
          onchange: (e) => { studioState.runFilters.strategyOnly = e.target.checked; refreshRuns(ctx); },
        }),
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
    el('span', { class: 'studio-run-item__meta muted' }, `${versionLabel(run)} · ${run.from?.slice(5, 10) || ''}–${run.to?.slice(5, 10) || ''}`),
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
  await refreshRuns(ctx);
  await loadRunDetail(ctx, id);
}

async function loadRunDetail(ctx, runId) {
  const main = document.getElementById('studio-main');
  if (!main) return;
  resetMetricsViewMode();

  if (studioState.compareIds.length >= 2) {
    const res = await ctx.api.get(`/api/backtest/compare?ids=${studioState.compareIds.join(',')}`);
    if (res.ok) return renderCompare(main, res.data);
  }

  const runRes = await ctx.api.get(`/api/backtest/runs/${runId}?slim=1`);
  if (!runRes.ok) return mount(main, el('p', { class: 'muted' }, 'Run não encontrado'));
  const run = runRes.data.run;

  if (run.status === 'queued' || run.status === 'running') {
    renderProgressPanel(main, run, ctx);
    return;
  }

  const summary = run.summary || {};
  mount(main, el('div', { class: 'studio-result' }, [
    renderRunMetricsPanel(summary, { cardId: 'studio-metrics-card' }),
    el('div', { class: 'studio-equity', id: 'studio-equity-chart' }),
    renderNoEntryDiagnostic(summary, studioState.events),
    el('div', { class: 'studio-tabs' }, [
      el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => showAnalysisTab(ctx, runId, run, summary) }, 'Análise'),
      el('button', { class: 'btn btn--ghost is-active', type: 'button' }, 'Eventos'),
    ]),
    el('div', { class: 'studio-events-filter-bar' }, buildEventFilters(ctx, runId)),
    el('div', { id: 'studio-events-table-container' }),
  ]));

  if (run.equity?.length) {
    renderUplotLine(document.getElementById('studio-equity-chart'), run.equity.map((p) => [new Date(p.ts).getTime(), p.pnl]));
  }
  studioState.eventsOffset = 0;
  await loadEvents(ctx, runId, { append: false });
  if (studioState.selectedEventId) {
    openEventDrawer(ctx, runId, studioState.selectedEventId, 0, { syncUrl: false });
  }
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
      }, ['all', 'win', 'loss', 'no_entry'].map((v) => el('option', { value: v, selected: studioState.filterResult === v }, v))),
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
    }, 'CSV'),
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
  if (append) studioState.events.push(...page);
  else studioState.events = page;
  studioState.eventsOffset = studioState.events.length;
  studioState.eventsHasMore = page.length === EVENTS_PAGE;

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
  const analysisRes = await ctx.api.get(`/api/backtest/runs/${runId}/analysis`);
  const a = analysisRes.ok ? analysisRes.data.analysis : {};
  mount(main, el('div', { class: 'studio-analysis' }, [
    renderTimingSection(run, summary),
    el('h3', {}, 'Piores eventos'),
    el('ul', {}, (a.worst_events || []).map((ev) => el('li', {}, [
      el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => openEventDrawer(ctx, runId, ev.id) },
        `${ev.condition_id} · ${formatPnl(ev.final_pnl)}`),
    ]))),
    el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => loadRunDetail(ctx, runId) }, '← Voltar ao resultado'),
  ]));
}

function renderProgressPanel(container, run, ctx) {
  const progress = run.progress || { phase: 'queued', ticks: 0, total_ticks: null, percent: 0 };
  const percentVal = progress.percent != null ? progress.percent : 0;
  mount(container, el('div', { class: 'studio-progress-panel' }, [
    el('div', { class: 'studio-progress-card' }, [
      el('strong', {}, `Backtest #${run.id}`),
      StatusBadge({ status: run.status }),
      progress.depends_on_job ? el('p', { class: 'muted' }, `Aguardando job #${progress.depends_on_job}`) : null,
      el('div', { class: 'studio-progress-bar' }, [
        el('span', { class: 'studio-progress-fill', id: 'studio-progress-fill', style: { width: `${percentVal}%` } }),
      ]),
      el('button', {
        type: 'button',
        class: 'btn btn--danger btn--sm',
        onclick: async () => {
          if (!confirm('Cancelar backtest?')) return;
          const cancelRes = await ctx.api.post(`/api/backtest/runs/${run.id}/cancel`);
          if (cancelRes.ok) { cacheInvalidate('runs'); await refreshRuns(ctx); await loadRunDetail(ctx, run.id); }
        },
      }, 'Cancelar'),
    ]),
  ]));
}

function renderVirtualEventTable(events, ctx, runId) {
  const rowH = 36;
  const wrap = el('div', { class: 'studio-events-wrap' });
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
  return el('button', {
    type: 'button',
    class: 'studio-event-row',
    onclick: () => openEventDrawer(ctx, runId, ev.id, index),
  }, [
    el('span', {}, ev.condition_id?.slice(0, 12) || '—'),
    el('span', {}, ev.side || '—'),
    el('span', {}, formatPnl(ev.final_pnl)),
    el('span', { class: 'muted' }, ev.result || ''),
  ]);
}

async function openEventDrawer(ctx, runId, eventId, index = 0, { syncUrl = true } = {}) {
  const token = ++openEventToken;
  studioState.selectedEventId = eventId;
  studioState.eventIndex = index;
  if (syncUrl) pushStudioQuery({ run: runId, event: eventId });
  const drawer = document.getElementById('studio-drawer');
  if (!drawer) return;
  drawer.hidden = false;
  mount(drawer, Skeleton({ lines: 4 }));

  const res = await ctx.api.get(`/api/backtest/runs/${runId}/events/${eventId}`);
  if (token !== openEventToken) return;
  if (!res.ok) return mount(drawer, el('p', {}, 'Evento não encontrado'));
  const event = res.data.event;

  let chartData = null;
  if (event.condition_id) {
    const chartRes = await ctx.api.get(`/api/backtest/runs/${runId}/chart-data?condition_id=${encodeURIComponent(event.condition_id)}`);
    if (token !== openEventToken) return;
    chartData = chartRes.ok ? chartRes.data : null;
  }

  const tabs = [
    { id: 'chart', label: 'Gráfico' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'diagnostics', label: 'Diagnóstico' },
    { id: 'logs', label: 'Logs' },
  ];
  let activeTab = 'chart';

  function renderDrawerContent() {
    mount(drawer, el('div', { class: 'studio-drawer__inner' }, [
      el('header', { class: 'studio-drawer__head' }, [
        el('strong', {}, `${event.condition_id?.slice(0, 16)} (${event.side || 'N/A'})`),
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => { drawer.hidden = true; } }, 'Fechar'),
      ]),
      renderEventOverview(event),
      el('div', { class: 'drawer-tabs' }, tabs.map((t) => el('button', {
        type: 'button',
        class: `drawer-tab-link${activeTab === t.id ? ' is-active' : ''}`,
        onclick: () => { activeTab = t.id; renderDrawerContent(); },
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
        renderLogList(event.logs || []),
      ]),
    ]));

    if (activeTab === 'chart') {
      const container = document.getElementById('studio-event-chart');
      if (chartData?.series) renderEventChartWithMarkers(container, event, chartData);
      else if (event.series?.underlying?.length) renderEventChartWithMarkers(container, event, { series: event.series });
    }
  }

  renderDrawerContent();
}

function renderCompare(main, data) {
  mount(main, el('div', { class: 'studio-compare' }, [
    el('h3', {}, 'Comparador'),
    el('div', { class: 'studio-kpis' }, (data.runs || []).map((r) => MetricCard({
      label: `#${r.id}`,
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

function bindSse(ctx) {
  if (sseHandler) disconnectSse(sseHandler);
  sseHandler = (event) => {
    if (event.type === 'run:progress' && event.runId === studioState.selectedRunId) {
      const fill = document.getElementById('studio-progress-fill');
      if (fill) fill.style.width = `${event.progress?.percent || 0}%`;
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
      const drawer = document.getElementById('studio-drawer');
      if (drawer) drawer.hidden = true;
    }
    if (ev.key === 'j' || ev.key === 'k') {
      const delta = ev.key === 'j' ? 1 : -1;
      const next = studioState.eventIndex + delta;
      if (next >= 0 && next < studioState.events.length && studioState.selectedRunId) {
        openEventDrawer(ctx, studioState.selectedRunId, studioState.events[next].id, next);
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
