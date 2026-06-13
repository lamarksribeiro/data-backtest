import { el, emptyState } from '../utils/dom.js';
import { formatPnl } from '../utils/format.js';

export function buildExecutionItems(event) {
  const summary = event.summary || {};
  const items = [];
  const orders = event.orders || [];
  const hasExitOrders = orders.some((order) => order?.type === 'exit');
  for (const order of orders) {
    let kind = order.type === 'exit' ? 'exit' : 'entry';
    const reasonText = (order.reason || order.source || '').toLowerCase();
    if (kind === 'exit') {
      if (reasonText.includes('stop loss') || reasonText.includes('stop_loss')) {
        kind = 'stop';
      } else if (reasonText.includes('trail') || reasonText.includes('trailing')) {
        kind = 'trail_stop';
      } else if (reasonText.includes('take profit') || reasonText.includes('take_profit') || reasonText.includes('profit') || reasonText.includes('limit')) {
        kind = 'take_profit';
      }
    }
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
    let kind = 'exit';
    const reasonText = (exit.reason || '').toLowerCase();
    if (reasonText.includes('stop loss') || reasonText.includes('stop_loss') || reasonText.includes('stop')) {
      kind = 'stop';
    } else if (reasonText.includes('trail') || reasonText.includes('trailing')) {
      kind = 'trail_stop';
    } else if (reasonText.includes('take profit') || reasonText.includes('take_profit') || reasonText.includes('profit') || reasonText.includes('limit')) {
      kind = 'take_profit';
    }
    items.push({
      kind,
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
    items.push({
      kind: 'take_profit',
      ts: order.fillTime || order.time,
      title: 'Parcial / Take Profit',
      meta: [['Preço', formatPrice(order.price)], ['Qtd', formatQty(order.qty ?? order.filledQty)], ['Status', order.filled ? 'filled' : '-']],
    });
  }
  for (const reversal of summary.reversals || []) {
    items.push({
      kind: 'reverse',
      ts: reversal.time,
      title: `Reversão ${reversal.fromSide || ''} → ${reversal.toSide || ''}`,
      meta: [['Exit', formatPrice(reversal.exitPrice)], ['Entrada', formatPrice(reversal.avgEntryPrice)], ['Budget', formatPnl(reversal.budget ?? 0)], ['Qtd', formatQty(reversal.entryQty)]],
    });
  }
  for (const mark of event.marks || []) {
    items.push({
      kind: 'mark',
      ts: mark.ts,
      title: mark.name ? `Marca · ${mark.name}` : 'Marca da estratégia',
      meta: Object.entries(mark.data || {}).slice(0, 4).map(([key, value]) => [labelize(key), String(value)]),
    });
  }
  return items.sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0));
}

export function renderExecutionTimeline(event, { tableMode = false } = {}) {
  const items = buildExecutionItems(event);
  if (tableMode && event.orders?.length) {
    return el('table', { class: 'studio-drawer__orders-table' }, [
      el('thead', {}, el('tr', {}, ['Lado', 'Shares', 'Preço', 'Valor', 'Tipo', 'Timestamp'].map((h) => el('th', {}, h)))),
      el('tbody', {}, event.orders.map((o) => el('tr', {}, [
        el('td', {}, o.side || ''),
        el('td', {}, String(o.shares || '')),
        el('td', {}, formatPnl(o.price)),
        el('td', {}, formatPnl(o.notional)),
        el('td', {}, o.type || ''),
        el('td', {}, o.ts ? new Date(o.ts).toLocaleTimeString() : '-'),
      ]))),
    ]);
  }
  return el('div', { class: 'execution-timeline' }, items.length
    ? items.map(timelineItem)
    : [emptyState('Nenhuma ordem ou marca registrada.')]);
}

export function renderEventOverview(event) {
  return el('section', { class: 'card card--compact' }, [
    el('h3', { class: 'card__title' }, 'Resumo'),
    renderEventFeeSummary(event),
  ]);
}

