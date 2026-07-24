import { formatStoredRange } from '../utils/dateRange.js';
import { el, mount, emptyState } from '../utils/dom.js';
import { loadContext } from '../utils/context.js';
import { backtestPayloadFromPick } from '../utils/strategyPicker.js';
import { notifyStudioCatalogChanged, notifyRunDataChanged, registerStrategiesRefresh } from '../utils/studioCatalogSync.js';
import { promptDialog, confirmDialog } from '../utils/confirm.js';
import { formatPnl } from '../utils/format.js';
import { renderUplotSparkline, destroyChartsIn } from '../utils/uplotChart.js';
import { updateSourceParams } from '../utils/updateSourceParams.js';

const STRATEGY_JS_TEMPLATE_BODY = `export default strategy({
  name: "Nova Estrategia",

  params: {
    minDistanceAbs: 50,
    maxAsk: 0.58,
    budget: 15,
  },

  onEventStart({ state }) {
    state.entered = false;
  },

  onTick(ctx) {
    const { tick, event, state, params } = ctx;
    const dist = market.distanceFromPtb(tick.underlyingPrice, event.priceToBeat);
    const side = market.sideFromPrice(tick.underlyingPrice, event.priceToBeat);
    const ask = book.ask(side, tick);
    if (!state.entered && dist >= params.minDistanceAbs && ask <= params.maxAsk) {
      orders.enter(side, { price: ask, budget: params.budget, reason: "entry" });
      state.entered = true;
      trace.mark("entry");
    }
  },

  onEventEnd() {
    orders.closeOpenPosition({ reason: "event_end" });
  },
});`;

function buildStrategyJsTemplate(name = 'Nova Estrategia') {
  const safeName = String(name || 'Nova Estrategia').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return STRATEGY_JS_TEMPLATE_BODY.replace('Nova Estrategia', safeName);
}

function buildGlsTemplate(name = 'Nova Estrategia') {
  const safeName = String(name || 'Nova Estrategia').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `strategy "${safeName}" {
  param minDistanceAbs = 50
  param maxAsk = 0.58
  param budget = 15

  onEventStart(event) {
    state.entered = false
  }

  onTick(tick, event) {
    let dist = market.distanceFromPtb(tick.underlyingPrice, event.priceToBeat)
    let side = market.sideFromPrice(tick.underlyingPrice, event.priceToBeat)
    let ask = book.ask(side, tick)
    if (!state.entered && dist >= params.minDistanceAbs && ask <= params.maxAsk) {
      enter(side, { price: ask, budget: params.budget, reason: "entry" })
      state.entered = true
      mark("entry")
    }
  }

  onEventEnd(event) {
    closeOpenPosition({ reason: "event_end" })
  }
}`;
}

function buildDefaultTemplate(name, language = 'strategy-js-v1') {
  return language === 'gls-v1' ? buildGlsTemplate(name) : buildStrategyJsTemplate(name);
}

function renderStrategyPerformanceSummary(stats) {
  const totals = stats?.totals || {};
  const runs = totals.runs ?? 0;
  if (!runs) {
    return el('p', { class: 'strategy-summary-strip muted' }, 'Nenhuma simulação ainda. Rode um backtest no Estúdio para ver desempenho aqui.');
  }
  const wr = totals.win_rate ?? 0;
  const avgPnl = totals.avg_pnl ?? 0;
  const bestPnl = totals.best_pnl ?? 0;
  const parts = [
    `${runs} run${runs === 1 ? '' : 's'}`,
    `${Math.round(wr * 100)}% WR`,
  ];
  return el('p', { class: 'strategy-summary-strip' }, [
    parts.join(' · '),
    ' · ',
    el('span', {
      style: { color: avgPnl > 0 ? 'var(--ok)' : (avgPnl < 0 ? 'var(--err)' : 'inherit') },
    }, `${formatPnl(avgPnl)} médio`),
    bestPnl ? ` · melhor ${formatPnl(bestPnl)}` : '',
  ]);
}

/** @type {{ list: object[], selectedId: number|null, selectedVersionId: number|null, focusedEditor: object|null, sourceCode: string, validation: object|null, blocks: object[], currentStrategy: object|null, currentVersion: object|null, strategyQuery: string, statusFilter: string, historyStrategyId: number|null, historyFilters: object }} */
const state = {
  list: [],
  selectedId: null,
  selectedVersionId: null,
  focusedEditor: null,
  sourceCode: '',
  validation: null,
  blocks: [],
  capabilities: null,
  editorLanguage: 'strategy-js-v1',
  currentStrategy: null,
  currentVersion: null,
  strategyQuery: '',
  statusFilter: 'all',
  librarySort: 'last_use',
  libraryStats: [],
  trashList: [],
  historyStrategyId: null,
  historyFilters: {
    versionQuery: '',
    versionScope: 'all',
    runQuery: '',
    runOutcome: 'all',
  },
  historyPanelApi: null,
  historyFocusedVersionId: null,
  presets: [],
  selectedPresetId: null,
  presetCompareId: null,
};

let strategiesViewCtx = null;

export function unregisterStrategiesView() {
  strategiesViewCtx = null;
  registerStrategiesRefresh(null);
}

