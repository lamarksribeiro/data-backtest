export const LANGUAGE = 'strategy-js-v1';
export const LANGUAGE_VERSION = 'strategy-js-v1';
export const STDLIB_VERSION = 'stdlib-v3';
export const COMPILER_VERSION = 'compiler-soa-v3';

export const MAX_SOURCE_BYTES = 256_000;
export const MAX_AST_DEPTH = 64;
export const MAX_AST_NODES = 80_000;
export const MAX_BODY_STATEMENTS = 500;
export const MAX_HOOKS = 10;

export const ALLOWED_HOOKS = new Set(['onEventStart', 'onTick', 'onEventEnd']);

export const CTX_BINDINGS = new Set(['tick', 'event', 'state', 'runState', 'position', 'params', 'samples']);

export const ORDER_ALIASES = {
  'orders.enter': 'enter',
  'orders.exit': 'exit',
  'orders.reverse': 'reverse',
  'orders.closeOpenPosition': 'closeOpenPosition',
};

export const TRACE_ALIASES = {
  'trace.log': 'log',
  'trace.mark': 'mark',
  'trace.metric': 'metric',
};

export const TOP_LEVEL_ORDER = new Set(['enter', 'exit', 'reverse', 'closeOpenPosition']);
export const TOP_LEVEL_TRACE = new Set(['log', 'mark', 'metric']);

export const MATH_WHITELIST = new Set([
  'abs', 'min', 'max', 'sqrt', 'floor', 'ceil', 'round', 'trunc', 'sign', 'pow', 'hypot', 'log', 'exp', 'cbrt',
]);

export const MATH_TO_STDLIB = {
  abs: 'abs',
  min: 'min',
  max: 'max',
  sqrt: 'sqrt',
  floor: 'floor',
  ceil: 'ceil',
  round: 'round',
  trunc: 'trunc',
  sign: 'sign',
  pow: 'pow',
  hypot: 'hypot',
  log: 'log',
  exp: 'exp',
  cbrt: 'cbrt',
};

export const FORBIDDEN_IDENTIFIERS = new Set([
  'import', 'require', 'eval', 'Function', 'fetch', 'setTimeout', 'setInterval',
  'Promise', 'async', 'await', 'global', 'globalThis', 'process', 'window', 'document',
]);

export const FORBIDDEN_MEMBER_ROOTS = new Set(['Math', 'Date', 'console', 'process', 'global', 'globalThis']);

export const TICK_PROP_TO_COLUMN = {
  underlyingPrice: 'underlying_price',
  priceToBeat: 'price_to_beat',
  upPrice: 'up_price',
  downPrice: 'down_price',
  conditionId: 'condition_id',
  eventStart: 'event_start',
  eventEnd: 'event_end',
  marketId: 'market_id',
  ts: 'ts',
};
