// Line charts (SVG) — mesmo padrão visual do data-colector.
import { el } from './dom.js';

const UNDERLYING_DECIMALS = { BTC: 2, ETH: 2, SOL: 2, XRP: 4, DOGE: 6, HYPE: 2, BNB: 2 };

export function underlyingDecimals(symbol) {
  return UNDERLYING_DECIMALS[String(symbol || '').toUpperCase()] ?? 2;
}

function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child) node.appendChild(child);
  }
  return node;
}

function svgRoot(attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.setAttribute('class', value);
    else node.setAttribute(key, value);
  }
  return node;
}

function finiteYs(points) {
  return points.map((point) => point.y).filter((y) => y != null && Number.isFinite(y));
}

function yScaleFromValues(values) {
  const minY = Math.min(...values);
  const maxY = Math.max(...values);
  const span = maxY - minY;
  const padY = span > 0 ? span * 0.05 : Math.max(Math.abs(maxY) * 0.001, 0.01);
  return { y0: minY - padY, y1: maxY + padY };
}

function formatAxisValue(value, decimals) {
  if (decimals != null) return Number(value).toFixed(decimals);
  const magnitude = Math.abs(Number(value));
  if (magnitude < 1) return Number(value).toFixed(4);
  if (magnitude < 100) return Number(value).toFixed(4);
  return Number(value).toFixed(2);
}

function yAxisColumn(scale, decimals, side) {
  if (!scale) return el('div', { class: `chart__yaxis chart__yaxis--${side} chart__yaxis--empty` });
  const mid = (scale.y0 + scale.y1) / 2;
  return el('div', { class: `chart__yaxis chart__yaxis--${side}` }, [
    el('span', { class: 'chart__ytick' }, formatAxisValue(scale.y1, decimals)),
    el('span', { class: 'chart__ytick' }, formatAxisValue(mid, decimals)),
    el('span', { class: 'chart__ytick' }, formatAxisValue(scale.y0, decimals)),
  ]);
}

/**
 * @param {{ label: string, color: string, points: { x: number, y: number | null }[], dash?: boolean, strokeWidth?: number }[]} series
 * @param {{ title?: string, yAxisDecimals?: number, fixedScale?: { y0: number, y1: number }, compact?: boolean, refLines?: { y: number }[], xAxisLabels?: string[], overlayBands?: { x0: number, x1: number, color?: string }[] }} [opts]
 */
