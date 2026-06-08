import { el, mount, emptyState } from '../utils/dom.js';
import { fieldLabelWithHelp } from '../utils/fieldHelp.js';
import { applyContextOptions, contextBarOptions, loadContext, saveContext, selectField } from '../utils/context.js';
import { escapeHtml, formatPnl } from '../utils/format.js';
import { loadStrategyOptions, renderStrategySelect, backtestPayloadFromPick } from '../utils/strategyPicker.js';

const state = {
  runs: [],
  strategyOptions: [],
  selectedStrategyPick: '',
  filterBySelectedStrategy: true,
  historyFilters: {
    status: 'all',
    sort: 'newest',
  }
};

export async function renderBacktests(ctx) {
  ctx.setBreadcrumb('backtests', null);
  ctx.renderContextBar?.();

  const optionsRes = await ctx.api.get('/api/context-options');
  const apiOptions = optionsRes.ok ? (optionsRes.data.options || {}) : {};
  const fieldOptions = contextBarOptions(apiOptions);
  const formCtx = applyContextOptions(loadContext(), fieldOptions);
  const underlyingOptions = fieldOptions.underlyings?.length ? fieldOptions.underlyings : [formCtx.underlying];
  const intervalOptions = fieldOptions.intervals?.length ? fieldOptions.intervals : [formCtx.interval];
  const bookDepthOptions = fieldOptions.book_depths?.length ? fieldOptions.book_depths : [formCtx.book_depth];

  state.strategyOptions = await loadStrategyOptions(ctx.api);
  if (state.strategyOptions.length && !state.selectedStrategyPick) {
    state.selectedStrategyPick = state.strategyOptions[0].value;
  }
  const defaultPick = state.selectedStrategyPick || '';

  const runsRes = await ctx.api.get('/api/backtest/runs?limit=50');
  state.runs = runsRes.ok ? runsRes.data.runs || [] : [];

  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Backtests'),
        el('p', { class: 'page-header__sub' }, 'Execute runs de estratégias e compare resultados passados.'),
      ]),
    ]),
    el('div', { class: 'backtest-dashboard-layout' }, [
      // Coluna da Esquerda: Formulário de Execução
      el('aside', { class: 'backtest-sidebar-panel' }, [
        el('section', { class: 'card' }, [
          el('h2', { class: 'card__title', style: { marginBottom: '14px' } }, 'Configurar Simulação'),
          el('form', { id: 'backtest-form', class: 'backtest-execution-form' }, [
            el('label', { class: 'field' }, [
              el('span', { class: 'field__label' }, 'Estratégia'),
              el('div', { id: 'strategy-pick-wrap' }),
            ]),
            el('label', { class: 'field' }, [
              el('span', { class: 'field__label' }, 'Ativo'),
              selectField('underlying', underlyingOptions, formCtx.underlying),
            ]),
            el('label', { class: 'field' }, [
              el('span', { class: 'field__label' }, 'Intervalo'),
              selectField('interval', intervalOptions, formCtx.interval),
            ]),
            el('label', { class: 'field' }, [
              el('span', { class: 'field__label' }, 'Book depth'),
              selectField('book_depth', bookDepthOptions, formCtx.book_depth),
            ]),
            el('label', { class: 'field' }, [
              el('span', { class: 'field__label' }, 'De'),
              el('input', { class: 'field__input', type: 'date', name: 'from', value: formCtx.from, required: true }),
            ]),
            el('label', { class: 'field' }, [
              el('span', { class: 'field__label' }, 'Até'),
              el('input', { class: 'field__input', type: 'date', name: 'to', value: formCtx.to, required: true }),
            ]),
            el('details', { class: 'advanced-settings-details', style: { gridColumn: '1 / -1', marginTop: '4px' } }, [
              el('summary', { style: { cursor: 'pointer', color: 'var(--accent)', fontSize: '12.5px', fontWeight: '600', outline: 'none' } }, 'Configurações Avançadas'),
              el('div', { style: { paddingTop: '10px' } }, [
                el('label', { class: 'field' }, [
                  fieldLabelWithHelp(
                    'Batch size',
                    'Tamanho do lote de ticks lidos por vez. Afeta performance/memória, não a lógica da estratégia.',
                  ),
                  el('input', { class: 'field__input', type: 'number', name: 'batch_size', min: '1', value: formCtx.batch_size }),
                ]),
              ])
            ]),
            el('button', { 
              class: 'btn btn--primary btn--large', 
              type: 'submit', 
              style: { gridColumn: '1 / -1', marginTop: '14px', width: '100%', height: '42px', fontSize: '14px', fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' },
              disabled: !state.strategyOptions.length 
            }, [
              'Iniciar Backtest ',
              el('i', { class: 'fa-solid fa-bolt' })
            ]),
          ]),
          state.strategyOptions.length ? null : el('p', { class: 'muted', style: { marginTop: '10px', fontSize: '12.5px' } }, 'Crie e salve uma versão de estratégia antes de executar backtests.'),
          el('div', { id: 'backtest-run-result', style: { marginTop: '12px' } }),
        ])
      ]),
      // Coluna da Direita: Estatísticas e Histórico
      el('div', { class: 'backtest-main-panel' }, [
        el('div', { id: 'backtest-stats-panel' }),
        el('div', { id: 'backtests-table-panel' }),
      ])
    ])
  ]);

  const strategyPickWrap = document.getElementById('strategy-pick-wrap');
  if (strategyPickWrap) {
    strategyPickWrap.innerHTML = renderStrategySelect(state.strategyOptions, defaultPick);
    const select = strategyPickWrap.querySelector('select');
    if (select) {
      select.addEventListener('change', (e) => {
        state.selectedStrategyPick = e.target.value;
        updateDashboard(ctx);
      });
    }
  }

  updateDashboard(ctx);

  const form = document.getElementById('backtest-form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fd = new FormData(event.target);
    const ctxSaved = saveContext({
      batch_size: fd.get('batch_size'),
      from: fd.get('from'),
      to: fd.get('to'),
      underlying: String(fd.get('underlying')).trim(),
      interval: String(fd.get('interval')).trim(),
      book_depth: fd.get('book_depth'),
    });
    
    const pick = fd.get('strategy_pick');
    if (!pick) {
      ctx.toast.warn('Selecione uma estratégia versionada.');
      return;
    }

    const payload = backtestPayloadFromPick(String(pick), ctxSaved);
    const resultPanel = document.getElementById('backtest-run-result');
    mount(resultPanel, el('p', { class: 'muted' }, 'Executando backtest...'));

    const res = await ctx.api.post('/api/backtest/run', payload);
    if (!res.ok) {
      if (res.data?.availability) {
        mount(resultPanel, dataNotReadyCard(res.data.availability, payload, ctx));
        ctx.toast.warn('Dados não prontos — veja os dias bloqueados no painel');
      } else {
        mount(resultPanel, el('p', { class: 'bad' }, res.error?.message || 'Falha ao executar'));
      }
      return;
    }
    
    const summary = res.data.result?.summary || res.data.run?.summary || {};
    ctx.toast.ok(`Backtest #${res.data.run.id} concluído · PnL ${formatPnl(summary.totalPnl ?? 0)}`);
    mount(resultPanel, el('div', { class: 'row row--wrap' }, [
      el('span', { class: 'badge badge--ok' }, `Run #${res.data.run.id}`),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onclick: () => ctx.navigate(`backtests/${res.data.run.id}`),
      }, 'Ver detalhes'),
    ]));

    const runsRes = await ctx.api.get('/api/backtest/runs?limit=50');
    state.runs = runsRes.ok ? runsRes.data.runs || [] : [];
    updateDashboard(ctx);
  });
}

