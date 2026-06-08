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
    eventOverview(event),
    executionTimeline(event),
    diagnosticsPanel(event),
    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title' }, 'Logs'),
      renderLogList(event.logs || []),
    ]),
  ]);

  if (chartData?.series) {
    renderEventChart(document.getElementById('event-chart'), chartData);
  }
}

function eventOverview(event) {
  const summary = event.summary || {};
  const fees = summary.fees || {};
  return el('section', { class: 'card' }, [
    el('h2', { class: 'card__title' }, 'Resumo da execução'),
    el('div', { class: 'event-detail-grid' }, [
      detailMetric('PnL líquido', formatPnl(event.final_pnl), Number(event.final_pnl) >= 0 ? 'good' : 'bad'),
      detailMetric('PnL bruto', summary.finalPnlBeforeFees == null ? '-' : formatPnl(summary.finalPnlBeforeFees), Number(summary.finalPnlBeforeFees ?? 0) >= 0 ? 'good' : 'bad'),
      detailMetric('Taxas', formatPnl(fees.totalFee ?? 0), fees.totalFee > 0 ? 'warn' : ''),
      detailMetric('Lado', event.side || summary.positionType || '-'),
      detailMetric('Quantidade', formatQty(summary.quantity ?? 0)),
      detailMetric('Custo', formatPnl(summary.cost ?? 0)),
      detailMetric('Preço médio', formatPrice(summary.avgEntryPrice)),
      detailMetric('Motivo final', event.reason || '-'),
    ]),
  ]);
}

function executionTimeline(event) {
  const items = buildExecutionItems(event);
  return el('section', { class: 'card' }, [
    el('h2', { class: 'card__title' }, 'Linha do tempo'),
    items.length ? el('div', { class: 'execution-timeline' }, items.map(timelineItem)) : emptyState('Nenhuma ordem ou marca registrada para este evento.'),
  ]);
}

function diagnosticsPanel(event) {
  const summary = event.summary || {};
  const diagnostics = summary.diagnostics || {};
  const fees = summary.fees || {};
  const items = [
    ['Distância entrada', formatMetric(summary.entryDistanceToPtb)],
    ['Tempo restante entrada', summary.entryTimeRemaining == null ? '-' : `${formatMetric(summary.entryTimeRemaining)}s`],
    ['Resultado expiração', summary.expirationResult || '-'],
    ['Winner side', summary.winnerSide || '-'],
    ['PnL expiração', formatPnl(summary.expiryPnl ?? 0)],
    ['Taxa entrada', formatPnl(fees.entryFee ?? 0)],
    ['Taxa saída', formatPnl(fees.exitFee ?? 0)],
    ['Trades taxados', String(fees.tradesCharged ?? 0)],
  ];
  for (const [key, value] of Object.entries(diagnostics || {})) {
    if (value == null || typeof value === 'object') continue;
    items.push([labelize(key), String(value)]);
  }
  return el('section', { class: 'card' }, [
    el('h2', { class: 'card__title' }, 'Diagnóstico'),
    el('div', { class: 'event-detail-grid' }, items.map(([label, value]) => detailMetric(label, value))),
  ]);
}

function buildExecutionItems(event) {
  const summary = event.summary || {};
  const items = [];
  const orders = event.orders || [];
  const hasExitOrders = orders.some((order) => order?.type === 'exit');
  for (const order of orders) {
    const kind = order.type === 'exit' ? 'exit' : 'entry';
    items.push({
      kind,
      ts: order.createdAt || order.ts || order.time,
      title: kind === 'entry' ? `Entrada ${order.side || event.side || ''}` : `Saída ${order.side || event.side || ''}`,
      meta: [
        ['Preço', formatPrice(order.avgPrice ?? order.price)],
        ['Qtd', formatQty(order.shares ?? order.filledQty ?? order.qty)],
        ['Notional', formatPnl(order.notional ?? order.cost ?? 0)],
        ['Motivo', order.reason || order.source || '-'],
      ],
      fills: order.fills,
    });
  }
  for (const exit of hasExitOrders ? [] : (summary.exits || [])) {
    items.push({
      kind: 'exit',
      ts: exit.ts || exit.time,
      title: `Saída ${exit.reason || ''}`,
      meta: [
        ['Preço', formatPrice(exit.avgPrice ?? exit.price)],
        ['Qtd', formatQty(exit.shares ?? exit.qty)],
        ['PnL', formatPnl(exit.pnl ?? 0)],
        ['Restante', formatQty(exit.remainingShares ?? '-')],
      ],
      fills: exit.fills,
    });
  }
  for (const order of summary.profitOrders || []) {
    items.push({ kind: 'partial', ts: order.fillTime || order.time, title: 'Parcial / take profit', meta: [['Preço', formatPrice(order.price)], ['Qtd', formatQty(order.qty ?? order.filledQty)], ['Status', order.filled ? 'filled' : '-']] });
  }
  for (const reversal of summary.reversals || []) {
    items.push({ kind: 'reverse', ts: reversal.time, title: `Reversão ${reversal.fromSide || ''} → ${reversal.toSide || ''}`, meta: [['Exit', formatPrice(reversal.exitPrice)], ['Entrada', formatPrice(reversal.avgEntryPrice)], ['Budget', formatPnl(reversal.budget ?? 0)], ['Qtd', formatQty(reversal.entryQty)]] });
  }
  for (const mark of event.marks || []) {
    items.push({ kind: 'mark', ts: mark.ts, title: mark.name || 'Mark', meta: Object.entries(mark.data || {}).slice(0, 4).map(([key, value]) => [labelize(key), String(value)]) });
  }
  return items.sort((left, right) => new Date(left.ts || 0) - new Date(right.ts || 0));
}

function timelineItem(item) {
  return el('article', { class: `execution-timeline__item execution-timeline__item--${item.kind}` }, [
    el('div', { class: 'execution-timeline__dot' }),
    el('div', { class: 'execution-timeline__body' }, [
      el('div', { class: 'execution-timeline__head' }, [
        el('strong', {}, item.title),
        el('span', { class: 'mono muted' }, formatLogTs(item.ts)),
      ]),
      el('div', { class: 'execution-timeline__meta' }, (item.meta || []).map(([label, value]) => detailMetric(label, value))),
      renderFills(item.fills),
    ]),
  ]);
}

function renderFills(fills) {
  if (!Array.isArray(fills) || !fills.length) return null;
  return el('div', { class: 'fills-strip' }, fills.slice(0, 8).map((fill) => el('span', { class: 'fills-strip__item' }, `${formatQty(fill.qty)} @ ${formatPrice(fill.price)}`)));
}

function detailMetric(label, value, tone = '') {
  let cls = 'metric-item';
  let valueCls = 'metric-item__value';
  if (tone === 'good') valueCls += ' metric-item__value--good';
  if (tone === 'bad') valueCls += ' metric-item__value--bad';
  if (tone === 'warn') valueCls += ' metric-item__value--warn';
  return el('div', { class: cls }, [
    el('span', { class: 'metric-item__label' }, label),
    el('span', { class: valueCls }, String(value ?? '-')),
  ]);
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

function formatPrice(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(3) : '-';
}

function formatQty(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(num >= 100 ? 0 : 2) : String(value ?? '-');
}

function formatMetric(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(Math.abs(num) >= 100 ? 1 : 2) : '-';
}

function labelize(value) {
  return String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}
