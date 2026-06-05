import { el, mount, emptyState } from '../utils/dom.js';
import { loadContext, saveContext } from '../utils/context.js';
import { escapeHtml, formatPnl } from '../utils/format.js';
import { loadStrategyOptions, renderStrategySelect, backtestPayloadFromPick } from '../utils/strategyPicker.js';

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
          el('span', { class: 'field__label' }, 'Batch size'),
          el('input', { class: 'field__input', type: 'number', name: 'batch_size', min: '1', value: formCtx.batch_size }),
        ]),
        el('label', { class: 'field field--wide' }, [
          el('span', { class: 'field__label' }, 'Params JSON'),
          el('textarea', { class: 'field__input', name: 'params', rows: '2', placeholder: '{"minDistanceAbs":40}' }),
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
    let params = {};
    const rawParams = String(fd.get('params') || '').trim();
    if (rawParams) {
      try { params = JSON.parse(rawParams); } catch { ctx.toast.err('Params JSON inválido'); return; }
    }
    const payload = backtestPayloadFromPick(String(pick), ctxSaved, { params });
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

  const table = el('table', { class: 'table' }, [
    el('thead', {}, el('tr', {}, [
      el('th', {}, 'ID'), el('th', {}, 'Estratégia'), el('th', {}, 'Período'),
      el('th', {}, 'Ticks'), el('th', {}, 'PnL'), el('th', {}, ''),
    ])),
    el('tbody', {}, runs.map((run) => {
      const summary = run.summary || {};
      return el('tr', {}, [
        el('td', {}, `#${run.id}`),
        el('td', {}, el('code', {}, run.strategy)),
        el('td', {}, `${run.underlying} ${run.interval}`),
        el('td', {}, String(run.ticks ?? 0)),
        el('td', {}, formatPnl(summary.totalPnl ?? 0)),
        el('td', {}, el('button', {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          onclick: () => ctx.navigate(`backtests/${run.id}`),
        }, 'Abrir')),
      ]);
    })),
  ]);
  mount(panel, el('section', { class: 'card' }, [
    el('h2', { class: 'card__title' }, 'Histórico'),
    table,
  ]));
}
