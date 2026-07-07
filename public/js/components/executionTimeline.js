import { el, emptyState } from '../utils/dom.js';
import { formatPnl } from '../utils/format.js';

export function buildExecutionItems(event) {
  const summary = event.summary || {};
  const items = [];
  const orders = event.orders || [];
  const feeCursor = createFeeCursor(summary.fees || {});
  const hasExitOrders = orders.some((order) => order?.type === 'exit');
  for (const order of orders) {
    const isExit = order.type === 'exit';
    let kind = isExit ? 'exit' : 'entry';
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
    const feeInfo = isExit ? feeCursor.nextExit(order) : feeCursor.nextEntry(order);
    const meta = [
      ['Preço', formatPrice(order.avgPrice ?? order.price)],
      ['Qtd', formatQty(order.shares ?? order.filledQty ?? order.qty)],
      ['Notional', formatPnl(order.notional ?? order.cost ?? 0)],
      ['Motivo', order.reason || order.source || '-'],
    ];
    appendFeeMeta(meta, feeInfo, isExit ? 'Taxa saída' : 'Taxa entrada');
    items.push({
      kind,
      ts: order.createdAt || order.ts || order.time,
      title: kind === 'entry' ? `Entrada ${order.side || event.side || ''}` : `Saída ${order.side || event.side || ''}`,
      side: order.side || event.side || summary.positionType || '',
      shares: order.shares ?? order.filledQty ?? order.qty,
      price: order.avgPrice ?? order.price,
      notional: order.notional ?? order.cost ?? 0,
      type: order.type || kind,
      meta,
      fills: order.fills,
      feeInfo,
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
    const feeInfo = feeCursor.nextExit(exit);
    const meta = [
      ['Preço', formatPrice(exit.avgPrice ?? exit.price)],
      ['Qtd', formatQty(exit.shares ?? exit.qty)],
      ['PnL', formatPnl(exit.pnl ?? 0)],
      ['Restante', formatQty(exit.remainingShares ?? '-')],
    ];
    appendFeeMeta(meta, feeInfo, 'Taxa saída');
    items.push({
      kind,
      ts: exit.ts || exit.time,
      title: `Saída ${exit.reason || ''}`,
      side: exit.side || event.side || summary.positionType || '',
      shares: exit.shares ?? exit.qty,
      price: exit.avgPrice ?? exit.price,
      notional: exit.notional ?? exit.proceeds ?? 0,
      type: 'exit',
      meta,
      fills: exit.fills,
      feeInfo,
    });
  }
  for (const order of summary.profitOrders || []) {
    const feeInfo = feeCursor.nextExit({
      ...order,
      side: order.side || event.side || summary.positionType,
      time: order.fillTime || order.time,
      source: order.source || order.reason || 'profit_order',
    });
    const meta = [
      ['Preço', formatPrice(order.price)],
      ['Qtd', formatQty(order.qty ?? order.filledQty)],
      ['Status', order.filled ? 'filled' : '-'],
    ];
    appendFeeMeta(meta, feeInfo, 'Taxa saída');
    items.push({
      kind: 'take_profit',
      ts: order.fillTime || order.time,
      title: 'Parcial / Take Profit',
      side: order.side || event.side || summary.positionType || '',
      shares: order.qty ?? order.filledQty,
      price: order.price,
      notional: order.notional ?? ((Number(order.qty ?? order.filledQty) || 0) * (Number(order.price) || 0)),
      type: 'exit',
      meta,
      feeInfo,
    });
  }
  for (const reversal of summary.reversals || []) {
    const exitFeeInfo = feeCursor.nextExit({
      ...reversal,
      side: reversal.fromSide,
      time: reversal.time,
      source: 'stop_reverse_exit',
      price: reversal.exitPrice,
      qty: reversal.soldQty,
    });
    const entryFeeInfo = feeCursor.nextEntry({
      ...reversal,
      side: reversal.toSide,
      time: reversal.time,
      source: 'stop_reverse',
      price: reversal.avgEntryPrice,
      qty: reversal.entryQty,
      fills: reversal.entryFills,
    });
    const meta = [
      ['Exit', formatPrice(reversal.exitPrice)],
      ['Entrada', formatPrice(reversal.avgEntryPrice)],
      ['Budget', formatPnl(reversal.budget ?? 0)],
      ['Qtd', formatQty(reversal.entryQty)],
    ];
    appendFeeMeta(meta, exitFeeInfo, 'Taxa saída');
    appendFeeMeta(meta, entryFeeInfo, 'Taxa entrada');
    items.push({
      kind: 'reverse',
      ts: reversal.time,
      title: `Reversão ${reversal.fromSide || ''} → ${reversal.toSide || ''}`,
      side: `${reversal.fromSide || ''}→${reversal.toSide || ''}`,
      shares: reversal.entryQty,
      price: reversal.avgEntryPrice,
      notional: reversal.budget ?? 0,
      type: 'reverse',
      meta,
      feeInfo: combineFeeInfo(exitFeeInfo, entryFeeInfo),
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
  const tableRows = items.filter((item) => item.kind !== 'mark');
  if (tableMode && tableRows.length) {
    return el('table', { class: 'studio-drawer__orders-table' }, [
      el('thead', {}, el('tr', {}, ['Operação', 'Lado', 'Shares', 'Preço', 'Valor', 'Tipo', 'Taxa', 'Trades taxados', 'Timestamp'].map((h) => el('th', {}, h)))),
      el('tbody', {}, tableRows.map((item) => el('tr', {}, [
        el('td', {}, item.title || ''),
        el('td', {}, item.side || ''),
        el('td', {}, formatQty(item.shares)),
        el('td', {}, formatPrice(item.price)),
        el('td', {}, formatPnl(item.notional ?? 0)),
        el('td', {}, item.type || item.kind || ''),
        el('td', {}, item.feeInfo?.hasFeeData ? formatFee(item.feeInfo.fee ?? 0) : '-'),
        el('td', {}, item.feeInfo?.hasFeeData ? String(item.feeInfo.tradesCharged ?? 0) : '-'),
        el('td', {}, item.ts ? new Date(item.ts).toLocaleTimeString() : '-'),
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
    detailMetric('Taxas', formatFee(fees.totalFee ?? 0), fees.totalFee > 0 ? 'warn' : ''),
    detailMetric('Taxa entrada', formatFee(fees.entryFee ?? 0)),
    detailMetric('Taxa saída', formatFee(fees.exitFee ?? 0)),
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
    ['Taxa entrada', formatFee(fees.entryFee ?? 0)],
    ['Taxa saída', formatFee(fees.exitFee ?? 0)],
    ['Trades taxados', String(fees.tradesCharged ?? 0)],
  ];
  for (const [key, value] of Object.entries(diagnostics || {})) {
    if (value == null || typeof value === 'object') continue;
    items.push([diagnosticLabel(key), formatDiagnosticValue(key, value)]);
  }
  return el('div', { class: 'event-detail-grid event-detail-grid--diagnostics' }, items.map(([label, value]) => detailMetric(label, value)));
}

export function generateNarratedLogs(event) {
  const logs = [];
  const feeCursor = createFeeCursor(event.summary?.fees || {});
  
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
    const feeInfo = isExit ? feeCursor.nextExit(order) : feeCursor.nextEntry(order);
    logs.push({
      ts: order.createdAt || order.ts || order.time,
      type: isExit ? 'warn' : 'success',
      msg: `Ordem de ${isExit ? 'Saída' : 'Entrada'} (${order.side || ''}): Enviada e preenchida a ${formatPrice(order.price ?? order.avgPrice)} para ${formatQty(order.shares ?? order.qty)} contratos. Valor total (Notional): ${formatPnl(order.notional ?? 0)}.${feeLogSuffix(feeInfo, isExit ? 'Taxa saída' : 'Taxa entrada')}${order.reason ? ` Motivo: ${order.reason}` : ''}`,
    });
  }

  const exits = event.summary?.exits || [];
  const hasExitOrders = orders.some((o) => o?.type === 'exit');
  if (!hasExitOrders) {
    for (const exit of exits) {
      const feeInfo = feeCursor.nextExit(exit);
      logs.push({
        ts: exit.ts || exit.time,
        type: 'warn',
        msg: `Saída executada a ${formatPrice(exit.price ?? exit.avgPrice)} para ${formatQty(exit.shares ?? exit.qty)} contratos. PnL da saída: ${formatPnl(exit.pnl ?? 0)}.${feeLogSuffix(feeInfo, 'Taxa saída')}${exit.reason ? ` Motivo: ${exit.reason}` : ''}`,
      });
    }
  }

  const profitOrders = event.summary?.profitOrders || [];
  for (const profit of profitOrders) {
    const feeInfo = feeCursor.nextExit({
      ...profit,
      side: profit.side || event.side || event.summary?.positionType,
      time: profit.fillTime || profit.time,
      source: profit.source || profit.reason || 'profit_order',
    });
    logs.push({
      ts: profit.fillTime || profit.time,
      type: 'success',
      msg: `Take Profit Parcial atingido a ${formatPrice(profit.price)}. Qtd preenchida: ${formatQty(profit.qty ?? profit.filledQty)}.${feeLogSuffix(feeInfo, 'Taxa saída')}`,
    });
  }

  const reversals = event.summary?.reversals || [];
  for (const rev of reversals) {
    const exitFeeInfo = feeCursor.nextExit({
      ...rev,
      side: rev.fromSide,
      time: rev.time,
      source: 'stop_reverse_exit',
      price: rev.exitPrice,
      qty: rev.soldQty,
    });
    const entryFeeInfo = feeCursor.nextEntry({
      ...rev,
      side: rev.toSide,
      time: rev.time,
      source: 'stop_reverse',
      price: rev.avgEntryPrice,
      qty: rev.entryQty,
      fills: rev.entryFills,
    });
    logs.push({
      ts: rev.time,
      type: 'info',
      msg: `Reversão de posição executada de ${rev.fromSide || ''} para ${rev.toSide || ''}. Preço de saída: ${formatPrice(rev.exitPrice)}. Novo preço médio de entrada: ${formatPrice(rev.avgEntryPrice)}. Qtd revertida: ${formatQty(rev.entryQty)}.${feeLogSuffix(exitFeeInfo, 'Taxa saída')}${feeLogSuffix(entryFeeInfo, 'Taxa entrada')}`,
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
    msg: `Fim do Evento por '${event.reason || 'Concluído'}'. PnL Líquido Final: ${formatPnl(finalPnlVal)}. Taxas Totais: ${formatFee(totalFeesVal)}. Lado vencedor: ${event.summary?.winnerSide || '-'}.`,
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

function createFeeCursor(fees = {}) {
  const hasFeeData = Boolean(
    fees?.applied
    || fees?.model
    || fees?.totalFee != null
    || fees?.entryFee != null
    || fees?.exitFee != null,
  );
  const entries = normalizeFeeDetails(fees.entries);
  const exits = normalizeFeeDetails(fees.exits);
  const usedEntries = new Set();
  const usedExits = new Set();

  return {
    nextEntry(operation) {
      return feeInfoForOperation(operation, entries, usedEntries, fees, hasFeeData);
    },
    nextExit(operation) {
      return feeInfoForOperation(operation, exits, usedExits, fees, hasFeeData);
    },
  };
}

function feeInfoForOperation(operation, details, used, fees, hasFeeData) {
  const matched = takeMatchingFeeDetails(operation, details, used);
  if (matched.length) return summarizeFeeDetails(matched, hasFeeData);
  if (!hasFeeData) return null;
  return estimateOperationFee(operation, fees?.feeRate, hasFeeData);
}

function takeMatchingFeeDetails(operation, details, used) {
  if (!operation || !details.length) return [];
  const matchedIndexes = [];
  for (let index = 0; index < details.length; index += 1) {
    if (used.has(index)) continue;
    if (feeDetailMatchesOperation(details[index], operation)) matchedIndexes.push(index);
  }

  if (!matchedIndexes.length) {
    const unusedIndexes = details.map((_, index) => index).filter((index) => !used.has(index));
    if (unusedIndexes.length === 1 && operationLiquidity(operation) !== 'maker') matchedIndexes.push(unusedIndexes[0]);
  }

  for (const index of matchedIndexes) used.add(index);
  return matchedIndexes.map((index) => details[index]);
}

function feeDetailMatchesOperation(detail, operation) {
  const detailSide = detail?.side;
  const operationSideValue = operationSide(operation);
  if (detailSide && operationSideValue && String(detailSide) !== String(operationSideValue)) return false;

  const detailTime = timestampMs(detail?.time);
  const opTime = timestampMs(operationTimestamp(operation));
  if (detailTime != null && opTime != null && Math.abs(detailTime - opTime) <= 1000) return true;

  const sourceMatches = textMatches(detail?.source || detail?.reason, operation?.source || operation?.reason || operation?.orderRole);
  if (sourceMatches && operationPriceQtyMatches(detail, operation)) return true;
  return operationPriceQtyMatches(detail, operation);
}

function operationPriceQtyMatches(detail, operation) {
  const detailPrice = finiteNumber(detail?.price);
  const detailQty = finiteNumber(detail?.qty ?? detail?.shares);
  if (Array.isArray(operation?.fills) && operation.fills.length) {
    return operation.fills.some((fill) => {
      const fillPrice = finiteNumber(fill?.price);
      const fillQty = finiteNumber(fill?.qty ?? fill?.shares);
      return numbersClose(detailPrice, fillPrice) && numbersClose(detailQty, fillQty);
    });
  }

  const opPrice = finiteNumber(operation?.avgPrice ?? operation?.price ?? operation?.exitPrice ?? operation?.avgEntryPrice);
  const opQty = finiteNumber(operation?.shares ?? operation?.qty ?? operation?.filledQty ?? operation?.soldQty ?? operation?.entryQty);
  const canComparePrice = detailPrice != null && opPrice != null;
  const canCompareQty = detailQty != null && opQty != null;
  if (!canComparePrice && !canCompareQty) return false;
  const priceMatches = !canComparePrice || numbersClose(detailPrice, opPrice);
  const qtyMatches = !canCompareQty || numbersClose(detailQty, opQty);
  return priceMatches && qtyMatches;
}

function summarizeFeeDetails(details, hasFeeData) {
  const fee = details.reduce((sum, detail) => sum + (finiteNumber(detail.fee) ?? 0), 0);
  const notional = details.reduce((sum, detail) => sum + ((finiteNumber(detail.qty) ?? 0) * (finiteNumber(detail.price) ?? 0)), 0);
  return {
    hasFeeData,
    fee: roundFee(fee),
    tradesCharged: details.length,
    notional,
    makerTradesFree: 0,
  };
}

function estimateOperationFee(operation, feeRate, hasFeeData) {
  const rate = finiteNumber(feeRate);
  const liquidity = operationLiquidity(operation);
  const fills = Array.isArray(operation?.fills) && operation.fills.length
    ? operation.fills
    : [{ price: operation?.avgPrice ?? operation?.price ?? operation?.exitPrice, qty: operation?.shares ?? operation?.qty ?? operation?.filledQty ?? operation?.soldQty ?? operation?.entryQty, liquidity }];
  let fee = 0;
  let tradesCharged = 0;
  let makerTradesFree = 0;

  for (const fill of fills) {
    const fillLiquidity = fill?.liquidity ?? liquidity;
    const qty = finiteNumber(fill?.qty ?? fill?.shares);
    const price = finiteNumber(fill?.price ?? operation?.avgPrice ?? operation?.price);
    if (qty == null || qty <= 0 || price == null || price <= 0 || price >= 1) continue;
    if (fillLiquidity === 'maker') {
      makerTradesFree += 1;
      continue;
    }
    if (rate == null || rate <= 0) continue;
    const fillFee = qty * rate * price * (1 - price);
    if (fillFee > 0) {
      fee += fillFee;
      tradesCharged += 1;
    }
  }

  return {
    hasFeeData,
    fee: roundFee(fee),
    tradesCharged,
    makerTradesFree,
  };
}

function normalizeFeeDetails(details) {
  return Array.isArray(details)
    ? details.filter((detail) => detail && typeof detail === 'object')
    : [];
}

function appendFeeMeta(meta, feeInfo, feeLabel) {
  if (!feeInfo?.hasFeeData) return;
  meta.push([feeLabel, formatFee(feeInfo.fee ?? 0)]);
  meta.push(['Trades taxados', String(feeInfo.tradesCharged ?? 0)]);
  if ((feeInfo.makerTradesFree ?? 0) > 0) meta.push(['Maker sem taxa', String(feeInfo.makerTradesFree)]);
}

function feeLogSuffix(feeInfo, feeLabel) {
  if (!feeInfo?.hasFeeData) return '';
  return ` ${feeLabel}: ${formatFee(feeInfo.fee ?? 0)}. Trades taxados: ${feeInfo.tradesCharged ?? 0}.`;
}

function combineFeeInfo(...items) {
  const active = items.filter((item) => item?.hasFeeData);
  if (!active.length) return null;
  return {
    hasFeeData: true,
    fee: roundFee(active.reduce((sum, item) => sum + (finiteNumber(item.fee) ?? 0), 0)),
    tradesCharged: active.reduce((sum, item) => sum + (Number(item.tradesCharged) || 0), 0),
    makerTradesFree: active.reduce((sum, item) => sum + (Number(item.makerTradesFree) || 0), 0),
  };
}

function operationTimestamp(operation) {
  return operation?.createdAt ?? operation?.ts ?? operation?.time ?? operation?.fillTime ?? null;
}

function operationSide(operation) {
  return operation?.side ?? operation?.fromSide ?? operation?.toSide ?? null;
}

function operationLiquidity(operation) {
  return operation?.liquidity ?? (Array.isArray(operation?.fills) ? operation.fills.find((fill) => fill?.liquidity)?.liquidity : null);
}

function textMatches(left, right) {
  if (!left || !right) return false;
  const a = String(left).toLowerCase();
  const b = String(right).toLowerCase();
  return a.includes(b) || b.includes(a);
}

function numbersClose(left, right) {
  if (left == null || right == null) return false;
  return Math.abs(Number(left) - Number(right)) <= 1e-8;
}

function timestampMs(value) {
  if (value == null) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function roundFee(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.round((num + Number.EPSILON) * 100000) / 100000;
}

function timelineItem(item) {
  const icon = {
    entry: el('i', { class: 'fa-solid fa-arrow-up-long', 'aria-hidden': 'true' }),
    exit: el('i', { class: 'fa-solid fa-arrow-down-long', 'aria-hidden': 'true' }),
    stop: el('i', { class: 'fa-solid fa-hand', 'aria-hidden': 'true' }),
    trail_stop: el('i', { class: 'fa-solid fa-hand-holding-dollar', 'aria-hidden': 'true' }),
    take_profit: el('i', { class: 'fa-solid fa-check', 'aria-hidden': 'true' }),
    partial: el('i', { class: 'fa-solid fa-circle-nodes', 'aria-hidden': 'true' }),
    reverse: el('i', { class: 'fa-solid fa-arrows-spin', 'aria-hidden': 'true' }),
    mark: el('i', { class: 'fa-solid fa-circle-info', 'aria-hidden': 'true' })
  }[item.kind] || el('i', { class: 'fa-solid fa-circle', 'aria-hidden': 'true' });

  return el('article', { class: `execution-timeline__item execution-timeline__item--${item.kind}` }, [
    el('div', { class: 'execution-timeline__dot' }, [icon]),
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

function formatFee(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(5) : String(value ?? '-');
}

function formatQty(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(num >= 100 ? 0 : 2) : String(value ?? '-');
}

function formatMetric(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(Math.abs(num) >= 100 ? 1 : 2) : '-';
}

const DIAGNOSTIC_LABELS = {
  lastNoEntryReason: 'Motivo sem entrada',
  lastNoEntryDetail: 'Detalhe sem entrada',
  lastCandidateSide: 'Lado candidato',
  lastCandidateAsk: 'Ask candidato',
  lastCandidateEdge: 'Edge candidato',
  lastCandidateProbability: 'Prob. candidato',
  lastLiquidityRatio: 'Razão liquidez',
  lastDistance: 'Distância',
  lastMinDistance: 'Dist. mínima',
  lastSecsLeft: 'Segs restantes',
  lastElapsed: 'Tempo decorrido',
};

function diagnosticLabel(key) {
  return DIAGNOSTIC_LABELS[key] || labelize(key);
}

function formatDiagnosticValue(key, value) {
  if (value == null) return '-';
  if (typeof value === 'string') return value;
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  const k = String(key).toLowerCase();
  if (k.includes('probability') || k.includes('edge')) return num.toFixed(3);
  if (k.includes('ask') || k.includes('price')) return num.toFixed(3);
  if (k.includes('distance')) return num.toFixed(2);
  if (k.includes('ratio')) return num.toFixed(2);
  if (k.includes('secs') || k.includes('elapsed') || k.includes('remaining')) return `${num.toFixed(1)}s`;
  return formatMetric(num);
}

function labelize(value) {
  return String(value || '')
    .replaceAll('_', ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
