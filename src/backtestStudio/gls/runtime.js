import { createStandardLibrary, normalizeTick, buildEventFromTick } from './standardLibrary.js';
import { createOrderSimulator, settleEventPnl } from './orderSimulator.js';
import { createTraceCollector } from './traceCollector.js';
import { DEBUG_FUNCTIONS, ORDER_FUNCTIONS } from './blocks.js';
import { compileStrategy } from './compiler.js';
import { compileStrategySoa } from './compilerSoa.js';
import {
  createTickCursorView,
  eventRecordFromColumnSet,
  msToIso,
  snapshotTickCursorView,
} from '../../backtest/columnStore.js';
import { parse } from './parser.js';
import { compileStrategyJs } from '../strategyJs/compile.js';
import { inferNativeLibrariesFromAst } from '../strategyJs/dependencies.js';
import { ensureStrategyLibraryDatabase } from '../nativeLibrary/registry.js';
import { applyEmbeddedModelsToLib } from '../strategyJs/embeddedModels.js';
import { getCachedSoaHooks } from '../strategyJs/compiledCache.js';
import { loadConfig } from '../../config.js';

const DEFAULT_LIMITS = {
  maxRuntimeMs: 900000,
  maxEventRuntimeMs: 5000,
  maxLogsPerEvent: 200,
  maxMarksPerEvent: 200,
  maxOrdersPerEvent: 20,
  maxOperationsPerTick: 10000,
};

const NOOP_TRACE = {
  log() {},
  mark() {},
  metric() {},
  snapshot: () => ({ logs: [], marks: [], metrics: {} }),
  reset() {},
};

