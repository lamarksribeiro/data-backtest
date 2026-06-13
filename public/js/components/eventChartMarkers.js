import { renderUplotLine } from '../utils/uplotChart.js';
import { buildExecutionItems } from './executionTimeline.js';

const MARKER_STYLES = {
  entry: { color: '#22c55e', symbol: '▲', label: 'Entrada' },
  exit: { color: '#fb7185', symbol: '▼', label: 'Saída' },
  partial: { color: '#fbbf24', symbol: '◆', label: 'Parcial' },
  reverse: { color: '#a78bfa', symbol: '↻', label: 'Reversão' },
  mark: { color: '#94a3b8', symbol: '●', label: 'Mark' },
};

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
    .filter((item) => item.ts)
    .map((item) => {
      const style = MARKER_STYLES[item.kind] || MARKER_STYLES.mark;
      const ts = new Date(item.ts).getTime();
      const spot = spotAtTime(series, item.ts);
      return {
        ts,
        price: spot,
        label: style.symbol,
        color: style.color,
        title: item.title || style.label,
      };
    });
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

  return renderUplotLine(container, pts, [
    { label: 'PTB', data: ptbLine },
  ], {
    markers,
    primaryLabel: asset,
    yRange: 'tight',
    height: 280,
  });
}
