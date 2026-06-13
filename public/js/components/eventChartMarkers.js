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
  const underlying = series?.underlying || [];
  const target = new Date(ts).getTime();
  if (!Number.isFinite(target) || !underlying.length) return null;
  let best = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const point of underlying) {
    const pointMs = new Date(point.ts).getTime();
    if (!Number.isFinite(pointMs)) continue;
    const diff = Math.abs(pointMs - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = finite(point.value);
    }
  }
  return best;
}

function buildChartPoints(series) {
  const underlying = series?.underlying || [];
  const pts = [];
  const ptb = [];
  for (let i = 0; i < underlying.length; i += 1) {
    const row = underlying[i];
    const tsMs = new Date(row.ts).getTime();
    if (!Number.isFinite(tsMs)) continue;
    const spot = finite(row.value);
    const beat = finite(series.priceToBeat?.[i]?.value);
    if (spot != null) pts.push([tsMs, spot]);
    if (beat != null) ptb.push([tsMs, beat]);
  }
  return { pts, ptb };
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
  const markers = buildMarkers(event, series);

  return renderUplotLine(container, pts, [
    { label: 'PTB', data: ptb },
  ], {
    markers,
    primaryLabel: asset,
    yRange: 'tight',
    height: 280,
  });
}