function strategiesRouteParams() {
  const path = location.hash.replace(/^#\/?/, '').split('?')[0];
  const parts = path.split('/');
  if (parts[0] !== 'strategies') return null;
  if (parts[1] === 'trash') return { trash: true };
  const params = {};
  if (parts[1]) params.id = parts[1];
  if (parts[2]) params.versionId = parts[2];
  return params;
}

function registerStrategiesView(ctx) {
  strategiesViewCtx = ctx;
  registerStrategiesRefresh(async () => {
    if (!strategiesViewCtx || !document.getElementById('strategies-root')) return;
    const params = strategiesRouteParams();
    if (!params) return;
    await renderStrategies(strategiesViewCtx, params);
  });
}

const DEFAULT_HISTORY_FILTERS = {
  versionQuery: '',
  versionScope: 'all',
  runQuery: '',
  runOutcome: 'all',
};

function versionOptionLabel(v, strategy) {
  const parts = [`v${v.version}`];
  if (strategy?.default_version_id === v.id) parts.push('padrão');
  if (v.notes) parts.push(v.notes);
  return parts.join(' · ');
}

function resetHistoryFilters(strategyId) {
  if (state.historyStrategyId !== strategyId) {
    state.historyStrategyId = strategyId;
    state.historyFilters = { ...DEFAULT_HISTORY_FILTERS };
    state.historyFocusedVersionId = null;
  }
}

function captureScrollState(ctx) {
  return {
    windowY: window.scrollY,
    contentTop: ctx.contentEl?.scrollTop ?? 0,
    activeTab: document.querySelector('.premium-tab-content.is-active')?.id?.replace('tab-content-', '') || 'stats',
  };
}

function restoreScrollState(ctx, snap) {
  if (!snap) return;
  if (snap.activeTab) switchTab(snap.activeTab);
  requestAnimationFrame(() => {
    window.scrollTo(0, snap.windowY);
    if (ctx.contentEl) ctx.contentEl.scrollTop = snap.contentTop;
  });
}

function filterVersions(versions, stats, strategy) {
  const q = state.historyFilters.versionQuery.toLowerCase().trim();
  return versions.filter((v) => {
    const vStat = stats.by_version?.find((bv) => bv.version_id === v.id) || {};
    const runs = vStat.runs ?? 0;
    if (state.historyFilters.versionScope === 'tested' && runs === 0) return false;
    if (state.historyFilters.versionScope === 'untested' && runs > 0) return false;
    if (state.historyFilters.versionScope === 'default' && strategy.default_version_id !== v.id) return false;
    if (!q) return true;
    const hay = `v${v.version} ${v.notes || ''}`.toLowerCase();
    return hay.includes(q);
  });
}

function filterRuns(runs, versions) {
  const q = state.historyFilters.runQuery.toLowerCase().trim();
  const versionId = state.historyFocusedVersionId;
  return runs.filter((run) => {
    if (versionId && run.strategy_version_id !== versionId) return false;
    const pnl = run.summary?.totalPnl ?? 0;
    if (state.historyFilters.runOutcome === 'positive' && pnl <= 0) return false;
    if (state.historyFilters.runOutcome === 'negative' && pnl >= 0) return false;
    if (!q) return true;
    const versionLabel = run.strategy_version_id
      ? `v${versions.find((v) => v.id === run.strategy_version_id)?.version || ''}`
      : '';
    const hay = `#${run.id} ${versionLabel} ${run.underlying || ''} ${run.interval || ''}`.toLowerCase();
    return hay.includes(q);
  });
}

function renderVersionTableRow(ctx, strategy, version, versionStat, onVersionFocus) {
  const isDefault = strategy.default_version_id === version.id;
  const isFocused = state.historyFocusedVersionId === version.id;
  const vRuns = versionStat.runs ?? 0;
  const vWinRate = versionStat.win_rate ?? 0;
  const vAvgPnl = versionStat.avg_pnl ?? 0;

  return el('tr', {
    class: `strategy-history-row${isDefault ? ' is-default' : ''}${isFocused ? ' is-selected' : ''}`,
    title: 'Clique para ver simulações desta versão',
    onclick: (e) => {
      if (e.target.closest('button')) return;
      onVersionFocus(version.id, { scroll: true });
    },
  }, [
    el('td', { class: 'mono strategy-history-col--version' }, el('strong', {}, `v${version.version}`)),
    el('td', { class: 'strategy-history-col--notes', title: version.notes || '' },
      version.notes || el('span', { class: 'muted' }, '—')),
    el('td', { class: 'mono strategy-history-col--num' }, vRuns > 0 ? String(vRuns) : el('span', { class: 'muted' }, '0')),
    el('td', { class: 'mono strategy-history-col--num' },
      vRuns > 0 ? `${Math.round(vWinRate * 100)}%` : el('span', { class: 'muted' }, '—')),
    el('td', {
      class: 'mono strategy-history-col--num',
      style: { color: vRuns > 0 ? (vAvgPnl > 0 ? 'var(--ok)' : (vAvgPnl < 0 ? 'var(--err)' : 'inherit')) : 'inherit' },
    }, vRuns > 0 ? formatPnl(vAvgPnl) : el('span', { class: 'muted' }, '—')),
    el('td', { class: 'strategy-history-col--actions' }, el('div', { class: 'btn-group' }, [
      el('button', {
        class: `btn btn--ghost btn--sm btn--icon strategy-version-star${isDefault ? ' is-on' : ''}`,
        type: 'button',
        title: isDefault ? 'Versão padrão no Estúdio' : 'Fixar como padrão',
        disabled: isDefault,
        onclick: async (e) => {
          e.stopPropagation();
          const res = await ctx.api.patch(`/api/strategies/${strategy.id}`, { default_version_id: version.id });
          if (!res.ok) return ctx.toast.err(res.error?.message || 'Falha ao fixar versão');
          strategy.default_version_id = version.id;
          notifyStudioCatalogChanged();
          ctx.toast.ok('Versão fixada como padrão');
          await state.historyPanelApi?.refresh({ scrollSnap: captureScrollState(ctx) });
        },
      }, '★'),
      el('button', {
        class: 'btn btn--ghost btn--sm btn--icon',
        type: 'button',
        title: 'Rodar no Estúdio',
        onclick: (e) => {
          e.stopPropagation();
          ctx.navigate(`studio?strategy=${strategy.id}&version=${version.id}`);
        },
      }, '▶'),
      el('button', {
        class: 'btn btn--ghost btn--sm btn--icon btn--danger-hover',
        type: 'button',
        title: 'Excluir versão',
        onclick: (e) => {
          e.stopPropagation();
          deleteVersionFlow(ctx, strategy, version);
        },
      }, el('i', { class: 'fa-solid fa-trash-can' })),
    ])),
  ]);
}

function renderRunTableRow(ctx, strategyId, run, versions) {
  const pnl = run.summary?.totalPnl ?? 0;
  const wr = run.summary?.winRate ?? 0;
  const winRateFormatted = wr ? `${Math.round(wr * (wr > 1 ? 1 : 100))}%` : '—';
  const versionLabel = run.strategy_version_id
    ? `v${versions.find((v) => v.id === run.strategy_version_id)?.version || '?'}`
    : '—';
  const period = formatStoredRange(run.from, run.to);
  const ranAt = run.created_at ? run.created_at.slice(0, 16).replace('T', ' ') : '—';

  return el('tr', {
    class: `strategy-history-row strategy-history-row--run${pnl > 0 ? ' is-profit' : (pnl < 0 ? ' is-loss' : '')}`,
    title: 'Clique para abrir no Estúdio',
    onclick: (e) => {
      if (e.target.closest('button')) return;
      ctx.navigate(`studio?run=${run.id}`);
    },
  }, [
    el('td', { class: 'mono strategy-history-col--id' }, `#${run.id}`),
    el('td', { class: 'mono strategy-history-col--version' }, versionLabel),
    el('td', { class: 'mono strategy-history-col--asset' }, `${run.underlying} · ${run.interval}`),
    el('td', { class: 'strategy-history-col--period muted' }, period),
    el('td', {
      class: 'mono strategy-history-col--num',
      style: { color: pnl > 0 ? 'var(--ok)' : (pnl < 0 ? 'var(--err)' : 'inherit'), fontWeight: '600' },
    }, formatPnl(pnl)),
    el('td', { class: 'mono strategy-history-col--num muted' }, winRateFormatted),
    el('td', { class: 'strategy-history-col--date muted' }, ranAt),
    el('td', { class: 'strategy-history-col--actions' }, el('button', {
      class: 'btn btn--ghost btn--sm btn--icon btn--danger-hover',
      type: 'button',
      title: 'Excluir simulação',
      onclick: (e) => {
        e.stopPropagation();
        deleteRunFlow(ctx, strategyId, run.id);
      },
    }, el('i', { class: 'fa-solid fa-trash-can' }))),
  ]);
}

function renderHistoryFilterCount(shown, total) {
  if (shown === total) return el('span', { class: 'strategy-history-count' }, `${total} item${total === 1 ? '' : 's'}`);
  return el('span', { class: 'strategy-history-count' }, `${shown} de ${total}`);
}

function renderStrategyHistoryTab(ctx, { strategy, strategyId, versions: initialVersions, strategyRuns: initialRuns, strategyStats: initialStats, switchTab }) {
  let strategyRef = strategy;
  let versions = [...(initialVersions || [])];
  let strategyRuns = [...(initialRuns || [])];
  let strategyStats = initialStats;
  let stats = strategyStats || { totals: {}, by_version: [] };
  const summaryEl = el('div', { class: 'strategy-summary-host' });
  const versionsTbody = el('tbody', { id: 'strategy-versions-tbody' });
  const runsTbody = el('tbody', { id: 'strategy-runs-tbody' });
  const versionsCountEl = el('span', { class: 'strategy-history-count' });
  const runsCountEl = el('span', { class: 'strategy-history-count' });
  const runsSectionTitleEl = el('h3', { class: 'card__title' }, 'Simulações');

  function updateRunsSectionTitle() {
    const focused = state.historyFocusedVersionId
      ? versions.find((v) => v.id === state.historyFocusedVersionId)
      : null;
    mount(runsSectionTitleEl, [
      'Simulações',
      focused
        ? el('span', { class: 'muted', style: { fontWeight: 400, fontSize: '13px', marginLeft: '8px' } }, `· v${focused.version}`)
        : null,
    ]);
  }

  function focusVersionInHistory(versionId, { scroll = false } = {}) {
    state.historyFocusedVersionId = versionId;
    updateRunsSectionTitle();
    refreshVersionsTable();
    refreshRunsTable();
    if (scroll) {
      document.querySelector('#tab-content-stats .strategy-history-section:last-child')
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function refreshVersionsTable() {
    const filtered = filterVersions(versions, stats, strategyRef);
    mount(versionsCountEl, [renderHistoryFilterCount(filtered.length, versions.length)]);
    if (!filtered.length) {
      mount(versionsTbody, el('tr', {}, el('td', {
        colspan: '6',
        class: 'strategy-history-empty-cell muted',
      }, versions.length ? 'Nenhuma versão corresponde ao filtro.' : 'Nenhuma versão salva.')));
      return;
    }
    mount(versionsTbody, filtered.map((v) => {
      const vStat = stats.by_version?.find((bv) => bv.version_id === v.id) || {};
      return renderVersionTableRow(ctx, strategyRef, v, vStat, focusVersionInHistory);
    }));
  }

  function refreshRunsTable() {
    const filtered = filterRuns(strategyRuns, versions);
    mount(runsCountEl, [renderHistoryFilterCount(filtered.length, strategyRuns.length)]);
    if (!filtered.length) {
      mount(runsTbody, el('tr', {}, el('td', {
        colspan: '8',
        class: 'strategy-history-empty-cell muted',
      }, strategyRuns.length ? 'Nenhuma simulação corresponde ao filtro.' : 'Nenhuma simulação executada ainda.')));
      return;
    }
    mount(runsTbody, filtered.map((r) => renderRunTableRow(ctx, strategyId, r, versions)));
  }

  function onFilterChange() {
    refreshVersionsTable();
    refreshRunsTable();
  }

  async function refresh(opts = {}) {
    const scrollSnap = opts.scrollSnap ?? captureScrollState(ctx);
    const [statsRes, runsRes, versionsRes, strategyRes] = await Promise.all([
      ctx.api.get(`/api/strategies/${strategyId}/stats`),
      ctx.api.get(`/api/backtest/runs?strategy_id=${strategyId}&limit=50`),
      ctx.api.get(`/api/strategies/${strategyId}/versions`),
      ctx.api.get(`/api/strategies/${strategyId}`),
    ]);
    if (strategyRes.ok) strategyRef = strategyRes.data.strategy;
    if (versionsRes.ok) versions = versionsRes.data.versions || [];
    if (runsRes.ok) strategyRuns = runsRes.data.runs || [];
    if (statsRes.ok) {
      strategyStats = statsRes.data.stats;
      stats = strategyStats || { totals: {}, by_version: [] };
    }
    if (state.historyFocusedVersionId && !versions.some((v) => v.id === state.historyFocusedVersionId)) {
      state.historyFocusedVersionId = null;
    }
    mount(summaryEl, renderStrategyPerformanceSummary(strategyStats));
    updateRunsSectionTitle();
    refreshVersionsTable();
    refreshRunsTable();
    restoreScrollState(ctx, scrollSnap);
    return { strategy: strategyRef, versions, strategyRuns, strategyStats };
  }

  const versionScopeSelect = el('select', {
    class: 'field__input field__input--sm',
    value: state.historyFilters.versionScope,
    onchange: (e) => {
      state.historyFilters.versionScope = e.target.value;
      onFilterChange();
    },
  }, [
    el('option', { value: 'all' }, 'Todas'),
    el('option', { value: 'tested' }, 'Com simulações'),
    el('option', { value: 'untested' }, 'Sem simulações'),
    el('option', { value: 'default' }, 'Padrão'),
  ]);
  versionScopeSelect.value = state.historyFilters.versionScope;

  const runOutcomeSelect = el('select', {
    class: 'field__input field__input--sm',
    onchange: (e) => {
      state.historyFilters.runOutcome = e.target.value;
      onFilterChange();
    },
  }, [
    el('option', { value: 'all' }, 'Qualquer resultado'),
    el('option', { value: 'positive' }, 'Lucro'),
    el('option', { value: 'negative' }, 'Prejuízo'),
  ]);
  runOutcomeSelect.value = state.historyFilters.runOutcome;

  mount(summaryEl, renderStrategyPerformanceSummary(strategyStats));
  updateRunsSectionTitle();
  refreshVersionsTable();
  refreshRunsTable();

  state.historyPanelApi = {
    strategyId,
    refresh,
    getVersions: () => versions,
  };

  return el('div', { class: 'strategy-history-tab' }, [
    summaryEl,
    el('section', { class: 'strategy-history-section' }, [
      el('div', { class: 'strategy-history-section__head' }, [
        el('h3', { class: 'card__title' }, 'Versões'),
        el('div', { class: 'row', style: { gap: '8px' } }, [
          versionsCountEl,
          el('button', {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onclick: () => switchTab('code'),
          }, [el('i', { class: 'fa-solid fa-plus' }), ' Nova versão']),
        ]),
      ]),
      el('div', { class: 'strategy-history-toolbar' }, [
        el('input', {
          class: 'field__input field__input--sm strategy-history-search',
          type: 'search',
          placeholder: 'Buscar versão ou nota…',
          value: state.historyFilters.versionQuery,
          oninput: (e) => {
            state.historyFilters.versionQuery = e.target.value;
            refreshVersionsTable();
          },
        }),
        versionScopeSelect,
      ]),
      el('div', { class: 'strategy-history-table-wrap' }, [
        el('table', { class: 'strategy-history-table strategy-history-table--versions' }, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, 'Versão'),
            el('th', {}, 'Notas'),
            el('th', {}, 'Runs'),
            el('th', {}, 'Win rate'),
            el('th', {}, 'PnL médio'),
            el('th', {}, 'Ações'),
          ])),
          versionsTbody,
        ]),
      ]),
    ]),
    el('section', { class: 'strategy-history-section' }, [
      el('div', { class: 'strategy-history-section__head' }, [
        runsSectionTitleEl,
        runsCountEl,
      ]),
      el('div', { class: 'strategy-history-toolbar' }, [
        el('input', {
          class: 'field__input field__input--sm strategy-history-search',
          type: 'search',
          placeholder: 'Buscar #, ativo ou intervalo…',
          value: state.historyFilters.runQuery,
          oninput: (e) => {
            state.historyFilters.runQuery = e.target.value;
            refreshRunsTable();
          },
        }),
        runOutcomeSelect,
      ]),
      el('div', { class: 'strategy-history-table-wrap' }, [
        el('table', { class: 'strategy-history-table strategy-history-table--runs' }, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, '#'),
            el('th', {}, 'Versão'),
            el('th', {}, 'Ativo'),
            el('th', {}, 'Período'),
            el('th', {}, 'PnL'),
            el('th', {}, 'WR'),
            el('th', {}, 'Executado'),
            el('th', {}, 'Ações'),
          ])),
          runsTbody,
        ]),
      ]),
    ]),
  ]);
}

function renderVisualDiff(a, b) {
  const left = String(a).split('\n');
  const right = String(b).split('\n');
  const max = Math.max(left.length, right.length);
  const elements = [];

  for (let i = 0; i < max; i++) {
    const l = left[i];
    const r = right[i];
    if (l === r) {
      elements.push(el('div', { class: 'diff-line' }, [
        el('span', { class: 'diff-line-number' }, String(i + 1)),
        el('span', { class: 'diff-line-text' }, l ?? '')
      ]));
    } else {
      if (l !== undefined) {
        elements.push(el('div', { class: 'diff-line diff-line--removed' }, [
          el('span', { class: 'diff-line-number' }, String(i + 1)),
          el('span', { class: 'diff-line-text' }, `- ${l}`)
        ]));
      }
      if (r !== undefined) {
        elements.push(el('div', { class: 'diff-line diff-line--added' }, [
          el('span', { class: 'diff-line-number' }, String(i + 1)),
          el('span', { class: 'diff-line-text' }, `+ ${r}`)
        ]));
      }
    }
  }

  return el('div', { class: 'visual-diff-container' }, elements);
}