export function lineChartPanel(series, opts = {}) {
  const {
    title,
    yAxisDecimals,
    fixedScale,
    compact = false,
    refLines = [],
    xAxisLabels = [],
    overlayBands = [],
    highlightCrossings = false,
  } = opts;

  const active = series.filter((item) => finiteYs(item.points).length >= 2);
  const allY = active.flatMap((item) => finiteYs(item.points));

  if (!allY.length) {
    return el('div', { class: 'chart chart--empty' }, [
      title ? el('div', { class: 'chart__title' }, title) : null,
      el('div', { class: 'chart__empty' }, 'Sem dados para gráfico'),
    ]);
  }

  const scale = fixedScale || yScaleFromValues(allY);
  const plotW = 1000;
  const plotH = compact ? 120 : 280;
  const maxX = Math.max(...active.flatMap((item) => item.points.map((point) => point.x)), 1);

  function toSvg(item) {
    const points = item.points.filter((point) => point.y != null && Number.isFinite(point.y));
    if (points.length < 2) return '';
    const span = scale.y1 - scale.y0 || 1;
    return points.map((point, index) => {
      const x = (point.x / maxX) * plotW;
      const y = plotH - ((point.y - scale.y0) / span) * plotH;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
  }

  function yAt(value) {
    const span = scale.y1 - scale.y0 || 1;
    return plotH - ((value - scale.y0) / span) * plotH;
  }

  const svg = svgRoot({
    class: 'chart__svg chart__svg--multiline',
    viewBox: `0 0 ${plotW} ${plotH}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-hidden': 'true',
  });

  for (const pct of [0.25, 0.5, 0.75]) {
    const gy = plotH * pct;
    svg.appendChild(svgEl('line', {
      x1: '0',
      y1: String(gy),
      x2: String(plotW),
      y2: String(gy),
      stroke: 'rgba(148,163,184,0.1)',
      'stroke-width': '1',
    }));
  }

  for (const band of overlayBands) {
    const x0 = (band.x0 / maxX) * plotW;
    const x1 = (band.x1 / maxX) * plotW;
    svg.appendChild(svgEl('rect', {
      x: String(Math.min(x0, x1)),
      y: '0',
      width: String(Math.abs(x1 - x0) || 0),
      height: String(plotH),
      fill: band.color || 'rgba(239, 68, 68, 0.14)',
    }));
  }

  for (const ref of refLines) {
    if (!Number.isFinite(ref.y)) continue;
    const ry = yAt(ref.y);
    svg.appendChild(svgEl('line', {
      x1: '0',
      y1: String(ry),
      x2: String(plotW),
      y2: String(ry),
      stroke: 'rgba(148,163,184,0.35)',
      'stroke-width': '1',
      'stroke-dasharray': '5 5',
    }));
  }

  svg.appendChild(svgEl('line', {
    x1: '0',
    y1: '0',
    x2: '0',
    y2: String(plotH),
    stroke: 'rgba(148,163,184,0.25)',
  }));

  svg.appendChild(svgEl('line', {
    x1: '0',
    y1: String(plotH),
    x2: String(plotW),
    y2: String(plotH),
    stroke: 'rgba(148,163,184,0.25)',
  }));

  const crossings = [];
  if (highlightCrossings && active.length >= 2) {
    const left = active[0];
    const right = active[1];
    const minLen = Math.min(left.points.length, right.points.length);
    for (let index = 1; index < minLen; index += 1) {
      const leftPrev = left.points[index - 1].y;
      const leftCurr = left.points[index].y;
      const rightPrev = right.points[index - 1].y;
      const rightCurr = right.points[index].y;
      if (leftPrev == null || leftCurr == null || rightPrev == null || rightCurr == null) continue;
      const diffPrev = leftPrev - rightPrev;
      const diffCurr = leftCurr - rightCurr;
      if ((diffPrev > 0 && diffCurr < 0) || (diffPrev < 0 && diffCurr > 0)) {
        const t = diffPrev / (diffPrev - diffCurr);
        const exactX = (index - 1) + t;
        const exactY = rightPrev + t * (rightCurr - rightPrev);
        crossings.push({
          cx: (exactX / maxX) * plotW,
          cy: plotH - ((exactY - scale.y0) / (scale.y1 - scale.y0 || 1)) * plotH,
        });
      }
    }
  }

  for (const crossing of crossings) {
    svg.appendChild(svgEl('line', {
      x1: crossing.cx.toFixed(2),
      y1: '0',
      x2: crossing.cx.toFixed(2),
      y2: String(plotH),
      stroke: 'rgba(234, 179, 8, 0.25)',
      'stroke-width': '1',
      'stroke-dasharray': '3 3',
    }));
  }

  for (const item of active) {
    const path = toSvg(item);
    if (!path) continue;

    if (!item.dash) {
      const gradId = `grad-${item.key || Math.random().toString(36).slice(2, 11)}`;
      let defs = svg.querySelector('defs');
      if (!defs) {
        defs = svgEl('defs');
        svg.appendChild(defs);
      }
      const grad = svgEl('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
      grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': item.color, 'stop-opacity': '0.12' }));
      grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': item.color, 'stop-opacity': '0.0' }));
      defs.appendChild(grad);

      const points = item.points.filter((point) => point.y != null && Number.isFinite(point.y));
      if (points.length >= 2) {
        const firstX = (points[0].x / maxX) * plotW;
        const lastX = (points[points.length - 1].x / maxX) * plotW;
        svg.appendChild(svgEl('path', {
          d: `${path} L${lastX.toFixed(2)},${plotH} L${firstX.toFixed(2)},${plotH} Z`,
          fill: `url(#${gradId})`,
          stroke: 'none',
        }));
      }
    }

    const pathAttrs = {
      d: path,
      fill: 'none',
      stroke: item.color,
      'stroke-width': String(item.strokeWidth ?? 2.5),
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
      opacity: '0.95',
    };
    if (item.dash) pathAttrs['stroke-dasharray'] = '6 4';
    svg.appendChild(svgEl('path', pathAttrs));
  }

  for (const crossing of crossings) {
    svg.appendChild(svgEl('circle', {
      cx: crossing.cx.toFixed(2),
      cy: crossing.cy.toFixed(2),
      r: '4',
      fill: '#fbbf24',
      stroke: 'var(--bg-0)',
      'stroke-width': '1.5',
      opacity: '0.95',
    }));
  }

  const chartClass = compact ? 'chart chart--multiline chart--compact' : 'chart chart--multiline';

  return el('div', { class: chartClass }, [
    title ? el('div', { class: 'chart__title' }, title) : null,
    el('div', { class: 'chart__frame' }, [
      yAxisColumn(scale, yAxisDecimals, 'left'),
      el('div', { class: 'chart__main-col' }, [
        el('div', { class: 'chart__viewport' }, svg),
        xAxisLabels.length
          ? el('div', { class: 'chart__xaxis' }, xAxisLabels.map((label) => el('span', { class: 'chart__xtick' }, label)))
          : null,
      ]),
      el('div', { class: 'chart__yaxis chart__yaxis--right chart__yaxis--empty' }),
    ]),
    el('div', { class: 'chart__legend' },
      active.map((item) => el('span', { class: 'chart__legend-item' }, [
        el('span', {
          class: 'chart__legend-swatch' + (item.dash ? ' chart__legend-swatch--dash' : ''),
          style: { background: item.dash ? 'transparent' : item.color, borderColor: item.color },
        }),
        item.label,
      ]))),
  ]);
}

