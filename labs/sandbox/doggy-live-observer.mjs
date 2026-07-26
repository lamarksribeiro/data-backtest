/**
 * Etapa 10/13 — observer live Doggy (só-leitura, local) + shadow CLOB tick.
 *
 * Captura book CLOB (WS + REST), journal tick (best changes), spot BTC e
 * activity da wallet. No fill: ask@t, minAsk±500ms/±1s, dAsk, phase shadow.
 *
 * Usage:
 *   node labs/sandbox/doggy-live-observer.mjs [--minutes=45] [--wallet=0x…] [--no-ws]
 *
 * Output:
 *   .tmp/pair-ladder-re/live-observer/<runId>/
 *     fills.jsonl  books.jsonl  books-tick.jsonl  status.json  summary.json
 *
 * Sem credenciais. Sem ordens. Ctrl+C encerra com summary.
 * Activity timestamp = segundo (±0,5–1s de incerteza no join).
 */
import fs from 'node:fs';
import path from 'node:path';

const WALLET_DEFAULT = '0x0484e64092ba4108c2786b61e6fc052d3bf41b1a';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const CLOB_HTTP = 'https://clob.polymarket.com';
const GAMMA = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const BINANCE = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT';

const args = process.argv.slice(2);
function argVal(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const minutes = Math.max(0.5, Number(argVal('minutes', '45')) || 45);
const wallet = String(argVal('wallet', WALLET_DEFAULT)).toLowerCase();
const noWs = args.includes('--no-ws');
const bookSampleSec = Math.max(0.5, Number(argVal('book-sample-sec', '1')) || 1);
const tickMinMs = Math.max(0, Number(argVal('tick-min-ms', '10')) || 10);
const activityPollMs = Math.max(800, Number(argVal('activity-ms', '1500')) || 1500);
const spotPollMs = Math.max(400, Number(argVal('spot-ms', '800')) || 800);

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve('.tmp/pair-ladder-re/live-observer', runId);
fs.mkdirSync(OUT, { recursive: true });

const fillsPath = path.join(OUT, 'fills.jsonl');
const booksPath = path.join(OUT, 'books.jsonl');
const booksTickPath = path.join(OUT, 'books-tick.jsonl');
const statusPath = path.join(OUT, 'status.json');
const summaryPath = path.join(OUT, 'summary.json');

function log(...xs) {
  process.stdout.write(`${new Date().toISOString()} ${xs.join(' ')}\n`);
}
function appendJsonl(file, obj) {
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
}
async function fetchJson(url, timeoutMs = 10000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}
function eventStartFromSlug(slug) {
  const m = String(slug || '').match(/btc-updown-5m-(\d+)/i);
  return m ? Number(m[1]) : null;
}
function currentSlug(nowSec = Math.floor(Date.now() / 1000)) {
  const start = nowSec - (nowSec % 300);
  return `btc-updown-5m-${start}`;
}
function parseMaybeJson(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return []; }
  }
  return [];
}
function activityKey(row) {
  return [row.type, row.transactionHash, row.timestamp, row.asset, row.size, row.price, row.usdcSize].join('|');
}

/** Ring buffer of {t, value} */
class Ring {
  constructor(maxMs) {
    this.maxMs = maxMs;
    this.items = [];
  }
  push(t, value) {
    this.items.push({ t, value });
    const cut = t - this.maxMs;
    while (this.items.length && this.items[0].t < cut) this.items.shift();
  }
  at(tTarget) {
    if (!this.items.length) return null;
    let best = this.items[0];
    let bestDist = Math.abs(best.t - tTarget);
    for (const it of this.items) {
      const d = Math.abs(it.t - tTarget);
      if (d < bestDist) { best = it; bestDist = d; }
    }
    return best;
  }
  /** Samples with |t - tTarget| <= halfWindowMs */
  window(tTarget, halfWindowMs) {
    return this.items.filter((it) => Math.abs(it.t - tTarget) <= halfWindowMs);
  }
  latest() {
    return this.items.length ? this.items[this.items.length - 1] : null;
  }
}