export async function renderStrategies(ctx, params = {}) {
  const routeToken = ctx.getRouteToken?.() ?? 0;
  registerStrategiesView(ctx);
  if (params.trash) {
    return renderTrashView(ctx);
  }

  const strategyId = params.id ? Number(params.id) : null;
  if (strategyId) state.selectedId = strategyId;
  ctx.setBreadcrumb('strategies', null);

  // Clean up any old editor before loading
  if (state.focusedEditor) {
    try {
      state.focusedEditor.toTextArea();
    } catch { /* ignore */ }
    state.focusedEditor = null;
  }

  mount(ctx.contentEl, [
    el('div', { class: 'editor-layout editor-layout--full-width', id: 'strategies-root', style: { marginTop: '12px' } }, el('p', { class: 'muted' }, 'Carregando...')),
  ]);

  const res = await ctx.api.get('/api/strategies?stats=1');
  if ((ctx.getRouteToken?.() ?? routeToken) !== routeToken) return;
  if (!res.ok) {
    mount(document.getElementById('strategies-root'), el('div', { class: 'stack', style: { gap: '12px' } }, [
      el('p', { class: 'bad' }, res.error?.message || 'Falha ao carregar estratégias'),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        onclick: () => renderStrategies(ctx, params),
      }, 'Tentar novamente'),
    ]));
    return;
  }
  state.list = res.data.strategies || [];
  state.libraryStats = state.list;
  if (state.selectedId && !state.list.some((strategy) => strategy.id === state.selectedId)) {
    state.selectedId = null;
    state.selectedVersionId = null;
  }

  if (!strategyId) {
    ctx.setBreadcrumb('strategies', 'Biblioteca');
    mount(document.getElementById('strategies-root'), renderLibrary(ctx));
    requestAnimationFrame(() => _renderLibrarySparklines());
    return;
  }

  const selected = state.list.find((strategy) => strategy.id === state.selectedId);
  ctx.setBreadcrumb('strategies', selected?.name || null);

  mount(document.getElementById('strategies-root'), [
    el('div', { class: 'editor-main card editor-main--full-width', id: 'strategy-editor' }, el('p', { class: 'muted' }, 'Selecione uma estratégia.')),
  ]);

  await openStrategyEditor(ctx, state.selectedId, params.versionId ? Number(params.versionId) : null);
}

function renderLibrary(ctx) {
  const filtered = state.list.filter((s) => {
    const q = state.strategyQuery.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.slug.toLowerCase().includes(q);
  }).sort((a, b) => {
    const sa = a.stats?.totals || {};
    const sb = b.stats?.totals || {};
    if (state.librarySort === 'best_pnl') return (sb.best_pnl ?? 0) - (sa.best_pnl ?? 0);
    if (state.librarySort === 'win_rate') return (sb.win_rate ?? 0) - (sa.win_rate ?? 0);
    if (state.librarySort === 'name') return a.name.localeCompare(b.name);
    return String(sb.last_run_at || '').localeCompare(String(sa.last_run_at || ''));
  });

  const columns = {
    draft: { title: 'Em Teste', class: 'warn', items: [] },
    validated: { title: 'Aprovadas', class: 'ok', items: [] },
    failed: { title: 'Falharam', class: 'err', items: [] },
    archived: { title: 'Arquivadas', class: 'idle', items: [] }
  };

  for (const s of filtered) {
    const status = s.status || 'draft';
    if (columns[status]) {
      columns[status].items.push(s);
    } else {
      columns.draft.items.push(s);
    }
  }

  return el('div', { class: 'strategy-library', style: { marginTop: '12px' } }, [
    el('div', { class: 'strategy-library__toolbar', style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } }, [
      el('input', {
        class: 'field__input search-field-library',
        placeholder: 'Buscar estratégias…',
        value: state.strategyQuery,
        oninput: (e) => { state.strategyQuery = e.target.value; updateKanbanCards(ctx); },
        style: { flex: '1', minWidth: '200px' }
      }),
      el('select', {
        class: 'field__input sort-field-library',
        onchange: (e) => { state.librarySort = e.target.value; renderStrategies(ctx); },
        style: { minWidth: '130px' }
      }, [
        el('option', { value: 'last_use', selected: state.librarySort === 'last_use' }, 'Último uso'),
        el('option', { value: 'best_pnl', selected: state.librarySort === 'best_pnl' }, 'Melhor PnL'),
        el('option', { value: 'win_rate', selected: state.librarySort === 'win_rate' }, 'Win rate'),
        el('option', { value: 'name', selected: state.librarySort === 'name' }, 'Nome'),
      ]),
      el('div', { class: 'row', style: { marginLeft: 'auto', gap: '8px' } }, [
        el('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => createStrategyFlow(ctx) }, [
          el('i', { class: 'fa-solid fa-plus', style: { marginRight: '6px' } }),
          'Nova'
        ]),
        el('button', {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          title: 'Estratégias removidas da biblioteca',
          onclick: () => ctx.navigate('strategies/trash'),
        }, [
          el('i', { class: 'fa-solid fa-trash-can', style: { marginRight: '6px' } }),
          'Lixeira',
        ]),
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => renderStrategies(ctx) }, [
          el('i', { class: 'fa-solid fa-rotate', style: { marginRight: '6px' } }),
          'Recarregar'
        ]),
      ])
    ]),
    el('div', { class: 'strategy-kanban' }, Object.entries(columns).map(([statusKey, col]) => {
      return el('div', { class: `kanban-column kanban-column--${col.class}`, dataset: { status: statusKey } }, [
        el('div', { class: 'kanban-column__header' }, [
          el('div', { class: 'row' }, [
            el('span', { class: `dot dot--${col.class}` }),
            el('h3', {}, col.title),
          ]),
          el('div', { class: 'row' }, [
            el('span', { class: 'kanban-column__count' }, String(col.items.length)),
            statusKey === 'draft' ? el('button', {
              class: 'btn btn--ghost btn--sm btn--icon',
              style: { width: '24px', height: '24px', padding: 0 },
              title: 'Nova estratégia rápida',
              onclick: () => createStrategyFlow(ctx)
            }, '+') : null
          ])
        ]),
        el('div', {
          class: 'kanban-column__cards',
          ondragover: (e) => {
            e.preventDefault();
            e.currentTarget.classList.add('is-drag-over');
          },
          ondragleave: (e) => {
            e.currentTarget.classList.remove('is-drag-over');
          },
          ondrop: async (e) => {
            e.preventDefault();
            e.currentTarget.classList.remove('is-drag-over');
            const strategyId = Number(e.dataTransfer.getData('text/plain'));
            const nextStatus = statusKey;
            if (strategyId) {
              const strategy = state.list.find(s => s.id === strategyId);
              if (strategy && strategy.status !== nextStatus) {
                const patchRes = await ctx.api.patch(`/api/strategies/${strategyId}`, { status: nextStatus });
                if (patchRes.ok) {
                  ctx.toast.ok(`"${strategy.name}" movida para ${col.title}`);
                  const listRes = await ctx.api.get('/api/strategies?stats=1');
                  if (listRes.ok) {
                    state.list = listRes.data.strategies || [];
                    state.libraryStats = state.list;
                  }
                  renderStrategies(ctx);
                  notifyStudioCatalogChanged();
                } else {
                  ctx.toast.err(patchRes.error?.message || 'Falha ao mover estratégia');
                }
              }
            }
          }
        }, col.items.length
          ? col.items.map((s) => strategyCard(ctx, s))
          : [el('div', { class: 'kanban-empty-column' }, 'Arraste estratégias aqui')])
      ]);
    }))
  ]);
}

function updateKanbanCards(ctx) {
  const q = state.strategyQuery.toLowerCase();
  document.querySelectorAll('.strategy-card').forEach((card) => {
    const titleEl = card.querySelector('.strategy-card__title');
    if (titleEl) {
      const name = titleEl.textContent.toLowerCase();
      const match = name.includes(q);
      card.style.display = match ? 'flex' : 'none';
    }
  });
}

function cardChartForStrategy(strategy) {
  return strategy.stats?.card_chart || strategy.card_chart || null;
}

function formatCardChartCaption(chart) {
  if (!chart) return '';
  const asset = chart.underlying && chart.interval ? `${chart.underlying} · ${chart.interval}` : '';
  const period = chart.from && chart.to ? `${chart.from} → ${chart.to}` : '';
  const version = chart.version != null ? `v${chart.version}` : '';
  if (chart.type === 'evolution') {
    const parts = [`${chart.comparable_runs} execuções`, version, asset, period].filter(Boolean);
    return parts.join(' · ');
  }
  const parts = [`#${chart.run_id}`, version, asset, period].filter(Boolean);
  return parts.join(' · ');
}

function cardChartStroke(chart) {
  if (!chart?.values?.length) return '#f97316';
  const last = chart.values[chart.values.length - 1];
  if (chart.type === 'evolution') return '#38bdf8';
  return last >= 0 ? '#34d399' : '#f87171';
}

function strategyCard(ctx, strategy) {
  const stats = strategy.stats?.totals || strategy.totals || {};
  const cardChart = cardChartForStrategy(strategy);
  const hasChart = cardChart?.values?.length > 0;
  const versionNum = strategy.latest_version ?? strategy.stats?.by_version?.[0]?.version;
  return el('article', {
    class: `strategy-card${strategy.pinned ? ' is-pinned-card' : ''}`,
    draggable: 'true',
    dataset: { id: String(strategy.id) },
    ondragstart: (e) => {
      e.dataTransfer.setData('text/plain', String(strategy.id));
      e.currentTarget.classList.add('is-dragging');
    },
    ondragend: (e) => {
      e.currentTarget.classList.remove('is-dragging');
    }
  }, [
    el('header', { class: 'strategy-card__head' }, [
      el('button', {
        type: 'button',
        class: `strategy-card__star${strategy.pinned ? ' is-pinned' : ''}`,
        title: 'Favorito',
        'aria-label': strategy.pinned ? 'Remover favorito' : 'Marcar favorito',
        onclick: async (e) => {
          e.stopPropagation();
          await ctx.api.patch(`/api/strategies/${strategy.id}`, { pinned: !strategy.pinned });
          const res = await ctx.api.get('/api/strategies?stats=1');
          if (res.ok) {
            state.list = res.data.strategies || [];
            state.libraryStats = state.list;
          }
          renderStrategies(ctx);
          notifyStudioCatalogChanged();
        },
      }, '★'),
      el('strong', { class: 'strategy-card__title', onclick: () => ctx.navigate(`strategies/${strategy.id}`) }, strategy.name),
      el('span', { class: `badge badge--${strategyStatusTone(strategy.status)}` },
        `${translateStatus(strategy.status)}${versionNum != null ? ` · v${versionNum}` : ''}`),
    ]),
    hasChart
      ? el('div', { class: 'strategy-card__chart' }, [
        el('div', {
          class: 'strategy-card__spark',
          id: `spark-${strategy.id}`,
          'aria-hidden': 'true',
          title: formatCardChartCaption(cardChart),
        }),
        el('p', { class: 'strategy-card__chart-caption muted' }, formatCardChartCaption(cardChart)),
      ])
      : el('p', { class: 'muted strategy-card__empty' }, stats.runs ? 'Sem curva de patrimônio' : 'Sem runs ainda'),
    el('div', { class: 'strategy-card__stats' }, [
      el('span', {}, `${stats.runs ?? 0} runs`),
      el('span', {}, stats.runs ? `${Math.round((stats.win_rate ?? 0) * 100)}% WR` : '—'),
      el('span', {}, stats.best_pnl != null ? `best ${formatPnl(stats.best_pnl)}` : ''),
    ]),
    el('div', { class: 'strategy-card__actions' }, [
      el('button', {
        type: 'button',
        class: 'btn btn--primary btn--sm',
        onclick: () => ctx.navigate(`studio?strategy=${strategy.id}&version=${strategy.default_version_id || strategy.latest_version_id || ''}`),
      }, '▶ Rodar'),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        onclick: () => ctx.navigate(`strategies/${strategy.id}`),
      }, 'Editar'),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        onclick: async () => {
          const res = await ctx.api.post(`/api/strategies/${strategy.id}/fork`, {});
          if (res.ok) { ctx.toast.ok('Fork criado'); ctx.navigate(`strategies/${res.data.strategy.id}`); }
          else ctx.toast.err(res.error?.message || 'Falha');
        },
      }, 'Fork'),
    ]),
  ]);
}

// Render gráficos dos cards após layout (equity do último run ou evolução entre runs comparáveis)
export function _renderLibrarySparklines() {
  for (const strategy of state.libraryStats || []) {
    const chart = cardChartForStrategy(strategy);
    const container = document.getElementById(`spark-${strategy.id}`);
    if (container && chart?.values?.length) {
      destroyChartsIn(container);
      void renderUplotSparkline(container, chart.values, { stroke: cardChartStroke(chart) });
    }
  }
}