export function renderEventFeeSummary(event) {
  const summary = event.summary || {};
  const fees = summary.fees || {};
  return el('div', { class: 'event-detail-grid' }, [
    detailMetric('PnL líquido', formatPnl(event.final_pnl), Number(event.final_pnl) >= 0 ? 'good' : 'bad'),
    detailMetric('PnL bruto', summary.finalPnlBeforeFees == null ? '—' : formatPnl(summary.finalPnlBeforeFees)),
    detailMetric('Preço entrada', formatContractPrice(summary.avgEntryPrice)),
    detailMetric('Contratos', summary.quantity == null ? '—' : String(summary.quantity)),
    detailMetric('Custo', summary.cost == null ? '—' : formatPnl(summary.cost)),
    detailMetric('PTB inicial', formatUsd(summary.priceToBeat)),
    detailMetric('Dist. PTB entrada', summary.entryDistanceToPtb == null ? '—' : formatUsd(summary.entryDistanceToPtb)),
    detailMetric('Tempo restante', summary.entryTimeRemaining == null ? '—' : `${Math.round(summary.entryTimeRemaining)}s`),
    detailMetric('Taxas', formatPnl(fees.totalFee ?? 0), fees.totalFee > 0 ? 'warn' : ''),
    detailMetric('Taxa entrada', formatPnl(fees.entryFee ?? 0)),
    detailMetric('Taxa saída', formatPnl(fees.exitFee ?? 0)),
    detailMetric('Trades taxados', String(fees.tradesCharged ?? 0)),
    detailMetric('Lado', event.side || summary.positionType || '—'),
    detailMetric('Motivo final', event.reason || '—'),
  ]);
}

export function renderDiagnosticsPanel(event) {
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
  return el('div', { class: 'event-detail-grid' }, items.map(([label, value]) => detailMetric(label, value)));
}

export function generateNarratedLogs(event) {
  const logs = [];
  
  if (event.event_start) {
    logs.push({
      ts: event.event_start,
      type: 'info',
      msg: `Início do Evento detectado. PTB (Preço Limite) inicial: ${formatUsd(event.summary?.priceToBeat) !== '—' ? formatUsd(event.summary?.priceToBeat) : formatContractPrice(event.summary?.avgEntryPrice)}`,
    });
  }

  const orders = event.orders || [];
  for (const order of orders) {
    const isExit = order.type === 'exit';
    logs.push({
      ts: order.createdAt || order.ts || order.time,
      type: isExit ? 'warn' : 'success',
      msg: `Ordem de ${isExit ? 'Saída' : 'Entrada'} (${order.side || ''}): Enviada e preenchida a ${formatPrice(order.price ?? order.avgPrice)} para ${formatQty(order.shares ?? order.qty)} contratos. Valor total (Notional): ${formatPnl(order.notional ?? 0)}.${order.reason ? ` Motivo: ${order.reason}` : ''}`,
    });
  }

  const exits = event.summary?.exits || [];
  const hasExitOrders = orders.some((o) => o?.type === 'exit');
  if (!hasExitOrders) {
    for (const exit of exits) {
      logs.push({
        ts: exit.ts || exit.time,
        type: 'warn',
        msg: `Saída executada a ${formatPrice(exit.price ?? exit.avgPrice)} para ${formatQty(exit.shares ?? exit.qty)} contratos. PnL da saída: ${formatPnl(exit.pnl ?? 0)}.${exit.reason ? ` Motivo: ${exit.reason}` : ''}`,
      });
    }
  }

  const profitOrders = event.summary?.profitOrders || [];
  for (const profit of profitOrders) {
    logs.push({
      ts: profit.fillTime || profit.time,
      type: 'success',
      msg: `Take Profit Parcial atingido a ${formatPrice(profit.price)}. Qtd preenchida: ${formatQty(profit.qty ?? profit.filledQty)}.`,
    });
  }

  const reversals = event.summary?.reversals || [];
  for (const rev of reversals) {
    logs.push({
      ts: rev.time,
      type: 'info',
      msg: `Reversão de posição executada de ${rev.fromSide || ''} para ${rev.toSide || ''}. Preço de saída: ${formatPrice(rev.exitPrice)}. Novo preço médio de entrada: ${formatPrice(rev.avgEntryPrice)}. Qtd revertida: ${formatQty(rev.entryQty)}.`,
    });
  }

  const marks = event.marks || [];
  for (const mark of marks) {
    let detailStr = '';
    if (mark.data && typeof mark.data === 'object') {
      detailStr = Object.entries(mark.data).map(([k, v]) => `${labelize(k)}: ${v}`).join(', ');
    }
    logs.push({
      ts: mark.ts,
      type: 'info',
      msg: `Marca registrada [${mark.name || 'Mark'}]: ${detailStr || 'sem dados adicionais'}.`,
    });
  }

  const rawLogs = event.logs || [];
  for (const logEntry of rawLogs) {
    const msg = logEntry.msg || logEntry.message || '';
    if (msg) {
      logs.push({
        ts: logEntry.ts,
        type: logEntry.type || 'info',
        msg: `[Estratégia] ${msg}`,
      });
    }
  }

  logs.sort((a, b) => new Date(a.ts) - new Date(b.ts));

  const finalPnlVal = Number(event.final_pnl ?? 0);
  const totalFeesVal = Number(event.summary?.fees?.totalFee ?? 0);
  logs.push({
    ts: event.summary?.closedAt || event.event_end,
    type: finalPnlVal > 0 ? 'success' : finalPnlVal < 0 ? 'error' : 'info',
    msg: `Fim do Evento por '${event.reason || 'Concluído'}'. PnL Líquido Final: ${formatPnl(finalPnlVal)}. Taxas Totais: ${formatPnl(totalFeesVal)}. Lado vencedor: ${event.summary?.winnerSide || '-'}.`,
  });

  return logs;
}