class BookState {
  constructor() {
    this.up = { asks: new Map(), bids: new Map(), bestAsk: null, bestBid: null };
    this.down = { asks: new Map(), bids: new Map(), bestAsk: null, bestBid: null };
    this.updatedAt = 0;
  }
  side(tokenIsUp) {
    return tokenIsUp ? this.up : this.down;
  }
  rebuild(tokenIsUp, bids, asks) {
    const s = this.side(tokenIsUp);
    s.asks.clear();
    s.bids.clear();
    for (const a of asks || []) {
      const px = Number(a.price);
      const sz = Number(a.size);
      if (Number.isFinite(px) && Number.isFinite(sz) && sz > 0) s.asks.set(px, sz);
    }
    for (const b of bids || []) {
      const px = Number(b.price);
      const sz = Number(b.size);
      if (Number.isFinite(px) && Number.isFinite(sz) && sz > 0) s.bids.set(px, sz);
    }
    this.recompute(tokenIsUp);
  }
  applyLevel(tokenIsUp, bookSide, price, size) {
    const s = this.side(tokenIsUp);
    const book = bookSide === 'ask' ? s.asks : s.bids;
    const px = Number(price);
    const sz = Number(size);
    if (!Number.isFinite(px)) return;
    if (!Number.isFinite(sz) || sz <= 0) book.delete(px);
    else book.set(px, sz);
    this.recompute(tokenIsUp);
  }
  recompute(tokenIsUp) {
    const s = this.side(tokenIsUp);
    s.bestAsk = s.asks.size ? Math.min(...s.asks.keys()) : null;
    s.bestBid = s.bids.size ? Math.max(...s.bids.keys()) : null;
    this.updatedAt = Date.now();
  }
  depthAt(tokenIsUp, bookSide, price) {
    const s = this.side(tokenIsUp);
    const book = bookSide === 'ask' ? s.asks : s.bids;
    const px = Number(price);
    if (!Number.isFinite(px)) return null;
    if (book.has(px)) return book.get(px);
    const rounded = Math.round(px * 100) / 100;
    return book.get(rounded) ?? null;
  }
  snapshot() {
    return {
      t: Date.now(),
      upBestAsk: this.up.bestAsk,
      upBestBid: this.up.bestBid,
      downBestAsk: this.down.bestAsk,
      downBestBid: this.down.bestBid,
      upAskDepth: this.up.bestAsk != null ? this.up.asks.get(this.up.bestAsk) ?? null : null,
      downAskDepth: this.down.bestAsk != null ? this.down.asks.get(this.down.bestAsk) ?? null : null,
    };
  }
}

function bestKey(snap) {
  return [snap.upBestAsk, snap.upBestBid, snap.downBestAsk, snap.downBestBid].join('|');
}

const state = {
  market: null,
  book: new BookState(),
  bookHist: new Ring(120_000),
  spotHist: new Ring(120_000),
  askHist: { Up: new Ring(120_000), Down: new Ring(120_000) },
  seenActivity: new Set(),
  warmed: false,
  liveGateAt: 0,
  bookReadyAt: 0, // ms — only join fills after book has warmed
  eventPath: null, // { slug, openedSide, hedged, fills }
  stats: {
    fills: 0,
    fillsBookMatched: 0,
    fillsSkippedStale: 0,
    bookSamples: 0,
    bookTicks: 0,
    activityPolls: 0,
    wsMessages: 0,
    restBookPolls: 0,
    marketRollover: 0,
    errors: 0,
  },
  ws: null,
  wsGeneration: 0,
  subscribedSlug: null,
  stopping: false,
  _lastBookWrite: null,
  _lastTickWrite: null,
  _lastTickKey: null,
};

function resetEventPath(slug) {
  state.eventPath = { slug, openedSide: null, hedged: false, fills: 0 };
}

function classifyPhase(outcome, px, secInto, dAsk15) {
  const ep = state.eventPath;
  if (!ep) return 'unknown';
  if (ep.fills === 0) {
    ep.openedSide = outcome;
    ep.fills += 1;
    return 'open';
  }
  if (!ep.hedged && ep.openedSide && outcome !== ep.openedSide) {
    ep.hedged = true;
    ep.fills += 1;
    return 'hedge';
  }
  ep.fills += 1;
  if (px <= 0.20 && secInto != null && secInto >= 120) return 'vacuum';
  if (dAsk15 != null && dAsk15 >= 0.02) return 'build_momo';
  if (dAsk15 != null && dAsk15 <= -0.02) return 'build_fade';
  return 'build_flat';
}