function dataNotReadyCard(availability, payload, ctx) {
  const missing = availability.missing || [];
  const unavailable = availability.unavailable || [];
  const acceptedWarnings = (availability.partitions || []).filter((p) => p.status === 'accepted').length;
  const degraded = (availability.partitions || []).filter((p) => p.has_degraded).length;
  const blockers = [
    ...missing.map((dt) => ({ dt, status: 'missing', detail: 'Sem partição no manifesto.' })),
    ...unavailable.map((item) => ({
      dt: item.dt,
      status: item.status,
      detail: item.error || item.hint || 'Partição não liberada para strict.',
    })),
  ];

  return el('div', { class: 'backtest-data-blocker' }, [
    el('div', { class: 'backtest-data-blocker__head' }, [
      el('span', { class: 'badge badge--warn' }, 'dados não prontos'),
      el('strong', {}, `${blockers.length} dia(s) bloqueando o backtest`),
    ]),
    el('p', {}, acceptedWarnings
      ? `Períodos aceitos com aviso não bloqueiam a execução. O bloqueio abaixo vem de datas ausentes, needs_review, stale ou inválidas no intervalo.`
      : 'O backtest só executa quando todas as partições do intervalo estão valid ou accepted.'),
    el('div', { class: 'backtest-data-blocker__stats' }, [
      miniMetric('Prontas strict', availability.summary?.valid ?? 0),
      miniMetric('Pendentes', (availability.summary?.missing ?? missing.length) + (availability.summary?.unavailable ?? unavailable.length)),
      miniMetric('Aceitas aviso', acceptedWarnings),
      miniMetric('Degradadas', degraded),
    ]),
    blockers.length ? el('div', { class: 'backtest-data-blocker__list' }, blockers.slice(0, 12).map((item) =>
      el('div', { class: 'backtest-data-blocker__item' }, [
        el('code', {}, item.dt),
        el('span', { class: `badge badge--${partitionTone(item.status)}` }, item.status),
        el('span', {}, item.detail),
      ]))) : null,
    blockers.length > 12 ? el('p', { class: 'muted' }, `Mostrando 12 de ${blockers.length} bloqueios.`) : null,
    el('div', { class: 'backtest-data-blocker__actions' }, [
      el('button', {
        class: 'btn btn--primary btn--sm',
        type: 'button',
        onclick: () => {
          saveContext({
            dataset: 'backtest_ticks',
            from: payload.from,
            to: payload.to,
            underlying: payload.underlying,
            interval: payload.interval,
            book_depth: payload.book_depth,
          });
          ctx.navigate('data');
        },
      }, 'Abrir na aba Dados'),
    ]),
  ]);
}

