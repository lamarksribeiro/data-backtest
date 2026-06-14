/** Catalogo canonico de blocos GLS v1 (MVP). */
export const HOOKS = new Set(['onEventStart', 'onTick', 'onEventEnd']);

export const ORDER_FUNCTIONS = new Set(['enter', 'exit', 'reverse', 'closeOpenPosition']);

export const DEBUG_FUNCTIONS = new Set(['log', 'mark', 'metric']);

export const ROOT_BINDINGS = new Set(['params', 'state', 'runState', 'position', 'tick', 'event', 'samples']);

export const BLOCK_CATALOG = {
  market: [
    'distanceFromPtb',
    'directionFromPtb',
    'sideFromPrice',
    'isAbovePtb',
    'isBelowPtb',
  ],
  prices: ['mid', 'marketProbUp', 'priceForSide', 'oppositeSide'],
  book: ['ask', 'bid', 'spread', 'availableQty', 'liquidityRatio'],
  signals: ['momentum', 'slowMomentum', 'volatility', 'directionalEdge', 'zScore', 'effectiveMinDistance', 'stopReverseMinDistance', 'underlyingAgo'],
  risk: ['sizeByBudget', 'capOrderValue', 'stopBid', 'takeProfit', 'trailingStop'],
  time: ['secondsUntil', 'secondsSince', 'inWindow', 'isNearExpiry'],
  math: ['abs', 'min', 'max', 'clamp', 'sqrt', 'logistic', 'erf', 'normalCdf'],
  model: ['directionProbability', 'scoreSides', 'scoreImpulseElasticitySides'],
  debug: ['log', 'mark', 'metric'],
};

export function listBlockSignatures() {
  const blocks = [];
  for (const [namespace, methods] of Object.entries(BLOCK_CATALOG)) {
    for (const method of methods) {
      blocks.push({ namespace, name: method, signature: `${namespace}.${method}(...)` });
    }
  }
  for (const name of ORDER_FUNCTIONS) {
    blocks.push({ namespace: 'orders', name, signature: `${name}(...)` });
  }
  return blocks;
}

export function isKnownCall(path) {
  if (ORDER_FUNCTIONS.has(path)) return true;
  if (DEBUG_FUNCTIONS.has(path)) return true;
  const dot = path.indexOf('.');
  if (dot <= 0) return false;
  const ns = path.slice(0, dot);
  const fn = path.slice(dot + 1);
  return BLOCK_CATALOG[ns]?.includes(fn) ?? false;
}
