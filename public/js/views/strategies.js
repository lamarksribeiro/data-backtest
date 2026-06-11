import { el, mount, emptyState } from '../utils/dom.js';
import { loadContext } from '../utils/context.js';
import { backtestPayloadFromPick } from '../utils/strategyPicker.js';
import { promptDialog, confirmDialog } from '../utils/confirm.js';
import { formatPnl } from '../utils/format.js';
import { renderUplotSparkline } from '../utils/uplotChart.js';

const GLS_TEMPLATE = `strategy "Nova Estrategia" {
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

/** @type {{ list: object[], selectedId: number|null, selectedVersionId: number|null, focusedEditor: object|null, sourceCode: string, validation: object|null, blocks: object[], currentStrategy: object|null, currentVersion: object|null, strategyQuery: string, statusFilter: string }} */
const state = {
  list: [],
  selectedId: null,
  selectedVersionId: null,
  focusedEditor: null,
  sourceCode: '',
  validation: null,
  blocks: [],
  currentStrategy: null,
  currentVersion: null,
  strategyQuery: '',
  statusFilter: 'all',
  librarySort: 'last_use',
  libraryStats: [],
};

export async function renderStrategies(ctx, params = {}) {
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
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Estratégias'),
        el('p', { class: 'page-header__sub' }, 'Editor GLS, validação e parâmetros integrados.'),
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => createStrategyFlow(ctx) }, 'Nova'),
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => renderStrategies(ctx) }, 'Recarregar'),
      ]),
    ]),
    el('div', { class: 'editor-layout editor-layout--full-width', id: 'strategies-root' }, el('p', { class: 'muted' }, 'Carregando...')),
  ]);

  const res = await ctx.api.get('/api/strategies?stats=1');
  if (!res.ok) {
    mount(document.getElementById('strategies-root'), el('p', { class: 'bad' }, res.error?.message || 'Falha ao carregar estratégias'));
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
    queueMicrotask(() => _renderLibrarySparklines());
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

  return el('div', { class: 'strategy-library' }, [
    el('div', { class: 'strategy-library__toolbar' }, [
      el('input', {
        class: 'field__input search-field-library',
        placeholder: 'Buscar estratégias…',
        value: state.strategyQuery,
        oninput: (e) => { state.strategyQuery = e.target.value; updateKanbanCards(ctx); },
      }),
      el('select', {
        class: 'field__input sort-field-library',
        onchange: (e) => { state.librarySort = e.target.value; renderStrategies(ctx); },
      }, [
        el('option', { value: 'last_use', selected: state.librarySort === 'last_use' }, 'Último uso'),
        el('option', { value: 'best_pnl', selected: state.librarySort === 'best_pnl' }, 'Melhor PnL'),
        el('option', { value: 'win_rate', selected: state.librarySort === 'win_rate' }, 'Win rate'),
        el('option', { value: 'name', selected: state.librarySort === 'name' }, 'Nome'),
      ]),
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

function strategyCard(ctx, strategy) {
  const stats = strategy.stats?.totals || strategy.totals || {};
  const spark = strategy.stats?.sparkline || strategy.sparkline || [];
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
        },
      }, '★'),
      el('strong', { class: 'strategy-card__title', onclick: () => ctx.navigate(`strategies/${strategy.id}`) }, strategy.name),
      el('span', { class: `badge badge--${strategyStatusTone(strategy.status)}` },
        `${translateStatus(strategy.status)}${versionNum != null ? ` · v${versionNum}` : ''}`),
    ]),
    spark.length
      ? el('div', { class: 'strategy-card__spark', id: `spark-${strategy.id}`, 'aria-hidden': 'true' })
      : el('p', { class: 'muted strategy-card__empty' }, stats.runs ? 'Sem histórico de PnL' : 'Sem runs ainda'),
    el('div', { class: 'strategy-card__stats' }, [
      el('span', {}, `${stats.runs ?? 0} runs`),
      el('span', {}, stats.runs ? `${Math.round((stats.win_rate ?? 0) * 100)}% WR` : '—'),
      el('span', {}, stats.best_pnl != null ? `best ${formatPnl(stats.best_pnl)}` : ''),
    ]),
    el('div', { class: 'strategy-card__actions' }, [
      el('button', {
        type: 'button',
        class: 'btn btn--primary btn--sm',
        onclick: () => ctx.navigate(`studio?strategy=${strategy.id}&version=${strategy.latest_version_id || ''}`),
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

// Render sparklines after cards mount
export function _renderLibrarySparklines() {
  for (const strategy of state.libraryStats || []) {
    const spark = strategy.stats?.sparkline || strategy.sparkline || [];
    const container = document.getElementById(`spark-${strategy.id}`);
    if (container && spark.length) renderUplotSparkline(container, spark);
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

async function openStrategyEditor(ctx, strategyId, versionId = null) {
  const editorPanel = document.getElementById('strategy-editor');
  if (!editorPanel) return;

  // Clean up any old editor before loading next one
  if (state.focusedEditor) {
    try {
      state.focusedEditor.toTextArea();
    } catch { /* ignore */ }
    state.focusedEditor = null;
  }

  mount(editorPanel, el('p', { class: 'muted' }, 'Carregando detalhes do editor...'));

  const [strategyRes, versionsRes, blocksRes, statsRes] = await Promise.all([
    ctx.api.get(`/api/strategies/${strategyId}`),
    ctx.api.get(`/api/strategies/${strategyId}/versions`),
    ctx.api.get('/api/strategy-blocks'),
    ctx.api.get(`/api/strategies/${strategyId}/stats`),
  ]);
  const strategyStats = statsRes.ok ? statsRes.data.stats : null;
  if (!strategyRes.ok) {
    mount(editorPanel, el('p', { class: 'bad' }, strategyRes.error?.message || 'Falha ao abrir estratégia'));
    return;
  }

  const strategy = strategyRes.data.strategy;
  state.currentStrategy = strategy;
  ctx.setBreadcrumb('strategies', strategy.name);
  const versions = versionsRes.ok ? versionsRes.data.versions || [] : [];
  const version = versionId
    ? versions.find((item) => item.id === versionId) || versions[0]
    : versions[0];
  state.selectedVersionId = version?.id ?? null;
  state.currentVersion = version ?? null;

  state.sourceCode = version?.source_code || GLS_TEMPLATE;
  state.validation = version?.validation || null;
  state.blocks = blocksRes.data?.blocks || [];
  
  const schema = state.validation?.params_schema || version?.params_schema || {};
  const hasParams = Object.keys(schema).length > 0;

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
        el('div', { class: 'strategy-version-control' }, [
          el('span', { class: 'strategy-version-control__label' }, [
            el('i', { class: 'fa-solid fa-code-branch' }),
            'Versão',
          ]),
          el('select', {
            class: 'strategy-version-control__select',
            id: 'strategy-version-select',
            onchange: async (e) => {
              const nextVersionId = Number(e.target.value);
              if (!Number.isFinite(nextVersionId)) return;
              state.selectedVersionId = nextVersionId;
              ctx.navigate(`strategies/${strategyId}/${nextVersionId}`);
              await openStrategyEditor(ctx, strategyId, nextVersionId);
            },
          }, versions.length
            ? versions.map((item) => el('option', { value: item.id, selected: item.id === version?.id }, `v${item.version}${item.notes ? ` — ${item.notes}` : ''} · ${item.created_at ? item.created_at.slice(0, 10) : '—'}`))
            : [el('option', { value: '' }, 'Sem versões')]),
          ...(versions.length > 1
            ? [el('button', {
              class: 'btn btn--ghost btn--sm btn--icon strategy-version-control__delete',
              type: 'button',
              title: 'Excluir esta versão',
              onclick: () => deleteVersionFlow(ctx, strategy, version),
            }, el('i', { class: 'fa-solid fa-trash-can' }))]
            : []),
        ]),
        el('div', { class: 'strategy-header-toolbar__sep', 'aria-hidden': 'true' }),
        el('button', {
          class: 'btn btn--danger btn--sm btn--ghost',
          type: 'button',
          onclick: () => deleteStrategyFlow(ctx, strategy),
        }, [
          el('i', { class: 'fa-solid fa-trash-can' }),
          'Apagar estratégia',
        ]),
      ]),
    ]),

    // Tab Navigation bar
    el('div', { class: 'premium-tabs-nav' }, [
      el('button', { class: 'premium-tab-link is-active', id: 'tab-link-code', type: 'button', onclick: () => switchTab('code') }, [
        el('i', { class: 'fa-solid fa-code', style: { marginRight: '8px' } }),
        'Editor de Código'
      ]),
      el('button', { class: 'premium-tab-link', id: 'tab-link-params', type: 'button', onclick: () => switchTab('params') }, [
        el('i', { class: 'fa-solid fa-sliders', style: { marginRight: '8px' } }),
        'Parâmetros'
      ]),
      el('button', { class: 'premium-tab-link', id: 'tab-link-config', type: 'button', onclick: () => switchTab('config') }, [
        el('i', { class: 'fa-solid fa-circle-info', style: { marginRight: '8px' } }),
        'Ficha Técnica'
      ]),
    ]),

    // 1. Tab Código Content
    el('div', { class: 'premium-tab-content is-active', id: 'tab-content-code' }, [
      el('div', { class: 'strategy-code-tab-layout strategy-code-tab-layout--single' }, [
        el('div', { class: 'strategy-code-editor-area' }, [
          el('div', { class: 'row row--between', style: { flexWrap: 'wrap', gap: '8px' } }, [
            el('span', { class: 'eyebrow' }, 'Linguagem GLS'),
            el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } }, [
              el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => toggleGlsDrawer(true) }, [
                'Ajuda GLS ',
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
              el('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => saveTabCodeVersion(ctx, strategy.id) }, [
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
        ]),
      ]),
    ]),

    // 2. Tab Parâmetros Content
    el('div', { class: 'premium-tab-content', id: 'tab-content-params' }, [
      el('div', { class: 'row row--between', style: { marginBottom: '14px' } }, [
        el('div', {}, [
          el('h3', { class: 'card__title' }, 'Parâmetros Declarados'),
          el('p', { class: 'muted', style: { fontSize: '12px' } }, 'Edite os valores numéricos ou booleanos diretamente na estrutura do código.'),
        ]),
        el('button', { class: 'btn btn--primary btn--sm', type: 'button', disabled: !hasParams, onclick: () => saveParamsVersion(ctx, strategy.id) }, 'Salvar parâmetros e recriar versão'),
      ]),
      el('div', { class: 'strategy-workbench', id: 'strategy-workbench-root' }, [
        hasParams ? renderParamsForm(schema) : emptyState('Esta versão de estratégia não declara parâmetros editáveis no cabeçalho param.'),
      ]),
    ]),

    // 3. Tab Ficha Técnica / Metadados Content
    el('div', { class: 'premium-tab-content', id: 'tab-content-config' }, [
      el('div', { style: { maxWidth: '720px' } }, [
        el('h3', { class: 'card__title', style: { marginBottom: '14px' } }, 'Metadados da Estratégia'),
        renderStrategyMetaForm(ctx, strategy),
        el('h3', { class: 'card__title', style: { marginTop: '20px' } }, 'Evolução por versão'),
        el('div', { id: 'strategy-evolution-chart', class: 'strategy-evolution-chart' }),
        el('h3', { class: 'card__title', style: { marginTop: '20px' } }, 'Diff entre versões'),
        renderVersionDiffPanel(versions, version),
      ]),
    ]),
  ]);

  loadStrategyEvolution(ctx, strategyId);

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

async function loadStrategyEvolution(ctx, strategyId) {
  const res = await ctx.api.get(`/api/strategies/${strategyId}/stats`);
  if (!res.ok) return;
  const byVersion = res.data.stats?.by_version || [];
  const container = document.getElementById('strategy-evolution-chart');
  if (!container || !byVersion.length) {
    if (container) mount(container, el('p', { class: 'muted' }, 'Sem runs para comparar versões.'));
    return;
  }
  const labels = byVersion.map((v) => `v${v.version}`);
  const winRates = byVersion.map((v) => Math.round((v.win_rate ?? 0) * 100));
  mount(container, el('div', { class: 'evolution-bars' }, byVersion.map((v, i) => el('div', { class: 'evolution-bar' }, [
    el('span', { class: 'evolution-bar__label' }, labels[i]),
    el('span', { class: 'evolution-bar__fill', style: { width: `${winRates[i]}%` } }),
    el('span', { class: 'evolution-bar__value' }, `${winRates[i]}% · avg ${formatPnl(v.avg_pnl)}`),
  ]))));
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
  const res = await ctx.api.post('/api/strategies/validate', { source_code: source });
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao validar');
    return null;
  }
  state.validation = res.data.validation;
  renderValidation(state.validation);
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
  if (validation.ok) ctx.toast.ok('Código GLS válido');
  else ctx.toast.err(`Código inválido: ${validation.errors?.length || 0} erro(s)`);
}

async function testStrategyQuick(ctx, strategyId) {
  if (state.focusedEditor) state.sourceCode = state.focusedEditor.getValue();
  const validation = await validateStrategySource(ctx, state.sourceCode);
  if (!validation?.ok) {
    ctx.toast.warn('Valide e corrija o código GLS antes de testar');
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
  if (!hasSourceChanged(source, state.currentVersion?.source_code)) {
    ctx.toast.warn('Nenhuma alteração detectada. Versão não criada.');
    return null;
  }
  const validation = await validateStrategySource(ctx, source);
  if (!validation?.ok) {
    ctx.toast.warn('Corrija os erros de validação do GLS antes de salvar.');
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
  const form = document.getElementById('strategy-params-form');
  if (!form) return;
  const schema = state.validation?.params_schema || {};
  const values = {};
  try {
    for (const [key, def] of Object.entries(schema)) {
      const input = form.elements[key];
      if (!input) continue;
      values[key] = parseParamValue(input.value, typeof def?.default);
    }
  } catch (err) {
    ctx.toast.err(err.message || 'Parâmetro inválido');
    return;
  }
  const source = updateParamDefaults(state.sourceCode, values);
  if (source === state.sourceCode) {
    ctx.toast.warn('Nenhum parâmetro foi alterado.');
    return;
  }
  await saveSourceVersion(ctx, strategyId, source);
  
  // Go back to parameters tab to see changes
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

function updateParamDefaults(source, values) {
  let next = String(source || '');
  for (const [name, value] of Object.entries(values)) {
    const literal = glsLiteral(value);
    const re = new RegExp(`(^\\s*param\\s+${escapeRegExp(name)}\\s*=\\s*)(?:"(?:\\\\.|[^"])*"|true|false|null|-?\\d+(?:\\.\\d+)?)`, 'm');
    next = next.replace(re, `$1${literal}`);
  }
  return next;
}