async function discoverMarket() {
  const slug = currentSlug();
  const markets = await fetchJson(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
  const m = Array.isArray(markets) ? markets[0] : null;
  if (!m) throw new Error(`market not found for ${slug}`);
  const ids = parseMaybeJson(m.clobTokenIds);
  const outs = parseMaybeJson(m.outcomes);
  if (ids.length < 2) throw new Error(`no clobTokenIds for ${slug}`);
  let upIdx = outs.findIndex((o) => String(o).toLowerCase() === 'up');
  let downIdx = outs.findIndex((o) => String(o).toLowerCase() === 'down');
  if (upIdx < 0) upIdx = 0;
  if (downIdx < 0) downIdx = 1;
  const start = eventStartFromSlug(slug);
  return {
    slug,
    start,
    end: start != null ? start + 300 : null,
    upTokenId: String(ids[upIdx]),
    downTokenId: String(ids[downIdx]),
    conditionId: m.conditionId || null,
    title: m.question || m.title || slug,
  };
}

async function refreshRestBook() {
  if (!state.market) return;
  const { upTokenId, downTokenId } = state.market;
  const [up, down] = await Promise.all([
    fetchJson(`${CLOB_HTTP}/book?token_id=${upTokenId}`),
    fetchJson(`${CLOB_HTTP}/book?token_id=${downTokenId}`),
  ]);
  state.book.rebuild(true, up.bids, up.asks);
  state.book.rebuild(false, down.bids, down.asks);
  state.stats.restBookPolls += 1;
  pushBookSample({ source: 'rest' });
}

function pushBookSample({ source = 'ws' } = {}) {
  const snap = state.book.snapshot();
  state.bookHist.push(snap.t, snap);
  if (snap.upBestAsk != null) state.askHist.Up.push(snap.t, snap.upBestAsk);
  if (snap.downBestAsk != null) state.askHist.Down.push(snap.t, snap.downBestAsk);
  state.stats.bookSamples += 1;
  if (!state.bookReadyAt && (snap.upBestAsk != null || snap.downBestAsk != null)) {
    state.bookReadyAt = snap.t;
    // Don't join fills whose activity ts is before we had a book.
    const readySec = Math.floor(snap.t / 1000) + 2;
    if (!state.liveGateAt || readySec > state.liveGateAt) {
      state.liveGateAt = readySec;
      log('book ready — liveGateAt=', state.liveGateAt);
    }
  }

  // Downsample 1 Hz for books.jsonl
  if (state._lastBookWrite == null || snap.t - state._lastBookWrite >= bookSampleSec * 1000) {
    appendJsonl(booksPath, { ...snap, slug: state.market?.slug ?? null, source });
    state._lastBookWrite = snap.t;
  }

  // Tick journal: only when bests change; throttle identical storm
  const key = bestKey(snap);
  const changed = key !== state._lastTickKey;
  const cooled = state._lastTickWrite == null || snap.t - state._lastTickWrite >= tickMinMs;
  if (changed && cooled) {
    appendJsonl(booksTickPath, {
      t: snap.t,
      slug: state.market?.slug ?? null,
      source,
      upBestAsk: snap.upBestAsk,
      upBestBid: snap.upBestBid,
      downBestAsk: snap.downBestAsk,
      downBestBid: snap.downBestBid,
      upAskDepth: snap.upAskDepth,
      downAskDepth: snap.downAskDepth,
    });
    state._lastTickWrite = snap.t;
    state._lastTickKey = key;
    state.stats.bookTicks += 1;
  }
}

function connectWs() {
  if (noWs || typeof WebSocket === 'undefined') {
    log('WS disabled — REST book only');
    return;
  }
  if (!state.market) return;
  if (state.subscribedSlug === state.market.slug && state.ws?.readyState === WebSocket.OPEN) {
    return;
  }
  const gen = ++state.wsGeneration;
  const slug = state.market.slug;
  if (state.ws) {
    try { state.ws.close(); } catch { /* ignore */ }
    state.ws = null;
  }
  const ws = new WebSocket(CLOB_WS);
  state.ws = ws;
  state.subscribedSlug = slug;
  ws.addEventListener('open', () => {
    if (gen !== state.wsGeneration || state.market?.slug !== slug) return;
    log('WS open — subscribe', slug);
    ws.send(JSON.stringify({
      assets_ids: [state.market.upTokenId, state.market.downTokenId],
      operation: 'subscribe',
      custom_feature_enabled: true,
    }));
  });
  ws.addEventListener('message', (ev) => {
    if (gen !== state.wsGeneration) return;
    try {
      const text = String(ev.data || '');
      if (!text || text === 'PONG') return;
      const data = JSON.parse(text);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) handleWsMessage(item);
      state.stats.wsMessages += 1;
    } catch {
      state.stats.errors += 1;
    }
  });
  ws.addEventListener('close', () => {
    if (gen !== state.wsGeneration) return;
    log('WS closed');
    state.subscribedSlug = null;
    if (!state.stopping) {
      setTimeout(() => {
        if (!state.stopping && gen === state.wsGeneration) connectWs();
      }, 2000);
    }
  });
  ws.addEventListener('error', () => {
    state.stats.errors += 1;
  });
  const ping = setInterval(() => {
    if (gen !== state.wsGeneration || state.ws !== ws || ws.readyState !== WebSocket.OPEN) {
      clearInterval(ping);
      return;
    }
    try { ws.send('PING'); } catch { /* ignore */ }
  }, 10_000);
}

