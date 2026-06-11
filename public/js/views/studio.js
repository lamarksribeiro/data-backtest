import { el, mount } from '../utils/dom.js';
import { applyContextOptions, contextBarOptions, loadContext, saveContext, selectField } from '../utils/context.js';
import { fetchContextOptionsCached } from '../utils/contextOptionsCache.js';
import { formatPnl } from '../utils/format.js';
import { loadStrategyOptions, renderStrategySelect, backtestPayloadFromPick } from '../utils/strategyPicker.js';
import { MetricCard, Skeleton, StatusBadge } from '../components/Skeleton.js';
import { connectSse, disconnectSse } from '../utils/sse.js';
import { cacheInvalidate, cachedFetch } from '../utils/apiCache.js';
import { navigate as routerNavigate } from '../router.js';
import { renderUplotLine } from '../utils/uplotChart.js';

const studioState = {
  runs: [],
  selectedRunId: null,
  selectedEventId: null,
  compareIds: [],
  events: [],
  eventIndex: 0,
  filterQ: '',
  filterResult: 'all',
  filterSort: 'default',
};

function debounce(fn, delay) {
  let timer = null;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

let sseHandler = null;
let studioCtx = null;

function parseStudioQuery() {
  const hash = location.hash.replace(/^#\/?/, '');
  const q = hash.includes('?') ? hash.split('?')[1] : '';
  const params = new URLSearchParams(q);
  return {
    run: params.get('run') ? Number(params.get('run')) : null,
    event: params.get('event') ? Number(params.get('event')) : null,
    compare: (params.get('compare') || '').split(',').map((v) => Number(v)).filter((n) => Number.isFinite(n)),
  };
}

function pushStudioQuery(patch) {
  const cur = parseStudioQuery();
  const next = { ...cur, ...patch };
  const params = new URLSearchParams();
  if (next.run) params.set('run', String(next.run));
  if (next.event) params.set('event', String(next.event));
  if (next.compare?.length) params.set('compare', next.compare.join(','));
  const qs = params.toString();
  routerNavigate(`studio${qs ? `?${qs}` : ''}`);
}

let shortcutsBound = false;

export async function renderStudio(ctx) {
  studioCtx = ctx;
  ctx.setBreadcrumb('studio', 'Estúdio');
  ctx.renderContextBar?.();

  const query = parseStudioQuery();
  studioState.selectedRunId = query.run;
  studioState.selectedEventId = query.event;
  studioState.compareIds = query.compare || [];

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
    const strategyOptions = await loadStrategyOptions(ctx.api);

    renderConfigPanel(ctx, { formCtx, fieldOptions, strategyOptions });
    await refreshRuns(ctx);
    if (studioState.selectedRunId) await loadRunDetail(ctx, studioState.selectedRunId);
    else mount(document.getElementById('studio-main'), el('div', { class: 'card' }, [
      el('p', { class: 'muted' }, 'Selecione um run à direita ou rode um novo backtest.'),
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

function renderConfigPanel(ctx, { formCtx, fieldOptions, strategyOptions }) {
  const wrap = document.getElementById('studio-config');
  if (!wrap) return;
  mount(wrap, el('div', { class: 'card' }, [
    el('h2', { class: 'card__title' }, 'Configurar'),
    el('form', { id: 'studio-form', class: 'studio-form' }, [
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Estratégia'),
        el('div', { id: 'studio-strategy-pick' }),
      ]),
      el('label', { class: 'field' }, ['De ', el('input', { type: 'date', name: 'from', value: formCtx.from, class: 'field__input' })]),
      el('label', { class: 'field' }, ['Até ', el('input', { type: 'date', name: 'to', value: formCtx.to, class: 'field__input' })]),
      el('label', { class: 'field' }, ['Ativo ', selectField('underlying', fieldOptions.underlyings || [formCtx.underlying], formCtx.underlying)]),
      el('label', { class: 'field' }, ['Intervalo ', selectField('interval', fieldOptions.intervals || [formCtx.interval], formCtx.interval)]),
      el('label', { class: 'field' }, ['Book ', selectField('book_depth', fieldOptions.book_depths || [formCtx.book_depth], formCtx.book_depth)]),
      el('label', { class: 'field field--checkbox' }, [
        el('input', { type: 'checkbox', name: 'fast_run', value: '1' }),
        ' Modo rápido (menos traces)',
      ]),
      el('button', { class: 'btn btn--primary', type: 'submit' }, 'Rodar backtest'),
      el('button', { class: 'btn btn--ghost', type: 'button', id: 'studio-prepare-btn' }, 'Preparar dados'),
    ]),
  ]));

  const strategyPickWrap = document.getElementById('studio-strategy-pick');
  if (strategyPickWrap) {
    strategyPickWrap.innerHTML = renderStrategySelect(strategyOptions, strategyOptions[0]?.value || '');
  }

  const form = document.getElementById('studio-form');
  form?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    runBacktest(ctx, ev.target);
  });
  document.getElementById('studio-prepare-btn')?.addEventListener('click', () => prepareData(ctx));
}

async function runBacktest(ctx, form) {
  const fd = new FormData(form);
  saveContext({
    from: fd.get('from'),
    to: fd.get('to'),
    underlying: fd.get('underlying'),
    interval: fd.get('interval'),
    book_depth: fd.get('book_depth'),
  });
  const pick = form.querySelector('[name="strategy_pick"]')?.value;
  const payload = backtestPayloadFromPick(pick, {
    from: fd.get('from'),
    to: fd.get('to'),
    underlying: fd.get('underlying'),
    interval: fd.get('interval'),
    book_depth: Number(fd.get('book_depth')),
    batch_size: 25000,
    fast_run: fd.get('fast_run') === '1',
    async: true,
  });
  if (!payload) return ctx.toast.warn('Selecione uma estratégia');
  const res = await ctx.api.post('/api/backtest/run', payload);
  if (!res.ok) return ctx.toast.err(res.error?.message || 'Falha ao rodar');
  cacheInvalidate('runs');
  studioState.selectedRunId = res.data.run.id;
  pushStudioQuery({ run: studioState.selectedRunId, event: null });
  await refreshRuns(ctx);
  await loadRunDetail(ctx, studioState.selectedRunId);
  ctx.toast.ok('Backtest enfileirado');
}

async function prepareData(ctx) {
  const form = document.getElementById('studio-form');
  const fd = new FormData(form);
  const q = new URLSearchParams({
    dataset: 'backtest_ticks',
    from: String(fd.get('from')),
    to: String(fd.get('to')),
    underlying: String(fd.get('underlying')),
    interval: String(fd.get('interval')),
    book_depth: String(fd.get('book_depth')),
  });
  const res = await ctx.api.get(`/api/prepare?${q}`);
  if (!res.ok) return ctx.toast.err(res.error?.message || 'Erro');
  if (res.data.ready) return ctx.toast.ok('Dados já prontos');
  const job = await ctx.api.post('/api/prepare/run', { request: res.data.request, dry_run: false, confirm_rebuild: false });
  if (job.ok) ctx.toast.ok('Job de preparação criado');
  else ctx.toast.err(job.error?.message || 'Falha ao criar job');
}

async function refreshRuns(ctx) {
  const runs = await cachedFetch('runs:list', async () => {
    const res = await ctx.api.get('/api/backtest/runs?limit=30');
    return res.ok ? res.data.runs : [];
  }, 15_000);
  studioState.runs = runs;
  const panel = document.getElementById('studio-runs');
  if (!panel) return;
  mount(panel, el('div', { class: 'card studio-runs-card' }, [
    el('h3', { class: 'card__title' }, 'Runs'),
    el('div', { class: 'studio-run-list' }, runs.map((run) => runListItem(run, ctx))),
  ]));
}

function runListItem(run, ctx) {
  const active = studioState.selectedRunId === run.id;
  const compareOn = studioState.compareIds.includes(run.id);
  
  let pnlText = formatPnl(run.summary?.totalPnl);
  if (run.status === 'running') {
    pnlText = `Rodando (${run.progress?.percent?.toFixed(0) || 0}%)`;
  } else if (run.status === 'queued') {
    pnlText = 'Fila';
  }

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
  pushStudioQuery({ run: id, event: null });
  await refreshRuns(ctx);
  await loadRunDetail(ctx, id);
}

async function loadRunDetail(ctx, runId) {
  const main = document.getElementById('studio-main');
  if (!main) return;

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

  const kpis = [
    MetricCard({ label: 'PnL', value: formatPnl(run.summary?.totalPnl), tone: (run.summary?.totalPnl || 0) >= 0 ? 'ok' : 'err' }),
    MetricCard({ label: 'Win rate', value: `${(run.summary?.winRate || 0).toFixed(1)}%` }),
    MetricCard({ label: 'Eventos', value: String(run.summary?.totalEvents ?? '—') }),
    MetricCard({ label: 'Ticks', value: String(run.ticks ?? '—') }),
  ];

  mount(main, el('div', { class: 'studio-result' }, [
    el('div', { class: 'studio-kpis' }, kpis),
    el('div', { class: 'studio-equity', id: 'studio-equity-chart' }),
    el('div', { class: 'studio-tabs' }, [
      el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => loadAnalysis(ctx, runId) }, 'Análise'),
    ]),
    el('div', { class: 'studio-events-filter-bar' }, [
      el('div', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Buscar ID'),
        el('input', {
          type: 'text',
          class: 'field__input',
          placeholder: 'Buscar condição...',
          value: studioState.filterQ,
          oninput: debounce((ev) => {
            studioState.filterQ = ev.target.value;
            loadEvents(ctx, runId);
          }, 250),
        }),
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Resultado'),
        el('select', {
          class: 'field__input',
          onchange: (ev) => {
            studioState.filterResult = ev.target.value;
            loadEvents(ctx, runId);
          }
        }, [
          el('option', { value: 'all', selected: studioState.filterResult === 'all' }, 'Todos'),
          el('option', { value: 'win', selected: studioState.filterResult === 'win' }, 'Vitória'),
          el('option', { value: 'loss', selected: studioState.filterResult === 'loss' }, 'Derrota'),
          el('option', { value: 'no_entry', selected: studioState.filterResult === 'no_entry' }, 'Sem entrada'),
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field__label' }, 'Ordenar'),
        el('select', {
          class: 'field__input',
          onchange: (ev) => {
            studioState.filterSort = ev.target.value;
            loadEvents(ctx, runId);
          }
        }, [
          el('option', { value: 'default', selected: studioState.filterSort === 'default' }, 'Padrão'),
          el('option', { value: 'pnl_desc', selected: studioState.filterSort === 'pnl_desc' }, 'Melhor PnL'),
          el('option', { value: 'pnl_asc', selected: studioState.filterSort === 'pnl_asc' }, 'Pior PnL'),
          el('option', { value: 'event_start_desc', selected: studioState.filterSort === 'event_start_desc' }, 'Mais novos'),
          el('option', { value: 'event_start', selected: studioState.filterSort === 'event_start' }, 'Mais antigos'),
        ]),
      ]),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost',
        onclick: () => {
          const params = new URLSearchParams({
            format: 'csv',
            limit: '5000',
            q: studioState.filterQ,
            result: studioState.filterResult,
            sort: studioState.filterSort,
          });
          window.open(`/api/backtest/runs/${runId}/events?${params.toString()}`, '_blank');
        }
      }, [
        el('i', { class: 'fa-solid fa-download' }),
        ' Exportar CSV'
      ]),
    ]),
    el('div', { id: 'studio-events-table-container' }),
  ]));

  if (run.equity?.length) {
    renderUplotLine(document.getElementById('studio-equity-chart'), run.equity.map((p) => [new Date(p.ts).getTime(), p.pnl]));
  }
  await loadEvents(ctx, runId);
  if (studioState.selectedEventId) openEventDrawer(ctx, runId, studioState.selectedEventId);
}