function renderStrategyList(ctx) {
  const filtered = state.list.filter((s) => {
    const q = state.strategyQuery.toLowerCase();
    const matchesQuery = s.name.toLowerCase().includes(q) || s.slug.toLowerCase().includes(q);
    const matchesStatus = state.statusFilter === 'all' || s.status === state.statusFilter;
    return matchesQuery && matchesStatus;
  });
  const counts = countByStatus(state.list);

  const listItems = filtered.map((strategy) => el('li', { dataset: { status: strategy.status } }, [
    el('button', {
      type: 'button',
      class: state.selectedId === strategy.id ? 'is-active' : '',
      onclick: async () => {
        state.selectedId = strategy.id;
        state.selectedVersionId = null;
        ctx.navigate(`strategies/${strategy.id}`);
        await renderStrategies(ctx, { id: strategy.id });
      },
    }, [
      el('div', { style: { fontWeight: '700' } }, strategy.name),
      el('div', { class: 'muted mono', style: { fontSize: '11px', marginTop: '2px' } }, `${strategy.slug} · v${strategy.latest_version ?? '-'} · ${strategy.status}`),
    ]),
  ]));

  return [
    el('div', { class: 'strategy-status-tabs' }, [
      statusTab(ctx, 'all', `Todas ${state.list.length}`),
      statusTab(ctx, 'draft', `Draft ${counts.draft || 0}`),
      statusTab(ctx, 'validated', `Validated ${counts.validated || 0}`),
      statusTab(ctx, 'archived', `Archived ${counts.archived || 0}`),
    ]),
    el('div', { class: 'strategy-search-wrap', style: { position: 'relative' } }, [
      el('i', { class: 'fa-solid fa-magnifying-glass search-icon', style: { position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)', pointerEvents: 'none' } }),
      el('input', {
        class: 'strategy-search-input',
        style: { paddingLeft: '32px' },
        type: 'text',
        placeholder: 'Buscar estratégia...',
        value: state.strategyQuery,
        oninput: (e) => {
          state.strategyQuery = e.target.value;
          const panel = document.getElementById('strategy-list-panel');
          if (panel) {
            // Re-render list reactive content
            const nextList = renderStrategyList(ctx);
            mount(panel, nextList);
            const input = panel.querySelector('.strategy-search-input');
            if (input) {
              input.focus();
              input.selectionStart = input.selectionEnd = input.value.length;
            }
          }
        }
      })
    ]),
    el('ul', { class: 'strategy-list' }, listItems.length ? listItems : emptyState('Nenhuma estratégia encontrada.'))
  ];
}

function countByStatus(strategies) {
  return strategies.reduce((acc, strategy) => {
    acc[strategy.status] = (acc[strategy.status] || 0) + 1;
    return acc;
  }, {});
}

function statusTab(ctx, status, label) {
  return el('button', {
    class: `strategy-status-tab ${state.statusFilter === status ? 'is-active' : ''}`,
    type: 'button',
    onclick: () => {
      state.statusFilter = status;
      const panel = document.getElementById('strategy-list-panel');
      if (panel) mount(panel, renderStrategyList(ctx));
    },
  }, label);
}

function strategyStatusTone(status) {
  if (status === 'validated') return 'ok';
  if (status === 'archived') return 'idle';
  if (status === 'failed') return 'err';
  return 'warn';
}

function translateStatus(status) {
  if (status === 'draft') return 'Em Teste';
  if (status === 'validated') return 'Aprovada';
  if (status === 'failed') return 'Falhou';
  if (status === 'archived') return 'Arquivada';
  return status;
}

function renderStrategyHeaderMeta(strategy) {
  return el('div', { class: 'strategy-header-meta', id: 'strategy-title-meta' }, [
    el('span', {
      class: `badge badge--${strategyStatusTone(strategy.status)}`,
      id: 'strategy-status-badge',
    }, strategy.status),
    el('span', { class: 'mono muted strategy-header-meta__slug', id: 'strategy-title-slug' }, strategy.slug),
  ]);
}

function pickDefaultStrategyVersion(strategy, versions = []) {
  if (!versions.length) return null;
  if (strategy?.default_version_id != null) {
    const preferred = versions.find((item) => item.id === strategy.default_version_id);
    if (preferred) return preferred;
  }
  return versions[0];
}

async function openStrategyEditor(ctx, strategyId, versionId = null, options = {}) {
  const scrollSnap = options.preserveScroll ? captureScrollState(ctx) : null;
  const editorPanel = document.getElementById('strategy-editor');
  if (!editorPanel) return;

  // Clean up any old editor before loading next one
  if (state.focusedEditor) {
    try {
      state.focusedEditor.toTextArea();
    } catch { /* ignore */ }
    state.focusedEditor = null;
  }

  if (!options.preserveScroll) {
    mount(editorPanel, el('p', { class: 'muted' }, 'Carregando detalhes do editor...'));
  }

  const [strategyRes, versionsRes, blocksRes, capsRes, statsRes, runsRes] = await Promise.all([
    ctx.api.get(`/api/strategies/${strategyId}`),
    ctx.api.get(`/api/strategies/${strategyId}/versions`),
    ctx.api.get('/api/strategy-blocks'),
    ctx.api.get('/api/strategy-runtime/capabilities'),
    ctx.api.get(`/api/strategies/${strategyId}/stats`),
    ctx.api.get(`/api/backtest/runs?strategy_id=${strategyId}&limit=50`),
  ]);
  const strategyStats = statsRes.ok ? statsRes.data.stats : null;
  const strategyRuns = runsRes.ok ? runsRes.data.runs || [] : [];
  if (!strategyRes.ok) {
    mount(editorPanel, el('p', { class: 'bad' }, strategyRes.error?.message || 'Falha ao abrir estratégia'));
    return;
  }

  const strategy = strategyRes.data.strategy;
  state.currentStrategy = strategy;
  ctx.setBreadcrumb('strategies', strategy.name);
  const versions = versionsRes.ok ? versionsRes.data.versions || [] : [];
  const version = versionId
    ? versions.find((item) => item.id === versionId) || pickDefaultStrategyVersion(strategy, versions)
    : pickDefaultStrategyVersion(strategy, versions);
  state.selectedVersionId = version?.id ?? null;
  state.currentVersion = version ?? null;
  state.selectedPresetId = null;
  state.presetCompareId = null;
  await loadStrategyPresets(ctx, strategyId, state.selectedVersionId);

  state.capabilities = capsRes.ok ? capsRes.data : null;
  state.editorLanguage = version?.language || state.capabilities?.default_language || 'strategy-js-v1';
  state.sourceCode = version?.source_code || buildDefaultTemplate(strategy.name, state.editorLanguage);
  state.validation = version?.validation || null;
  state.blocks = blocksRes.data?.blocks || state.capabilities?.blocks || [];
  
  const schema = state.validation?.params_schema || version?.params_schema || {};
  const hasParams = Object.keys(schema).length > 0;

  resetHistoryFilters(strategyId);

  let leftVersionId = versions[1]?.id || versions[0]?.id;
  let rightVersionId = version?.id || versions[0]?.id;

  const leftSelect = el('select', {
    class: 'field__input',
    style: { width: '120px' },
    onchange: (e) => {
      leftVersionId = Number(e.target.value);
      updateVisualDiff();
    }
  }, versions.map((v) => el('option', { value: v.id, selected: v.id === leftVersionId }, `v${v.version}`)));

  const rightSelect = el('select', {
    class: 'field__input',
    style: { width: '120px' },
    onchange: (e) => {
      rightVersionId = Number(e.target.value);
      updateVisualDiff();
    }
  }, versions.map((v) => el('option', { value: v.id, selected: v.id === rightVersionId }, `v${v.version}`)));

  const diffArea = el('div', { id: 'visual-diff-area' });

  function updateVisualDiff() {
    const left = versions.find((v) => v.id === leftVersionId);
    const right = versions.find((v) => v.id === rightVersionId);
    if (!left || !right) {
      mount(diffArea, el('p', { class: 'muted' }, 'Selecione versões válidas para comparar.'));
      return;
    }
    mount(diffArea, renderVisualDiff(left.source_code, right.source_code));
  }

  mount(editorPanel, [
    el('div', { class: 'strategy-header-row' }, [
      el('div', { class: 'editor-title-block', style: { display: 'flex', alignItems: 'center', gap: '12px' } }, [
        el('button', {
          class: 'btn btn--ghost btn--sm btn--back-library',
          style: { padding: '6px 10px' },
          title: 'Voltar para o Kanban',
          onclick: () => ctx.navigate('strategies')
        }, el('i', { class: 'fa-solid fa-arrow-left' })),
        el('div', {}, [
          el('h2', { class: 'card__title', id: 'strategy-title', style: { margin: 0 } }, strategy.name),
          renderStrategyHeaderMeta(strategy),
        ]),
      ]),
      el('div', { class: 'strategy-header-toolbar' }, [
        el('button', {
          class: 'btn btn--danger btn--sm btn--ghost',
          type: 'button',
          onclick: () => trashStrategyFlow(ctx, strategy),
        }, [
          el('i', { class: 'fa-solid fa-trash-can' }),
          'Mover para lixeira',
        ]),
      ]),
    ]),

    el('div', { class: 'premium-tabs-nav' }, [
      el('button', { class: 'premium-tab-link is-active', id: 'tab-link-stats', type: 'button', onclick: () => switchTab('stats') }, [
        el('i', { class: 'fa-solid fa-clock-rotate-left', style: { marginRight: '8px' } }),
        'Histórico'
      ]),
      el('button', { class: 'premium-tab-link', id: 'tab-link-code', type: 'button', onclick: () => switchTab('code') }, [
        el('i', { class: 'fa-solid fa-code', style: { marginRight: '8px' } }),
        'Editor'
      ]),
      el('button', { class: 'premium-tab-link', id: 'tab-link-params', type: 'button', onclick: () => switchTab('params') }, [
        el('i', { class: 'fa-solid fa-sliders', style: { marginRight: '8px' } }),
        'Parâmetros'
      ]),
      el('button', { class: 'premium-tab-link', id: 'tab-link-diff', type: 'button', onclick: () => switchTab('diff') }, [
        el('i', { class: 'fa-solid fa-code-compare', style: { marginRight: '8px' } }),
        'Comparador (Diff)'
      ]),
      el('button', { class: 'premium-tab-link', id: 'tab-link-config', type: 'button', onclick: () => switchTab('config') }, [
        el('i', { class: 'fa-solid fa-gears', style: { marginRight: '8px' } }),
        'Configurações'
      ]),
    ]),

    // 1. Tab Histórico (versões + simulações)
    el('div', { class: 'premium-tab-content is-active', id: 'tab-content-stats' },
      renderStrategyHistoryTab(ctx, {
        strategy,
        strategyId,
        versions,
        strategyRuns,
        strategyStats,
        switchTab,
      }),
    ),

    // 2. Tab Editor Strategy JS
    el('div', { class: 'premium-tab-content', id: 'tab-content-code' }, [
      el('div', { class: 'strategy-code-tab-layout strategy-code-tab-layout--single' }, [
        el('div', { class: 'strategy-code-editor-area' }, [
          el('div', { class: 'row row--between', style: { flexWrap: 'wrap', gap: '8px' } }, [
            el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '10px', alignItems: 'center' } }, [
              el('span', { class: 'badge', style: { fontSize: '11px' } }, 'Strategy JS'),
              versions.length ? el('select', {
                id: 'strategy-editor-version-select',
                class: 'field__input field__input--sm strategy-editor-version-select',
                onchange: async (e) => {
                  const vid = Number(e.target.value);
                  if (!vid || vid === state.selectedVersionId) return;
                  await openStrategyEditor(ctx, strategy.id, vid, { preserveScroll: true, activeTab: 'code' });
                },
              }, versions.map((v) => el('option', {
                value: v.id,
                selected: v.id === version?.id,
              }, versionOptionLabel(v, strategy)))) : el('span', { class: 'muted' }, 'Sem versões'),
            ]),
            el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } }, [
              el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => toggleGlsDrawer(true) }, [
                'Ajuda ',
                el('i', { class: 'fa-solid fa-circle-question', style: { marginLeft: '4px' } })
              ]),
              el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => validateTabCode(ctx) }, [
                el('i', { class: 'fa-solid fa-circle-check', style: { marginRight: '4px' } }),
                'Validar Código'
              ]),
              el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => testStrategyQuick(ctx, strategy.id) }, [
                el('i', { class: 'fa-solid fa-bolt', style: { marginRight: '4px' } }),
                'Testar'
              ]),
              el('button', {
                class: 'btn btn--primary btn--sm',
                type: 'button',
                onclick: () => saveTabCodeVersion(ctx, strategy.id),
              }, [
                el('i', { class: 'fa-solid fa-floppy-disk', style: { marginRight: '6px' } }),
                'Salvar Versão'
              ]),
            ]),
          ]),
          el('textarea', { id: `gls-editor-textarea-${strategyId}` }, state.sourceCode),
          el('div', { class: 'validation-console-card' }, [
            el('div', { class: 'validation-console-card__header' }, [
              el('span', {}, 'Console de Validação'),
              renderValidationBadge(state.validation),
            ]),
            el('div', { id: 'strategy-validation' }, renderValidationDetails(state.validation)),
          ]),
          el('div', { class: 'validation-console-card', id: 'strategy-runtime-panel' }, renderRuntimePanel(version, state.validation)),
        ]),
      ]),
    ]),

    // 3. Tab Parâmetros
    el('div', { class: 'premium-tab-content', id: 'tab-content-params' }, [
      el('div', { class: 'row row--between', style: { marginBottom: '14px', flexWrap: 'wrap', gap: '10px' } }, [
        el('div', {}, [
          el('h3', { class: 'card__title' }, 'Parâmetros e Presets'),
          el('p', { class: 'muted', style: { fontSize: '12px' } }, 'Teste presets sem versionar; depois salve no código ou promova o preset a uma nova versão.'),
        ]),
        el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, [
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', disabled: !hasParams, onclick: () => saveParamsAsPreset(ctx, strategy.id) }, 'Salvar preset'),
          el('button', { class: 'btn btn--primary btn--sm', type: 'button', disabled: !hasParams, onclick: () => saveParamsVersion(ctx, strategy.id) }, 'Salvar no código (nova versão)'),
        ]),
      ]),
      el('div', { id: 'strategy-presets-panel', style: { marginBottom: '16px' } }, renderPresetsPanel(ctx, strategy.id, version)),
      el('div', { class: 'strategy-workbench', id: 'strategy-workbench-root' }, [
        hasParams ? renderParamsForm(schema) : emptyState('Esta versão de estratégia não declara parâmetros editáveis no cabeçalho param.'),
      ]),
    ]),

    // 4. Tab Comparador (Diff)
    el('div', { class: 'premium-tab-content', id: 'tab-content-diff' }, [
      el('div', { class: 'row row--between', style: { marginBottom: '16px', flexWrap: 'wrap', gap: '12px' } }, [
        el('div', {}, [
          el('h3', { class: 'card__title' }, 'Comparador de Versões'),
          el('p', { class: 'muted', style: { fontSize: '12px' } }, 'Compare a diferença de código Strategy JS entre duas versões da estratégia.'),
        ]),
        el('div', { class: 'row' }, [
          el('label', { class: 'row', style: { gap: '6px', fontSize: '13px', alignItems: 'center' } }, [
            'De: ',
            leftSelect
          ]),
          el('label', { class: 'row', style: { gap: '6px', fontSize: '13px', alignItems: 'center' } }, [
            'Para: ',
            rightSelect
          ])
        ])
      ]),
      diffArea
    ]),

    // 5. Tab Configurações
    el('div', { class: 'premium-tab-content', id: 'tab-content-config' }, [
      el('div', { style: { maxWidth: '720px' } }, [
        el('h3', { class: 'card__title', style: { marginBottom: '14px' } }, 'Metadados da Estratégia'),
        renderStrategyMetaForm(ctx, strategy),
      ]),
    ]),
  ]);

  updateVisualDiff();

  // Initialize CodeMirror editor
  const editorId = `gls-editor-textarea-${strategyId}`;
  const textarea = document.getElementById(editorId);
  if (textarea) {
    const editor = window.CodeMirror.fromTextArea(textarea, {
      mode: 'javascript',
      theme: 'material-darker',
      lineNumbers: true,
      lineWrapping: true,
      autofocus: true,
      extraKeys: {
        'Ctrl-Space': (cm) => showGlsHint(cm),
        'Ctrl-S': async (cm) => {
          state.sourceCode = cm.getValue();
          await saveTabCodeVersion(ctx, strategy.id);
        },
        Tab: (cm) => cm.execCommand('indentMore'),
      },
    });
    state.focusedEditor = editor;
    editor.on('inputRead', (cm, change) => {
      if (!change.text?.[0] || /\s/.test(change.text[0])) return;
      if (/[A-Za-z_.]/.test(change.text[0])) showGlsHint(cm, true);
    });
    editor.on('change', (cm) => {
      state.sourceCode = cm.getValue();
    });
    window.setTimeout(() => editor.refresh(), 50);
  }

  if (options.preserveScroll) {
    const snap = scrollSnap || captureScrollState(ctx);
    if (options.activeTab) snap.activeTab = options.activeTab;
    restoreScrollState(ctx, snap);
  } else if (options.activeTab) {
    switchTab(options.activeTab);
  }
}

