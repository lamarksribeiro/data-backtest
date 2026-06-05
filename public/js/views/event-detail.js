import { el, mount, emptyState } from '../utils/dom.js';
import { escapeHtml, formatPnl, shortId, resultBadgeClass } from '../utils/format.js';
import { destroyActiveChart, renderEventChart } from '../utils/chart.js';

export async function renderEventDetail(ctx, params) {
  const runId = Number(params.id);
  const eventId = Number(params.eventId);
  ctx.setBreadcrumb('backtests', `Evento ${shortId(eventId)}`);
  destroyActiveChart();

  mount(ctx.contentEl, el('p', { class: 'muted' }, 'Carregando evento...'));

  const detailRes = await ctx.api.get(`/api/backtest/runs/${runId}/events/${eventId}`);
  if (!detailRes.ok) {
    mount(ctx.contentEl, el('section', { class: 'card card--error' }, el('p', {}, detailRes.error?.message || 'Evento não encontrado')));
    return;
  }

  const event = detailRes.data.event;
  const conditionId = event.condition_id;
  let chartData = null;
  if (conditionId) {
    const chartRes = await ctx.api.get(`/api/backtest/runs/${runId}/chart-data?condition_id=${encodeURIComponent(conditionId)}`);
    chartData = chartRes.ok ? chartRes.data : null;
  }

  mount(ctx.contentEl, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {}, shortId(conditionId)),
        el('p', { class: 'page-header__sub' }, `Run #${runId} · explorador de evento`),
      ]),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onclick: () => ctx.navigate(`backtests/${runId}`),
      }, '← Voltar ao run'),
    ]),
    el('div', { class: 'row row--wrap' }, [
      el('span', { class: `badge ${resultBadgeClass(event.result)}` }, event.result || 'n/a'),
      el('span', { class: 'badge badge--idle' }, `PnL ${formatPnl(event.final_pnl)}`),
      el('span', { class: 'badge badge--idle' }, `${event.entries_count ?? 0} entradas`),
      el('span', { class: 'badge badge--idle' }, `${event.exits_count ?? 0} saídas`),
    ]),
    el('section', { class: 'card chart-card' }, [
      el('h2', { class: 'card__title' }, 'BTC vs PTB e odds'),
      chartData?.series
        ? el('div', { class: 'chart-wrap' }, el('canvas', { id: 'event-chart' }))
        : emptyState('Sem serie de grafico para este evento. Verifique se o periodo do run ainda existe no lakehouse.'),
    ]),
    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, 'Ordens & marks'),
      el('pre', { class: 'code-block' }, escapeHtml(JSON.stringify({ orders: event.orders || [], marks: event.marks || [] }, null, 2))),
    ]),
    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, 'Logs'),
      renderLogList(event.logs || []),
    ]),
    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, 'Summary'),
      el('pre', { class: 'code-block' }, escapeHtml(JSON.stringify(event.summary || {}, null, 2))),
    ]),
  ]);

  if (chartData?.series) {
    renderEventChart(document.getElementById('event-chart'), chartData);
  }
}

function renderLogList(logs) {
  if (!logs.length) return el('p', { class: 'muted' }, 'Nenhum log neste evento.');
  return el('ul', { class: 'log-list' }, logs.map((entry) => el('li', {}, [
    el('span', { class: 'log-ts' }, formatLogTs(entry.ts)),
    el('span', { class: `log-type log-type--${entry.type || 'info'}` }, entry.type || 'info'),
    escapeHtml(entry.msg || entry.message || ''),
  ])));
}

function formatLogTs(ts) {
  if (!ts) return '-';
  return new Date(ts).toISOString().slice(11, 19);
}