function handleWsMessage(data) {
  if (!state.market) return;
  const eventType = data.event_type || '';
  const upId = state.market.upTokenId;
  const downId = state.market.downTokenId;

  if (eventType === 'price_change') {
    const changes = data.price_changes || data.changes || [];
    for (const c of changes) {
      const asset = String(c.asset_id || '');
      const isUp = asset === upId;
      const isDown = asset === downId;
      if (!isUp && !isDown) continue;
      const bookSide = c.side === 'SELL' ? 'ask' : 'bid';
      state.book.applyLevel(isUp, bookSide, c.price, c.size);
    }
    pushBookSample({ source: 'ws_price_change' });
    return;
  }

  const asset = String(data.asset_id || '');
  const isUp = asset === upId;
  const isDown = asset === downId;
  if (!isUp && !isDown) return;

  if (eventType === 'book') {
    state.book.rebuild(isUp, data.bids || [], data.asks || []);
    pushBookSample({ source: 'ws_book' });
  } else if (eventType === 'best_bid_ask') {
    const s = state.book.side(isUp);
    if (data.best_bid != null) s.bestBid = Number(data.best_bid);
    if (data.best_ask != null) s.bestAsk = Number(data.best_ask);
    state.book.updatedAt = Date.now();
    pushBookSample({ source: 'ws_bba' });
  }
}

async function ensureMarket() {
  const slug = currentSlug();
  if (state.market?.slug === slug) return false;
  const m = await discoverMarket();
  state.market = m;
  resetEventPath(m.slug);
  state.stats.marketRollover += 1;
  state._lastTickKey = null;
  state.bookReadyAt = 0;
  // Fresh ring for new market — avoid cross-slug join.
  state.bookHist = new Ring(120_000);
  state.askHist = { Up: new Ring(120_000), Down: new Ring(120_000) };
  log('market', m.slug, m.title);
  await refreshRestBook();
  connectWs();
  return true;
}

async function pollSpot() {
  try {
    const j = await fetchJson(BINANCE, 5000);
    const px = Number(j.price);
    if (Number.isFinite(px)) state.spotHist.push(Date.now(), px);
  } catch {
    state.stats.errors += 1;
  }
}

function spotDelta(nowMs, lookbackMs) {
  const now = state.spotHist.at(nowMs);
  const prev = state.spotHist.at(nowMs - lookbackMs);
  if (!now || !prev) return null;
  return now.value - prev.value;
}

function askDelta(side, nowMs, lookbackMs) {
  const ring = state.askHist[side];
  if (!ring) return null;
  const now = ring.at(nowMs);
  const prev = ring.at(nowMs - lookbackMs);
  if (!now || !prev) return null;
  if (Math.abs(now.t - prev.t) < lookbackMs * 0.4) return null;
  return now.value - prev.value;
}

function bookNear(tsMs) {
  const t = tsMs < 1e12 ? tsMs * 1000 : tsMs;
  const hit = state.bookHist.at(t);
  return hit ? { ...hit.value, lagMs: hit.t - t } : null;
}

