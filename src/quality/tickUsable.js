const DEFAULT_MIN_PTB = 1000;

function isPriceInRange(value) {
  return value != null && Number.isFinite(value) && value >= 0 && value <= 1;
}

function quotesValid(tick) {
  const pairs = [
    [tick.upBestBid, tick.upBestAsk],
    [tick.downBestBid, tick.downBestAsk],
  ];
  for (const [bid, ask] of pairs) {
    if (bid == null && ask == null) continue;
    if (bid != null && (!Number.isFinite(bid) || bid < 0 || bid > 1)) return false;
    if (ask != null && (!Number.isFinite(ask) || ask < 0 || ask > 1)) return false;
    if (bid != null && ask != null && bid > ask) return false;
  }
  return true;
}

export function getTickQualityIssues(tick, { minPriceToBeat = DEFAULT_MIN_PTB } = {}) {
  const issues = [];
  const hasUnderlying = tick.underlyingPrice != null && tick.underlyingPrice > 0;
  const hasUp = isPriceInRange(tick.upPrice);
  const hasDown = isPriceInRange(tick.downPrice);
  const hasPtb = tick.priceToBeat != null && tick.priceToBeat > minPriceToBeat;

  if (!hasUnderlying && (hasUp || hasDown)) issues.push('null_underlying');
  if (hasUnderlying && (!hasUp || !hasDown)) issues.push('outcome_missing');
  if (!hasPtb) issues.push('ptb_missing');
  if ((hasUp || hasDown) && !quotesValid(tick)) issues.push('quote_invalid');
  if (!hasUnderlying || !hasUp || !hasDown || !hasPtb) issues.push('feed_incomplete');

  return issues;
}

export function isTickUsable(tick, opts = {}) {
  return getTickQualityIssues(tick, opts).length === 0;
}

export function pricesEqual(left, right, decimals = 4) {
  if (left == null || right == null) return left === right;
  const factor = 10 ** decimals;
  return Math.round(left * factor) === Math.round(right * factor);
}
