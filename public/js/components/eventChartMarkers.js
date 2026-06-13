import { el, mount } from '../utils/dom.js';
import { explorerTickCharts } from '../utils/lineChart.js';
import { buildExecutionItems } from './executionTimeline.js';

const MARKER_COLORS = {
  entry: '#22c55e',
  exit: '#fb7185',
  partial: '#fbbf24',
  reverse: '#a78bfa',
  mark: '#94a3b8',
};

export function chartSeriesToTicks(series = {}) {
  const underlying = series.underlying || [];
  return underlying.map((row, index) => ({
    ts: row.ts,
    underlying_price: row.value,
    price_to_beat: series.priceToBeat?.[index]?.value ?? null,
    up_price: series.upPrice?.[index]?.value ?? null,
    down_price: series.downPrice?.[index]?.value ?? null,
  }));
}

function indexForTimestamp(ticks, ts) {
  const target = new Date(ts).getTime();
  if (!Number.isFinite(target) || !ticks.length) return 0;
  let bestIndex = 0;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ticks.length; index += 1) {
    const current = new Date(ticks[index].ts).getTime();
    if (!Number.isFinite(current)) continue;
    const diff = Math.abs(current - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function markerBandsFromEvent(ticks, event) {
  const items = buildExecutionItems(event);
  return items
    .filter((item) => item.ts)
    .map((item) => {
      const index = indexForTimestamp(ticks, item.ts);
      const color = `${MARKER_COLORS[item.kind] || MARKER_COLORS.mark}33`;
      return { x0: index, x1: index, color };
    });
}

function renderMarkerLegend(event) {
  const items = buildExecutionItems(event);
  if (!items.length) return null;
  return el('div', { class: 'studio-event-chart__markers' },
    items.slice(0, 12).map((item) => el('span', {
      class: 'studio-event-chart__marker',
      style: { color: MARKER_COLORS[item.kind] || MARKER_COLORS.mark },
      title: item.title,
    }, [
      el('strong', {}, item.title),
      item.ts ? ` · ${new Date(item.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '',
    ])));
}

export async function renderEventChartWithMarkers(container, event, chartData, opts = {}) {
  if (!container) return null;
  const series = chartData?.series || {};
  const ticks = chartSeriesToTicks(series);
  const hasSpot = ticks.some((row) => row.underlying_price != null && Number.isFinite(Number(row.underlying_price)));
  const hasOdds = ticks.some((row) => row.up_price != null || row.down_price != null);
  if (!hasSpot && !hasOdds) return null;

  const asset = opts.assetSymbol || event.underlying || 'BTC';
  const overlayBands = markerBandsFromEvent(ticks, event);
  mount(container, el('div', { class: 'studio-event-chart__stack' }, [
    explorerTickCharts(ticks, {
      assetSymbol: asset,
      compact: true,
      overlayBands,
    }),
    renderMarkerLegend(event),
  ]));
  return container;
}