function sideAskFromSnap(snap, outcome) {
  if (!snap) return null;
  return outcome === 'Up' ? snap.upBestAsk : snap.downBestAsk;
}

/** Min side-ask in [tsMs - half, tsMs + half] from bookHist */
function minAskInWindow(outcome, tsMs, halfWindowMs) {
  const win = state.bookHist.window(tsMs, halfWindowMs);
  let min = null;
  for (const it of win) {
    const a = sideAskFromSnap(it.value, outcome);
    if (a == null || !Number.isFinite(a)) continue;
    if (min == null || a < min) min = a;
  }
  return min;
}

function enrichFill(row) {
  const tsSec = Number(row.timestamp);
  // Activity clock is whole seconds — join center of second; note ±0.5–1s uncertainty.
  const tsMs = tsSec * 1000 + 500;
  const outcome = String(row.outcome || '').toLowerCase().includes('up') ? 'Up' : 'Down';
  const px = Number(row.price);
  const size = Number(row.size);
  const slug = String(row.slug || '');
  const marketSlug = state.market?.slug ?? null;
  const bookMatched = Boolean(marketSlug && slug === marketSlug);
  const book = bookMatched ? bookNear(tsMs) : null;
  const lagOk = book != null && Math.abs(book.lagMs) <= 2500;
  const sideAsk = lagOk ? sideAskFromSnap(book, outcome) : null;
  const sideBid = lagOk ? (outcome === 'Up' ? book.upBestBid : book.downBestBid) : null;
  const oppAsk = lagOk ? (outcome === 'Up' ? book.downBestAsk : book.upBestAsk) : null;
  const fillMinusAsk = sideAsk != null && Number.isFinite(px) ? px - sideAsk : null;
  const minAsk500 = bookMatched ? minAskInWindow(outcome, tsMs, 500) : null;
  const minAsk1000 = bookMatched ? minAskInWindow(outcome, tsMs, 1000) : null;
  const fillMinusMinAsk500 = minAsk500 != null && Number.isFinite(px) ? px - minAsk500 : null;
  const fillMinusMinAsk1000 = minAsk1000 != null && Number.isFinite(px) ? px - minAsk1000 : null;
  const start = eventStartFromSlug(slug) ?? state.market?.start ?? null;
  const secInto = start != null ? tsSec - start : null;
  const depth = lagOk
    ? state.book.depthAt(outcome === 'Up', 'ask', sideAsk)
    : null;
  const dAsk15 = bookMatched && lagOk ? askDelta(outcome, tsMs, 15_000) : null;
  const dAsk5 = bookMatched && lagOk ? askDelta(outcome, tsMs, 5_000) : null;

  if (state.eventPath?.slug !== slug) resetEventPath(slug);
  const phase = classifyPhase(outcome, px, secInto, dAsk15);

  return {
    capturedAt: new Date().toISOString(),
    type: row.type,
    slug,
    ts: tsSec,
    tsIso: new Date(tsSec * 1000).toISOString(),
    tsJoinMs: tsMs,
    clockNote: 'activity_ts_sec_join_midpoint_pm_0.5_1s',
    outcome,
    side: row.side,
    price: px,
    size,
    usdcSize: row.usdcSize,
    tx: row.transactionHash,
    asset: row.asset,
    secInto,
    phase,
    bookMatched: bookMatched && lagOk,
    bookLagMs: book?.lagMs ?? null,
    upBestAsk: lagOk ? book.upBestAsk : null,
    upBestBid: lagOk ? book.upBestBid : null,
    downBestAsk: lagOk ? book.downBestAsk : null,
    downBestBid: lagOk ? book.downBestBid : null,
    sideAsk,
    sideBid,
    oppAsk,
    askAtCapture: sideAsk,
    minAsk500,
    minAsk1000,
    fillMinusAsk,
    fillMinusMinAsk500,
    fillMinusMinAsk1000,
    askDepthAtBest: depth,
    dAsk15,
    dAsk5,
    dSpot1s: spotDelta(tsMs, 1_000),
    dSpot5s: spotDelta(tsMs, 5_000),
    dSpot15s: spotDelta(tsMs, 15_000),
    spot: state.spotHist.at(tsMs)?.value ?? null,
    marketSlug,
  };
}

