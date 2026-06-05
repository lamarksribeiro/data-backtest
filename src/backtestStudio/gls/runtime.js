import { createStandardLibrary, normalizeTick, buildEventFromTick } from './standardLibrary.js';
import { createOrderSimulator, settleEventPnl } from './orderSimulator.js';
import { createTraceCollector } from './traceCollector.js';
import { DEBUG_FUNCTIONS, ORDER_FUNCTIONS } from './blocks.js';
import { parse } from './parser.js';

const DEFAULT_LIMITS = {
  maxRuntimeMs: 120000,
  maxEventRuntimeMs: 5000,
  maxLogsPerEvent: 200,
  maxMarksPerEvent: 200,
  maxOrdersPerEvent: 20,
  maxOperationsPerTick: 10000,
};

export function createGlsBacktestRunner(ast, rawParams = {}, options = {}) {
  if (!ast || ast.type !== 'Strategy') throw new Error('Invalid GLS strategy AST');
  const params = mergeParams(ast.params, rawParams);
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const lib = createStandardLibrary();

  const events = [];
  const equity = [];
  const log = [];
  let totalPnl = 0;
  let totalEntries = 0;
  let wins = 0;
  let losses = 0;
  let ticksProcessed = 0;
  let currentKey = null;
  let currentEvent = null;
  let runState = {};
  let state = {};
  let samples = [];
  let orderSim = null;
  let trace = null;
  let startedAt = Date.now();

  function mergeParams(declarations, overrides) {
    const merged = {};
    for (const decl of declarations || []) merged[decl.name] = decl.default;
    return { ...merged, ...overrides };
  }

  function eventKey(tick) {
    return `${tick.condition_id}|${tick.event_start}`;
  }

  function resetEventContext() {
    state = {};
    samples = [];
    orderSim = createOrderSimulator({ limits });
    trace = createTraceCollector({ limits });
  }

  function finalizeEvent(lastTick) {
    if (!currentEvent) return;
    const snap = orderSim.snapshot();
    const settlement = settleEventPnl(orderSim, lastTick, currentEvent);
    const traces = trace.snapshot();
    const pnl = settlement.finalPnl;
    totalPnl += pnl;
    if (snap.orders.some((o) => o.type === 'entry')) totalEntries += 1;
    if (pnl > 0) wins += 1;
    else if (pnl < 0 && snap.orders.some((o) => o.type === 'entry')) losses += 1;

    const eventRecord = {
      eventId: currentEvent.eventId,
      eventStart: currentEvent.eventStart,
      eventEnd: currentEvent.eventEnd,
      marketId: lastTick?.market_id ?? null,
      positionType: snap.position?.side ?? (snap.orders.find((o) => o.type === 'entry')?.side ?? null),
      entryTime: snap.orders.find((o) => o.type === 'entry')?.ts ?? null,
      quantity: snap.orders.find((o) => o.type === 'entry')?.shares ?? 0,
      cost: snap.orders.find((o) => o.type === 'entry')?.notional ?? 0,
      avgEntryPrice: snap.orders.find((o) => o.type === 'entry')?.price ?? null,
      orders: snap.orders,
      exits: snap.exits,
      marks: traces.marks,
      logs: traces.logs,
      metrics: traces.metrics,
      expirationResult: settlement.expirationResult,
      winnerSide: settlement.winnerSide ?? null,
      expiryPnl: settlement.expiryPnl ?? 0,
      finalPnl: pnl,
      reason: snap.orders.length ? settlement.reason : 'no_entry',
      closedAt: lastTick?.ts ?? currentEvent.eventEnd,
    };
    events.push(eventRecord);
    equity.push({ ts: eventRecord.closedAt, pnl: totalPnl });
    currentEvent = null;
    currentKey = null;
  }

  function buildRuntimeContext(tick, event) {
    const normalized = normalizeTick(tick);
    orderSim.updatePeakBid(normalized, lib);

    const ordersApi = {
      enter: (side, opts = {}) => orderSim.enter(side, { ...opts, ts: normalized.ts }),
      exit: (opts = {}) => orderSim.exit({ ...opts, ts: normalized.ts }),
      reverse: (side, opts = {}) => orderSim.reverse(side, { ...opts, ts: normalized.ts }),
      closeOpenPosition: (opts = {}) => orderSim.closeOpenPosition({ ...opts, tick: normalized, ts: normalized.ts }),
    };

    const debugApi = {
      log: (name, value) => trace.log(name, value, normalized.ts),
      mark: (name, data) => trace.mark(name, data, normalized.ts),
      metric: (name, value) => trace.metric(name, value, normalized.ts),
    };

    return {
      params,
      state,
      runState,
      position: orderSim.positionView,
      tick: normalized,
      event,
      samples,
      lib,
      orders: ordersApi,
      debug: debugApi,
    };
  }

  function runHook(name, ctx, extraArgs = []) {
    const hook = ast.hooks?.[name];
    if (!hook?.body?.length) return;
    const interpreter = createInterpreter(ctx);
    interpreter.runBlock(hook.body);
  }

  function processTick(rawTick) {
    ticksProcessed += 1;
    if (Date.now() - startedAt > limits.maxRuntimeMs) {
      throw new Error('failed_resource_limit: maxRuntimeMs exceeded');
    }

    const tick = normalizeTick(rawTick);
    const key = eventKey(tick);
    if (key !== currentKey) {
      if (currentEvent) {
        runHook('onEventEnd', buildRuntimeContext(tick, currentEvent));
        finalizeEvent(tick);
      }
      resetEventContext();
      currentKey = key;
      currentEvent = buildEventFromTick(tick);
      runHook('onEventStart', buildRuntimeContext(tick, currentEvent));
    }

    samples.push(tick);
    if (samples.length > 500) samples.shift();

    const ctx = buildRuntimeContext(tick, currentEvent);
    runHook('onTick', ctx);
  }

  function finish() {
    if (currentEvent) {
      const ctx = buildRuntimeContext({ ts: currentEvent.eventEnd, condition_id: currentEvent.eventId, event_start: currentEvent.eventStart, event_end: currentEvent.eventEnd, price_to_beat: currentEvent.priceToBeat }, currentEvent);
      runHook('onEventEnd', ctx);
      finalizeEvent({ ts: currentEvent.eventEnd, condition_id: currentEvent.eventId, price_to_beat: currentEvent.priceToBeat });
    }

    return {
      strategy: ast.name,
      summary: {
        totalEvents: events.length,
        totalEntries,
        wins,
        losses,
        totalPnl,
        ticksProcessed,
      },
      events,
      equity,
      log,
    };
  }

  return { processTick, finish };
}

function createInterpreter(ctx) {
  let ops = 0;

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

  const locals = new Map();

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

  return { runBlock };
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
  const ast = parse(source);
  return createGlsBacktestRunner(ast, params, options);
}