function glsLiteral(value) {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value == null) return 'null';
  return JSON.stringify(String(value));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  await ctx.api.post(`/api/strategies/${created.data.strategy.id}/versions`, { source_code: GLS_TEMPLATE });
  state.selectedId = created.data.strategy.id;
  ctx.navigate(`strategies/${state.selectedId}`);
  await renderStrategies(ctx, { id: state.selectedId });
}

async function deleteStrategyFlow(ctx, strategy) {
  const ok = await confirmDialog({
    title: 'Apagar estratégia',
    message: `Apagar "${strategy.name}" e todas as versões salvas?`,
    detail: 'Runs antigos permanecem no histórico com o snapshot já gravado.',
    confirmLabel: 'Apagar',
    tone: 'danger',
  });
  if (!ok) return;

  const res = await ctx.api.delete(`/api/strategies/${strategy.id}`);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao apagar estratégia');
    return;
  }
  ctx.toast.ok('Estratégia apagada');
  state.selectedId = null;
  state.selectedVersionId = null;
  state.list = state.list.filter((s) => s.id !== strategy.id);
  state.libraryStats = state.list;
  ctx.navigate('strategies');
  await renderStrategies(ctx);
}

async function deleteVersionFlow(ctx, strategy, version) {
  if (!version) return;
  const ok = await confirmDialog({
    title: 'Excluir versão',
    message: `Excluir a versão v${version.version} de "${strategy.name}"?`,
    detail: 'A exclusão só é permitida se a versão não foi usada em nenhum backtest e se não for a última versão da estratégia.',
    confirmLabel: 'Excluir versão',
    tone: 'danger',
  });
  if (!ok) return;
  const res = await ctx.api.delete(`/api/strategies/${strategy.id}/versions/${version.id}`);
  if (!res.ok) {
    ctx.toast.err(res.error?.message || 'Falha ao excluir versão');
    return;
  }
  ctx.toast.ok(`Versão v${version.version} excluída`);
  state.selectedVersionId = null;
  await renderStrategies(ctx, { id: strategy.id });
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
        'Ajuda GLS ',
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
        el('h4', { style: { margin: '0 0 8px 0' } }, 'Blocos GLS'),
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