function miniMetric(label, value) {
  return el('div', { class: 'backtest-data-blocker__metric' }, [
    el('span', {}, label),
    el('strong', {}, String(value)),
  ]);
}

function partitionTone(status) {
  if (status === 'valid') return 'ok';
  if (status === 'accepted' || status === 'needs_review' || status === 'stale') return 'warn';
  if (status === 'missing') return 'idle';
  return 'err';
}

function updateDashboard(ctx) {
  const statsPanel = document.getElementById('backtest-stats-panel');
  const tablePanel = document.getElementById('backtests-table-panel');
  
  const selectedOpt = state.strategyOptions.find(opt => opt.value === state.selectedStrategyPick);
  const activeStrategyName = (state.filterBySelectedStrategy && selectedOpt) ? selectedOpt.label.split(' · ')[0] : 'all';

  if (statsPanel) {
    mount(statsPanel, renderStatsCards(activeStrategyName));
  }
  if (tablePanel) {
    mount(tablePanel, renderRunsTablePanel(ctx));
  }
}

function renderStatsCards(strategyNameFilter) {
  const filtered = state.runs.filter(run => {
    if (strategyNameFilter === 'all') return true;
    return strategyName(run) === strategyNameFilter;
  });

  const totalRuns = filtered.length;
  const completedRuns = filtered.filter(r => (r.status || 'completed') === 'completed');
  const profitableRuns = completedRuns.filter(r => Number(r.summary?.totalPnl ?? 0) > 0);
  const winRate = totalRuns > 0 ? Math.round((profitableRuns.length / totalRuns) * 100) : 0;
  
  const totalPnl = completedRuns.reduce((sum, r) => sum + Number(r.summary?.totalPnl ?? 0), 0);
  
  let bestPnl = 0;
  if (completedRuns.length) {
    bestPnl = Math.max(...completedRuns.map(r => Number(r.summary?.totalPnl ?? 0)));
  }

  const titlePrefix = strategyNameFilter === 'all' ? 'Globais (Todos os Runs)' : `Estratégia: ${strategyNameFilter}`;

  return el('section', { class: 'card backtest-stats-section', style: { padding: '16px 20px', marginBottom: '16px' } }, [
    el('h3', { class: 'card__title', style: { fontSize: '11px', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: '12px' } }, `Métricas de Simulação · ${titlePrefix}`),
    el('div', { class: 'grid grid--4' }, [
      statCardMini('Runs Totais', String(totalRuns), 'fa-solid fa-chart-column', 'idle', `${profitableRuns.length} lucrativos`),
      statCardMini('PnL Acumulado', formatPnlMini(totalPnl), 'fa-solid fa-wallet', totalPnl > 0 ? 'ok' : (totalPnl < 0 ? 'err' : 'idle')),
      statCardMini('Win Rate', `${winRate}%`, 'fa-solid fa-bullseye', winRate > 50 ? 'ok' : (winRate > 0 ? 'warn' : 'idle'), 'runs com lucro'),
      statCardMini('Melhor Run', formatPnlMini(bestPnl), 'fa-solid fa-trophy', bestPnl > 0 ? 'ok' : 'idle'),
    ])
  ]);
}

