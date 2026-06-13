const MIN_SPOT_USD = {
  BTC: 1000,
  ETH: 100,
  SOL: 10,
  XRP: 0.1,
  DOGE: 0.001,
  HYPE: 1,
  BNB: 10,
};

const DEFAULT_MIN_SPOT_USD = 1000;

export function minSpotUsd(underlying) {
  return MIN_SPOT_USD[String(underlying || '').toUpperCase()] ?? DEFAULT_MIN_SPOT_USD;
}

export function resolveChartThresholds(config = {}, ticks = []) {
  const underlying = config.underlying || ticks[0]?.underlying || null;
  const assetMin = minSpotUsd(underlying);
  const minSpot = Number(config.minSpotPrice) > 0 ? Number(config.minSpotPrice) : assetMin;
  const minPtb = Number(config.minPriceToBeat) > 0 ? Number(config.minPriceToBeat) : assetMin;
  return { underlying, minSpot, minPtb };
}
