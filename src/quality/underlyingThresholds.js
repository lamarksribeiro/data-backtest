import {
  minSpotUsd,
  underlyingDecimals,
  MIN_SPOT_USD,
  UNDERLYING_DECIMALS,
  DEFAULT_MIN_SPOT_USD,
  listedUnderlyings,
} from '../../public/shared/underlyingAssets.js';

export {
  minSpotUsd,
  underlyingDecimals,
  MIN_SPOT_USD,
  UNDERLYING_DECIMALS,
  DEFAULT_MIN_SPOT_USD,
  listedUnderlyings,
};

export function resolveChartThresholds(config = {}, ticks = []) {
  const underlying = config.underlying || ticks[0]?.underlying || null;
  const assetMin = minSpotUsd(underlying);
  const minSpot = Number(config.minSpotPrice) > 0 ? Number(config.minSpotPrice) : assetMin;
  const minPtb = Number(config.minPriceToBeat) > 0 ? Number(config.minPriceToBeat) : assetMin;
  return { underlying, minSpot, minPtb };
}