export function createGlsBacktestRunner(ast, rawParams = {}, options = {}) {
  if (!ast || ast.type !== 'Strategy') throw new Error('Invalid GLS strategy AST');
  const params = mergeParams(ast.params, rawParams);
  const fastRun = Boolean(options.fastRun);
  const limits = {
    ...DEFAULT_LIMITS,
    ...options.limits,
    ...(fastRun ? { maxLogsPerEvent: 0, maxMarksPerEvent: 0 } : {}),
  };
  const onEventFinalized = typeof options.onEventFinalized === 'function' ? options.onEventFinalized : null;
  const embeddedModelsSource = options.embeddedModelsSource ?? (options.embeddedModels ? options.strategySourceCode : null);
  const nativeLibraries = embeddedModelsSource
    ? []
    : (options.nativeLibraries
      ?? options.extensionLibraries
      ?? inferNativeLibrariesFromAst(ast));
  if (nativeLibraries.length > 0) {
    ensureStrategyLibraryDatabase(options.db);
  }
  const lib = createStandardLibrary({ nativeLibraries });
  if (embeddedModelsSource) {
    applyEmbeddedModelsToLib(embeddedModelsSource, lib);
  }

  const events = [];
  const equity = [];
  const log = [];
  const completedEvents = new Set();
  let totalPnl = 0;
  let totalEntries = 0;
  let wins = 0;
  let losses = 0;
  let ticksProcessed = 0;
  let currentKey = null;
  let currentEvent = null;
  let runState = { totalPnl: 0 };
  let state = {};
  let samples = [];
  let orderSim = null;
  let trace = null;
  let ordersApi = null;
  let debugApi = null;
  let normalizedHolder = null;
  let sharedCtx = null;
  let currentLastTick = null;
  let startedAt = null;
  const executionMode = options.executionMode ?? loadConfig().glsExecution;
  const compiled = executionMode === 'compiled' ? compileStrategy(ast) : null;
  const compiledSoa = executionMode === 'compiled-soa'
    ? (getCachedSoaHooks(options.generatedSource) ?? compileStrategySoa(ast, options.bookDepth ?? 25))
    : null;
  const interpreter = executionMode === 'interpreter' ? createInterpreter() : null;
  let columnSet = null;
  let tickCursor = null;
  let soaEvent = null;

  function mergeParams(declarations, overrides) {
    const merged = {};
    for (const decl of declarations || []) merged[decl.name] = decl.default;
    return { ...merged, ...overrides };
  }

  function eventKey(tick) {
    return `${tick.condition_id}|${tick.event_start}`;
  }

  function tickTimestamp(tick) {
    if (tick?._tsMs != null && Number.isFinite(tick._tsMs)) return tick._tsMs;
    if (typeof tick?.ts === 'number') return tick.ts;
    return tick?.ts ?? null;
  }

  function resetEventContext() {
    state = {};
    samples = [];
    orderSim = createOrderSimulator({
      limits: {
        ...limits,
        ...(Number.isFinite(Number(params.makerFillEpsilon)) ? { makerFillEpsilon: Number(params.makerFillEpsilon) } : {}),
        ...(params.makerFillPolicy ? { makerFillPolicy: String(params.makerFillPolicy) } : {}),
      },
    });
    trace = fastRun ? NOOP_TRACE : createTraceCollector({ limits });
    currentLastTick = null;
    normalizedHolder = { tick: null };
    ordersApi = {
      enter: (side, opts = {}) => orderSim.enter(side, { ...opts, tick: normalizedHolder.tick, ts: tickTimestamp(normalizedHolder.tick) }),
      exit: (opts = {}) => orderSim.exit({ ...opts, tick: normalizedHolder.tick, ts: tickTimestamp(normalizedHolder.tick) }),
      reverse: (side, opts = {}) => orderSim.reverse(side, { ...opts, tick: normalizedHolder.tick, ts: tickTimestamp(normalizedHolder.tick) }),
      closeOpenPosition: (opts = {}) => orderSim.closeOpenPosition({ ...opts, tick: normalizedHolder.tick, ts: tickTimestamp(normalizedHolder.tick) }),
      placeLimitBuy: (side, opts = {}) => orderSim.placeLimitBuy(side, { ...opts, tick: normalizedHolder.tick, ts: tickTimestamp(normalizedHolder.tick) }),
      placeBuyStop: (side, opts = {}) => orderSim.placeBuyStop(side, { ...opts, tick: normalizedHolder.tick, ts: tickTimestamp(normalizedHolder.tick) }),
      cancelLimit: (id) => orderSim.cancelLimit(id ?? null),
    };
    debugApi = fastRun
      ? { log() {}, mark() {}, metric() {} }
      : {
        log: (name, value) => trace.log(name, value, tickTimestamp(normalizedHolder.tick)),
        mark: (name, data) => trace.mark(name, data, tickTimestamp(normalizedHolder.tick)),
        metric: (name, value) => trace.metric(name, value, tickTimestamp(normalizedHolder.tick)),
      };
    sharedCtx = {
      params,
      state,
      runState,
      position: orderSim.positionView,
      tick: null,
      event: null,
      samples,
      lib,
      orders: ordersApi,
      debug: debugApi,
    };
  }

  function shouldEarlyFinalizeEvent() {
    if (!currentEvent) return false;
    const snap = orderSim.snapshot();
    const hadEntry = snap.orders.some((o) => o.type === 'entry');
    if (!hadEntry || orderSim.positionView.open) return false;
    if (orderSim.hasOpenRestingOrders()) return false;
    return true;
  }

  function finalizeEvent(lastTick) {
    if (!currentEvent) return;
    orderSim.expireRestingOrders();
    const snap = orderSim.snapshot();
    const settlement = settleEventPnl(orderSim, lastTick, currentEvent);
    const pnl = settlement.finalPnl;
    totalPnl += pnl;
    runState.totalPnl = totalPnl;
    const hadEntry = snap.orders.some((o) => o.type === 'entry');
    if (hadEntry) totalEntries += 1;
    if (pnl > 0) wins += 1;
    else if (pnl < 0 && hadEntry) losses += 1;

    const closedAt = closedAtForEvent(snap, lastTick, currentEvent);
    const entryOrder = snap.orders
      .filter((o) => !o?.type || o.type === 'entry')
      .sort((a, b) => new Date(a.ts || a.createdAt || 0) - new Date(b.ts || b.createdAt || 0))[0];
    const priceToBeat = resolvePriceToBeat(currentEvent, lastTick, samples);
    const entryMetrics = computeEntryMetrics(entryOrder, { ...currentEvent, priceToBeat }, samples);
    const eventRecord = {
      eventId: currentEvent.eventId,
      eventStart: currentEvent.eventStart,
      eventEnd: currentEvent.eventEnd,
      priceToBeat,
      positionType: snap.position?.side ?? entryOrder?.side ?? null,
      entryTime: entryOrder?.ts ?? null,
      entryDistanceToPtb: entryMetrics.entryDistanceToPtb,
      entryTimeRemaining: entryMetrics.entryTimeRemaining,
      quantity: entryOrder?.shares ?? snap.position?.shares ?? 0,
      cost: entryOrder?.notional ?? snap.position?.cost ?? 0,
      avgEntryPrice: entryOrder?.price ?? snap.position?.avgPrice ?? null,
      orders: snap.orders,
      exits: snap.exits,
      expirationResult: settlement.expirationResult,
      winnerSide: settlement.winnerSide ?? null,
      expiryPnl: settlement.expiryPnl ?? 0,
      finalPnl: pnl,
      reason: snap.orders.length ? settlement.reason : 'no_entry',
      restingOrders: snap.restingOrders,
      hedgeFill: settlement.hedgeFill ?? null,
      hedgePnl: settlement.hedgePnl ?? null,
      primaryLotPnl: settlement.primaryLotPnl ?? null,
      lotPnls: settlement.lotPnls ?? null,
      closedAt,
      ...(fastRun ? {} : {
        marketId: lastTick?.market_id ?? null,
        marks: trace.snapshot().marks,
        logs: trace.snapshot().logs,
        metrics: trace.snapshot().metrics,
        diagnostics: buildDiagnosticsFromState(state),
        ticksProcessed: samples.length,
      }),
    };
    events.push(eventRecord);
    equity.push({ ts: closedAt, pnl: totalPnl });
    if (!fastRun && onEventFinalized) {
      onEventFinalized(eventRecord, [...samples]);
    }
    completedEvents.add(currentKey);
    currentEvent = null;
    currentKey = null;
  }

  function buildRuntimeContext(tick, event) {
    const normalized = tick?.underlyingPrice != null && tick?.priceToBeat != null ? tick : normalizeTick(tick);
    orderSim.updatePeakBid(normalized, lib);
    orderSim.checkRestingOrders(normalized);
    normalizedHolder.tick = normalized;
    sharedCtx.tick = normalized;
    sharedCtx.event = event;
    lib.setActiveSamples?.(samples);
    return sharedCtx;
  }

  function runHook(name, ctx) {
    if (compiledSoa?.[name]) {
      compiledSoa[name](ctx, columnSet.columns, lib, ordersApi, debugApi);
      return;
    }
    if (compiled?.[name]) {
      compiled[name](ctx, lib, ordersApi, debugApi);
      return;
    }
    const hook = ast.hooks?.[name];
    if (!hook?.body?.length || !interpreter) return;
    interpreter.run(hook.body, ctx);
  }

  function bindColumnSet(nextColumnSet) {
    columnSet = nextColumnSet;
    tickCursor = createTickCursorView(columnSet);
  }

  function beginEvent(eventMeta) {
    if (!columnSet || !compiledSoa) return;
    soaEvent = eventRecordFromColumnSet(columnSet, eventMeta);
    resetEventContext();
    currentKey = `${columnSet.dictionaries.get('condition_id')?.[eventMeta.conditionCode] ?? ''}|${msToIso(eventMeta.eventStart)}`;
    currentEvent = soaEvent;
    const ctx = buildRuntimeContext(tickCursor, soaEvent);
    ctx.__i = eventMeta.startRow;
    runHook('onEventStart', ctx);
  }

  function endEvent(eventMeta) {
    if (!columnSet || !compiledSoa || !currentEvent) return;
    const lastIndex = Math.max(eventMeta.endRow - 1, eventMeta.startRow);
    tickCursor.setIndex(lastIndex);
    const ctx = buildRuntimeContext(tickCursor, currentEvent);
    ctx.__i = lastIndex;
    runHook('onEventEnd', ctx);
    finalizeEvent(tickCursor);
  }

  function processIndex(rowIndex) {
    if (!columnSet || !tickCursor || !compiledSoa) return;
    // Espelha processTick: após fechamento antecipado do evento, ignorar ticks restantes.
    if (!currentEvent) return;
    if (startedAt == null) startedAt = Date.now();
    ticksProcessed += 1;
    if (Date.now() - startedAt > limits.maxRuntimeMs) {
      throw new Error('failed_resource_limit: maxRuntimeMs exceeded');
    }

    tickCursor.setIndex(rowIndex);
    samples.push(snapshotTickCursorView(tickCursor));

    const ctx = buildRuntimeContext(tickCursor, currentEvent);
    ctx.__i = rowIndex;
    runHook('onTick', ctx);
    currentLastTick = tickCursor;

    if (shouldEarlyFinalizeEvent()) {
      runHook('onEventEnd', ctx);
      finalizeEvent(tickCursor);
    }
  }

  function processTick(rawTick) {
    if (startedAt == null) startedAt = Date.now();
    ticksProcessed += 1;
    if (Date.now() - startedAt > limits.maxRuntimeMs) {
      throw new Error('failed_resource_limit: maxRuntimeMs exceeded');
    }

    const tick = normalizeTick(rawTick);
    const key = eventKey(tick);
    if (completedEvents.has(key)) return;

    if (key !== currentKey) {
      if (currentEvent) {
        runHook('onEventEnd', buildRuntimeContext(tick, currentEvent));
        finalizeEvent(currentLastTick ?? tick);
      }
      resetEventContext();
      currentKey = key;
      currentEvent = buildEventFromTick(tick);
      runHook('onEventStart', buildRuntimeContext(tick, currentEvent));
    }

    if ((tick._tsMs ?? new Date(tick.ts).getTime()) >= new Date(currentEvent.eventEnd).getTime()) {
      currentLastTick = tick;
      runHook('onEventEnd', buildRuntimeContext(tick, currentEvent));
      finalizeEvent(tick);
      return;
    }

    samples.push(tick);

    const ctx = buildRuntimeContext(tick, currentEvent);
    runHook('onTick', ctx);
    currentLastTick = tick;

    if (shouldEarlyFinalizeEvent()) {
      runHook('onEventEnd', ctx);
      finalizeEvent(tick);
    }
  }

  function importParallelSlices(slices) {
    const ordered = slices.slice().sort((left, right) => left.eventIndexOffset - right.eventIndexOffset);
    events.length = 0;
    equity.length = 0;
    ticksProcessed = 0;
    totalEntries = 0;
    wins = 0;
    losses = 0;

    for (const slice of ordered) {
      ticksProcessed += Number(slice.ticksProcessed || 0);
      const part = slice.result;
      totalEntries += Number(part.summary?.totalEntries ?? part.summary?.entries ?? 0);
      wins += Number(part.summary?.wins ?? part.summary?.totalWins ?? 0);
      losses += Number(part.summary?.losses ?? part.summary?.totalLosses ?? 0);
      for (const eventRecord of part.events) events.push(eventRecord);
    }

    totalPnl = 0;
    for (const eventRecord of events) {
      totalPnl += Number(eventRecord.finalPnl || 0);
      equity.push({ ts: eventRecord.closedAt, pnl: totalPnl });
    }
    runState.totalPnl = totalPnl;
  }

  function finish() {
    if (currentEvent) {
      const ctx = buildRuntimeContext({ ts: currentEvent.eventEnd, condition_id: currentEvent.eventId, event_start: currentEvent.eventStart, event_end: currentEvent.eventEnd, price_to_beat: currentEvent.priceToBeat }, currentEvent);
      runHook('onEventEnd', ctx);
      finalizeEvent(currentLastTick ?? { ts: currentEvent.eventEnd, condition_id: currentEvent.eventId, price_to_beat: currentEvent.priceToBeat });
    }

    return {
      strategy: ast.name,
      summary: buildSummary({ events, equity, totalEntries, wins, losses, totalPnl, ticksProcessed }),
      events,
      equity,
      log,
    };
  }

  return {
    processTick,
    processIndex,
    bindColumnSet,
    beginEvent,
    endEvent,
    importParallelSlices,
    finish,
    executionMode,
  };
}

