let uplotReady = null;

/** @type {WeakMap<HTMLElement, import('uplot').default[]>} */
const containerCharts = new WeakMap();

const DEFAULT_COLORS = ['#f97316', '#38bdf8', '#a78bfa', '#34d399', '#f472b6'];

export function destroyChartsIn(container) {
  if (!container) return;
  const charts = containerCharts.get(container);
  if (!charts?.length) return;
  for (const chart of charts) chart?.destroy?.();
  containerCharts.delete(container);
}

function trackChart(container, chart) {
  if (!container || !chart) return;
  const list = containerCharts.get(container) || [];
  list.push(chart);
  containerCharts.set(container, list);
}

function loadUplot() {
  if (window.uPlot) return Promise.resolve(window.uPlot);
  if (uplotReady) return uplotReady;
  uplotReady = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/uplot@1.6.30/dist/uPlot.min.css';
    document.head.appendChild(link);
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/uplot@1.6.30/dist/uPlot.iife.min.js';
    script.onload = () => resolve(window.uPlot);
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return uplotReady;
}

const SPARKLINE_HEIGHT = 56;

/** Mini sparkline: valores numéricos no eixo X (sem converter para data). */
export async function renderUplotSparkline(container, values) {
  if (!container || !values?.length) return null;
  const uPlot = await loadUplot();
  container.innerHTML = '';
  const xs = values.map((_, i) => i);
  const ys = values.map((v) => Number(v) || 0);
  const chart = new uPlot({
    width: container.clientWidth || 200,
    height: SPARKLINE_HEIGHT,
    scales: {
      y: {
        auto: true,
        range: (u, min, max) => tightYRange(u, min, max),
      },
    },
    series: [{}, { stroke: '#f97316', width: 1.5, points: { show: false } }],
    axes: [{ show: false }, { show: false }],
    cursor: { show: false },
    legend: { show: false },
    padding: [6, 4, 6, 4],
  }, [xs, ys], container);
  const onResize = () => chart.setSize({ width: container.clientWidth || 200, height: SPARKLINE_HEIGHT });
  window.addEventListener('resize', onResize);
  chart.destroy = ((orig) => () => {
    window.removeEventListener('resize', onResize);
    orig.call(chart);
  })(chart.destroy);
  trackChart(container, chart);
  return chart;
}

function tightYRange(_u, min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.abs(min) * 0.001 || 1;
    return [min - pad, max + pad];
  }
  const pad = Math.max((max - min) * 0.12, Math.abs(max) * 0.00005, 1e-6);
  return [min - pad, max + pad];
}

function resolveColors(opts) {
  if (Array.isArray(opts.colors) && opts.colors.length) return opts.colors;
  if (opts.primaryColor) return [opts.primaryColor, ...DEFAULT_COLORS.slice(1)];
  return DEFAULT_COLORS;
}

function seriesConfig(seriesItem, index, colors) {
  return {
    label: seriesItem.label || `s${index}`,
    stroke: seriesItem.stroke || colors[index % colors.length],
    width: seriesItem.width ?? 2,
    dash: seriesItem.dash,
    spanGaps: false,
    points: { show: false },
  };
}

export async function renderUplotLine(container, primarySeries, extraSeries = [], opts = {}) {
  if (!container) return null;
  const uPlot = await loadUplot();
  destroyChartsIn(container);
  container.innerHTML = '';
  const labeled = [
    { label: opts.primaryLabel || 'primary', data: primarySeries },
    ...extraSeries,
  ].filter((s) => s?.data?.length);
  if (!labeled.length) return null;
  const primaryPoints = normalizeSeriesPoints(labeled[0].data);
  const xs = primaryPoints.map((p) => p[0] / 1000);
  const data = [
    xs,
    primaryPoints.map((p) => p[1]),
    ...labeled.slice(1).map((s) => alignSeriesToX(normalizeSeriesPoints(s.data), primaryPoints)),
  ];
  if (!primaryPoints.some((p) => p[1] != null)) return null;
  const colors = resolveColors(opts);
  const markers = Array.isArray(opts.markers) ? opts.markers : [];
  const chartHeight = Number(opts.height) > 0 ? Number(opts.height) : 220;
  const useTightY = opts.yRange === 'tight';
  const chart = new uPlot({
    width: container.clientWidth || 600,
    height: chartHeight,
    scales: {
      x: { time: true },
      y: {
        auto: true,
        range: useTightY
          ? (_u, min, max) => tightYRange(_u, min, max)
          : undefined,
      },
    },
    series: [{}, ...labeled.map((s, i) => seriesConfig(s, i, colors))],
    axes: [
      { stroke: '#64748b', grid: { stroke: 'rgba(255,255,255,0.06)' } },
      { stroke: '#64748b', grid: { stroke: 'rgba(255,255,255,0.06)' }, size: 72 },
    ],
    cursor: { drag: { x: true, y: false, setScale: true } },
    hooks: {
      draw: [
        ...(Array.isArray(opts.regions) && opts.regions.length ? [(u) => drawRegions(u, opts.regions)] : []),
        ...(markers.length ? [(u) => drawMarkers(u, markers)] : []),
      ],
      setSelect: [(u) => {
        if (u.select.width <= 0) return;
        const min = u.posToVal(u.select.left, 'x');
        const max = u.posToVal(u.select.left + u.select.width, 'x');
        u.setScale('x', { min, max });
        u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
      }],
    },
  }, data, container);

  const onResize = () => {
    chart.setSize({ width: container.clientWidth || 600, height: chartHeight });
  };
  window.addEventListener('resize', onResize);
  chart.destroy = ((orig) => () => {
    window.removeEventListener('resize', onResize);
    orig.call(chart);
  })(chart.destroy);
  trackChart(container, chart);

  return chart;
}