function switchTab(tabId) {
  document.querySelectorAll('.premium-tab-link').forEach((link) => {
    link.classList.toggle('is-active', link.id === `tab-link-${tabId}`);
  });
  document.querySelectorAll('.premium-tab-content').forEach((content) => {
    content.classList.toggle('is-active', content.id === `tab-content-${tabId}`);
  });
  if (tabId === 'code' && state.focusedEditor) {
    window.setTimeout(() => state.focusedEditor.refresh(), 50);
  }
}

function shortcut(keys, label) {
  return el('div', { class: 'shortcut-row' }, [el('kbd', {}, keys), el('span', {}, label)]);
}

function renderVersionDiffPanel(versions, currentVersion) {
  if (versions.length < 2) {
    return el('p', { class: 'muted' }, 'Salve pelo menos duas versões para comparar.');
  }
  let leftId = versions[1]?.id;
  let rightId = currentVersion?.id || versions[0]?.id;
  const panel = el('div', { class: 'version-diff-panel' });
  const pre = el('pre', { class: 'code-block version-diff-output' });

  function refreshDiff() {
    const left = versions.find((v) => v.id === Number(leftId));
    const right = versions.find((v) => v.id === Number(rightId));
    pre.textContent = textDiff(left?.source_code || '', right?.source_code || '');
  }

  panel.append(
    el('div', { class: 'row row--wrap' }, [
      el('label', {}, ['De ', el('select', {
        class: 'field__input',
        onchange: (e) => { leftId = Number(e.target.value); refreshDiff(); },
      }, versions.map((v) => el('option', { value: v.id, selected: v.id === leftId }, `v${v.version}`)))]),
      el('label', {}, ['Para ', el('select', {
        class: 'field__input',
        onchange: (e) => { rightId = Number(e.target.value); refreshDiff(); },
      }, versions.map((v) => el('option', { value: v.id, selected: v.id === rightId }, `v${v.version}`)))]),
    ]),
    pre,
  );
  refreshDiff();
  return panel;
}

function textDiff(a, b) {
  const left = String(a).split('\n');
  const right = String(b).split('\n');
  const max = Math.max(left.length, right.length);
  const lines = [];
  for (let i = 0; i < max; i++) {
    const l = left[i];
    const r = right[i];
    if (l === r) lines.push(`  ${l ?? ''}`);
    else {
      if (l !== undefined) lines.push(`- ${l}`);
      if (r !== undefined) lines.push(`+ ${r}`);
    }
  }
  return lines.join('\n');
}

function renderParamsForm(schema) {
  return el('form', { class: 'strategy-params-form', id: 'strategy-params-form' }, Object.entries(schema).map(([key, def]) => {
    const value = def?.default;
    const type = typeof value;
    const inputAttrs = {
      class: 'field__input param-input',
      name: key,
      value: String(value ?? ''),
      dataset: { paramType: type },
    };
    return el('label', { class: 'param-card' }, [
      el('span', { class: 'param-card__name', title: key }, key),
      el('span', { class: 'param-card__type' }, type),
      type === 'boolean'
        ? el('select', { ...inputAttrs, value: undefined }, [
          el('option', { value: 'true', selected: value === true }, 'true'),
          el('option', { value: 'false', selected: value === false }, 'false'),
        ])
        : el('input', { ...inputAttrs, type: type === 'number' ? 'number' : 'text', step: type === 'number' ? 'any' : undefined }),
    ]);
  }));
}

async function validateStrategySource(ctx, source = state.sourceCode) {
  const res = await ctx.api.post('/api/strategies/validate', {
    source_code: source,
    language: 'strategy-js-v1',
  });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao validar');
    return null;
  }
  state.validation = res.data.validation;
  renderValidation(state.validation);
  const runtimePanel = document.getElementById('strategy-runtime-panel');
  if (runtimePanel) mount(runtimePanel, renderRuntimePanel(state.currentVersion, state.validation));
  return state.validation;
}

function renderValidation(validation) {
  state.validation = validation;
  const panel = document.getElementById('strategy-validation');
  if (panel) mount(panel, renderValidationDetails(validation));

  const badgeWrap = document.querySelector('.validation-console-card__header .badge');
  if (badgeWrap) {
    mount(badgeWrap.parentElement, [
      el('span', {}, 'Console de Validação'),
      renderValidationBadge(validation),
    ]);
  }
}

function renderValidationBadge(validation) {
  if (!validation) return el('span', { class: 'badge badge--idle' }, 'Não validado');
  return el('span', { class: `badge ${validation.ok ? 'badge--ok' : 'badge--err'}` }, validation.ok ? 'Válido' : 'Inválido');
}

function formatStrategyLanguage(lang) {
  if (lang === 'strategy-js-v1') return 'Strategy JS';
  return lang || 'Strategy JS';
}

function renderRuntimePanel(version, validation) {
  const lang = formatStrategyLanguage(validation?.language || version?.language || state.editorLanguage || 'strategy-js-v1');
  const cols = validation?.column_analysis?.scalarColumns || version?.compiled?.column_analysis?.scalarColumns || [];
  const parallel = validation?.parallelism || version?.compiled?.parallelism;
  const compile = validation?.compile || version?.compiled?.compile;
  const executionKind = validation?.execution_kind || version?.validation?.execution_kind;
  const dependencies = validation?.dependencies || version?.compiled?.dependencies || [];
  const cacheReady = Boolean(version?.compiled?.ir_json && version?.compiled?.generated_source);
  return el('div', {}, [
    el('div', { class: 'validation-console-card__header' }, el('span', {}, 'Runtime')),

    el('dl', { class: 'runtime-meta-list', style: { margin: 0, fontSize: '12px', display: 'grid', gridTemplateColumns: '140px 1fr', gap: '4px 12px' } }, [
      el('dt', { class: 'muted' }, 'Linguagem'),
      el('dd', {}, lang),
      executionKind ? [el('dt', { class: 'muted' }, 'Execução'), el('dd', {}, executionKind)] : null,
      el('dt', { class: 'muted' }, 'Checksum'),
      el('dd', { class: 'mono' }, version?.checksum?.slice(0, 12) || '—'),
      el('dt', { class: 'muted' }, 'Modo'),
      el('dd', {}, compile?.mode || 'compiled-soa'),
      el('dt', { class: 'muted' }, 'Cache'),
      el('dd', {}, cacheReady ? 'artefato persistido' : 'recompilar no save'),
      compile?.compileMs != null ? [el('dt', { class: 'muted' }, 'compileMs'), el('dd', {}, String(compile.compileMs))] : null,
      el('dt', { class: 'muted' }, 'Paralelo'),
      el('dd', {}, parallel ? (parallel.parallelSafe ? 'sim' : `não (${parallel.usesRunState ? 'runState' : 'dependência'})`) : '—'),
      el('dt', { class: 'muted' }, 'Colunas'),
      el('dd', { class: 'mono' }, cols.length ? cols.slice(0, 8).join(', ') + (cols.length > 8 ? '…' : '') : '—'),
      dependencies.length ? [el('dt', { class: 'muted' }, 'Dependências'), el('dd', { class: 'mono' }, dependencies.map((dep) => `${dep.alias || dep.slug}@${dep.slug}:${dep.version}`).join(', '))] : null,
    ]),
  ]);
}