function closedAtForEvent(snapshot, lastTick, currentEvent) {
  if (!snapshot?.position && snapshot?.exits?.length) {
    return snapshot.exits[snapshot.exits.length - 1].ts ?? lastTick?.ts ?? currentEvent.eventEnd;
  }
  return lastTick?.ts ?? currentEvent.eventEnd;
}

function computeEntryMetrics(entryOrder, currentEvent, samples = []) {
  if (!entryOrder?.ts && !entryOrder?.createdAt) return { entryDistanceToPtb: null, entryTimeRemaining: null };
  const entryTs = entryOrder.ts || entryOrder.createdAt;
  const entryMs = new Date(entryTs).getTime();
  const eventEndMs = new Date(currentEvent?.eventEnd).getTime();
  const entryTimeRemaining = Number.isFinite(entryMs) && Number.isFinite(eventEndMs)
    ? Math.max(0, Math.round((eventEndMs - entryMs) / 1000))
    : null;

  const ptb = Number(currentEvent?.priceToBeat);
  let entryTick = null;
  if (Number.isFinite(entryMs) && samples.length) {
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const sample of samples) {
      const sampleMs = new Date(sample.ts).getTime();
      if (!Number.isFinite(sampleMs)) continue;
      const diff = Math.abs(sampleMs - entryMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        entryTick = sample;
      }
    }
  }
  const spot = Number(entryTick?.underlying_price ?? entryTick?.underlyingPrice);
  const entryDistanceToPtb = Number.isFinite(ptb) && Number.isFinite(spot)
    ? Math.abs(spot - ptb)
    : null;
  return { entryDistanceToPtb, entryTimeRemaining };
}

