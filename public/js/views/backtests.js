import { el, mount, emptyState } from '../utils/dom.js';
import { fieldLabelWithHelp } from '../utils/fieldHelp.js';
import { loadContext, saveContext } from '../utils/context.js';
import { escapeHtml, formatPnl } from '../utils/format.js';
import { loadStrategyOptions, renderStrategySelect, backtestPayloadFromPick } from '../utils/strategyPicker.js';

const historyState = {
  strategy: 'all',
  version: 'all',
  period: 'all',
  status: 'all',
  pnl: 'all',
  sort: 'newest',
};

export async function renderBacktests(ctx) {
  ctx.setBreadcrumb('backtests', null);
  ctx.renderContextBar?.();

  const formCtx = loadContext();
  const strategyOptions = await loadStrategyOptions(ctx.api);
  const defaultPick = strategyOptions[0]?.value || '';

  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, 'Backtests'),
        el('p', { class: 'page-header__sub' }, 'Execute e acompanhe runs de estratégias versionadas.'),
      ]),
    ]),
    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, 'Executar backtest'),
      el('form', { id: 'backtest-form', class: 'form-grid form-grid--compact' }, [
        el('label', { class: 'field' }, [
          el('span', { class: 'field__label' }, 'Estratégia'),
          el('div', { id: 'strategy-pick-wrap' }),
        ]),
        el('label', { class: 'field' }, [
          fieldLabelWithHelp(
            'Batch size',
            'Tamanho do lote de ticks lidos por vez. Afeta performance/memória, não a lógica da estratégia.',
          ),
          el('input', { class: 'field__input', type: 'number', name: 'batch_size', min: '1', value: formCtx.batch_size }),
        ]),
        el('div', { class: 'form-actions' }, [
          el('button', { class: 'btn btn--primary', type: 'submit', disabled: !strategyOptions.length }, 'Executar'),
        ]),
      ]),
      strategyOptions.length ? null : el('p', { class: 'muted' }, 'Crie e salve uma versão de estratégia antes de executar backtests.'),
      el('div', { id: 'backtest-run-result' }),
    ]),
    el('div', { id: 'backtests-table' }),
  ]);

  document.getElementById('strategy-pick-wrap').innerHTML = renderStrategySelect(strategyOptions, defaultPick);

  document.getElementById('backtest-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const fd = new FormData(event.target);
    const ctxSaved = saveContext({ batch_size: fd.get('batch_size') });
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
      mount(resultPanel, el('p', { class: 'bad' }, res.error?.message || 'Falha ao executar'));
      if (res.data?.availability) {
        ctx.toast.warn('Dados não prontos — verifique a aba Dados');
      }
      return;
    }
    const summary = res.data.result?.summary || {};
    ctx.toast.ok(`Backtest #${res.data.run.id} concluído · PnL ${formatPnl(summary.totalPnl ?? 0)}`);
    mount(resultPanel, el('div', { class: 'row row--wrap' }, [
      el('span', { class: 'badge badge--ok' }, `Run #${res.data.run.id}`),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onclick: () => ctx.navigate(`backtests/${res.data.run.id}`),
      }, 'Ver detalhes'),
    ]));
    await loadRunsTable(ctx);
  });

  await loadRunsTable(ctx);
}

async function loadRunsTable(ctx) {
  const panel = document.getElementById('backtests-table');
  const res = await ctx.api.get('/api/backtest/runs?limit=50');
  if (!res.ok) {
    mount(panel, el('p', { class: 'bad' }, res.error?.message || 'Falha'));
    return;
  }
  const runs = res.data.runs || [];
  if (!runs.length) {
    mount(panel, emptyState('Nenhum backtest executado ainda.'));
    return;
  }

  const filteredRuns = filterAndSortRuns(runs);

  const table = el('table', { class: 'table' }, [
    el('thead', {}, el('tr', {}, [
      el('th', {}, 'ID'), el('th', {}, 'Estratégia'), el('th', {}, 'Versão'), el('th', {}, 'Período'), el('th', {}, 'Status'),
      el('th', {}, 'Ticks'), el('th', {}, 'PnL'), el('th', {}, ''),
    ])),
    el('tbody', {}, filteredRuns.map((run) => {
      const summary = run.summary || {};
      return el('tr', {}, [
        el('td', {}, `#${run.id}`),
        el('td', {}, strategyName(run)),
        el('td', {}, versionLabel(run)),
        el('td', {}, periodLabel(run)),
        el('td', {}, statusBadge(run.status)),
        el('td', {}, String(run.ticks ?? 0)),
        el('td', {}, renderPnlBadge(summary.totalPnl ?? 0)),
        el('td', {}, el('button', {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          onclick: () => ctx.navigate(`backtests/${run.id}`),
        }, 'Abrir')),
      ]);
    })),
  ]);
  mount(panel, el('section', { class: 'card' }, [
    el('div', { class: 'card__header card__header--inline' }, [
      el('h2', { class: 'card__title' }, 'Histórico'),
      el('span', { class: 'muted' }, `${filteredRuns.length}/${runs.length} runs`),
    ]),
    renderRunFilters(runs, ctx),
    filteredRuns.length ? table : emptyState('Nenhum run encontrado com os filtros atuais.'),
  ]));
}