async function loadEvents(ctx, runId) {
  const q = new URLSearchParams();
  q.set('limit', '500');
  if (studioState.filterQ) q.set('q', studioState.filterQ);
  if (studioState.filterResult !== 'all') q.set('result', studioState.filterResult);
  if (studioState.filterSort) q.set('sort', studioState.filterSort);
  
  const res = await ctx.api.get(`/api/backtest/runs/${runId}/events?${q.toString()}`);
  studioState.events = res.ok ? res.data.events : [];
  
  const tableContainer = document.getElementById('studio-events-table-container');
  if (tableContainer) {
    mount(tableContainer, renderVirtualEventTable(studioState.events, ctx, runId));
  }
}

function renderProgressPanel(container, run, ctx) {
  const progress = run.progress || { phase: 'queued', ticks: 0, total_ticks: null, percent: 0 };
  const percentVal = progress.percent != null ? progress.percent : 0;
  const etaText = progress.eta_ms != null ? `${Math.round(progress.eta_ms / 1000)}s` : 'calculando...';
  
  mount(container, el('div', { class: 'studio-progress-panel' }, [
    el('div', { class: 'studio-progress-card' }, [
      el('div', { class: 'studio-progress-card__head' }, [
        el('strong', {}, `Rodando Backtest #${run.id}`),
        StatusBadge({ status: run.status }),
      ]),
      el('div', { class: 'studio-progress-bar' }, [
        el('span', { class: 'studio-progress-fill', id: 'studio-progress-fill', style: { width: `${percentVal}%` } }),
      ]),
      el('div', { class: 'studio-progress-metrics' }, [
        el('div', { class: 'studio-progress-metric' }, [
          el('span', { class: 'studio-progress-metric__label' }, 'Progresso'),
          el('span', { class: 'studio-progress-metric__value', id: 'studio-progress-pct' }, `${percentVal.toFixed(1)}%`),
        ]),
        el('div', { class: 'studio-progress-metric' }, [
          el('span', { class: 'studio-progress-metric__label' }, 'Fase'),
          el('span', { class: 'studio-progress-metric__value', id: 'studio-progress-phase' }, progress.phase || 'queued'),
        ]),
        el('div', { class: 'studio-progress-metric' }, [
          el('span', { class: 'studio-progress-metric__label' }, 'Ticks Processados'),
          el('span', { class: 'studio-progress-metric__value', id: 'studio-progress-ticks' }, `${progress.ticks} / ${progress.total_ticks || 'estimando...'}`),
        ]),
        el('div', { class: 'studio-progress-metric' }, [
          el('span', { class: 'studio-progress-metric__label' }, 'Tempo Restante (ETA)'),
          el('span', { class: 'studio-progress-metric__value', id: 'studio-progress-eta' }, etaText),
        ]),
      ]),
      el('button', {
        type: 'button',
        class: 'btn btn--danger',
        style: { marginTop: '10px' },
        onclick: async () => {
          const ok = confirm('Deseja realmente cancelar este backtest?');
          if (!ok) return;
          const cancelRes = await ctx.api.post(`/api/backtest/runs/${run.id}/cancel`);
          if (cancelRes.ok) {
            ctx.toast.ok('Backtest cancelado');
            cacheInvalidate('runs');
            await refreshRuns(ctx);
            await loadRunDetail(ctx, run.id);
          } else {
            ctx.toast.err(cancelRes.error?.message || 'Falha ao cancelar');
          }
        }
      }, 'Cancelar Backtest'),
    ]),
  ]));
}

