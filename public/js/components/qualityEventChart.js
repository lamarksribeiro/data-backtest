import { el, mount } from '../utils/dom.js';
import { destroyChartsIn, renderUplotLine } from '../utils/uplotChart.js';

function toPoints(series = []) {
  return series
    .filter((point) => point?.ts != null && point.value != null && Number.isFinite(point.value))
    .map((point) => [new Date(point.ts).getTime(), point.value]);
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
  const underlyingPts = toPoints(preview.series?.underlying);
  const ptbPts = toPoints(preview.series?.price_to_beat);
  const upPts = toPoints(preview.series?.up);
  const downPts = toPoints(preview.series?.down);

  mount(container, el('div', { class: 'quality-event-chart' }, [
    el('div', { class: 'quality-event-chart__summary' }, [
      el('span', { class: `event-badge event-badge--${preview.action === 'omit' ? 'omit' : preview.action === 'trim' ? 'trim' : 'ok'}` },
        preview.action === 'omit' ? 'omitido' : preview.action === 'trim' ? 'aparado' : 'ok'),
      preview.issues?.length
        ? el('span', { class: 'quality-event-chart__issues' }, preview.issues.map(issueLabel).join(' · '))
        : null,
      el('span', { class: 'muted' }, `${preview.ticks_out ?? 0}/${preview.ticks_in ?? 0} ticks exportados`),
    ]),
    el('div', { class: 'quality-event-chart__legend' }, [
      el('span', {}, 'Faixas: '),
      el('span', { class: 'quality-event-chart__swatch quality-event-chart__swatch--clob' }, 'CLOB stale'),
      el('span', { class: 'quality-event-chart__swatch quality-event-chart__swatch--underlying' }, 'Spot stale'),
      preview.action === 'omit' ? el('span', { class: 'quality-event-chart__swatch quality-event-chart__swatch--omit' }, 'Evento omitido') : null,
    ]),
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

  if (underlyingPts.length) {
    await renderUplotLine(spotEl, underlyingPts, [
      { label: 'Underlying', data: underlyingPts },
      ...(ptbPts.length ? [{ label: 'PTB', data: ptbPts }] : []),
    ], { regions, height: 180 });
  } else {
    mount(spotEl, el('p', { class: 'muted' }, 'Sem série de underlying.'));
  }

  if (upPts.length || downPts.length) {
    await renderUplotLine(clobEl, upPts.length ? upPts : downPts, [
      ...(upPts.length ? [{ label: 'UP', data: upPts }] : []),
      ...(downPts.length ? [{ label: 'DOWN', data: downPts }] : []),
    ], { regions, height: 160 });
  } else {
    mount(clobEl, el('p', { class: 'muted' }, 'Sem série UP/DOWN.'));
  }

  return container;
}
