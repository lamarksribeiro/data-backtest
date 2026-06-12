import { el, mount } from '../utils/dom.js';
import { destroyChartsIn, renderUplotLine } from '../utils/uplotChart.js';

function toAlignedPoints(series = []) {
  return series
    .filter((point) => point?.ts != null)
    .map((point) => {
      const value = point.value;
      return [new Date(point.ts).getTime(), value != null && Number.isFinite(value) ? value : null];
    });
}

function hasValues(points = []) {
  return points.some((point) => point[1] != null && Number.isFinite(point[1]));
}

function regionsFromPreview(preview) {
  const regions = (preview?.trim_regions || []).map((region) => ({
    from: new Date(region.from).getTime(),
    to: new Date(region.to).getTime(),
    color: region.kind === 'underlying_stale' ? 'rgba(245, 158, 11, 0.18)' : 'rgba(239, 68, 68, 0.18)',
  }));

  if (preview?.action === 'omit') {
    const underlying = preview.series?.underlying || [];
    if (underlying.length >= 2) {
      regions.push({
        from: new Date(underlying[0].ts).getTime(),
        to: new Date(underlying[underlying.length - 1].ts).getTime(),
        color: 'rgba(239, 68, 68, 0.22)',
      });
    }
  }

  return regions;
}

function issueLabel(issue) {
  if (issue === 'clob_stale') return 'CLOB travado';
  if (issue === 'underlying_stale') return 'Spot travado';
  return issue;
}

export async function renderQualityEventChart(container, preview) {
  if (!container || !preview) return null;
  destroyChartsIn(container);

  const regions = regionsFromPreview(preview);
  const underlyingPts = toAlignedPoints(preview.series?.underlying);
  const ptbPts = toAlignedPoints(preview.series?.price_to_beat);
  const upPts = toAlignedPoints(preview.series?.up);
  const downPts = toAlignedPoints(preview.series?.down);

  const trimRegions = preview?.trim_regions || [];
  const legendSwatches = [
    trimRegions.some((region) => region.kind === 'clob_stale')
      ? el('span', { class: 'quality-event-chart__swatch quality-event-chart__swatch--clob' }, 'CLOB stale')
      : null,
    trimRegions.some((region) => region.kind === 'underlying_stale')
      ? el('span', { class: 'quality-event-chart__swatch quality-event-chart__swatch--underlying' }, 'Spot stale')
      : null,
    preview.action === 'omit'
      ? el('span', { class: 'quality-event-chart__swatch quality-event-chart__swatch--omit' }, 'Evento omitido')
      : null,
  ].filter(Boolean);

  mount(container, el('div', { class: 'quality-event-chart' }, [
    el('div', { class: 'quality-event-chart__summary' }, [
      el('span', { class: `event-badge event-badge--${preview.action === 'omit' ? 'omit' : preview.action === 'trim' ? 'trim' : 'ok'}` },
        preview.action === 'omit' ? 'omitido' : preview.action === 'trim' ? 'aparado' : 'ok'),
      preview.issues?.length
        ? el('span', { class: 'quality-event-chart__issues' }, preview.issues.map(issueLabel).join(' · '))
        : null,
      el('span', { class: 'muted' }, `${preview.ticks_out ?? 0}/${preview.ticks_in ?? 0} ticks exportados`),
    ]),
    legendSwatches.length
      ? el('div', { class: 'quality-event-chart__legend' }, [
        el('span', {}, 'Faixas: '),
        ...legendSwatches,
      ])
      : null,
    el('div', { class: 'quality-event-chart__panel' }, [
      el('div', { class: 'quality-event-chart__title' }, 'Underlying × PTB'),
      el('div', { class: 'quality-event-chart__plot', id: 'quality-event-chart-spot' }),
    ]),
    el('div', { class: 'quality-event-chart__panel' }, [
      el('div', { class: 'quality-event-chart__title' }, 'UP × DOWN'),
      el('div', { class: 'quality-event-chart__plot', id: 'quality-event-chart-clob' }),
    ]),
  ]));

  const spotEl = container.querySelector('#quality-event-chart-spot');
  const clobEl = container.querySelector('#quality-event-chart-clob');

  const spotPrimary = hasValues(underlyingPts) ? underlyingPts : ptbPts;
  const spotExtra = hasValues(underlyingPts) && hasValues(ptbPts)
    ? [{ label: 'PTB', data: ptbPts }]
    : [];

  if (hasValues(spotPrimary)) {
    await renderUplotLine(spotEl, spotPrimary, spotExtra, {
      primaryLabel: hasValues(underlyingPts) ? 'Underlying' : 'PTB',
      regions,
      height: 180,
      yRange: 'tight',
    });
  } else {
    mount(spotEl, el('p', { class: 'muted' }, 'Sem série de underlying/PTB.'));
  }

  const clobExtra = [];
  if (hasValues(upPts) && hasValues(downPts)) clobExtra.push({ label: 'DOWN', data: downPts });
  const clobPrimary = hasValues(upPts) ? upPts : downPts;

  if (hasValues(clobPrimary)) {
    await renderUplotLine(clobEl, clobPrimary, clobExtra, {
      primaryLabel: hasValues(upPts) ? 'UP' : 'DOWN',
      regions,
      height: 160,
      yRange: 'tight',
    });
  } else {
    mount(clobEl, el('p', { class: 'muted' }, 'Sem série UP/DOWN.'));
  }

  return container;
}