export function renderLogList(logs, event = null) {
  const unifiedLogs = event ? generateNarratedLogs(event) : logs;
  if (!unifiedLogs?.length) return el('p', { class: 'muted' }, 'Nenhum log neste evento.');
  return el('ul', { class: 'log-list' }, unifiedLogs.map((entry) => el('li', {}, [
    el('span', { class: 'log-ts' }, formatLogTs(entry.ts)),
    el('span', { class: `log-type log-type--${entry.type || 'info'}` }, entry.type || 'info'),
    el('span', { class: 'log-msg' }, entry.msg || entry.message || ''),
  ])));
}

function timelineItem(item) {
  const icon = {
    entry: '▲',
    exit: '▼',
    stop: '✖',
    trail_stop: '✖',
    take_profit: '✔',
    partial: '◆',
    reverse: '↻',
    mark: 'ℹ'
  }[item.kind] || '●';
  return el('article', { class: `execution-timeline__item execution-timeline__item--${item.kind}` }, [
    el('div', { class: 'execution-timeline__dot' }, icon),
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
  return el('div', { class: 'fills-strip' }, fills.slice(0, 8).map((fill) =>
    el('span', { class: 'fills-strip__item' }, `${formatQty(fill.qty)} @ ${formatPrice(fill.price)}`)));
}

function detailMetric(label, value, tone = '') {
  let valueCls = 'metric-item__value';
  if (tone === 'good') valueCls += ' metric-item__value--good';
  if (tone === 'bad') valueCls += ' metric-item__value--bad';
  if (tone === 'warn') valueCls += ' metric-item__value--warn';
  return el('div', { class: 'metric-item' }, [
    el('span', { class: 'metric-item__label' }, label),
    el('span', { class: valueCls }, String(value ?? '-')),
  ]);
}

function formatLogTs(ts) {
  if (!ts) return '-';
  return new Date(ts).toISOString().slice(11, 19);
}

function formatUsd(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  if (Math.abs(num) >= 1000) return `$${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return `$${num.toFixed(2)}`;
}

function formatContractPrice(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(3) : '—';
}

function formatPrice(value) {
  return formatContractPrice(value);
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
  return String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