function renderRunFilters(runs, ctx) {
  const strategies = [...new Set(runs.map(strategyName).filter(Boolean))].sort();
  const versions = [...new Set(runs.map(versionLabel).filter((value) => value !== '-'))].sort(sortVersionLabel);
  const periods = [...new Set(runs.map(periodLabel).filter(Boolean))].sort();
  const statuses = [...new Set(runs.map((run) => run.status || 'completed'))].sort();
  return el('div', { class: 'history-filters' }, [
    filterSelect('Estratégia', 'strategy', historyState.strategy, ['all', ...strategies], (value) => value === 'all' ? 'Todas' : value, ctx),
    filterSelect('Versão', 'version', historyState.version, ['all', ...versions], (value) => value === 'all' ? 'Todas' : value, ctx),
    filterSelect('Período', 'period', historyState.period, ['all', ...periods], (value) => value === 'all' ? 'Todos' : value, ctx),
    filterSelect('Status', 'status', historyState.status, ['all', ...statuses], (value) => value === 'all' ? 'Todos' : statusLabel(value), ctx),
    filterSelect('PnL', 'pnl', historyState.pnl, ['all', 'positive', 'negative', 'zero'], pnlFilterLabel, ctx),
    filterSelect('Ordenar', 'sort', historyState.sort, ['newest', 'best_pnl', 'worst_pnl'], sortFilterLabel, ctx),
  ]);
}

function filterSelect(label, key, selected, values, format, ctx) {
  return el('label', { class: 'field history-filter' }, [
    el('span', { class: 'field__label' }, label),
    el('select', {
      class: 'field__input',
      value: selected,
      onchange: async (event) => {
        historyState[key] = event.target.value;
        await loadRunsTable(ctx);
      },
    }, values.map((value) => el('option', { value, selected: value === selected }, format(value)))),
  ]);
}

function filterAndSortRuns(runs) {
  const filtered = runs.filter((run) => {
    if (historyState.strategy !== 'all' && strategyName(run) !== historyState.strategy) return false;
    if (historyState.version !== 'all' && versionLabel(run) !== historyState.version) return false;
    if (historyState.period !== 'all' && periodLabel(run) !== historyState.period) return false;
    if (historyState.status !== 'all' && (run.status || 'completed') !== historyState.status) return false;
    const pnl = Number(run.summary?.totalPnl ?? 0);
    if (historyState.pnl === 'positive' && !(pnl > 0)) return false;
    if (historyState.pnl === 'negative' && !(pnl < 0)) return false;
    if (historyState.pnl === 'zero' && pnl !== 0) return false;
    return true;
  });
  return filtered.sort((a, b) => {
    if (historyState.sort === 'best_pnl') return Number(b.summary?.totalPnl ?? 0) - Number(a.summary?.totalPnl ?? 0);
    if (historyState.sort === 'worst_pnl') return Number(a.summary?.totalPnl ?? 0) - Number(b.summary?.totalPnl ?? 0);
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

function statusBadge(status) {
  const value = status || 'completed';
  const tone = value === 'completed' ? 'ok' : 'err';
  return el('span', { class: `badge badge--${tone}` }, statusLabel(value));
}

function sortVersionLabel(a, b) {
  return Number(String(a).replace(/\D/g, '')) - Number(String(b).replace(/\D/g, ''));
}

function pnlFilterLabel(value) {
  if (value === 'positive') return 'Positivo';
  if (value === 'negative') return 'Negativo';
  if (value === 'zero') return 'Zero';
  return 'Todos';
}

function sortFilterLabel(value) {
  if (value === 'best_pnl') return 'Melhor PnL';
  if (value === 'worst_pnl') return 'Pior PnL';
  return 'Mais recentes';
}

function renderPnlBadge(value) {
  const num = Number(value);
  const formatted = formatPnl(num);
  let toneClass = 'pnl-badge--neutral';
  if (num > 0) toneClass = 'pnl-badge--positive';
  else if (num < 0) toneClass = 'pnl-badge--negative';
  return el('span', { class: `pnl-badge ${toneClass}` }, formatted);
}