function updateProgressUI(runId, progress) {
  if (studioState.selectedRunId !== runId) return;
  const fill = document.getElementById('studio-progress-fill');
  const pct = document.getElementById('studio-progress-pct');
  const phase = document.getElementById('studio-progress-phase');
  const ticks = document.getElementById('studio-progress-ticks');
  const eta = document.getElementById('studio-progress-eta');
  
  const percentVal = progress.percent != null ? progress.percent : 0;
  if (fill) fill.style.width = `${percentVal}%`;
  if (pct) pct.textContent = `${percentVal.toFixed(1)}%`;
  if (phase) phase.textContent = progress.phase || 'running';
  if (ticks) ticks.textContent = `${progress.ticks} / ${progress.total_ticks || 'estimando...'}`;
  if (eta) eta.textContent = progress.eta_ms != null ? `${Math.round(progress.eta_ms / 1000)}s` : 'calculando...';
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

async function openEventDrawer(ctx, runId, eventId, index = 0) {
  studioState.selectedEventId = eventId;
  studioState.eventIndex = index;
  pushStudioQuery({ event: eventId });
  const drawer = document.getElementById('studio-drawer');
  if (!drawer) return;
  drawer.hidden = false;
  mount(drawer, Skeleton({ lines: 4 }));
  
  const res = await ctx.api.get(`/api/backtest/runs/${runId}/events/${eventId}`);
  if (!res.ok) return mount(drawer, el('p', {}, 'Evento não encontrado'));
  const event = res.data.event;

  const tabs = [
    { id: 'chart', label: 'Gráfico' },
    { id: 'orders', label: 'Ordens' },
    { id: 'logs', label: 'Logs' },
    { id: 'diagnostics', label: 'Diagnósticos' },
  ];

  let activeTab = 'chart';

  function renderDrawerContent() {
    const header = el('header', { class: 'studio-drawer__head' }, [
      el('strong', {}, `${event.condition_id} (${event.side || 'N/A'})`),
      el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => { drawer.hidden = true; } }, 'Fechar'),
    ]);

    const tabLinks = el('div', { class: 'drawer-tabs' }, tabs.map((t) => {
      const active = t.id === activeTab;
      return el('button', {
        type: 'button',
        class: `drawer-tab-link${active ? ' is-active' : ''}`,
        onclick: () => {
          activeTab = t.id;
          renderDrawerContent();
        }
      }, t.label);
    }));

    const panelChart = el('div', { class: `drawer-tab-panel${activeTab === 'chart' ? ' is-active' : ''}` }, [
      el('div', { id: 'studio-event-chart', class: 'studio-event-chart' }),
    ]);

    const panelOrders = el('div', { class: `drawer-tab-panel${activeTab === 'orders' ? ' is-active' : ''}` }, [
      event.orders?.length ? el('table', { class: 'studio-drawer__orders-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', {}, 'Lado'),
            el('th', {}, 'Shares'),
            el('th', {}, 'Preço'),
            el('th', {}, 'Valor'),
            el('th', {}, 'Tipo'),
            el('th', {}, 'Timestamp'),
          ])
        ]),
        el('tbody', {}, event.orders.map((o) => el('tr', {}, [
          el('td', {}, o.side || ''),
          el('td', {}, String(o.shares || '')),
          el('td', {}, formatPnl(o.price)),
          el('td', {}, formatPnl(o.notional)),
          el('td', {}, o.type || ''),
          el('td', {}, new Date(o.ts).toLocaleTimeString()),
        ])))
      ]) : el('p', { class: 'muted' }, 'Nenhuma ordem executada.')
    ]);

    const panelLogs = el('div', { class: `drawer-tab-panel${activeTab === 'logs' ? ' is-active' : ''}`, style: { maxHeight: '30vh', overflow: 'auto' } }, [
      event.logs?.length ? el('pre', { class: 'studio-drawer__logs' }, event.logs.map((l) => `[${new Date(l.ts).toLocaleTimeString()}] ${l.message}`).join('\n')) : el('p', { class: 'muted' }, 'Nenhum log gravado.')
    ]);

    const panelDiag = el('div', { class: `drawer-tab-panel${activeTab === 'diagnostics' ? ' is-active' : ''}` }, [
      event.diagnostics ? el('div', { class: 'diagnostics-grid' }, Object.entries(event.diagnostics).map(([k, v]) => el('div', { class: 'diagnostic-item' }, [
        el('div', { class: 'diagnostic-item__label' }, k),
        el('div', { class: 'diagnostic-item__value' }, typeof v === 'number' ? v.toFixed(4) : String(v)),
      ]))) : el('p', { class: 'muted' }, 'Nenhum diagnóstico disponível.')
    ]);

    mount(drawer, el('div', { class: 'studio-drawer__inner' }, [
      header,
      tabLinks,
      panelChart,
      panelOrders,
      panelLogs,
      panelDiag,
    ]));

    if (activeTab === 'chart' && event.series?.underlying?.length) {
      const pts = event.series.underlying.map((p) => [new Date(p.ts).getTime(), p.value]);
      const ptb = event.series.priceToBeat?.map((p) => [new Date(p.ts).getTime(), p.value]) || [];
      renderUplotLine(document.getElementById('studio-event-chart'), pts, [{ label: 'BTC', data: pts }, { label: 'PTB', data: ptb }]);
    }
  }

  renderDrawerContent();
}