function normalizeSeriesPoints(points = []) {
  return (points || [])
    .map((point) => {
      const rawTs = Array.isArray(point) ? point[0] : point?.ts ?? point?.x ?? point?.time;
      const rawValue = Array.isArray(point) ? point[1] : point?.value ?? point?.y;
      const ts = typeof rawTs === 'number' ? rawTs : new Date(rawTs).getTime();
      const value = rawValue == null || rawValue === '' ? null : Number(rawValue);
      if (!Number.isFinite(ts)) return null;
      return [ts, Number.isFinite(value) ? value : null];
    })
    .filter(Boolean)
    .sort((left, right) => left[0] - right[0]);
}

function alignSeriesToX(points, primaryPoints) {
  const byTs = new Map(points.map(([ts, value]) => [ts, value]));
  return primaryPoints.map(([ts]) => byTs.get(ts) ?? null);
}

function drawRegions(u, regions = []) {
  const ctx = u.ctx;
  const { left, top, width, height } = u.bbox;
  for (const region of regions) {
    const from = region.from / 1000;
    const to = region.to / 1000;
    const x0 = u.valToPos(from, 'x', true);
    const x1 = u.valToPos(to, 'x', true);
    if (Math.max(x0, x1) < left || Math.min(x0, x1) > left + width) continue;
    ctx.fillStyle = region.color || 'rgba(239, 68, 68, 0.14)';
    ctx.fillRect(Math.min(x0, x1), top, Math.abs(x1 - x0), height);
  }
}

function hexAlpha(hex, alpha) {
  const clean = String(hex || '#94a3b8').replace('#', '');
  const full = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean.slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function drawShape(ctx, kind, x, y, size, color) {
  ctx.beginPath();
  switch (kind) {
    case 'entry':
      ctx.moveTo(x, y - size);
      ctx.lineTo(x + size, y + size * 0.65);
      ctx.lineTo(x - size, y + size * 0.65);
      ctx.closePath();
      break;
    case 'exit':
      ctx.moveTo(x, y + size);
      ctx.lineTo(x + size, y - size * 0.65);
      ctx.lineTo(x - size, y - size * 0.65);
      ctx.closePath();
      break;
    case 'stop':
    case 'trail_stop':
      ctx.moveTo(x, y - size);
      ctx.lineTo(x + size, y);
      ctx.lineTo(x, y + size);
      ctx.lineTo(x - size, y);
      ctx.closePath();
      break;
    case 'take_profit':
    case 'mark':
      ctx.arc(x, y, size * 0.72, 0, Math.PI * 2);
      break;
    case 'partial':
      ctx.rect(x - size * 0.72, y - size * 0.72, size * 1.44, size * 1.44);
      break;
    case 'reverse':
      ctx.moveTo(x, y - size);
      ctx.lineTo(x + size * 0.86, y - size * 0.25);
      ctx.lineTo(x + size * 0.55, y + size);
      ctx.lineTo(x - size * 0.55, y + size);
      ctx.lineTo(x - size * 0.86, y - size * 0.25);
      ctx.closePath();
      break;
    default:
      ctx.arc(x, y, size * 0.65, 0, Math.PI * 2);
      break;
  }
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#0b1120';
  ctx.lineWidth = 2;
  ctx.stroke();
}


function drawMarkers(u, markers) {
  const ctx = u.ctx;
  const { left, top, width, height } = u.bbox;
  const scaleKey = u.scales.y ? 'y' : 'y0';
  const guideX = new Set();

  for (const marker of markers) {
    const x = u.valToPos(marker.ts / 1000, 'x', true);
    if (x < left - 4 || x > left + width + 4) continue;

    const yVal = marker.price != null ? Number(marker.price) : null;
    const onSeries = yVal != null && Number.isFinite(yVal);
    const y = onSeries
      ? u.valToPos(yVal, scaleKey, true)
      : top + height * 0.12;

    const color = marker.color || '#94a3b8';
    const kind = marker.kind || 'mark';
    const guideKey = Math.round(x);

    if (!guideX.has(guideKey)) {
      guideX.add(guideKey);
      ctx.save();
      ctx.strokeStyle = hexAlpha(color, 0.18);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    if (onSeries && y >= top - 8 && y <= top + height + 8) {
      drawShape(ctx, kind, x, y, 6.5, color);
    }
  }
}