function resolvePriceToBeat(currentEvent, lastTick, samples = []) {
  const fromEvent = Number(currentEvent?.priceToBeat);
  if (Number.isFinite(fromEvent) && fromEvent > 0) return fromEvent;
  const fromTick = Number(lastTick?.price_to_beat ?? lastTick?.priceToBeat);
  if (Number.isFinite(fromTick) && fromTick > 0) return fromTick;
  for (const sample of samples) {
    const value = Number(sample.price_to_beat ?? sample.priceToBeat);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function buildDiagnosticsFromState(sourceState) {
  if (!sourceState || typeof sourceState !== 'object') return null;
  const allowed = [
    'lastNoEntryReason',
    'lastNoEntryDetail',
    'lastCandidateSide',
    'lastCandidateAsk',
    'lastCandidateEdge',
    'lastCandidateProbability',
    'lastLiquidityRatio',
    'lastDistance',
    'lastMinDistance',
    'lastSecsLeft',
    'lastElapsed',
  ];
  const diagnostics = {};
  for (const key of allowed) {
    const value = sourceState[key];
    if (value != null && Number.isFinite(Number(value))) diagnostics[key] = Number(value);
    else if (value != null && typeof value !== 'object') diagnostics[key] = value;
  }
  return Object.keys(diagnostics).length ? diagnostics : null;
}

function buildSummary({ events, equity, totalEntries, wins, losses, totalPnl, ticksProcessed }) {
  const traded = events.filter((event) => event.reason !== 'no_entry');
  const noEntryReasons = countNoEntryReasons(events);
  const pnls = traded.map((event) => Number(event.finalPnl || 0));
  const winPnls = pnls.filter((pnl) => pnl > 0);
  const lossPnls = pnls.filter((pnl) => pnl < 0);
  const grossProfit = winPnls.reduce((sum, pnl) => sum + pnl, 0);
  const grossLoss = Math.abs(lossPnls.reduce((sum, pnl) => sum + pnl, 0));
  const maxDrawdown = maxEquityDrawdown(equity);
  const totalVolume = traded.reduce((sum, event) => {
    const orderVolume = [...(event.orders || []), ...(event.exits || [])]
      .reduce((orderSum, order) => orderSum + Math.abs(Number(order.notional || 0)), 0);
    return sum + orderVolume;
  }, 0);

  return {
    totalEvents: events.length,
    totalNoEntry: events.length - traded.length,
    noEntryReasons,
    eventsWithEntries: traded.length,
    totalEntries,
    entries: totalEntries,
    wins,
    losses,
    totalWins: wins,
    totalLosses: losses,
    winRate: totalEntries ? (wins / totalEntries) * 100 : 0,
    totalPnl,
    avgPnl: pnls.length ? pnls.reduce((sum, pnl) => sum + pnl, 0) / pnls.length : 0,
    avgWin: winPnls.length ? grossProfit / winPnls.length : 0,
    avgLoss: lossPnls.length ? -grossLoss / lossPnls.length : 0,
    maxWin: winPnls.length ? Math.max(...winPnls) : 0,
    maxLoss: lossPnls.length ? Math.min(...lossPnls) : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    winLossRatio: grossLoss > 0 && winPnls.length && lossPnls.length
      ? (grossProfit / winPnls.length) / (grossLoss / lossPnls.length)
      : 0,
    maxDrawdown,
    volume: totalVolume,
    ticksProcessed,
  };
}

function countNoEntryReasons(events) {
  const counts = {};
  for (const event of events || []) {
    if (event.reason !== 'no_entry') continue;
    const reason = event.diagnostics?.lastNoEntryReason || 'unknown';
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

function maxEquityDrawdown(equity) {
  let peak = 0;
  let maxDrawdown = 0;
  for (const point of equity || []) {
    const pnl = Number(point.pnl || 0);
    peak = Math.max(peak, pnl);
    maxDrawdown = Math.max(maxDrawdown, peak - pnl);
  }
  return maxDrawdown;
}

function createInterpreter() {
  let ctx = null;
  let ops = 0;
  const locals = new Map();

  function run(body, runCtx) {
    ctx = runCtx;
    ops = 0;
    locals.clear();
    runBlock(body);
  }

  function runBlock(body) {
    for (const stmt of body) runStatement(stmt);
  }

  function runStatement(stmt) {
    switch (stmt.type) {
      case 'Let':
        setLocal(stmt.name, evalExpr(stmt.value));
        break;
      case 'Assign':
        assignTarget(stmt.target, evalExpr(stmt.value));
        break;
      case 'If':
        if (truthy(evalExpr(stmt.test))) runBlock(stmt.consequent);
        else if (stmt.alternate) runBlock(stmt.alternate);
        break;
      case 'ExprStmt':
        evalExpr(stmt.expr);
        break;
      default:
        break;
    }
  }

  function setLocal(name, value) {
    locals.set(name, value);
  }

  function assignTarget(node, value) {
    if (node.type === 'Member') {
      const root = rootName(node);
      const path = memberPath(node);
      if (root === 'state') setPath(ctx.state, path.slice(1), value);
      else if (root === 'runState') setPath(ctx.runState, path.slice(1), value);
      return;
    }
    throw new Error('Invalid assignment target');
  }

  function evalExpr(node) {
    ops += 1;
    if (ops > 10000) throw new Error('failed_resource_limit: maxOperationsPerTick exceeded');
    switch (node.type) {
      case 'Literal':
        return node.value;
      case 'Identifier':
        if (locals.has(node.name)) return locals.get(node.name);
        if (node.name === 'params') return ctx.params;
        if (node.name === 'state') return ctx.state;
        if (node.name === 'runState') return ctx.runState;
        if (node.name === 'position') return ctx.position;
        if (node.name === 'tick') return ctx.tick;
        if (node.name === 'event') return ctx.event;
        if (node.name === 'samples') return ctx.samples;
        throw new Error(`Undefined variable: ${node.name}`);
      case 'Unary':
        return node.operator === '!' ? !truthy(evalExpr(node.argument)) : evalExpr(node.argument);
      case 'Binary': {
        const left = evalExpr(node.left);
        if (node.operator === '&&') return truthy(left) ? evalExpr(node.right) : left;
        if (node.operator === '||') return truthy(left) ? left : evalExpr(node.right);
        const right = evalExpr(node.right);
        switch (node.operator) {
          case '+': return Number(left) + Number(right);
          case '-': return Number(left) - Number(right);
          case '*': return Number(left) * Number(right);
          case '/': return Number(right) === 0 ? 0 : Number(left) / Number(right);
          case '==': return left == right;
          case '!=': return left != right;
          case '<': return Number(left) < Number(right);
          case '<=': return Number(left) <= Number(right);
          case '>': return Number(left) > Number(right);
          case '>=': return Number(left) >= Number(right);
          default: return null;
        }
      }
      case 'Member': {
        const obj = evalExpr(node.object);
        if (obj && typeof obj === 'object') return obj[node.property];
        return undefined;
      }
      case 'ObjectLiteral': {
      const obj = {};
      for (const prop of node.properties || []) obj[prop.key] = evalExpr(prop.value);
      return obj;
    }
    case 'Call':
        return evalCall(node);
      default:
        return null;
    }
  }

  function evalCall(node) {
    const path = callPath(node.callee);
    const args = node.args.map((arg) => evalExpr(arg));
    if (ORDER_FUNCTIONS.has(path)) {
      if (path === 'enter') return ctx.orders.enter(args[0], objectArg(args[1]));
      if (path === 'exit') return ctx.orders.exit(objectArg(args[0]));
      if (path === 'reverse') return ctx.orders.reverse(args[0], objectArg(args[1]));
      if (path === 'closeOpenPosition') return ctx.orders.closeOpenPosition(objectArg(args[0]));
      if (path === 'placeLimitBuy') return ctx.orders.placeLimitBuy(args[0], objectArg(args[1]));
      if (path === 'placeBuyStop') return ctx.orders.placeBuyStop(args[0], objectArg(args[1]));
      if (path === 'cancelLimit') return ctx.orders.cancelLimit(args[0] ?? null);
    }
    if (DEBUG_FUNCTIONS.has(path)) {
      if (path === 'log') return ctx.debug.log(args[0], args[1]);
      if (path === 'mark') return args.length > 1 ? ctx.debug.mark(args[0], args[1]) : ctx.debug.mark(args[0], {});
      if (path === 'metric') return ctx.debug.metric(args[0], args[1]);
    }
    const dot = path.indexOf('.');
    if (dot > 0) {
      const ns = path.slice(0, dot);
      const fn = path.slice(dot + 1);
      const target = ctx.lib[ns];
      if (target?.[fn]) return target[fn](...args);
    }
    throw new Error(`Unknown function: ${path}`);
  }

  return { run };
}

function objectArg(value) {
  return value && typeof value === 'object' ? value : {};
}

function truthy(value) {
  return Boolean(value);
}

function callPath(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Member' && node.object.type === 'Identifier') {
    return `${node.object.name}.${node.property}`;
  }
  return '';
}

function rootName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Member') return rootName(node.object);
  return '';
}

function memberPath(node) {
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'Member') return [...memberPath(node.object), node.property];
  return [];
}

function setPath(obj, path, value) {
  if (!path.length) return;
  let cur = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    if (cur[path[i]] == null || typeof cur[path[i]] !== 'object') cur[path[i]] = {};
    cur = cur[path[i]];
  }
  cur[path[path.length - 1]] = value;
}

export function createGlsRunnerFromSource(source, params = {}, options = {}) {
  const ast = resolveSourceToAst(source, options);
  return createGlsBacktestRunner(ast, params, options);
}

function resolveSourceToAst(source, options = {}) {
  const code = String(source || '').trim();
  const language = options.language || detectSourceLanguage(code);
  if (language === 'strategy-js-v1') {
    const result = compileStrategyJs(code);
    if (!result.ok) throw new Error(result.errors[0]?.message || 'Strategy JS compilation failed');
    return result.ast;
  }
  return parse(code);
}

function detectSourceLanguage(code) {
  if (/^export\s+default\s+strategy\s*\(/.test(code) || /^strategy\s*\(\s*\{/.test(code)) {
    return 'strategy-js-v1';
  }
  return 'gls-v1';
}
