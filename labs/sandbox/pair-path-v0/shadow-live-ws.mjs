/**
 * Pair-Path V0 shadow LIVE via CLOB Market WebSocket (zero orders).
 *
 * Book updates on WS tick; engine onTick on every best-ask change + 250ms heartbeat.
 * REST used only to resolve market tokens + seed books.
 *
 *   node labs/sandbox/pair-path-v0/shadow-live-ws.mjs --events 3 --full-event
 *   node ... --preset presets/size-fee-v0.json --label sizefee-ws
 *
 * Giovanna:
 *   npm i && node shadow-live-ws.mjs --events 3 --full-event --preset presets/size-fee-v0.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createEventEngine, DEFAULT_PARAMS } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const args = process.argv.slice(2);

function hasFlag(f) {
  return args.includes(f);
}
function argVal(name, fb) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return fb;
}

const FULL_EVENT = hasFlag('--full-event') || Number(argVal('events', '1')) > 1;
const EVENTS = Math.max(1, Number(argVal('events', '1')) || 1);
const MIN_TAU = Math.max(0, Number(argVal('min-tau', '40')) || 40);
const HEARTBEAT_MS = Math.max(50, Number(argVal('heartbeat-ms', '100')) || 100);
const LABEL = String(argVal('label', 'shadow-ws'));
const OUT_ROOT = process.env.BALIZA_OUT || path.join(ROOT, '.tmp/pair-path-v0-shadow-ws');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const CLOB_WS = process.env.CLOB_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function nowIso() {
  return new Date().toISOString();
}
function nowMs() {
  return Date.now();
}

function loadParams() {
  const presetRel = argVal('preset', path.join(__dirname, 'presets/size-fee-v0.json'));
  const presetPath = path.isAbsolute(presetRel) ? presetRel : path.resolve(process.cwd(), presetRel);
  const alt = path.join(__dirname, 'presets/size-fee-v0.json');
  const p = fs.existsSync(presetPath) ? presetPath : alt;
  if (!fs.existsSync(p)) return { ...DEFAULT_PARAMS };
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { ...DEFAULT_PARAMS, ...(j.params || j) };
}

async function fetchJson(url, timeoutMs = 10000) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'pair-path-v0-shadow-ws/1.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    if (!res.ok) return { ok: false, ms, data: null, err: `http ${res.status}` };
    return { ok: true, ms, data: await res.json(), err: null };
  } catch (e) {
    return { ok: false, ms: Math.round((performance.now() - t0) * 10) / 10, data: null, err: String(e?.message || e) };
  }
}

function currentSlug(nowSec = Math.floor(Date.now() / 1000)) {
  const start = nowSec - (nowSec % 300);
  return `btc-updown-5m-${start}`;
}
function eventStart(slug) {
  const m = String(slug).match(/btc-updown-5m-(\d+)/i);
  return m ? Number(m[1]) : null;
}
function parseTokens(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      return Array.isArray(j) ? j.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function resolveMarket(slug) {
  const r = await fetchJson(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
  if (!r.ok) throw new Error(`gamma: ${r.err}`);
  const event = Array.isArray(r.data) ? r.data[0] : r.data;
  const m = (event?.markets || [])[0];
  const tokens = parseTokens(m?.clobTokenIds || m?.clob_token_ids);
  if (tokens.length < 2) throw new Error('need 2 tokens');
  return {
    slug,
    eventStart: eventStart(slug),
    tokens: { UP: tokens[0], DOWN: tokens[1] },
    resolveMs: r.ms,
  };
}

function bestFromLevels(levels, dir) {
  let best = null;
  for (const level of levels || []) {
    const p = Number(level.price ?? level[0]);
    if (!Number.isFinite(p)) continue;
    if (best == null) best = p;
    else if (dir === 'ask' && p < best) best = p;
    else if (dir === 'bid' && p > best) best = p;
  }
  return best;
}

/** Minimal dual-side book maintained from WS + REST seed */
function createBookPair(tokenUp, tokenDown) {
  const state = {
    UP: { asks: new Map(), bids: new Map(), bestAsk: null, bestBid: null },
    DOWN: { asks: new Map(), bids: new Map(), bestAsk: null, bestBid: null },
    tokenUp: String(tokenUp),
    tokenDown: String(tokenDown),
    lastUpdateMs: null,
    wsConnected: false,
    msgCount: 0,
    bookEvents: 0,
    priceChanges: 0,
  };

  function sync(side) {
    const s = state[side];
    let bestAsk = null;
    for (const [p, sz] of s.asks) {
      if (sz <= 0) continue;
      const price = Number(p);
      if (bestAsk == null || price < bestAsk) bestAsk = price;
    }
    let bestBid = null;
    for (const [p, sz] of s.bids) {
      if (sz <= 0) continue;
      const price = Number(p);
      if (bestBid == null || price > bestBid) bestBid = price;
    }
    s.bestAsk = bestAsk;
    s.bestBid = bestBid;
  }

  function setLevel(map, price, size) {
    const key = String(price);
    if (size <= 0) map.delete(key);
    else map.set(key, size);
  }

  function rebuild(side, bids, asks) {
    const s = state[side];
    s.asks.clear();
    s.bids.clear();
    for (const a of asks || []) setLevel(s.asks, a.price, parseFloat(a.size || 0));
    for (const b of bids || []) setLevel(s.bids, b.price, parseFloat(b.size || 0));
    sync(side);
    state.lastUpdateMs = nowMs();
  }

  function sideOfAsset(assetId) {
    const id = String(assetId || '');
    if (id === state.tokenUp) return 'UP';
    if (id === state.tokenDown) return 'DOWN';
    return null;
  }

  function processMessage(data) {
    if (!data || data.event_type === 'market_resolved') return false;
    const side = sideOfAsset(data.asset_id);
    if (!side) return false;
    state.msgCount += 1;

    if (data.event_type === 'book') {
      rebuild(side, data.bids || [], data.asks || []);
      state.bookEvents += 1;
      return true;
    }
    if (data.event_type === 'price_change') {
      const s = state[side];
      let changed = false;
      for (const c of data.changes || []) {
        const size = parseFloat(c.size || 0);
        if (c.side === 'SELL') {
          setLevel(s.asks, c.price, size);
          changed = true;
        }
        if (c.side === 'BUY') {
          setLevel(s.bids, c.price, size);
          changed = true;
        }
      }
      if (changed) {
        sync(side);
        state.lastUpdateMs = nowMs();
        state.priceChanges += 1;
      }
      return changed;
    }
    if (data.event_type === 'best_bid_ask') {
      // optional compact event
      const s = state[side];
      if (data.best_ask != null) s.bestAsk = Number(data.best_ask);
      if (data.best_bid != null) s.bestBid = Number(data.best_bid);
      state.lastUpdateMs = nowMs();
      return true;
    }
    return false;
  }

  async function seedFromRest() {
    const [up, dn] = await Promise.all([
      fetchJson(`${CLOB}/book?token_id=${encodeURIComponent(state.tokenUp)}`),
      fetchJson(`${CLOB}/book?token_id=${encodeURIComponent(state.tokenDown)}`),
    ]);
    if (up.ok) rebuild('UP', up.data.bids || [], up.data.asks || []);
    if (dn.ok) rebuild('DOWN', dn.data.bids || [], dn.data.asks || []);
    return { upMs: up.ms, dnMs: dn.ms };
  }

  return {
    state,
    processMessage,
    seedFromRest,
    bestAsks: () => ({ UP: state.UP.bestAsk, DOWN: state.DOWN.bestAsk }),
  };
}

