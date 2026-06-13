/** Fonte única de limiares e formatação por underlying (backend + frontend). */

export const MIN_SPOT_USD = {
  BTC: 1000,
  ETH: 100,
  SOL: 10,
  XRP: 0.1,
  DOGE: 0.001,
  HYPE: 1,
  BNB: 10,
};

export const UNDERLYING_DECIMALS = {
  BTC: 2,
  ETH: 2,
  SOL: 2,
  XRP: 4,
  DOGE: 6,
  HYPE: 2,
  BNB: 2,
};

export const DEFAULT_MIN_SPOT_USD = 1000;
export const DEFAULT_UNDERLYING_DECIMALS = 2;

export function normalizeUnderlying(symbol) {
  return String(symbol || '').toUpperCase();
}

export function minSpotUsd(underlying) {
  return MIN_SPOT_USD[normalizeUnderlying(underlying)] ?? DEFAULT_MIN_SPOT_USD;
}

export function underlyingDecimals(underlying) {
  return UNDERLYING_DECIMALS[normalizeUnderlying(underlying)] ?? DEFAULT_UNDERLYING_DECIMALS;
}

export function listedUnderlyings() {
  return Object.keys(MIN_SPOT_USD);
}
