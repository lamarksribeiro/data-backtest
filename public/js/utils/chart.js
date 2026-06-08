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
        {
          label: 'UP price',
          data: (series.upPrice || []).map((point) => point.value),
          borderColor: '#22c55e',
          tension: 0.12,
          pointRadius: 0,
          borderWidth: 1,
          yAxisID: 'odds',
          hidden: true,
        },
        {
          label: 'DOWN price',
          data: (series.downPrice || []).map((point) => point.value),
          borderColor: '#fb7185',
          tension: 0.12,
          pointRadius: 0,
          borderWidth: 1,
          yAxisID: 'odds',
          hidden: true,
        },
        {
          label: 'Bid lado',
          data: (series.bid || []).map((point) => point.value),
          borderColor: '#14b8a6',
          tension: 0.12,
          pointRadius: 0,
          borderWidth: 1,
          yAxisID: 'odds',
        },
        {
          label: 'Ask lado',
          data: (series.ask || []).map((point) => point.value),
          borderColor: '#f97316',
          tension: 0.12,
          pointRadius: 0,
          borderWidth: 1,
          yAxisID: 'odds',
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
        odds: {
          position: 'right',
          min: 0,
          max: 1,
          ticks: { color: '#91a4bd' },
          grid: { drawOnChartArea: false },
        },
      },
    },
    plugins: [markerPointPlugin(markers, series.underlying || [])],
  });
}

export function renderEquityChart(canvas, equity = []) {
  destroyActiveChart();
  if (!canvas || !window.Chart || !Array.isArray(equity) || !equity.length) return;

  activeChart = new window.Chart(canvas, {
    type: 'line',
    data: {
      labels: equity.map((point) => formatChartLabel(point.ts)),
      datasets: [{
        label: 'Equity / PnL acumulado',
        data: equity.map((point) => Number(point.pnl ?? point.value ?? 0)),
        borderColor: '#f97316',
        backgroundColor: 'rgba(249, 115, 22, 0.14)',
        fill: true,
        tension: 0.18,
        pointRadius: equity.length > 80 ? 0 : 2,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#91a4bd' } },
      },
      scales: {
        x: { ticks: { color: '#91a4bd', maxTicksLimit: 8 }, grid: { color: 'rgba(36, 48, 68, 0.6)' } },
        y: { ticks: { color: '#91a4bd' }, grid: { color: 'rgba(36, 48, 68, 0.6)' } },
      },
    },
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
  const orders = chartData.orders || [];
  const hasExitOrders = orders.some((order) => order?.type === 'exit');
  for (const order of orders) {
    const ts = order.createdAt || order.ts || order.time;
    const kind = order.type === 'exit' || order.reason?.includes('exit') || order.reason?.includes('stop') || order.reason?.includes('trail') ? 'exit' : 'entry';
    pushMarker(ts, `${kind}: ${order.side || ''} @ ${order.price ?? order.avgPrice ?? '-'}`, kind === 'entry' ? '#22c55e' : '#fb7185');
  }
  for (const exit of hasExitOrders ? [] : (chartData.exits || [])) {
    const ts = exit.ts || exit.time;
    pushMarker(ts, `exit: ${exit.reason || ''} @ ${exit.price ?? exit.avgPrice ?? '-'}`, '#fb7185');
  }
  for (const order of chartData.summary?.profitOrders || []) {
    pushMarker(order.fillTime || order.time, `partial: @ ${order.price ?? '-'}`, '#fbbf24');
  }
  for (const reversal of chartData.summary?.reversals || []) {
    pushMarker(reversal.time, `reverse: ${reversal.fromSide || ''} → ${reversal.toSide || ''}`, '#a78bfa');
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
