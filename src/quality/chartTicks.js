import { resolveChartThresholds } from './underlyingThresholds.js';

const DEFAULT_CHART_SAMPLE_SIZE = 400;

export function spotPriceForChart(value, minSpot = 1000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minSpot) return null;
  return parsed;
}

export function ptbForChart(value, minPtb = 1000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minPtb) return null;
  return parsed;
}

function oddsForChart(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return null;
  return parsed;
}

export function subsampleChartTicks(ticks, sampleSize = DEFAULT_CHART_SAMPLE_SIZE) {
  if (!ticks?.length || ticks.length <= sampleSize) return ticks || [];
  if (sampleSize <= 1) return [ticks[0]];
  const sampled = [];
  for (let index = 0; index < sampleSize; index += 1) {
    const sourceIndex = Math.round((index * (ticks.length - 1)) / (sampleSize - 1));
    sampled.push(ticks[sourceIndex]);
  }
  return sampled;
}

function trimLeadingChartTicks(rows) {
  let firstValidIdx = 0;
  while (firstValidIdx < rows.length) {
    const row = rows[firstValidIdx];
    if (row.underlying_price != null && row.price_to_beat != null) break;
    firstValidIdx += 1;
  }
  return rows.slice(firstValidIdx);
}

function mapTickToChartRow(tick, minSpot, minPtb) {
  return {
    ts: tick.ts,
    underlying_price: spotPriceForChart(tick.underlyingPrice, minSpot),
    price_to_beat: ptbForChart(tick.priceToBeat, minPtb),
    up_price: oddsForChart(tick.upPrice),
    down_price: oddsForChart(tick.downPrice),
  };
}

/**
 * Monta ticks para o gráfico a partir dos ticks exportáveis do evento.
 * Eventos OK usam exatamente os ticks que entram no Parquet.
 */
export function buildChartTicksFromScalars(ticks, config = {}) {
  const { minSpot, minPtb } = resolveChartThresholds(config, ticks);
  const sampleSize = Number(config.chartSampleSize) > 0 ? Number(config.chartSampleSize) : DEFAULT_CHART_SAMPLE_SIZE;
  const sorted = [...ticks].sort((left, right) => String(left.ts).localeCompare(String(right.ts)));
  const mapped = sorted.map((tick) => mapTickToChartRow(tick, minSpot, minPtb));
  const trimmed = trimLeadingChartTicks(mapped);
  const chartable = trimmed.filter((row) => row.underlying_price != null && row.price_to_beat != null);
  const source = chartable.length >= 2 ? chartable : trimmed;
  return subsampleChartTicks(source, sampleSize);
}

export function summarizeChartTicks(chartTicks = []) {
  const spotValues = chartTicks
    .map((row) => row.underlying_price)
    .filter((value) => value != null && Number.isFinite(value));
  const ptbValues = chartTicks
    .map((row) => row.price_to_beat)
    .filter((value) => value != null && Number.isFinite(value));
  if (!spotValues.length) {
    return {
      spot_points: 0,
      spot_min: null,
      spot_max: null,
      spot_range: 0,
      ptb: ptbValues[0] ?? null,
      has_spot_movement: false,
    };
  }
  const spotMin = Math.min(...spotValues);
  const spotMax = Math.max(...spotValues);
  return {
    spot_points: spotValues.length,
    spot_min: spotMin,
    spot_max: spotMax,
    spot_range: spotMax - spotMin,
    ptb: ptbValues[0] ?? null,
    has_spot_movement: spotMax - spotMin > Math.max(spotMin * 0.00001, 0.5),
  };
}
