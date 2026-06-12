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
  const chartHeight = Number(opts.height) > 0 ? Number(opts.height) : 220;
  const chart = new uPlot({
    width: container.clientWidth || 600,
    height: chartHeight,
    series: [{}, ...labeled.map((s, i) => ({ label: s.label || `s${i}`, stroke: colors[i % colors.length], width: 2 }))],
    axes: [{}, {}],
    cursor: { drag: { x: true, y: false, setScale: true } },
    hooks: {
      draw: [
        ...(Array.isArray(opts.regions) && opts.regions.length ? [(u) => drawRegions(u, opts.regions)] : []),
        ...(markers.length ? [(u) => drawMarkers(u, markers, colors[0])] : []),
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

function drawMarkers(u, markers, defaultColor) {
  const ctx = u.ctx;
  const { left, top, width, height } = u.bbox;
  for (const marker of markers) {
    const x = u.valToPos(marker.ts / 1000, 'x', true);
    if (x < left || x > left + width) continue;
    const yVal = marker.price != null ? Number(String(marker.price).replace(/[^0-9.-]/g, '')) : null;
    
    // Tenta usar a escala 'y' ou 'y0' dependendo do que estiver definido no uPlot
    const scaleKey = u.scales.y ? 'y' : 'y0';
    const y = yVal != null && Number.isFinite(yVal)
      ? u.valToPos(yVal, scaleKey, true)
      : top + height * 0.15;

    const color = marker.color || defaultColor;

    // 1. Desenhar linha vertical pontilhada bem sutil no ponto temporal
    ctx.strokeStyle = color + '44'; // Opacidade ~25%
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + height);
    ctx.stroke();
    ctx.setLineDash([]); // limpa tracejado

    // 2. Se temos a coordenada Y exata do preço, desenhar uma pequena marca/círculo no ponto exato
    if (yVal != null && Number.isFinite(yVal) && y >= top && y <= top + height) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      ctx.fill();
      ctx.strokeStyle = '#090d16'; // Borda escura para dar contraste
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // 3. Desenhar o símbolo e rótulo do marcador
    ctx.fillStyle = color;
    ctx.font = 'bold 12px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    
    // Deslocar o símbolo verticalmente para não sobrepor o círculo
    const offset = marker.label === '▲' ? 14 : -8; // Entrada abaixo, saída/outros acima
    const textY = yVal != null && Number.isFinite(yVal) ? y + offset : top + 15;
    
    // Garante que o texto fique dentro dos limites do gráfico
    const safeY = Math.min(top + height - 4, Math.max(top + 12, textY));
    ctx.fillText((marker.label || '●').slice(0, 2), x, safeY);
  }
}
