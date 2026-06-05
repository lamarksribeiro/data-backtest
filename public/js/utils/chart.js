/** @type {import('chart.js').Chart | null} */
let activeChart = null;

export function destroyActiveChart() {
  if (activeChart) {
    activeChart.destroy();
    activeChart = null;
  }
}

export function renderEventChart(canvas, chartData) {
  destroyActiveChart();
  if (!canvas || !window.Chart || !chartData?.series) return;

  const series = chartData.series;
  const labels = (series.underlying || []).map((point) => formatChartLabel(point.ts));
  const markers = buildChartMarkers(chartData, series.underlying || []);

  activeChart = new window.Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'BTC',
          data: (series.underlying || []).map((point) => point.value),
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56, 189, 248, 0.12)',
          tension: 0.15,
          pointRadius: 0,
          borderWidth: 2,
        },
        {
          label: 'PTB',
          data: (series.priceToBeat || []).map((point) => point.value),
          borderColor: '#fbbf24',
          borderDash: [6, 4],
          tension: 0,
          pointRadius: 0,
          borderWidth: 1.5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#91a4bd' } },
        tooltip: { callbacks: { afterBody: (items) => markerTooltip(markers, items[0]?.dataIndex) } },
      },
      scales: {
        x: { ticks: { color: '#91a4bd', maxTicksLimit: 8 }, grid: { color: 'rgba(36, 48, 68, 0.6)' } },
        y: { ticks: { color: '#91a4bd' }, grid: { color: 'rgba(36, 48, 68, 0.6)' } },
      },
    },
    plugins: [markerPointPlugin(markers, series.underlying || [])],
  });
}

function buildChartMarkers(chartData, underlyingSeries) {
  const markers = [];
  const indexByTs = new Map(underlyingSeries.map((point, index) => [new Date(point.ts).getTime(), index]));
  const pushMarker = (ts, label, color) => {
    const index = indexByTs.get(new Date(ts).getTime());
    if (index == null) return;
    markers.push({ index, label, color });
  };
  for (const order of chartData.orders || []) {
    const ts = order.createdAt || order.ts || order.time;
    const kind = order.type === 'exit' || order.reason?.includes('exit') || order.reason?.includes('stop') || order.reason?.includes('trail') ? 'exit' : 'entry';
    pushMarker(ts, `${kind}: ${order.side || ''} @ ${order.price ?? order.avgPrice ?? '-'}`, kind === 'entry' ? '#22c55e' : '#fb7185');
  }
  for (const mark of chartData.marks || []) {
    pushMarker(mark.ts, `mark: ${mark.name}`, '#a78bfa');
  }
  return markers;
}

function markerPointPlugin(markers, underlyingSeries) {
  return {
    id: 'eventMarkers',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!scales?.x || !underlyingSeries.length) return;
      for (const marker of markers) {
        const x = scales.x.getPixelForValue(marker.index);
        if (x < chartArea.left || x > chartArea.right) continue;
        ctx.save();
        ctx.fillStyle = marker.color;
        ctx.beginPath();
        ctx.arc(x, chartArea.top + 10, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    },
  };
}

function markerTooltip(markers, index) {
  if (index == null) return [];
  return markers.filter((marker) => marker.index === index).map((marker) => marker.label);
}

function formatChartLabel(ts) {
  if (!ts) return '';
  return new Date(ts).toISOString().slice(11, 19);
}
