import { el, mount } from '../utils/dom.js';
import { explorerTickCharts, underlyingDecimals } from '../utils/lineChart.js';

function previewToTicks(preview) {
  if (Array.isArray(preview?.chart_ticks) && preview.chart_ticks.length) {
    return preview.chart_ticks;
  }
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

function tickCountLabel(preview, sampled) {
  if (sampled) {
    return `${preview.chart_ticks.length} pontos amostrados de ${preview.ticks_in ?? preview.chart_ticks.length}`;
  }
  if (preview.data_role === 'parquet') {
    return `${preview.ticks_out ?? 0} ticks no Parquet`;
  }
  return `${preview.ticks_in ?? 0} ticks brutos`;
}

function renderChartPanel(title, hint, preview, asset, { overlayBands = null } = {}) {
  const ticks = previewToTicks(preview);
  const spotPoints = preview.chart_meta?.spot_points
    ?? ticks.filter((row) => row.underlying_price != null).length;
  const sampled = preview.chart_ticks?.length > 0
    && preview.chart_ticks.length < (preview.ticks_in ?? preview.chart_ticks.length);

  return el('div', { class: 'quality-event-chart__panel' }, [
    el('div', { class: 'quality-event-chart__panel-head' }, [
      el('h4', { class: 'quality-event-chart__panel-title' }, title),
      el('p', { class: 'quality-event-chart__panel-hint muted' }, hint),
      el('span', { class: 'quality-event-chart__panel-meta muted' }, tickCountLabel(preview, sampled)),
    ]),
    spotPoints < 2
      ? el('p', { class: 'muted quality-event-chart__panel-empty' }, 'Sem preço spot válido para gráfico.')
      : explorerTickCharts(ticks, {
        assetSymbol: asset,
        yAxisDecimals: underlyingDecimals(asset),
        overlayBands: overlayBands || [],
        compact: true,
      }),
  ]);
}

export function renderQualityEventChart(container, payload, opts = {}) {
  if (!container || !payload) return null;

  const asset = opts.assetSymbol || payload.underlying || 'BTC';
  const original = payload.original ?? payload.preview ?? payload;
  const parquet = payload.parquet ?? null;
  const parquetAvailable = Boolean(payload.parquet_available);

  const trimRegions = original?.trim_regions || [];
  const originalTicks = previewToTicks(original);
  const overlayBands = overlayBandsFromPreview(originalTicks, original);

  const legendSwatches = [
    trimRegions.some((region) => region.kind === 'clob_stale')
      ? el('span', { class: 'quality-event-chart__swatch quality-event-chart__swatch--clob' }, 'CLOB stale')
      : null,
    trimRegions.some((region) => region.kind === 'underlying_stale')
      ? el('span', { class: 'quality-event-chart__swatch quality-event-chart__swatch--underlying' }, 'Spot stale')
      : null,
    original.action === 'omit'
      ? el('span', { class: 'quality-event-chart__swatch quality-event-chart__swatch--omit' }, 'Evento omitido')
      : null,
  ].filter(Boolean);

  const parquetHint = !parquetAvailable
    ? `Partição ${payload.partition_status || 'indisponível'} — sync ainda não exportou este dia.`
    : parquet?.ticks_out
      ? 'Dados já normalizados no lakehouse (trechos ruins removidos).'
      : 'Evento omitido do export — nenhum tick no Parquet.';

  mount(container, el('div', { class: 'quality-event-chart' }, [
    el('div', { class: 'quality-event-chart__summary' }, [
      el('span', { class: `event-badge event-badge--${original.action === 'omit' ? 'omit' : original.action === 'trim' ? 'trim' : 'ok'}` },
        original.action === 'omit' ? 'omitido' : original.action === 'trim' ? 'aparado' : 'ok'),
      original.issues?.length
        ? el('span', { class: 'quality-event-chart__issues' }, original.issues.map(issueLabel).join(' · '))
        : null,
      el('span', { class: 'muted' },
        `export: ${original.ticks_out ?? 0}/${original.ticks_in ?? 0} ticks`),
    ]),
    legendSwatches.length
      ? el('div', { class: 'quality-event-chart__legend' }, [
        el('span', {}, 'Faixas (coletor): '),
        ...legendSwatches,
      ])
      : null,
    el('div', { class: 'quality-event-chart__compare' }, [
      renderChartPanel(
        'Coletor (bruto)',
        'Postgres do data-colector · faixas = trechos que o sync remove ou apara.',
        original,
        asset,
        { overlayBands },
      ),
      parquetAvailable && parquet
        ? renderChartPanel('Parquet exportado', parquetHint, parquet, asset)
        : el('div', { class: 'quality-event-chart__panel quality-event-chart__panel--empty' }, [
          el('div', { class: 'quality-event-chart__panel-head' }, [
            el('h4', { class: 'quality-event-chart__panel-title' }, 'Parquet exportado'),
            el('p', { class: 'quality-event-chart__panel-hint muted' }, parquetHint),
          ]),
        ]),
    ]),
  ]));

  return container;
}
