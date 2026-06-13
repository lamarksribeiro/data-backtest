// Line charts (SVG) — mesmo padrão visual do data-colector.
import { el } from './dom.js';
import { minSpotUsd, underlyingDecimals } from '../../shared/underlyingAssets.js';

export { underlyingDecimals } from '../../shared/underlyingAssets.js';

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

function isValidSpotPrice(value, asset) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minSpotUsd(asset);
}

function isValidPtbPrice(value, asset = 'BTC') {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minSpotUsd(asset);
}

function isValidOddsPrice(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1;
}

function finiteYs(points, kind = 'any', asset = 'BTC') {
  return points
    .map((point) => point.y)
    .filter((value) => {
      if (value == null || !Number.isFinite(value)) return false;
      if (kind === 'spot') return isValidSpotPrice(value, asset);
      if (kind === 'ptb') return isValidPtbPrice(value, asset);
      if (kind === 'odds') return isValidOddsPrice(value);
      return true;
    });
}

function yScaleFromUsdValues(values, asset = 'BTC') {
  const ys = values.filter((value) => Number.isFinite(value));
  if (!ys.length) return { y0: 0, y1: 1 };
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = maxY - minY;
  const ref = Math.max(Math.abs(maxY), Math.abs(minY), minSpotUsd(asset));
  const padY = span > 0
    ? Math.max(span * 0.08, ref * 0.00015)
    : Math.max(ref * 0.0015, ref * 0.00015);
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

function buildPath(points, scale, maxX, plotW, plotH) {
  const span = scale.y1 - scale.y0 || 1;
  let path = '';
  let prevX = null;
  for (const point of points) {
    const x = (point.x / maxX) * plotW;
    const y = plotH - ((point.y - scale.y0) / span) * plotH;
    const breakPath = prevX != null && point.x - prevX > 1;
    path += `${!path || breakPath ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    prevX = point.x;
  }
  return path;
}

/**
 * @param {{ label: string, color: string, points: { x: number, y: number | null }[], dash?: boolean, strokeWidth?: number }[]} series
 * @param {{ title?: string, yAxisDecimals?: number, fixedScale?: { y0: number, y1: number }, compact?: boolean, refLines?: { y: number }[], xAxisLabels?: string[], overlayBands?: { x0: number, x1: number, color?: string }[], scaleMode?: 'usd' | 'unit', assetSymbol?: string, highlightCrossings?: boolean }} [opts]
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
    scaleMode = 'unit',
    assetSymbol = 'BTC',
  } = opts;

  const valueKind = scaleMode === 'usd' ? 'spot' : scaleMode === 'odds' ? 'odds' : 'any';
  const active = series.filter((item) => finiteYs(item.points, valueKind, assetSymbol).length >= 2);
  const scaleValues = scaleMode === 'usd'
    ? active.flatMap((item) => finiteYs(
      item.points,
      item.dash ? 'ptb' : 'spot',
      assetSymbol,
    ))
    : active.flatMap((item) => finiteYs(item.points, valueKind, assetSymbol));

  if (!scaleValues.length) {
    return el('div', { class: 'chart chart--empty' }, [
      title ? el('div', { class: 'chart__title' }, title) : null,
      el('div', { class: 'chart__empty' }, 'Sem dados para gráfico'),
    ]);
  }

  const scale = fixedScale || (scaleMode === 'usd'
    ? yScaleFromUsdValues(scaleValues, assetSymbol)
    : yScaleFromUsdValues(scaleValues, assetSymbol));
  const plotW = 1000;
  const plotH = compact ? 120 : 280;
  const maxX = Math.max(...active.flatMap((item) => item.points.map((point) => point.x)), 1);

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
    const points = item.points.filter((point) => point.y != null && Number.isFinite(point.y));
    const path = buildPath(points, scale, maxX, plotW, plotH);
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

function tickSeries(ticks, key, kind, asset) {
  return ticks.map((tick, index) => {
    const raw = tick[key];
    const parsed = raw != null ? Number(raw) : null;
    let y = null;
    if (kind === 'spot') y = isValidSpotPrice(parsed, asset) ? parsed : null;
    else if (kind === 'ptb') y = isValidPtbPrice(parsed, asset) ? parsed : null;
    else if (kind === 'odds') y = isValidOddsPrice(parsed) ? parsed : null;
    else y = Number.isFinite(parsed) ? parsed : null;
    return { x: index, y };
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

function trimLeadingInvalidTicks(ticks, asset) {
  let firstValidIdx = 0;
  while (firstValidIdx < ticks.length) {
    const row = ticks[firstValidIdx];
    const hasSpot = isValidSpotPrice(row.underlying_price, asset);
    const hasPtb = isValidPtbPrice(row.price_to_beat, asset);
    if (hasSpot && hasPtb) break;
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
  const validTicks = trimLeadingInvalidTicks(ticks, asset);

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
    {
      label: `Preço ${asset}`,
      color: '#3b82f6',
      key: 'underlying_price',
      dash: false,
      points: tickSeries(validTicks, 'underlying_price', 'spot', asset),
    },
    {
      label: 'PTB (price to beat)',
      color: '#eab308',
      key: 'price_to_beat',
      dash: true,
      points: tickSeries(validTicks, 'price_to_beat', 'ptb', asset),
    },
  ];

  const oddsSeries = [
    { label: 'UP', color: '#10b981', key: 'up_price' },
    { label: 'DOWN', color: '#f43f5e', key: 'down_price' },
  ].map((item) => ({
    label: item.label,
    color: item.color,
    key: item.key,
    points: tickSeries(validTicks, item.key, 'odds', asset),
  }));

  const chartOpts = {
    xAxisLabels,
    compact: opts.compact === true,
    overlayBands: opts.overlayBands || [],
    assetSymbol: asset,
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
        scaleMode: 'usd',
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
        scaleMode: 'odds',
        fixedScale: { y0: 0, y1: 1 },
        refLines: [{ y: 0.5 }],
      }),
    ]),
  ]);
}
