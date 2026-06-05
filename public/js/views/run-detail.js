import { el, mount, emptyState } from '../utils/dom.js';
import { escapeHtml, formatPnl, shortId, resultBadgeClass } from '../utils/format.js';

export async function renderRunDetail(ctx, params) {
  const runId = Number(params.id);
  ctx.setBreadcrumb('backtests', `Run #${runId}`);

  mount(ctx.contentEl, el('p', { class: 'muted' }, 'Carregando run...'));

  const [runRes, eventsRes] = await Promise.all([
    ctx.api.get(`/api/backtest/runs/${runId}`),
    ctx.api.get(`/api/backtest/runs/${runId}/events?limit=200`),
  ]);

  if (!runRes.ok) {
    mount(ctx.contentEl, el('section', { class: 'card card--error' }, el('p', {}, runRes.error?.message || 'Run não encontrado')));
    return;
  }

  const run = runRes.data.run;
  const events = eventsRes.ok ? eventsRes.data.events || [] : [];
  const summary = run.summary || {};
  const paramsObj = run.params || {};

  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, `Run #${run.id}`),
        el('p', { class: 'page-header__sub' }, `${run.strategy} · ${run.underlying} ${run.interval} · ${run.from} → ${run.to}`),
      ]),
    ]),
    el('div', { class: 'grid grid--4' }, [
      stat('Ticks', run.ticks),
      stat('Eventos', summary.totalEvents ?? 0),
      stat('Wins', summary.totalWins ?? summary.wins ?? 0),
      stat('PnL', formatPnl(summary.totalPnl ?? 0)),
    ]),
    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, 'Parâmetros'),
      Object.keys(paramsObj).length
        ? el('pre', { class: 'code-block' }, escapeHtml(JSON.stringify(paramsObj, null, 2)))
        : el('p', { class: 'muted' }, 'Parâmetros padrão.'),
      run.strategy_snapshot ? el('details', { class: 'details-block' }, [
        el('summary', {}, 'Strategy snapshot'),
        el('pre', { class: 'code-block' }, escapeHtml(JSON.stringify(run.strategy_snapshot, null, 2))),
      ]) : null,
    ]),
    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, `Eventos (${events.length})`),
      events.length ? eventTable(ctx, runId, events) : emptyState('Nenhum evento neste run.'),
    ]),
  ]);
}

function stat(label, value) {
  return el('div', { class: 'stat stat--compact' }, [
    el('span', { class: 'stat__label' }, label),
    el('span', { class: 'stat__value' }, String(value)),
  ]);
}

function eventTable(ctx, runId, events) {
  return el('table', { class: 'table' }, [
    el('thead', {}, el('tr', {}, [
      el('th', {}, 'Condition'), el('th', {}, 'Resultado'), el('th', {}, 'PnL'),
      el('th', {}, 'Entradas'), el('th', {}, 'Saídas'), el('th', {}, 'Motivo'),
    ])),
    el('tbody', {}, events.map((event) => el('tr', {}, [
      el('td', {}, el('button', {
        class: 'btn btn--link',
        type: 'button',
        onclick: () => ctx.navigate(`backtests/${runId}/events/${event.id}`),
      }, el('code', {}, shortId(event.condition_id)))),
      el('td', {}, el('span', { class: `badge ${resultBadgeClass(event.result)}` }, event.result || 'n/a')),
      el('td', {}, formatPnl(event.final_pnl)),
      el('td', {}, String(event.entries_count)),
      el('td', {}, String(event.exits_count)),
      el('td', {}, escapeHtml(event.reason || '-')),
    ]))),
  ]);
}