async function pollActivity() {
  if (!state.warmed) return;
  state.stats.activityPolls += 1;
  try {
    const rows = await fetchJson(
      `${DATA_API}/activity?user=${wallet}&limit=80`,
      10000,
    );
    if (!Array.isArray(rows)) return;
    const novel = [];
    for (const row of rows) {
      const key = activityKey(row);
      if (state.seenActivity.has(key)) continue;
      state.seenActivity.add(key);
      novel.push(row);
    }
    novel.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    const nowSec = Math.floor(Date.now() / 1000);
    const liveSlug = state.market?.slug ?? currentSlug(nowSec);
    for (const row of novel) {
      if (row.type !== 'TRADE' || row.side !== 'BUY') continue;
      if (!/btc-updown-5m/i.test(row.slug || '')) continue;
      const tsSec = Number(row.timestamp);
      if (state.liveGateAt && tsSec < state.liveGateAt - 5) {
        state.stats.fillsSkippedStale += 1;
        continue;
      }
      const ageSec = nowSec - tsSec;
      if (ageSec > 360) {
        state.stats.fillsSkippedStale += 1;
        continue;
      }
      if (String(row.slug) !== liveSlug) {
        state.stats.fillsSkippedStale += 1;
        continue;
      }
      const enriched = enrichFill(row);
      appendJsonl(fillsPath, enriched);
      state.stats.fills += 1;
      if (enriched.bookMatched) state.stats.fillsBookMatched += 1;
      log(
        'FILL',
        enriched.phase,
        enriched.slug,
        enriched.outcome,
        `@${enriched.price}`,
        `x${enriched.size}`,
        `matched=${enriched.bookMatched}`,
        `fill-ask=${enriched.fillMinusAsk != null ? (enriched.fillMinusAsk * 100).toFixed(2) + '¢' : 'n/a'}`,
        `fill-min500=${enriched.fillMinusMinAsk500 != null ? (enriched.fillMinusMinAsk500 * 100).toFixed(2) + '¢' : 'n/a'}`,
        `dAsk15=${enriched.dAsk15 != null ? (enriched.dAsk15 * 100).toFixed(1) + '¢' : 'n/a'}`,
      );
    }
  } catch (err) {
    state.stats.errors += 1;
    log('activity error', err.message || err);
  }
}