async function loadAnalysis(ctx, runId) {
  const res = await ctx.api.get(`/api/backtest/runs/${runId}/analysis`);
  if (!res.ok) return ctx.toast.err('Análise indisponível');
  const main = document.getElementById('studio-main');
  const a = res.data.analysis;
  mount(main, el('div', { class: 'studio-analysis' }, [
    el('h3', {}, 'Piores eventos'),
    el('ul', {}, (a.worst_events || []).map((ev) => el('li', {}, [
      el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => openEventDrawer(ctx, runId, ev.id) },
        `${ev.condition_id} · ${formatPnl(ev.final_pnl)}`),
    ]))),
  ]));
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
    el('p', { class: 'muted' }, `${(data.delta_events || []).length} eventos divergentes`),
    el('div', { class: 'studio-compare-delta' }, (data.delta_events || []).slice(0, 12).map((row) => el('div', { class: 'studio-event-row' }, [
      el('span', {}, row.condition_id?.slice(0, 14) || '—'),
      el('span', {}, formatPnl(row.pnl_a)),
      el('span', {}, formatPnl(row.pnl_b)),
      el('span', { class: 'muted' }, formatPnl(row.delta)),
    ]))),
  ]));
  const runs = data.runs || [];
  const series = runs
    .filter((r) => r.equity?.length)
    .map((r) => ({
      label: `#${r.id}`,
      data: r.equity.map((p) => [new Date(p.ts).getTime(), p.pnl]),
    }));
  if (series.length) {
    renderUplotLine(document.getElementById('studio-compare-chart'), series[0].data, series.slice(1));
  }
}

function bindSse(ctx) {
  if (sseHandler) disconnectSse(sseHandler);
  sseHandler = (event) => {
    if (event.type === 'run:progress') {
      if (event.runId === studioState.selectedRunId) {
        updateProgressUI(event.runId, event.progress);
      }
      const itemEl = document.getElementById(`run-item-${event.runId}`);
      if (itemEl) {
        const pnlEl = itemEl.querySelector('.studio-run-item__pnl');
        if (pnlEl) pnlEl.textContent = `Rodando (${event.progress?.percent?.toFixed(0) || 0}%)`;
      }
    }
    if (event.type === 'run:completed' || event.type === 'run:failed') {
      cacheInvalidate('runs');
      refreshRuns(ctx);
      if (event.runId === studioState.selectedRunId) loadRunDetail(ctx, event.runId);
    }
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
      const form = document.getElementById('studio-form');
      if (form) form.requestSubmit();
    }
  });
}

export function redirectLegacyBacktestRoute(params) {
  if (params.eventId) routerNavigate(`studio?run=${params.id}&event=${params.eventId}`);
  else routerNavigate(`studio?run=${params.id}`);
}
