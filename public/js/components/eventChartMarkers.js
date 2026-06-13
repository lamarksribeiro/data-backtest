
import { renderUplotLine } from '../utils/uplotChart.js';
import { buildExecutionItems } from './executionTimeline.js';

const MARKER_STYLES = {
  entry: { color: '#4ade80', label: 'Entrada' },
  exit: { color: '#fb7185', label: 'Saída' },
  stop: { color: '#f87171', label: 'Stop Loss' },
  trail_stop: { color: '#ef4444', label: 'Trailing Stop' },
  take_profit: { color: '#2dd4bf', label: 'Take Profit' },
  partial: { color: '#fbbf24', label: 'Parcial' },
  reverse: { color: '#c4b5fd', label: 'Reversão' },
};

/** Só execução de trade no gráfico — marks GLS ficam na Linha do Tempo / Logs. */
const CHART_MARKER_KINDS = new Set([
  'entry', 'exit', 'stop', 'trail_stop', 'take_profit', 'partial', 'reverse',
]);

function finite(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function spotAtTime(series, ts) {
  const underlying = seriesArray(series, 'underlying');
  const target = new Date(ts).getTime();
  if (!Number.isFinite(target) || !underlying.length) return null;
  let best = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const point of underlying) {
    const pointMs = new Date(pointTs(point)).getTime();
    if (!Number.isFinite(pointMs)) continue;
    const diff = Math.abs(pointMs - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = pointValue(point, 'underlying');
    }
  }
  return best;
}

function buildChartPoints(series) {
  const underlying = seriesArray(series, 'underlying');
  const priceToBeat = seriesArray(series, 'priceToBeat');
  const pts = [];
  const ptb = [];
  for (let i = 0; i < underlying.length; i += 1) {
    const row = underlying[i];
    const ts = pointTs(row);
    const tsMs = new Date(ts).getTime();
    if (!Number.isFinite(tsMs)) continue;
    const spot = pointValue(row, 'underlying');
    const beat = pointValue(priceToBeat[i], 'priceToBeat');
    if (spot != null) pts.push([tsMs, spot]);
    if (beat != null) ptb.push([tsMs, beat]);
  }
  return { pts, ptb };
}

function buildConstantLine(points, value) {
  const num = finite(value);
  if (num == null || points.length < 2) return [];
  return points.map(([ts]) => [ts, num]);
}

function seriesArray(series, key) {
  if (!series) return [];
  if (Array.isArray(series[key])) return series[key];
  if (key === 'priceToBeat') {
    if (Array.isArray(series.price_to_beat)) return series.price_to_beat;
    if (Array.isArray(series.ptb)) return series.ptb;
  }
  return [];
}

function pointTs(point) {
  if (Array.isArray(point)) return point[0];
  return point?.ts ?? point?.time ?? point?.t ?? point?.x;
}

function pointValue(point, key) {
  if (Array.isArray(point)) return finite(point[1]);
  if (!point) return null;
  if (point.value != null) return finite(point.value);
  if (point.y != null) return finite(point.y);
  if (key === 'underlying') return finite(point.underlying_price ?? point.underlyingPrice ?? point.price);
  if (key === 'priceToBeat') return finite(point.price_to_beat ?? point.priceToBeat ?? point.ptb);
  return null;
}

function buildMarkers(event, series) {
  const items = buildExecutionItems(event);
  return items
    .filter((item) => item.ts && CHART_MARKER_KINDS.has(item.kind))
    .map((item) => {
      const style = MARKER_STYLES[item.kind];
      const ts = new Date(item.ts).getTime();
      const spot = spotAtTime(series, item.ts);
      return {
        kind: item.kind,
        ts,
        price: spot,
        color: style.color,
        title: item.title || style.label,
      };
    });
}

function markerLegendEl(markers) {
  if (!markers.length) return null;
  const seen = new Set();
  const legend = document.createElement('div');
  legend.className = 'studio-event-chart__markers';
  for (const marker of markers) {
    const style = MARKER_STYLES[marker.kind];
    if (!style) continue;
    const key = marker.kind || 'mark';
    if (seen.has(key)) continue;
    seen.add(key);
    const item = document.createElement('span');
    item.className = `studio-event-chart__marker studio-event-chart__marker--${key}`;
    item.innerHTML = `<span class="studio-event-chart__marker-swatch" style="--marker-color:${style.color}"></span><strong>${style.label}</strong>`;
    legend.appendChild(item);
  }
  return legend;
}

export async function renderEventChartWithMarkers(container, event, chartData, opts = {}) {
  if (!container) return null;
  const series = chartData?.series || {};
  const { pts, ptb } = buildChartPoints(series);
  if (pts.length < 2) return null;

  const asset = opts.assetSymbol || 'BTC';
  const ptbLine = ptb.length >= 2
    ? ptb
    : buildConstantLine(pts, event?.summary?.priceToBeat ?? event?.price_to_beat ?? chartData?.summary?.priceToBeat);
  const markers = buildMarkers(event, series);

  container.innerHTML = '';
  const stack = document.createElement('div');
  stack.className = 'studio-event-chart__stack';

  const header = document.createElement('div');
  header.className = 'studio-event-chart__head';
  header.innerHTML = `<span class="studio-event-chart__title">${asset} × PTB</span>`;
  const legend = markerLegendEl(markers);
  if (legend) header.appendChild(legend);
  stack.appendChild(header);

  const plot = document.createElement('div');
  plot.className = 'studio-event-chart__plot';
  stack.appendChild(plot);
  container.appendChild(stack);

  return renderUplotLine(plot, pts, [
    { label: 'PTB', data: ptbLine, dash: [7, 5], width: 1.75, stroke: '#38bdf8' },
  ], {
    markers,
    primaryLabel: asset,
    colors: ['#f97316', '#38bdf8'],
    yRange: 'tight',
    height: 280,
  });
}
