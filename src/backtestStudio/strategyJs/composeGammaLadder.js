import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseGls } from '../gls/parser.js';
import { EMBEDDED_RUNNER_FACTORY } from './embeddedRunner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_BOOTSTRAP = path.resolve(__dirname, '../../../data/strategy-libraries/gamma-ladder-engine.v1.json');

const TICK_BRIDGE_HELPERS = `
function __gammaLevelsFromFlattened(row, prefix, depth) {
  const asks = [];
  const bids = [];
  for (let i = 1; i <= depth; i += 1) {
    const askPx = Number(row[prefix + '_ask_px_' + i]);
    const askSz = Number(row[prefix + '_ask_sz_' + i]);
    if (Number.isFinite(askPx) && Number.isFinite(askSz)) asks.push({ price: askPx, size: askSz });
    const bidPx = Number(row[prefix + '_bid_px_' + i]);
    const bidSz = Number(row[prefix + '_bid_sz_' + i]);
    if (Number.isFinite(bidPx) && Number.isFinite(bidSz)) bids.push({ price: bidPx, size: bidSz });
  }
  return { asks, bids };
}

function __gammaLegacyTick(tick, bookDepth = 25) {
  if (tick?.up_book_asks != null || tick?._parsed_up_book_asks != null) return tick;
  const row = {
    ts: tick.ts,
    event_start: tick.event_start ?? tick.eventStart,
    event_end: tick.event_end ?? tick.eventEnd,
    condition_id: tick.condition_id ?? tick.conditionId,
    btc_price: tick.btc_price ?? tick.underlyingPrice ?? tick.underlying_price,
    underlying_price: tick.underlying_price ?? tick.underlyingPrice ?? tick.btc_price,
    price_to_beat: tick.price_to_beat ?? tick.priceToBeat,
    up_price: tick.up_price ?? tick.upPrice,
    down_price: tick.down_price ?? tick.downPrice,
    up_best_ask: tick.up_best_ask ?? tick.upBestAsk,
    up_best_bid: tick.up_best_bid ?? tick.upBestBid,
    down_best_ask: tick.down_best_ask ?? tick.downBestAsk,
    down_best_bid: tick.down_best_bid ?? tick.downBestBid,
  };
  for (const key of Object.keys(tick)) {
    if (/^(up|down)_(ask|bid)_(px|sz)_\\d+$/.test(key)) row[key] = tick[key];
  }
  const up = __gammaLevelsFromFlattened(row, 'up', bookDepth);
  const down = __gammaLevelsFromFlattened(row, 'down', bookDepth);
  return {
    ...row,
    id: tick.id ?? 0,
    up_book_asks: up.asks,
    up_book_bids: up.bids,
    down_book_asks: down.asks,
    down_book_bids: down.bids,
    _parsed_up_book_asks: up.asks,
    _parsed_up_book_bids: up.bids,
    _parsed_down_book_asks: down.asks,
    _parsed_down_book_bids: down.bids,
  };
}

function __gammaEnsureRunner(state, params) {
  if (!state.__gammaRunner) state.__gammaRunner = ${EMBEDDED_RUNNER_FACTORY}(params);
  return state.__gammaRunner;
}

function __gammaProcessTick(state, params, tick) {
  const runner = __gammaEnsureRunner(state, params);
  runner.processTick(__gammaLegacyTick(tick));
}
`;

const STRATEGY_WRAPPER_FOOTER = (name, paramsBlock) => `
export default strategy({
  name: ${JSON.stringify(name)},

  params: {
${paramsBlock}
  },

  onEventStart({ state, params }) {
    state.__gammaRunner = ${EMBEDDED_RUNNER_FACTORY}(params);
  },

  onTick(ctx) {
    __gammaProcessTick(ctx.state, ctx.params, ctx.tick);
  },

  onEventEnd() {},
});
`;

function stripDuplicateHelperFunctions(source) {
  const end = '\r?\n}\r?\n\r?\n';
  return String(source || '')
    .replace(new RegExp(`^function toFiniteNumber[\\s\\S]*?${end}`, 'm'), '')
    .replace(new RegExp(`^function toBool[\\s\\S]*?${end}`, 'm'), '')
    .replace(new RegExp(`^function clamp[\\s\\S]*?${end}`, 'm'), '');
}

function loadEngineModuleSource(enginePath = ENGINE_BOOTSTRAP) {
  const raw = JSON.parse(readFileSync(enginePath, 'utf8')).source_code;
  const stopReverseStart = raw.search(/\bconst\s+DEFAULT_STOP_REVERSE_PARAMS\s*=\s*\{/);
  const gammaStart = raw.search(/\bconst\s+DEFAULT_PARAMS\s*=\s*\{/);
  const gammaEnd = raw.search(/\bfunction\s+runGammaLadderBacktest\b/);
  const stopReverseBlock = raw.slice(
    stopReverseStart >= 0 ? stopReverseStart : 0,
    gammaStart > 0 ? gammaStart : raw.length,
  ).trim();
  const gammaBlock = stripDuplicateHelperFunctions(raw.slice(
    gammaStart > 0 ? gammaStart : 0,
    gammaEnd > 0 ? gammaEnd : raw.length,
  ).trim());
  const moduleSource = `${stopReverseBlock}\n\n${gammaBlock}`.trim();
  return moduleSource
    .replace(/function\s+createBacktestRunner\b/g, `function ${EMBEDDED_RUNNER_FACTORY}`)
    .replace(/function\s+createGammaLadderBacktestRunner\b/g, `function ${EMBEDDED_RUNNER_FACTORY}`)
    .replace(/Math\.SQRT2/g, '1.4142135623730951');
}

function formatParamsBlock(ast) {
  const lines = [];
  for (const param of ast.params || []) {
    lines.push(`    ${param.name}: ${formatLiteral(param.default)},`);
  }
  return lines.join('\n');
}

function formatLiteral(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value == null) return 'null';
  return String(value);
}

export function composeGammaLadderStrategyJs(glsSource, { name = null, enginePath = ENGINE_BOOTSTRAP } = {}) {
  const ast = typeof glsSource === 'string' ? parseGls(glsSource) : glsSource;
  const strategyName = name || ast.name || 'Gamma Ladder V1';
  const engine = loadEngineModuleSource(enginePath);
  const paramsBlock = formatParamsBlock(ast);
  return `${engine}\n${TICK_BRIDGE_HELPERS}\n${STRATEGY_WRAPPER_FOOTER(strategyName, paramsBlock)}`;
}