function tickSeries(ticks, key) {
  return ticks.map((tick, index) => {
    const raw = tick[key];
    const y = raw != null ? Number(raw) : null;
    return { x: index, y: Number.isFinite(y) ? y : null };
  });
}

function formatTickTime(tsStr, sameDay = true) {
  const date = new Date(tsStr);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (sameDay) return `${hhmm}:${pad(date.getSeconds())}`;
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${hhmm}`;
}

function trimLeadingInvalidTicks(ticks) {
  let firstValidIdx = 0;
  while (firstValidIdx < ticks.length
    && (ticks[firstValidIdx].underlying_price == null || ticks[firstValidIdx].price_to_beat == null)) {
    firstValidIdx += 1;
  }
  return ticks.slice(firstValidIdx);
}

/**
 * @param {object[]} ticks
 * @param {{ assetSymbol?: string, yAxisDecimals?: number, compact?: boolean, overlayBands?: { x0: number, x1: number, color?: string }[] }} [opts]
 */
export function explorerTickCharts(ticks, opts = {}) {
  const asset = opts.assetSymbol || 'BTC';
  const priceDecimals = opts.yAxisDecimals ?? underlyingDecimals(asset);
  const validTicks = trimLeadingInvalidTicks(ticks);

  if (!validTicks.length) {
    return el('div', { class: 'chart chart--empty' }, [
      el('div', { class: 'chart__empty' }, 'Sem dados de preço válidos no período'),
    ]);
  }

  const firstTs = validTicks[0]?.ts;
  const lastTs = validTicks[validTicks.length - 1]?.ts;
  const isSameDay = firstTs && lastTs
    ? new Date(firstTs).toDateString() === new Date(lastTs).toDateString()
    : true;

  const xAxisLabels = [];
  if (validTicks.length >= 2) {
    xAxisLabels.push(formatTickTime(validTicks[0].ts, isSameDay));
    if (validTicks.length >= 3) {
      xAxisLabels.push(formatTickTime(validTicks[Math.floor(validTicks.length / 2)].ts, isSameDay));
    }
    xAxisLabels.push(formatTickTime(validTicks[validTicks.length - 1].ts, isSameDay));
  }

  const priceSeries = [
    { label: `Preço ${asset}`, color: '#3b82f6', key: 'underlying_price', dash: false },
    { label: 'PTB (price to beat)', color: '#eab308', key: 'price_to_beat', dash: true },
  ].map((item) => ({
    label: item.label,
    color: item.color,
    dash: item.dash,
    key: item.key,
    points: tickSeries(validTicks, item.key),
  }));

  const oddsSeries = [
    { label: 'UP', color: '#10b981', key: 'up_price' },
    { label: 'DOWN', color: '#f43f5e', key: 'down_price' },
  ].map((item) => ({
    label: item.label,
    color: item.color,
    key: item.key,
    points: tickSeries(validTicks, item.key),
  }));

  const chartOpts = {
    xAxisLabels,
    compact: opts.compact === true,
    overlayBands: opts.overlayBands || [],
  };

  return el('div', { class: 'explorer-charts' }, [
    el('section', { class: 'explorer-charts__section' }, [
      el('div', { class: 'explorer-charts__heading' }, [
        el('h3', { class: 'explorer-charts__title' }, `Preço ${asset} vs PTB`),
        el('p', { class: 'explorer-charts__hint muted' }, 'Mesma escala em USD — linha tracejada é o alvo do evento'),
      ]),
      lineChartPanel(priceSeries, {
        ...chartOpts,
        yAxisDecimals: priceDecimals,
        highlightCrossings: true,
      }),
    ]),
    el('section', { class: 'explorer-charts__section explorer-charts__section--odds' }, [
      el('div', { class: 'explorer-charts__heading' }, [
        el('h3', { class: 'explorer-charts__title' }, 'Odds UP / DOWN'),
        el('p', { class: 'explorer-charts__hint muted' }, 'Probabilidade implícita (0–1) · linha pontilhada = 50%'),
      ]),
      lineChartPanel(oddsSeries, {
        ...chartOpts,
        yAxisDecimals: 2,
        fixedScale: { y0: 0, y1: 1 },
        refLines: [{ y: 0.5 }],
      }),
    ]),
  ]);
}
