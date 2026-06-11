let uplotReady = null;

/** @type {WeakMap<HTMLElement, import('uplot').default[]>} */
const containerCharts = new WeakMap();

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

/** Mini sparkline: valores numéricos no eixo X (sem converter para data). */
export async function renderUplotSparkline(container, values) {
  if (!container || !values?.length) return null;
  const uPlot = await loadUplot();
  container.innerHTML = '';
  const xs = values.map((_, i) => i);
  const ys = values.map((v) => Number(v) || 0);
  const chart = new uPlot({
    width: container.clientWidth || 200,
    height: 52,
    series: [{}, { stroke: '#f97316', width: 1.5, points: { show: false } }],
    axes: [{ show: false }, { show: false }],
    cursor: { show: false },
    legend: { show: false },
    padding: [4, 4, 0, 0],
  }, [xs, ys], container);
  const onResize = () => chart.setSize({ width: container.clientWidth || 200, height: 52 });
  window.addEventListener('resize', onResize);
  chart.destroy = ((orig) => () => {
    window.removeEventListener('resize', onResize);
    orig.call(chart);
  })(chart.destroy);
  trackChart(container, chart);
  return chart;
}

export async function renderUplotLine(container, primarySeries, extraSeries = [], opts = {}) {
  if (!container) return null;
  const uPlot = await loadUplot();
  destroyChartsIn(container);
  container.innerHTML = '';
  const labeled = [
    { label: 'primary', data: primarySeries },
    ...extraSeries,
  ].filter((s) => s?.data?.length);
  if (!labeled.length) return null;
  const xs = labeled[0].data.map((p) => p[0] / 1000);
  const data = [xs, ...labeled.map((s) => s.data.map((p) => p[1]))];
  const colors = ['#f97316', '#38bdf8', '#a78bfa', '#34d399', '#f472b6'];
  const markers = Array.isArray(opts.markers) ? opts.markers : [];
  const chart = new uPlot({
    width: container.clientWidth || 600,
    height: 220,
    series: [{}, ...labeled.map((s, i) => ({ label: s.label || `s${i}`, stroke: colors[i % colors.length], width: 2 }))],
    axes: [{}, {}],
    cursor: { drag: { x: true, y: false, setScale: true } },
    hooks: {
      draw: markers.length ? [(u) => drawMarkers(u, markers, colors[0])] : [],
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
    chart.setSize({ width: container.clientWidth || 600, height: 220 });
  };
  window.addEventListener('resize', onResize);
  chart.destroy = ((orig) => () => {
    window.removeEventListener('resize', onResize);
    orig.call(chart);
  })(chart.destroy);
  trackChart(container, chart);

  return chart;
}

function drawMarkers(u, markers, defaultColor) {
  const ctx = u.ctx;
  const { left, top, width, height } = u.bbox;
  for (const marker of markers) {
    const x = u.valToPos(marker.ts / 1000, 'x', true);
    if (x < left || x > left + width) continue;
    const yVal = marker.price != null ? Number(String(marker.price).replace(/[^0-9.-]/g, '')) : null;
    const y = yVal != null && Number.isFinite(yVal)
      ? u.valToPos(yVal, 'y0', true)
      : top + height * 0.15;
    ctx.fillStyle = marker.color || defaultColor;
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText((marker.label || '●').slice(0, 2), x, Math.max(top + 10, y - 4));
  }
}