function statCardMini(label, value, iconClass, tone, hint) {
  return el('div', { class: `stat stat--compact stat--${tone}`, style: { padding: '10px 14px', borderRadius: '8px' } }, [
    el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' } }, [
      el('span', { class: 'stat__label', style: { fontSize: '10px', margin: 0 } }, label),
      iconClass ? el('i', { class: iconClass, style: { fontSize: '12px', opacity: 0.8 } }) : null,
    ]),
    el('span', { class: 'stat__value', style: { fontSize: '16px', fontWeight: 'bold' } }, value),
    hint ? el('span', { class: 'stat__hint', style: { fontSize: '10px' } }, hint) : null,
  ]);
}

function formatPnlMini(value) {
  const num = Number(value);
  const formatted = formatPnl(num);
  return num > 0 ? `+${formatted}` : formatted;
}

function renderRunsTablePanel(ctx) {
  const selectedOpt = state.strategyOptions.find(opt => opt.value === state.selectedStrategyPick);
  const activeStrategyName = (state.filterBySelectedStrategy && selectedOpt) ? selectedOpt.label.split(' · ')[0] : 'all';

  const filteredRuns = filterAndSortRuns(state.runs, activeStrategyName);

  const table = el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table table--compact' }, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, 'ID'),
        el('th', {}, 'Estratégia'),
        el('th', {}, 'Versão'),
        el('th', {}, 'Período'),
        el('th', {}, 'Status'),
        el('th', {}, 'Ticks'),
        el('th', {}, 'PnL'),
        el('th', {}, 'Ações'),
      ])),
      el('tbody', {}, filteredRuns.map((run) => {
        const summary = run.summary || {};
        return el('tr', {}, [
          el('td', {}, `#${run.id}`),
          el('td', { style: { fontWeight: '600' } }, strategyName(run)),
          el('td', {}, versionLabel(run)),
          el('td', {}, periodLabel(run)),
          el('td', {}, statusBadge(run.status, run.error)),
          el('td', {}, String(run.ticks ?? 0)),
          el('td', {}, renderPnlBadge(summary.totalPnl ?? 0)),
          el('td', {}, el('button', {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            style: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
            onclick: () => ctx.navigate(`backtests/${run.id}`),
          }, [
            'Detalhes ',
            el('i', { class: 'fa-solid fa-chart-line' })
          ])),
        ]);
      })),
    ])
  ]);

  return el('section', { class: 'card' }, [
    el('div', { class: 'card__header card__header--inline' }, [
      el('div', {}, [
        el('h2', { class: 'card__title' }, 'Histórico de Simulações'),
        el('p', { class: 'muted', style: { fontSize: '11.5px', marginTop: '2px' } }, 'Runs executados no ambiente local.')
      ]),
      el('span', { class: 'badge badge--idle' }, `${filteredRuns.length}/${state.runs.length} runs`),
    ]),
    
    el('div', { class: 'history-filters-row', style: { display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '14px', alignItems: 'center' } }, [
      el('label', { class: 'switch-field', style: { fontSize: '12.5px', minHeight: 'auto', display: 'flex', alignItems: 'center' } }, [
        el('input', { 
          class: 'switch-field__input', 
          type: 'checkbox', 
          id: 'filter-by-selected-strategy',
          checked: state.filterBySelectedStrategy,
          onchange: (e) => {
            state.filterBySelectedStrategy = e.target.checked;
            updateDashboard(ctx);
          }
        }),
        el('span', { class: 'switch-field__slider', style: { transform: 'scale(0.85)' } }),
        el('span', { style: { marginLeft: '4px' } }, 'Filtrar por esta estratégia'),
      ]),
      
      el('div', { style: { flex: 1 } }),

      filterSelectMini('Status', state.historyFilters.status, ['all', 'completed', 'failed_runtime'], (value) => {
        if (value === 'all') return 'Todos';
        if (value === 'completed') return 'Concluídos';
        return 'Falhados';
      }, (e) => {
        state.historyFilters.status = e.target.value;
        updateDashboard(ctx);
      }),

      filterSelectMini('Ordenar', state.historyFilters.sort, ['newest', 'best_pnl', 'worst_pnl'], (value) => {
        if (value === 'best_pnl') return 'Melhor PnL';
        if (value === 'worst_pnl') return 'Pior PnL';
        return 'Mais Recentes';
      }, (e) => {
        state.historyFilters.sort = e.target.value;
        updateDashboard(ctx);
      })
    ]),

    filteredRuns.length ? table : emptyState('Nenhum run encontrado para os critérios de busca.')
  ]);
}