function connectMarketWs(book, onBookUpdate) {
  let ws = null;
  let stopped = false;
  let pingTimer = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;

  function subscribe() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        assets_ids: [book.state.tokenUp, book.state.tokenDown],
        operation: 'subscribe',
        custom_feature_enabled: true,
      }),
    );
  }

  function connect() {
    if (stopped || ws) return;
    const socket = new WebSocket(CLOB_WS);
    ws = socket;

    socket.on('open', () => {
      reconnectAttempt = 0;
      book.state.wsConnected = true;
      subscribe();
      void book.seedFromRest().then(() => onBookUpdate('seed'));
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send('PING');
          } catch {
            /* ignore */
          }
        }
      }, 10_000);
    });

    socket.on('message', (raw) => {
      const text = raw?.toString?.() ?? String(raw);
      if (!text || text === 'PONG') return;
      try {
        const data = JSON.parse(text);
        const items = Array.isArray(data) ? data : [data];
        let updated = false;
        for (const item of items) {
          if (item?.event_type) updated = book.processMessage(item) || updated;
        }
        if (updated) onBookUpdate('ws');
      } catch {
        /* ignore */
      }
    });

    socket.on('close', () => {
      book.state.wsConnected = false;
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      ws = null;
      if (!stopped) {
        reconnectAttempt += 1;
        const delay = Math.min(8000, 400 * 2 ** Math.min(reconnectAttempt, 5));
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      }
    });

    socket.on('error', () => {
      /* close will reconnect */
    });
  }

  connect();

  return {
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
    },
  };
}

