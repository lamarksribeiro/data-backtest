import { renderUplotLine } from '../utils/uplotChart.js';

const MARKER_STYLES = {
  entry: { color: '#22c55e', symbol: '▲', label: 'Entrada' },
  exit: { color: '#fb7185', symbol: '▼', label: 'Saída' },
  partial: { color: '#fbbf24', symbol: '◆', label: 'Parcial' },
  reverse: { color: '#a78bfa', symbol: '↻', label: 'Reversão' },
  mark: { color: '#94a3b8', symbol: '●', label: 'Mark' },
};

export function buildUplotMarkers(chartData, underlyingSeries = []) {
  const markers = [];
  const indexByTs = new Map(underlyingSeries.map((point, index) => [new Date(point.ts).getTime(), index]));

  const push = (ts, kind, price = null, detail = '') => {
    const index = indexByTs.get(new Date(ts).getTime());
    if (index == null) return;
    const style = MARKER_STYLES[kind] || MARKER_STYLES.mark;
    markers.push({
      index,
      ts: new Date(ts).getTime(),
      kind,
      price,
      color: style.color,
      symbol: style.symbol,
      label: `${style.label}${detail ? `: ${detail}` : ''}`,
    });
  };

  const orders = chartData?.orders || [];
  const hasExitOrders = orders.some((o) => o?.type === 'exit');
  for (const order of orders) {
    const ts = order.createdAt || order.ts || order.time;
    const kind = order.type === 'exit' ? 'exit' : 'entry';
    const priceVal = order.price ?? order.avgPrice ?? null;
    push(ts, kind, priceVal, `${order.side || ''} @ ${priceVal ?? '-'}`);
  }
  for (const exit of hasExitOrders ? [] : (chartData?.exits || chartData?.summary?.exits || [])) {
    const priceVal = exit.price ?? exit.avgPrice ?? null;
    push(exit.ts || exit.time, 'exit', priceVal, exit.reason || '');
  }
  for (const order of chartData?.summary?.profitOrders || []) {
    push(order.fillTime || order.time, 'partial', order.price ?? null, `@ ${order.price ?? '-'}`);
  }
  for (const reversal of chartData?.summary?.reversals || []) {
    push(reversal.time, 'reverse', reversal.avgEntryPrice ?? reversal.exitPrice ?? null, `${reversal.fromSide || ''}→${reversal.toSide || ''}`);
  }
  for (const mark of chartData?.marks || []) {
    push(mark.ts, 'mark', mark.price ?? mark.data?.price ?? null, mark.name || '');
  }
  return markers;
}

export async function renderEventChartWithMarkers(container, event, chartData) {
  if (!container) return null;
  const series = chartData?.series || {};
  const underlying = series.underlying || [];
  if (!underlying.length) return null;
  const pts = underlying.map((p) => [new Date(p.ts).getTime(), p.value]);
  const ptb = (series.priceToBeat || []).map((p) => [new Date(p.ts).getTime(), p.value]);
  const built = buildUplotMarkers({
    ...chartData,
    orders: event.orders,
    marks: event.marks,
    summary: event.summary,
  }, underlying);
  const markers = built.map((m) => ({
    ts: m.ts,
    price: m.price,
    label: m.symbol,
    color: m.color,
    title: m.label
  }));
  return renderUplotLine(container, pts, [
    { label: 'BTC', data: pts },
    { label: 'PTB', data: ptb },
  ], { markers });
}