async function warmActivity(retries = 4) {
  let lastErr = null;
  for (let i = 0; i < retries; i += 1) {
    try {
      const warm = await fetchJson(`${DATA_API}/activity?user=${wallet}&limit=100`, 15000);
      if (!Array.isArray(warm)) throw new Error('activity warm not array');
      for (const row of warm) state.seenActivity.add(activityKey(row));
      state.liveGateAt = Math.floor(Date.now() / 1000) - 8;
      state.warmed = true;
      log('warmed activity seen=', state.seenActivity.size, 'liveGateAt=', state.liveGateAt);
      return true;
    } catch (err) {
      lastErr = err;
      state.stats.errors += 1;
      log('warm retry', i + 1, err.message || err);
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  state.liveGateAt = Math.floor(Date.now() / 1000) - 8;
  state.warmed = true;
  log('warm failed — gating to live only. lastErr=', lastErr?.message || lastErr);
  return false;
}

function writeStatus(extra = {}) {
  fs.writeFileSync(statusPath, JSON.stringify({
    runId,
    out: OUT,
    wallet,
    minutes,
    noWs,
    tickMinMs,
    market: state.market,
    book: state.book.snapshot(),
    spot: state.spotHist.latest()?.value ?? null,
    stats: state.stats,
    ...extra,
  }, null, 2));
}

function summarize() {
  const fills = fs.existsSync(fillsPath)
    ? fs.readFileSync(fillsPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const matched = fills.filter((f) => f.bookMatched);
  const fillMinus = matched.map((f) => f.fillMinusAsk).filter((x) => x != null && Number.isFinite(x));
  const fillMin500 = matched.map((f) => f.fillMinusMinAsk500).filter((x) => x != null && Number.isFinite(x));
  const dAsk = matched.map((f) => f.dAsk15).filter((x) => x != null && Number.isFinite(x));
  const dSpot = matched.map((f) => f.dSpot5s).filter((x) => x != null && Number.isFinite(x));
  const med = (arr) => {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.floor((a.length - 1) / 2)];
  };
  const spotAligned = matched.filter((f) => {
    if (f.dSpot5s == null || !Number.isFinite(f.dSpot5s)) return false;
    if (f.outcome === 'Up') return f.dSpot5s > 1;
    return f.dSpot5s < -1;
  });
  const byPhase = {};
  for (const f of matched) {
    const p = f.phase || 'unknown';
    byPhase[p] = (byPhase[p] || 0) + 1;
  }
  const vacuumShare = matched.length
    ? (byPhase.vacuum || 0) / matched.length
    : null;
  const summary = {
    asOf: new Date().toISOString(),
    runId,
    out: OUT,
    wallet,
    durationMin: minutes,
    stats: state.stats,
    fillsN: fills.length,
    fillsBookMatchedN: matched.length,
    medFillMinusAskCents: med(fillMinus) != null ? med(fillMinus) * 100 : null,
    medFillMinusMinAsk500Cents: med(fillMin500) != null ? med(fillMin500) * 100 : null,
    medDAsk15Cents: med(dAsk) != null ? med(dAsk) * 100 : null,
    medDSpot5s: med(dSpot),
    momoShare: dAsk.length
      ? dAsk.filter((x) => x >= 0.02).length / dAsk.length
      : null,
    belowAskShare: fillMinus.length
      ? fillMinus.filter((x) => x < -0.001).length / fillMinus.length
      : null,
    belowMinAsk500Share: fillMin500.length
      ? fillMin500.filter((x) => x < -0.001).length / fillMin500.length
      : null,
    spotLeadShare: matched.length ? spotAligned.length / matched.length : null,
    vacuumShare,
    byPhase,
    sample: matched.slice(-5),
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  return summary;
}

async function main() {
  log('start', `minutes=${minutes}`, `out=${OUT}`, `wallet=${wallet.slice(0, 10)}…`, `tickMinMs=${tickMinMs}`);
  await ensureMarket();
  await pollSpot();
  await warmActivity();

  writeStatus({ phase: 'running' });

  const started = Date.now();
  const endAt = started + minutes * 60_000;

  const timers = [];
  timers.push(setInterval(() => { pollSpot().catch(() => {}); }, spotPollMs));
  timers.push(setInterval(() => { pollActivity().catch(() => {}); }, activityPollMs));
  timers.push(setInterval(() => {
    refreshRestBook().catch((e) => {
      state.stats.errors += 1;
      log('rest book error', e.message || e);
    });
  }, noWs ? 800 : 2500));
  timers.push(setInterval(() => {
    ensureMarket().catch((e) => {
      state.stats.errors += 1;
      log('market error', e.message || e);
    });
  }, 5000));
  timers.push(setInterval(() => writeStatus({ phase: 'running', elapsedSec: Math.round((Date.now() - started) / 1000) }), 5000));

  const stop = () => {
    if (state.stopping) return;
    state.stopping = true;
    for (const t of timers) clearInterval(t);
    try { state.ws?.close(); } catch { /* ignore */ }
    const summary = summarize();
    writeStatus({ phase: 'stopped', summary });
    log('stopped fills=', summary.fillsN,
      'matched=', summary.fillsBookMatchedN,
      'ticks=', state.stats.bookTicks,
      'med fill-ask ¢=', summary.medFillMinusAskCents?.toFixed?.(2),
      'med fill-min500 ¢=', summary.medFillMinusMinAsk500Cents?.toFixed?.(2),
      'momoShare=', summary.momoShare != null ? (summary.momoShare * 100).toFixed(0) + '%' : 'n/a',
      'vacuumShare=', summary.vacuumShare != null ? (summary.vacuumShare * 100).toFixed(0) + '%' : 'n/a');
    log('summary →', summaryPath);
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  setTimeout(() => { pollActivity().catch(() => {}); }, 3000);

  const wait = setInterval(() => {
    if (Date.now() >= endAt) {
      clearInterval(wait);
      stop();
    }
  }, 500);
}

main().catch((err) => {
  console.error(err);
  writeStatus({ phase: 'fatal', error: String(err?.message || err) });
  process.exit(1);
});