async function waitMarketReady(doneSlugs) {
  for (let a = 0; a < 120; a++) {
    const slug = currentSlug();
    const start = eventStart(slug);
    const tau = start != null ? start + 300 - Math.floor(Date.now() / 1000) : 0;
    if (doneSlugs.has(slug)) {
      await sleep(1000);
      continue;
    }
    if (FULL_EVENT && tau < MIN_TAU) {
      if (a % 5 === 0) console.log(`wait tau=${tau} ${slug}`);
      await sleep(1000);
      continue;
    }
    try {
      const market = await resolveMarket(slug);
      market.tauAtStart = tau;
      return market;
    } catch (e) {
      console.log('resolve', e.message);
      await sleep(1500);
    }
  }
  throw new Error('timeout resolving market');
}

async function runOneEvent({ params, market, seriesDir }) {
  const eng = createEventEngine(params, { slug: market.slug });
  const book = createBookPair(market.tokens.UP, market.tokens.DOWN);
  const evDir = path.join(seriesDir, 'events', market.slug);
  fs.mkdirSync(evDir, { recursive: true });
  const ticksPath = path.join(evDir, 'ticks.jsonl');
  const metaPath = path.join(evDir, 'ws-meta.json');

  let last = null;
  let ticks = 0;
  let decisions = 0;
  let lastDecisionKey = '';
  let lastLogMs = 0;
  let ended = false;

  function tauNow() {
    const start = market.eventStart;
    return start != null ? start + 300 - Math.floor(Date.now() / 1000) : null;
  }

  function pushDecision(source) {
    if (ended) return;
    const tau = tauNow();
    if (FULL_EVENT && tau != null && tau <= 0) {
      ended = true;
      return;
    }
    const asks = book.bestAsks();
    const key = `${asks.UP}|${asks.DOWN}|${eng.state.mode}|${eng.state.fills.length}`;
    // always allow heartbeat; for ws, skip duplicate pure-state if identical ask+mode within same ms
    const tick = {
      ts: nowIso(),
      tau,
      source,
      upAsk: asks.UP,
      downAsk: asks.DOWN,
      upBid: book.state.UP.bestBid,
      downBid: book.state.DOWN.bestBid,
      wsConnected: book.state.wsConnected,
      lagMs: book.state.lastUpdateMs != null ? nowMs() - book.state.lastUpdateMs : null,
    };
    // dedupe identical book for pure spam
    if (source === 'ws' && key === lastDecisionKey) {
      // still update engine? skip if no ask change
      return;
    }
    lastDecisionKey = key;
    fs.appendFileSync(ticksPath, `${JSON.stringify(tick)}\n`);
    eng.onTick(tick);
    last = tick;
    ticks += 1;
    decisions += 1;

    const t = nowMs();
    if (t - lastLogMs > 5000) {
      lastLogMs = t;
      console.log(
        `… t=${ticks} tau=${tau} up=${asks.UP} dn=${asks.DOWN} mode=${eng.state.mode} fills=${eng.state.fills.length}` +
          ` ws=${book.state.wsConnected} msgs=${book.state.msgCount} src=${source}`,
      );
    }
  }

  const feed = connectMarketWs(book, (source) => {
    pushDecision(source);
  });

  // heartbeat: ensures tau progression + decision even if book quiet
  const hb = setInterval(() => {
    if (ended) return;
    const tau = tauNow();
    if (FULL_EVENT && tau != null && tau <= 0) {
      ended = true;
      return;
    }
    pushDecision('hb');
  }, HEARTBEAT_MS);

  // wait until event ends or hard timeout 320s
  const deadline = nowMs() + 320_000;
  while (!ended && nowMs() < deadline) {
    await sleep(200);
    const tau = tauNow();
    if (FULL_EVENT && tau != null && tau <= 0) ended = true;
  }

  clearInterval(hb);
  feed.stop();

  const result = eng.finish(last);
  const summary = {
    slug: market.slug,
    ticks,
    decisions,
    ws: {
      msgCount: book.state.msgCount,
      bookEvents: book.state.bookEvents,
      priceChanges: book.state.priceChanges,
      lastUpdateMs: book.state.lastUpdateMs,
    },
    heartbeatMs: HEARTBEAT_MS,
    ...result,
  };
  fs.writeFileSync(path.join(evDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        tokens: market.tokens,
        wsUrl: CLOB_WS,
        msgCount: book.state.msgCount,
        bookEvents: book.state.bookEvents,
        priceChanges: book.state.priceChanges,
      },
      null,
      2,
    ),
  );
  console.log(
    `done mode=${result.mode} fills=${result.nFills} avgSum=${result.avgSum} pnl≈${result.pnl}` +
      ` worst=${result.worstPnl} ticks=${ticks} wsMsgs=${book.state.msgCount}`,
  );
  return summary;
}