async function convertGlsToStrategyJs(ctx) {
  if (state.focusedEditor) state.sourceCode = state.focusedEditor.getValue();
  const res = await ctx.api.post('/api/strategies/convert-to-strategy-js', { source_code: state.sourceCode });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha na conversão');
    return;
  }
  state.editorLanguage = 'strategy-js-v1';
  state.sourceCode = res.data.source_code;
  if (state.focusedEditor) state.focusedEditor.setValue(state.sourceCode);
  const langSelect = document.getElementById('strategy-language-select');
  if (langSelect) langSelect.value = 'strategy-js-v1';
  ctx.toast.ok('Convertido para Strategy JS — valide e salve uma nova versão');
}

function renderValidationDetails(validation) {
  if (!validation) return el('p', { class: 'muted', style: { margin: 0 } }, 'Pronto para validar.');
  const errors = validation.errors || [];
  const warnings = validation.warnings || [];
  if (!errors.length && !warnings.length) {
    return el('p', { style: { color: 'var(--ok)', fontWeight: '600', margin: 0 } }, '✓ Estratégia válida. Nenhum erro ou aviso encontrado.');
  }
  return el('div', { class: 'validation-panel' }, [
    errors.length ? el('ul', { class: 'validation-list', style: { margin: 0 } }, errors.map((item) => el('li', { class: 'is-error' }, `L${item.line}:${item.column} · ${item.message}`))) : null,
    warnings.length ? el('ul', { class: 'validation-list', style: { margin: 0 } }, warnings.map((item) => el('li', { class: 'is-warn' }, item.message))) : null,
  ]);
}

function renderStrategyMetaForm(ctx, strategy) {
  return el('form', {
    class: 'strategy-meta-form',
    id: 'strategy-meta-form',
    onsubmit: (event) => updateStrategyMeta(event, ctx, strategy.id),
  }, [
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label' }, 'Nome'),
      el('input', { class: 'field__input', name: 'name', value: strategy.name }),
    ]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label' }, 'Descrição'),
      el('textarea', { class: 'field__input', name: 'description', rows: '3' }, strategy.description || ''),
    ]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label' }, 'Status'),
      el('select', { class: 'field__input', name: 'status' }, ['draft', 'validated', 'failed', 'archived'].map((status) => (
        el('option', { value: status, selected: status === strategy.status }, translateStatus(status))
      ))),
    ]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label' }, 'Tags'),
      el('input', { class: 'field__input', name: 'tags', value: (strategy.tags || []).join(', '), placeholder: 'btc, 5m' }),
    ]),
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit', style: { alignSelf: 'flex-start', marginTop: '10px' } }, 'Salvar dados'),
  ]);
}

async function updateStrategyMeta(event, ctx, strategyId) {
  event.preventDefault();
  const form = event.currentTarget;
  const fd = new FormData(form);
  const payload = {
    name: String(fd.get('name') || '').trim(),
    description: String(fd.get('description') || '').trim() || null,
    status: String(fd.get('status') || 'draft'),
    tags: String(fd.get('tags') || '').split(',').map((tag) => tag.trim()).filter(Boolean),
  };
  if (!payload.name) {
    ctx.toast.warn('Informe um nome para a estratégia.');
    return;
  }
  const res = await ctx.api.patch(`/api/strategies/${strategyId}`, payload);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao salvar dados');
    return;
  }
  const updated = res.data.strategy;
  state.list = state.list.map((item) => (item.id === updated.id ? updated : item));
  ctx.setBreadcrumb('strategies', updated.name);
  
  const title = document.getElementById('strategy-title');
  if (title) title.textContent = updated.name;
  
  const statusBadge = document.getElementById('strategy-status-badge');
  if (statusBadge) {
    statusBadge.className = `badge badge--${strategyStatusTone(updated.status)}`;
    statusBadge.textContent = updated.status;
  }
  const slugEl = document.getElementById('strategy-title-slug');
  if (slugEl) slugEl.textContent = updated.slug;
  
  const listPanel = document.getElementById('strategy-list-panel');
  if (listPanel) mount(listPanel, renderStrategyList(ctx));
  notifyStudioCatalogChanged();
  ctx.toast.ok('Dados da estratégia atualizados');
}

async function saveTabCodeVersion(ctx, strategyId) {
  if (state.focusedEditor) state.sourceCode = state.focusedEditor.getValue();
  return saveSourceVersion(ctx, strategyId, state.sourceCode);
}

async function validateTabCode(ctx) {
  if (state.focusedEditor) state.sourceCode = state.focusedEditor.getValue();
  const validation = await validateStrategySource(ctx, state.sourceCode);
  if (!validation) return;
  if (validation.ok) ctx.toast.ok('Código Strategy JS válido');
  else ctx.toast.err(`Código inválido: ${validation.errors?.length || 0} erro(s)`);
}

async function loadStrategyPresets(ctx, strategyId, versionId) {
  if (!strategyId || !versionId) {
    state.presets = [];
    return [];
  }
  const res = await ctx.api.get(`/api/strategies/${strategyId}/presets?strategy_version_id=${versionId}`);
  if (!res.ok) {
    state.presets = [];
    return [];
  }
  state.presets = res.data.presets || [];
  return state.presets;
}

function renderPresetsPanel(ctx, strategyId, version) {
  const presets = state.presets || [];
  if (!version) return emptyState('Selecione uma versão para gerenciar presets.');
  if (!presets.length) {
    return el('div', { class: 'card', style: { padding: '12px' } }, [
      el('p', { class: 'muted', style: { margin: 0 } }, 'Nenhum preset salvo para esta versão. Ajuste parâmetros abaixo e clique em "Salvar preset".'),
    ]);
  }
  const comparePreset = presets.find((p) => p.id === state.presetCompareId);
  const selectedPreset = presets.find((p) => p.id === state.selectedPresetId);
  return el('div', { class: 'card', style: { padding: '12px' } }, [
    el('h4', { class: 'card__title', style: { marginBottom: '10px' } }, 'Presets'),
    el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px', marginBottom: '10px' } }, presets.map((preset) => el('button', {
      class: `btn btn--sm ${state.selectedPresetId === preset.id ? 'btn--primary' : 'btn--ghost'}`,
      type: 'button',
      onclick: () => applyPresetToForm(preset),
    }, preset.name))),
    el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } }, [
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        disabled: !state.selectedPresetId,
        onclick: () => runBacktestWithPreset(ctx, strategyId),
      }, 'Rodar backtest com preset'),
      el('button', {
        class: 'btn btn--primary btn--sm',
        type: 'button',
        disabled: !state.selectedPresetId,
        onclick: () => promotePresetToVersion(ctx, strategyId),
      }, 'Tornar versão'),
      el('select', {
        class: 'field__input field__input--sm',
        onchange: (e) => { state.presetCompareId = Number(e.target.value) || null; refreshPresetsPanel(ctx, strategyId, version); },
      }, [
        el('option', { value: '' }, 'Comparar com…'),
        ...presets.map((p) => el('option', { value: p.id, selected: p.id === state.presetCompareId }, p.name)),
      ]),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        disabled: !state.selectedPresetId || !state.presetCompareId,
        onclick: () => compareSelectedPresets(),
      }, 'Comparar'),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        disabled: !state.selectedPresetId,
        onclick: () => deleteSelectedPreset(ctx, strategyId, version),
      }, 'Excluir preset'),
    ]),
    comparePreset && selectedPreset ? el('pre', {
      class: 'code-block',
      style: { marginTop: '10px', fontSize: '11px', maxHeight: '160px', overflow: 'auto' },
    }, formatPresetDiff(selectedPreset.params, comparePreset.params)) : null,
  ]);
}

function formatPresetDiff(left, right) {
  const keys = [...new Set([...Object.keys(left || {}), ...Object.keys(right || {})])].sort();
  return keys.map((key) => {
    const a = left?.[key];
    const b = right?.[key];
    if (a === b) return `  ${key}: ${JSON.stringify(a)}`;
    return `- ${key}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`;
  }).join('\n');
}

function applyPresetToForm(preset) {
  state.selectedPresetId = preset.id;
  const form = document.getElementById('strategy-params-form');
  if (form) {
    for (const [key, value] of Object.entries(preset.params || {})) {
      const input = form.elements[key];
      if (!input) continue;
      input.value = String(value);
    }
  }
  if (state.currentStrategy) {
    refreshPresetsPanel(strategiesViewCtx, state.currentStrategy.id, state.currentVersion);
  }
}

function defaultsFromSchema(schema = {}) {
  const defaults = {};
  for (const [key, def] of Object.entries(schema)) {
    if (def && Object.prototype.hasOwnProperty.call(def, 'default')) {
      defaults[key] = def.default;
    }
  }
  return defaults;
}

function readParamsFromForm() {
  const form = document.getElementById('strategy-params-form');
  if (!form) return null;
  const schema = state.validation?.params_schema || state.currentVersion?.params_schema || {};
  const params = {};
  for (const [key, def] of Object.entries(schema)) {
    const input = form.elements[key];
    if (!input) continue;
    params[key] = parseParamValue(input.value, typeof def?.default);
  }
  return params;
}

function compareSelectedPresets() {
  const panel = document.getElementById('strategy-presets-panel');
  if (panel && state.currentStrategy) {
    mount(panel, renderPresetsPanel(strategiesViewCtx, state.currentStrategy.id, state.currentVersion));
  }
}

function refreshPresetsPanel(ctx, strategyId, version) {
  const panel = document.getElementById('strategy-presets-panel');
  if (panel) mount(panel, renderPresetsPanel(ctx, strategyId, version));
}

async function saveParamsAsPreset(ctx, strategyId) {
  if (!state.selectedVersionId) return;
  let params;
  try {
    params = readParamsFromForm();
  } catch (err) {
    ctx.toast.err(err.message || 'Parâmetro inválido');
    return;
  }
  if (!params || !Object.keys(params).length) {
    ctx.toast.warn('Nenhum parâmetro para salvar');
    return;
  }
  const name = await promptDialog({
    title: 'Nome do preset',
    message: 'Nome para este conjunto de parâmetros:',
    placeholder: 'Ex.: agressivo BTC 5m',
    confirmLabel: 'Salvar',
  });
  if (!name) return;
  const res = await ctx.api.post(`/api/strategies/${strategyId}/presets`, {
    strategy_version_id: state.selectedVersionId,
    name,
    params,
  });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao salvar preset');
    return;
  }
  await loadStrategyPresets(ctx, strategyId, state.selectedVersionId);
  state.selectedPresetId = res.data.preset.id;
  refreshPresetsPanel(ctx, strategyId, state.currentVersion);
  ctx.toast.ok(`Preset "${name}" salvo`);
}

async function deleteSelectedPreset(ctx, strategyId, version) {
  if (!state.selectedPresetId) return;
  const ok = await confirmDialog({ title: 'Excluir preset', message: 'Remover este preset?', confirmLabel: 'Excluir' });
  if (!ok) return;
  const res = await ctx.api.delete(`/api/strategies/${strategyId}/presets/${state.selectedPresetId}`);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao excluir preset');
    return;
  }
  state.selectedPresetId = null;
  await loadStrategyPresets(ctx, strategyId, state.selectedVersionId);
  refreshPresetsPanel(ctx, strategyId, version);
  ctx.toast.ok('Preset excluído');
}

