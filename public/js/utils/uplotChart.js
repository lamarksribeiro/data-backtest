let uplotReady = null;

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

export async function renderUplotLine(container, primarySeries, extraSeries = []) {
  if (!container) return null;
  const uPlot = await loadUplot();
  container.innerHTML = '';
  const labeled = [
    { label: 'primary', data: primarySeries },
    ...extraSeries,
  ].filter((s) => s?.data?.length);
  if (!labeled.length) return null;
  const xs = labeled[0].data.map((p) => p[0] / 1000);
  const data = [xs, ...labeled.map((s) => s.data.map((p) => p[1]))];
  const colors = ['#f97316', '#38bdf8', '#a78bfa', '#34d399', '#f472b6'];
  const chart = new uPlot({
    width: container.clientWidth || 600,
    height: 220,
    series: [{}, ...labeled.map((s, i) => ({ label: s.label || `s${i}`, stroke: colors[i % colors.length], width: 2 }))],
    axes: [{}, {}],
    cursor: { drag: { x: true, y: false, setScale: true } },
    hooks: {
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

  return chart;
}