async function main() {
  const params = loadParams();
  const host = process.env.HOSTNAME || process.env.COMPUTERNAME || 'unknown';
  const stamp = nowIso().replace(/[:.]/g, '-');
  const seriesDir = path.join(OUT_ROOT, `${stamp}-${LABEL}`);
  fs.mkdirSync(path.join(seriesDir, 'events'), { recursive: true });
  fs.writeFileSync(path.join(seriesDir, 'params.json'), JSON.stringify(params, null, 2));

  console.log('=== pair-path-v0 shadow LIVE WS ===');
  console.log(`host=${host} events=${EVENTS} heartbeatMs=${HEARTBEAT_MS} ws=${CLOB_WS}`);
  console.log(`out=${seriesDir}`);
  console.log(`params=${JSON.stringify(params)}`);

  const done = new Set();
  const summaries = [];

  for (let i = 0; i < EVENTS; i++) {
    console.log(`\n######## ${i + 1}/${EVENTS} ########`);
    const market = await waitMarketReady(done);
    console.log(`--- ${market.slug} tau≈${market.tauAtStart} resolveMs=${market.resolveMs} ---`);
    const summary = await runOneEvent({ params, market, seriesDir });
    summaries.push(summary);
    done.add(market.slug);
    fs.writeFileSync(
      path.join(seriesDir, 'STATUS.json'),
      JSON.stringify(
        {
          running: i + 1 < EVENTS,
          completed: done.size,
          target: EVENTS,
          lastSlug: market.slug,
          updatedAt: nowIso(),
          mode: 'ws',
        },
        null,
        2,
      ),
    );
    if (i + 1 < EVENTS) await sleep(2000);
  }

  const report = {
    generatedAt: nowIso(),
    host,
    mode: 'ws',
    heartbeatMs: HEARTBEAT_MS,
    params,
    summaries,
    totalPnl: summaries.reduce((a, s) => a + (s.pnl || 0), 0),
    nTraded: summaries.filter((s) => s.nFills > 0).length,
    wsMsgsTotal: summaries.reduce((a, s) => a + (s.ws?.msgCount || 0), 0),
  };
  fs.writeFileSync(path.join(seriesDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n=== shadow WS series done ===');
  console.log(`traded ${report.nTraded}/${summaries.length} totalPnl≈${report.totalPnl} wsMsgs=${report.wsMsgsTotal}`);
  console.log(seriesDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