async function runBacktestWithPreset(ctx, strategyId) {
  if (!state.selectedPresetId || !state.selectedVersionId) return;
  const saved = loadContext();
  const res = await ctx.api.post('/api/backtest/run', {
    strategy_id: strategyId,
    strategy_version_id: state.selectedVersionId,
    preset_id: state.selectedPresetId,
    from: saved.from,
    to: saved.to,
    underlying: saved.underlying,
    interval: saved.interval,
    book_depth: Number(saved.book_depth),
    batch_size: 25000,
    fast_run: true,
    async: true,
  });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao iniciar backtest');
    return;
  }
  ctx.toast.ok(`Backtest com preset enfileirado · run #${res.data.run.id}`);
  ctx.navigate(`studio?run=${res.data.run.id}`);
}

async function testStrategyQuick(ctx, strategyId) {
  if (state.focusedEditor) state.sourceCode = state.focusedEditor.getValue();
  const validation = await validateStrategySource(ctx, state.sourceCode);
  if (!validation?.ok) {
    ctx.toast.warn('Valide e corrija o código Strategy JS antes de testar');
    return;
  }
  if (!state.selectedVersionId) {
    ctx.toast.warn('Salve uma versão antes de testar');
    return;
  }
  if (hasSourceChanged(state.sourceCode, state.currentVersion?.source_code)) {
    ctx.toast.warn('Salve as alterações antes de testar a versão atual');
    return;
  }
  const saved = loadContext();
  const res = await ctx.api.post('/api/backtest/run', {
    strategy_id: strategyId,
    strategy_version_id: state.selectedVersionId,
    from: saved.from,
    to: saved.to,
    underlying: saved.underlying,
    interval: saved.interval,
    book_depth: Number(saved.book_depth),
    batch_size: 25000,
    fast_run: true,
    async: true,
  });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao iniciar teste');
    return;
  }
  ctx.toast.ok(`Teste enfileirado · run #${res.data.run.id}`);
  ctx.navigate(`studio?run=${res.data.run.id}`);
}

async function saveSourceVersion(ctx, strategyId, source) {
  const saveLanguage = state.editorLanguage || state.currentVersion?.language || 'strategy-js-v1';
  if (!hasSourceChanged(source, state.currentVersion?.source_code)) {
    ctx.toast.warn('Nenhuma alteração detectada. Versão não criada.');
    return null;
  }
  const validation = await validateStrategySource(ctx, source);
  if (!validation?.ok) {
    ctx.toast.warn('Corrija os erros de validação antes de salvar.');
    return null;
  }
  const notes = await promptDialog({
    title: 'Notas da versão',
    message: 'O que mudou nesta versão? (opcional)',
    placeholder: 'Ex.: ajuste minDistanceAbs, novo filtro de liquidez…',
    confirmLabel: 'Salvar',
  });
  if (notes === null) return null;
  const res = await ctx.api.post(`/api/strategies/${strategyId}/versions`, {
    source_code: source,
    language: state.editorLanguage || 'auto',
    notes: notes || undefined,
  });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao salvar versão');
    return null;
  }
  state.selectedVersionId = res.data.version.id;
  state.sourceCode = res.data.version.source_code;
  state.validation = res.data.version.validation;
  ctx.toast.ok(`Versão v${res.data.version.version} salva com sucesso`);
  
  // Re-render strategy view but preserve the active tab
  await renderStrategies(ctx, { id: strategyId, versionId: state.selectedVersionId });
  return res.data.version;
}

function hasSourceChanged(nextSource, currentSource) {
  return normalizeSource(nextSource) !== normalizeSource(currentSource || '');
}

function normalizeSource(source) {
  return String(source || '').replace(/\r\n/g, '\n').trim();
}

async function saveParamsVersion(ctx, strategyId) {
  let values;
  try {
    values = readParamsFromForm();
  } catch (err) {
    ctx.toast.err(err.message || 'Parâmetro inválido');
    return;
  }
  if (!values || !Object.keys(values).length) {
    ctx.toast.warn('Nenhum parâmetro para salvar');
    return;
  }
  const language = state.editorLanguage || state.currentVersion?.language || 'strategy-js-v1';
  const schema = state.validation?.params_schema || state.currentVersion?.params_schema || {};
  const merged = { ...defaultsFromSchema(schema), ...values };
  const { source, changed } = updateSourceParams(state.sourceCode, merged, { language });
  if (!changed) {
    ctx.toast.warn('Nenhum parâmetro foi alterado.');
    return;
  }
  await saveSourceVersion(ctx, strategyId, source);
  switchTab('params');
}

async function promotePresetToVersion(ctx, strategyId) {
  if (!state.selectedPresetId) return;
  const preset = (state.presets || []).find((p) => p.id === state.selectedPresetId);
  if (!preset) {
    ctx.toast.warn('Selecione um preset');
    return;
  }
  const language = state.editorLanguage || state.currentVersion?.language || 'strategy-js-v1';
  const schema = state.validation?.params_schema || state.currentVersion?.params_schema || {};
  const merged = { ...defaultsFromSchema(schema), ...(preset.params || {}) };
  const baseSource = state.currentVersion?.source_code || state.sourceCode;
  const { source, changed } = updateSourceParams(baseSource, merged, { language });
  if (!changed) {
    ctx.toast.warn('Os parâmetros do preset já estão no código desta versão.');
    return;
  }
  const notes = await promptDialog({
    title: 'Promover preset a versão',
    message: `Criar nova versão com os params do preset "${preset.name}"?`,
    placeholder: `Preset: ${preset.name}`,
    defaultValue: `Preset: ${preset.name}`,
    confirmLabel: 'Criar versão',
  });
  if (notes === null) return;

  const validation = await validateStrategySource(ctx, source);
  if (!validation?.ok) {
    ctx.toast.warn('Corrija os erros de validação antes de salvar.');
    return;
  }
  const res = await ctx.api.post(`/api/strategies/${strategyId}/versions`, {
    source_code: source,
    language: state.editorLanguage || 'auto',
    notes: notes || `Preset: ${preset.name}`,
  });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao criar versão a partir do preset');
    return;
  }
  state.selectedVersionId = res.data.version.id;
  state.sourceCode = res.data.version.source_code;
  state.validation = res.data.version.validation;
  ctx.toast.ok(`Versão v${res.data.version.version} criada a partir do preset "${preset.name}"`);
  await renderStrategies(ctx, { id: strategyId, versionId: state.selectedVersionId });
  switchTab('params');
}

function parseParamValue(value, type) {
  if (type === 'number') {
    const num = Number(value);
    if (!Number.isFinite(num)) throw new Error(`Valor numérico inválido: ${value}`);
    return num;
  }
  if (type === 'boolean') return String(value) === 'true';
  return String(value);
}

function showGlsHint(cm, automatic = false) {
  if (!window.CodeMirror?.showHint) return;
  cm.showHint({ hint: glsHint, completeSingle: false, closeOnUnfocus: !automatic });
}

function glsHint(cm) {
  const cursor = cm.getCursor();
  const token = cm.getTokenAt(cursor);
  const line = cm.getLine(cursor.line);
  const prefix = line.slice(0, cursor.ch).match(/[A-Za-z_][A-Za-z0-9_.]*$/)?.[0] || '';
  const from = window.CodeMirror.Pos(cursor.line, cursor.ch - prefix.length);
  const to = window.CodeMirror.Pos(cursor.line, cursor.ch);
  const words = buildHintWords();
  const filtered = words.filter((word) => word.text.startsWith(prefix) || word.displayText.startsWith(prefix));
  return { list: filtered.length ? filtered : words.slice(0, 30), from, to };
}

function buildHintWords() {
  const base = [
    'strategy', 'param', 'onEventStart(event)', 'onTick(tick, event)', 'onEventEnd(event)',
    'params', 'state', 'runState', 'position', 'tick', 'event', 'samples',
    'enter(side, { price: ask, budget: params.budget, reason: "entry" })',
    'exit({ price: bid, reason: "exit" })', 'reverse(side, { price: ask, budget: params.budget })',
    'closeOpenPosition({ reason: "event_end" })', 'mark("name")', 'log("name", value)', 'metric("name", value)',
  ].map((text) => ({ text, displayText: text }));
  const blocks = state.blocks.map((block) => ({ text: block.signature.replace('(...)', '('), displayText: block.signature }));
  return [...base, ...blocks];
}

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-');
}

async function createStrategyFlow(ctx) {
  const name = await promptDialog({ title: 'Nova estratégia', message: 'Nome da estratégia:', placeholder: 'Ex: Minha Estratégia' });
  if (!name?.trim()) return;
  const slug = slugify(name);
  if (!slug) {
    ctx.toast.err('Nome inválido para gerar slug');
    return;
  }
  const created = await ctx.api.post('/api/strategies', { slug, name: name.trim() });
  if (!created.ok) {
    ctx.toast.err(created.error?.message || 'Falha ao criar');
    return;
  }
  const actualSlug = created.data?.strategy?.slug;
  if (actualSlug && actualSlug !== slug) {
    ctx.toast.info(`Slug "${slug}" já existia — criada como "${actualSlug}"`);
  }
  const strategyId = created.data.strategy.id;
  const initial = await ctx.api.post(`/api/strategies/${strategyId}/versions`, {
    source_code: buildStrategyJsTemplate(name.trim()),
    language: 'strategy-js-v1',
    notes: 'Versão inicial Strategy JS',
  });
  if (!initial.ok) {
    ctx.toast.warn('Estratégia criada, mas falhou ao salvar template inicial');
  }
  state.selectedId = strategyId;
  state.selectedVersionId = initial.ok ? initial.data.version.id : null;
  ctx.navigate(`strategies/${strategyId}${state.selectedVersionId ? `/${state.selectedVersionId}` : ''}`);
  await renderStrategies(ctx, { id: strategyId, versionId: state.selectedVersionId });
}

async function trashStrategyFlow(ctx, strategy) {
  const ok = await confirmDialog({
    title: 'Mover para lixeira',
    message: `Mover "${strategy.name}" para a lixeira?`,
    detail: 'A estratégia some da biblioteca e do Estúdio. Os backtests ficam preservados e voltam ao restaurar.',
    confirmLabel: 'Mover para lixeira',
    tone: 'danger',
  });
  if (!ok) return;

  const res = await ctx.api.delete(`/api/strategies/${strategy.id}`);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao mover para lixeira');
    return;
  }
  notifyStudioCatalogChanged();
  ctx.toast.ok('Estratégia movida para a lixeira');
  state.selectedId = null;
  state.selectedVersionId = null;
  state.list = state.list.filter((s) => s.id !== strategy.id);
  state.libraryStats = state.list;
  ctx.navigate('strategies');
  await renderStrategies(ctx);
}

async function renderTrashView(ctx) {
  ctx.setBreadcrumb('strategies', 'Lixeira');

  mount(ctx.contentEl, [
    el('div', { class: 'strategy-library__toolbar', style: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px', marginBottom: '16px' } }, [
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onclick: () => ctx.navigate('strategies'),
      }, [
        el('i', { class: 'fa-solid fa-arrow-left', style: { marginRight: '6px' } }),
        'Biblioteca',
      ]),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onclick: () => renderTrashView(ctx),
        style: { marginLeft: 'auto' }
      }, [
        el('i', { class: 'fa-solid fa-rotate', style: { marginRight: '6px' } }),
        'Recarregar'
      ]),
    ]),
    el('div', { class: 'card trash-actions-card', id: 'strategies-trash-root' }, el('p', { class: 'muted' }, 'Carregando...')),
  ]);

  const res = await ctx.api.get('/api/strategies/trash?stats=1');
  const root = document.getElementById('strategies-trash-root');
  if (!res.ok) {
    mount(root, el('p', { class: 'bad' }, res.error?.message || 'Falha ao carregar lixeira'));
    return;
  }

  state.trashList = res.data.strategies || [];
  if (!state.trashList.length) {
    mount(root, emptyState('A lixeira está vazia.'));
    return;
  }

  mount(root, [
    el('div', { class: 'card__header card__header--inline' }, [
      el('h2', { class: 'card__title' }, `${state.trashList.length} estratégia(s)`),
      el('p', { class: 'muted card__subtitle' }, 'Restaurar traz de volta o histórico de runs vinculado.'),
    ]),
    el('div', { class: 'strategy-trash-list' }, state.trashList.map((strategy) => renderTrashItem(ctx, strategy))),
  ]);
}