function filterSelectMini(label, selected, values, format, onchange) {
  return el('label', { class: 'field', style: { flexDirection: 'row', alignItems: 'center', gap: '6px', margin: 0, fontSize: '12.5px' } }, [
    el('span', { class: 'muted' }, label),
    el('select', {
      class: 'field__input',
      style: { padding: '4px 24px 4px 8px', height: '26px', fontSize: '12px', width: 'auto' },
      onchange: onchange,
    }, values.map((value) => el('option', { value, selected: value === selected }, format(value)))),
  ]);
}

function filterAndSortRuns(runs, activeStrategyName) {
  const filtered = runs.filter((run) => {
    if (activeStrategyName !== 'all' && strategyName(run) !== activeStrategyName) return false;
    if (state.historyFilters.status !== 'all' && (run.status || 'completed') !== state.historyFilters.status) return false;
    return true;
  });

  return filtered.sort((a, b) => {
    if (state.historyFilters.sort === 'best_pnl') return Number(b.summary?.totalPnl ?? 0) - Number(a.summary?.totalPnl ?? 0);
    if (state.historyFilters.sort === 'worst_pnl') return Number(a.summary?.totalPnl ?? 0) - Number(b.summary?.totalPnl ?? 0);
    return Number(b.id) - Number(a.id);
  });
}

function strategyName(run) {
  return run.strategy_snapshot?.name || run.strategy || '-';
}

function versionLabel(run) {
  return run.strategy_snapshot?.version != null ? `v${run.strategy_snapshot.version}` : (run.strategy_version_id ? `#${run.strategy_version_id}` : '-');
}

function periodLabel(run) {
  return `${run.underlying || '-'} ${run.interval || '-'}`;
}

function statusLabel(status) {
  if (status === 'failed_runtime') return 'Falhou';
  if (status === 'completed') return 'Concluído';
  return status || '-';
}

function statusBadge(status, error = '') {
  const value = status || 'completed';
  const tone = value === 'completed' ? 'ok' : 'err';
  return el('span', { class: `badge badge--${tone}`, title: error || statusLabel(value) }, statusLabel(value));
}

function renderPnlBadge(value) {
  const num = Number(value);
  const formatted = formatPnl(num);
  let toneClass = 'pnl-badge--neutral';
  if (num > 0) toneClass = 'pnl-badge--positive';
  else if (num < 0) toneClass = 'pnl-badge--negative';
  return el('span', { class: `pnl-badge ${toneClass}` }, formatted);
}
