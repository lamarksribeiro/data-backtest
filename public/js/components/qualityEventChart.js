import { el, mount } from '../utils/dom.js';
import { explorerTickCharts, underlyingDecimals } from '../utils/lineChart.js';

function previewToTicks(preview) {
  const underlying = preview?.series?.underlying || [];
  return underlying.map((row, index) => ({
    ts: row.ts,
    underlying_price: row.value,
    price_to_beat: preview.series?.price_to_beat?.[index]?.value ?? null,
    up_price: preview.series?.up?.[index]?.value ?? null,
    down_price: preview.series?.down?.[index]?.value ?? null,
  }));
}

function indexForTimestamp(ticks, ts) {
  const target = new Date(ts).getTime();
  if (!Number.isFinite(target) || !ticks.length) return 0;
  for (let index = 0; index < ticks.length; index += 1) {
    const current = new Date(ticks[index].ts).getTime();
    if (Number.isFinite(current) && current >= target) return index;
  }
  return ticks.length - 1;
}

function overlayBandsFromPreview(ticks, preview) {
  const bands = (preview?.trim_regions || []).map((region) => ({
    x0: indexForTimestamp(ticks, region.from),
    x1: indexForTimestamp(ticks, region.to),
    color: region.kind === 'underlying_stale' ? 'rgba(245, 158, 11, 0.18)' : 'rgba(239, 68, 68, 0.18)',
  }));

  if (preview?.action === 'omit' && ticks.length >= 2) {
    bands.push({
      x0: 0,
      x1: ticks.length - 1,
      color: 'rgba(239, 68, 68, 0.22)',
    });
  }

  return bands;
}

function issueLabel(issue) {
  if (issue === 'clob_stale') return 'CLOB travado';
  if (issue === 'underlying_stale') return 'Spot travado';
  return issue;
}

export function renderQualityEventChart(container, preview, opts = {}) {
  if (!container || !preview) return null;

  const asset = opts.assetSymbol || preview.underlying || 'BTC';
  const ticks = previewToTicks(preview);
  const overlayBands = overlayBandsFromPreview(ticks, preview);
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
    explorerTickCharts(ticks, {
      assetSymbol: asset,
      yAxisDecimals: underlyingDecimals(asset),
      overlayBands,
      compact: true,
    }),
  ]));

  return container;
}