function renderTrashItem(ctx, strategy) {
  const stats = strategy.stats?.totals || strategy.totals || {};
  const deletedAt = strategy.deleted_at ? strategy.deleted_at.slice(0, 16).replace('T', ' ') : '—';

  return el('div', { class: 'strategy-trash-item' }, [
    el('div', { class: 'strategy-trash-item__main' }, [
      el('div', { class: 'strategy-trash-item__title' }, strategy.name),
      el('div', { class: 'muted mono strategy-trash-item__meta' }, `${strategy.slug} · v${strategy.latest_version ?? '-'} · removida ${deletedAt}`),
      el('div', { class: 'strategy-trash-item__stats muted' }, `${stats.runs ?? 0} runs · best ${formatPnl(stats.best_pnl ?? 0)}`),
    ]),
    el('div', { class: 'btn-group strategy-trash-item__actions' }, [
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onclick: () => restoreStrategyFlow(ctx, strategy),
      }, 'Restaurar'),
      el('button', {
        class: 'btn btn--danger btn--sm btn--ghost',
        type: 'button',
        onclick: () => permanentDeleteStrategyFlow(ctx, strategy),
      }, 'Apagar permanentemente'),
    ]),
  ]);
}

async function restoreStrategyFlow(ctx, strategy) {
  const res = await ctx.api.post(`/api/strategies/${strategy.id}/restore`);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao restaurar');
    return;
  }
  notifyStudioCatalogChanged();
  ctx.toast.ok(`"${strategy.name}" restaurada`);
  state.trashList = state.trashList.filter((s) => s.id !== strategy.id);
  await renderTrashView(ctx);
}

async function permanentDeleteStrategyFlow(ctx, strategy) {
  const ok = await confirmDialog({
    title: 'Apagar permanentemente',
    message: `Apagar "${strategy.name}" para sempre?`,
    detail: 'Só é possível apagar estratégias que já estão na lixeira. Por padrão os backtests são mantidos como órfãos.',
    confirmLabel: 'Continuar',
    tone: 'danger',
  });
  if (!ok) return;

  const deleteRuns = await confirmDeleteRunsDialog(strategy.name);
  if (deleteRuns == null) return;

  const qs = deleteRuns ? '?delete_runs=1' : '';
  const res = await ctx.api.delete(`/api/strategies/${strategy.id}/permanent${qs}`);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao apagar permanentemente');
    return;
  }
  notifyStudioCatalogChanged();
  ctx.toast.ok(deleteRuns ? 'Estratégia e runs apagados' : 'Estratégia apagada (runs preservados)');
  state.trashList = state.trashList.filter((s) => s.id !== strategy.id);
  await renderTrashView(ctx);
}

function confirmDeleteRunsDialog(strategyName) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    if (!root) {
      resolve(false);
      return;
    }
    const checkbox = el('input', { type: 'checkbox', id: 'trash-delete-runs', class: 'switch-field__input' });
    const overlay = el('div', {
      onclick: (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } },
      class: 'modal-overlay',
    }, [
      el('div', { class: 'modal modal--danger', role: 'dialog', onclick: (e) => e.stopPropagation() }, [
        el('div', { class: 'modal__header' }, [
          el('span', { class: 'modal__icon', 'aria-hidden': 'true' }, '⚠'),
          el('h2', { class: 'modal__title' }, 'Apagar runs também?'),
        ]),
        el('div', { class: 'modal__body' }, [
          el('p', { class: 'modal__message' }, `Confirme o que fazer com os backtests de "${strategyName}".`),
          el('label', { class: 'switch-field', style: { marginTop: '12px' } }, [
            checkbox,
            el('span', { class: 'switch-field__slider' }),
            ' Apagar também todos os backtests desta estratégia',
          ]),
          el('p', { class: 'modal__detail' }, 'Desmarcado: runs permanecem no banco, mas sem vínculo com a estratégia.'),
        ]),
        el('div', { class: 'modal__footer' }, [
          el('button', {
            class: 'btn btn--ghost',
            type: 'button',
            onclick: () => { overlay.remove(); resolve(null); },
          }, 'Cancelar'),
          el('button', {
            class: 'btn btn--danger',
            type: 'button',
            onclick: () => { overlay.remove(); resolve(checkbox.checked); },
          }, 'Apagar permanentemente'),
        ]),
      ]),
    ]);
    root.setAttribute('aria-hidden', 'false');
    root.appendChild(overlay);
  });
}

async function deleteVersionFlow(ctx, strategy, version) {
  if (!version) return;
  const scrollSnap = captureScrollState(ctx);
  const wasCurrent = state.selectedVersionId === version.id;
  const ok = await confirmDialog({
    title: 'Excluir versão',
    message: `Excluir a versão v${version.version} de "${strategy.name}"?`,
    detail: 'Deseja realmente excluir esta versão?',
    confirmLabel: 'Excluir',
    tone: 'danger',
  });
  if (!ok) return;

  let res = await ctx.api.delete(`/api/strategies/${strategy.id}/versions/${version.id}`);
  if (!res.ok) {
    const msg = res.error?.message || '';
    if (msg.includes('used by backtest runs')) {
      const cascadeOk = await confirmDialog({
        title: 'Excluir com histórico?',
        message: `A versão v${version.version} de "${strategy.name}" foi utilizada em simulações de backtest.`,
        detail: 'Deseja excluir esta versão e apagar permanentemente todo o histórico de simulações de backtest associadas a ela?',
        confirmLabel: 'Apagar tudo e excluir',
        tone: 'danger',
      });
      if (!cascadeOk) return;

      res = await ctx.api.delete(`/api/strategies/${strategy.id}/versions/${version.id}?delete_runs=true`);
      if (!res.ok) {
        ctx.toast.err(res.error?.message || 'Falha ao excluir versão com histórico');
        return;
      }
    } else {
      ctx.toast.err(res.error?.message || 'Falha ao excluir versão');
      return;
    }
  }

  ctx.toast.ok(`Versão v${version.version} excluída`);
  notifyStudioCatalogChanged();
  await state.historyPanelApi?.refresh({ scrollSnap });

  if (wasCurrent) {
    const remaining = state.historyPanelApi?.getVersions() || [];
    const nextVersionId = remaining[0]?.id ?? null;
    await openStrategyEditor(ctx, strategy.id, nextVersionId, {
      preserveScroll: true,
      activeTab: scrollSnap.activeTab,
    });
  }
}

function toggleGlsDrawer(isOpen) {
  let drawer = document.getElementById('gls-help-drawer');
  if (!drawer) {
    drawer = createGlsDrawer();
    document.body.appendChild(drawer);
  }
  drawer.classList.toggle('is-open', isOpen);
  if (isOpen) {
    const input = drawer.querySelector('.drawer-search-input');
    if (input) {
      input.value = '';
      input.focus();
    }
    renderDrawerBlocks('');
  }
}

function createGlsDrawer() {
  return el('div', { class: 'gls-drawer', id: 'gls-help-drawer' }, [
    el('div', { class: 'gls-drawer__header' }, [
      el('h3', {}, [
        'Ajuda Strategy JS ',
        el('i', { class: 'fa-solid fa-circle-question', style: { marginLeft: '4px', color: 'var(--accent)' } })
      ]),
      el('button', { class: 'btn btn--icon btn--ghost', type: 'button', onclick: () => toggleGlsDrawer(false) }, el('i', { class: 'fa-solid fa-xmark' })),
    ]),
    el('div', { class: 'gls-drawer__body' }, [
      el('section', { class: 'editor-help-card' }, [
        el('h4', { style: { margin: '0 0 8px 0' } }, 'Teclas de Atalho'),
        el('div', { class: 'shortcut-list' }, [
          shortcut('Ctrl+Space', 'Autocomplete'),
          shortcut('Ctrl+S', 'Salvar versão'),
          shortcut('Tab', 'Indentar Código'),
        ]),
      ]),
      el('section', { class: 'editor-help-card' }, [
        el('h4', { style: { margin: '0 0 8px 0' } }, 'Contrato para IA'),
        el('textarea', {
          class: 'field__input',
          rows: '6',
          readonly: true,
          style: { fontSize: '11px', fontFamily: 'var(--mono)' },
        }, state.capabilities?.ai_contract || 'Carregue /api/strategy-runtime/capabilities'),
        el('button', {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          style: { marginTop: '8px' },
          onclick: () => {
            const text = state.capabilities?.ai_contract || '';
            navigator.clipboard?.writeText(text);
          },
        }, 'Copiar para prompt'),
      ]),
      el('section', { class: 'editor-help-card' }, [
        el('h4', { style: { margin: '0 0 8px 0' } }, 'APIs do runtime'),
        el('div', { class: 'strategy-search-wrap', style: { position: 'relative' } }, [
          el('i', { class: 'fa-solid fa-magnifying-glass search-icon', style: { position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)', pointerEvents: 'none' } }),
          el('input', {
            class: 'strategy-search-input drawer-search-input',
            style: { paddingLeft: '32px' },
            type: 'text',
            placeholder: 'Buscar bloco ou assinatura...',
            oninput: (e) => renderDrawerBlocks(e.target.value),
          }),
        ]),
        el('div', { id: 'drawer-blocks-list-wrap', style: { marginTop: '12px' } }),
        el('p', { class: 'muted', style: { fontSize: '11px', marginTop: '12px' } }, 'Namespaces do runtime: market, book, prices, time, risk, debug. Clique em um bloco para inseri-lo no cursor.'),
      ]),
    ]),
  ]);
}

function renderDrawerBlocks(query = '') {
  const wrap = document.getElementById('drawer-blocks-list-wrap');
  if (!wrap) return;
  const q = query.toLowerCase().trim();
  const filtered = state.blocks.filter(block => 
    block.signature.toLowerCase().includes(q) || 
    (block.description && block.description.toLowerCase().includes(q))
  );
  mount(wrap, el('ul', { class: 'mono-list mono-list--dense', style: { fontSize: '11px', lineHeight: '1.4', paddingLeft: '12px', listStyle: 'none', margin: 0 } }, 
    filtered.length 
      ? filtered.map((block) => el('li', { style: { marginBottom: '8px', borderBottom: '1px solid var(--border)', paddingBottom: '8px' } }, [
          el('code', { 
            style: { display: 'block', color: 'var(--accent)', cursor: 'pointer', fontWeight: 'bold' }, 
            onclick: () => insertBlockIntoEditor(block.signature) 
          }, block.signature),
          block.description ? el('div', { class: 'muted', style: { fontSize: '10px', marginTop: '2px' } }, block.description) : null
        ]))
      : [el('li', { class: 'muted' }, 'Nenhum bloco encontrado.')]
  ));
}

function insertBlockIntoEditor(signature) {
  if (!state.focusedEditor) return;
  const cm = state.focusedEditor;
  const doc = cm.getDoc();
  const cursor = doc.getCursor();
  const cleanSig = signature.split(' -> ')[0].trim();
  doc.replaceRange(cleanSig, cursor);
  cm.focus();
}

async function deleteRunFlow(ctx, strategyId, runId) {
  const scrollSnap = captureScrollState(ctx);
  const ok = await confirmDialog({
    title: 'Excluir simulação',
    message: `Deseja apagar permanentemente a simulação #${runId}?`,
    detail: 'Esta simulação será removida do histórico e as médias de desempenho da estratégia serão atualizadas instantaneamente.',
    confirmLabel: 'Excluir simulação',
    tone: 'danger',
  });
  if (!ok) return;

  const res = await ctx.api.delete(`/api/backtest/runs/${runId}`);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao excluir simulação');
    return;
  }
  ctx.toast.ok(`Simulação #${runId} excluída`);
  notifyRunDataChanged();
  await state.historyPanelApi?.refresh({ scrollSnap });
}
