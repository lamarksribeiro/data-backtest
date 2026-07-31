/**
 * Public BTC 5m market evidence primitives.
 *
 * This module deliberately exposes no authenticated headers and no order
 * endpoints. It normalizes public Gamma discovery, CLOB REST books and the
 * public CLOB market WebSocket into an append-only, strategy-neutral event
 * stream that can be consumed through a callback/event sink.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PUBLIC_EVIDENCE_SCHEMA = 'polymarket-public-market-evidence/v1';
export const GAMMA_ORIGIN = 'https://gamma-api.polymarket.com';
export const CLOB_ORIGIN = 'https://clob.polymarket.com';
export const CLOB_MARKET_WS =
  'wss://ws-subscriptions-clob.polymarket.com/ws/market';

const PUBLIC_HTTP_ALLOWLIST = new Map([
  ['gamma-api.polymarket.com', new Set(['/markets', '/events'])],
  ['clob.polymarket.com', new Set(['/book'])],
]);

function finiteNumber(value) {
  if (
    value == null ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && value.trim() === '')
  ) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampMs(value, fallback = null) {
  const number = finiteNumber(value);
  if (number == null) return fallback;
  return number < 1e12 ? Math.round(number * 1000) : Math.round(number);
}

function parseMaybeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeLevels(levels) {
  const rows = [];
  for (const level of levels || []) {
    const price = finiteNumber(level?.price ?? level?.[0]);
    const size = finiteNumber(level?.size ?? level?.[1]);
    if (price == null || size == null || price < 0 || price > 1 || size < 0) {
      continue;
    }
    rows.push({ price, size });
  }
  return rows;
}

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

export function currentBtc5mSlug(nowMs = Date.now()) {
  const nowSec = Math.floor(nowMs / 1000);
  return `btc-updown-5m-${nowSec - (nowSec % 300)}`;
}

export function eventStartFromSlug(slug) {
  const match = String(slug || '').match(/^btc-updown-5m-(\d+)$/i);
  return match ? Number(match[1]) : null;
}

export function assertPublicReadOnlyUrl(rawUrl, kind = 'http') {
  const url = new URL(rawUrl);
  if (kind === 'ws') {
    if (
      url.protocol !== 'wss:' ||
      url.hostname !== 'ws-subscriptions-clob.polymarket.com' ||
      url.pathname !== '/ws/market'
    ) {
      throw new Error(`blocked non-public market WebSocket: ${rawUrl}`);
    }
    return url;
  }
  if (url.protocol !== 'https:') {
    throw new Error(`blocked non-HTTPS public request: ${rawUrl}`);
  }
  const paths = PUBLIC_HTTP_ALLOWLIST.get(url.hostname);
  if (!paths?.has(url.pathname)) {
    throw new Error(`blocked non-read-only endpoint: ${rawUrl}`);
  }
  return url;
}

export async function fetchPublicJson(
  rawUrl,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 12_000,
    userAgent = 'data-backtest-public-tape/1.0',
  } = {},
) {
  assertPublicReadOnlyUrl(rawUrl, 'http');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const response = await fetchImpl(rawUrl, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': userAgent,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`GET ${new URL(rawUrl).pathname} -> HTTP ${response.status}`);
  }
  return response.json();
}

export function normalizeGammaMarket(raw, slug) {
  const markets = Array.isArray(raw) ? raw : raw?.markets ?? raw;
  const market = Array.isArray(markets) ? markets[0] : markets;
  if (!market) throw new Error(`Gamma market not found: ${slug}`);

  const tokenIds = parseMaybeArray(
    market.clobTokenIds ?? market.clob_token_ids,
  ).map(String);
  const outcomes = parseMaybeArray(market.outcomes).map(String);
  if (tokenIds.length < 2) throw new Error(`Gamma tokens missing: ${slug}`);

  let upIndex = outcomes.findIndex((value) => /^up$/i.test(value));
  let downIndex = outcomes.findIndex((value) => /^down$/i.test(value));
  if (upIndex < 0) upIndex = 0;
  if (downIndex < 0) downIndex = 1;
  const eventStartSec = eventStartFromSlug(slug);
  if (eventStartSec == null) throw new Error(`invalid BTC 5m slug: ${slug}`);

  return {
    slug,
    conditionId: String(
      market.conditionId ?? market.condition_id ?? market.condition ?? '',
    ),
    title: String(market.question ?? market.title ?? slug),
    eventStartSec,
    eventEndSec: eventStartSec + 300,
    tokens: [
      { outcome: 'UP', tokenId: tokenIds[upIndex] },
      { outcome: 'DOWN', tokenId: tokenIds[downIndex] },
    ],
  };
}

export async function discoverCurrentBtc5mMarket({
  nowMs = Date.now(),
  fetchImpl = globalThis.fetch,
  gammaOrigin = GAMMA_ORIGIN,
} = {}) {
  const slug = currentBtc5mSlug(nowMs);
  const url = `${gammaOrigin}/markets?slug=${encodeURIComponent(slug)}`;
  const raw = await fetchPublicJson(url, { fetchImpl });
  return normalizeGammaMarket(raw, slug);
}

function assetFromMarket(market, tokenId) {
  const id = String(tokenId ?? '');
  const token = market?.tokens?.find((row) => String(row.tokenId) === id);
  return token ? { tokenId: id, outcome: token.outcome } : null;
}

function commonMarket(market) {
  if (!market) return null;
  return {
    slug: market.slug,
    conditionId: market.conditionId || null,
    eventStartSec: market.eventStartSec,
    eventEndSec: market.eventEndSec,
  };
}

function dispatchSink(sink, record) {
  if (typeof sink === 'function') return sink(record);
  if (sink && typeof sink.onEvent === 'function') return sink.onEvent(record);
  if (sink && typeof sink.append === 'function') return sink.append(record);
  throw new Error('event sink must be a function or expose onEvent/append');
}

export function createJsonlEventSink(filePath) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return {
    filePath: resolved,
    onEvent(record) {
      fs.appendFileSync(resolved, `${JSON.stringify(record)}\n`);
    },
  };
}

export class PublicTapeRecorder {
  constructor({
    sink,
    runId = `public-tape-${new Date().toISOString()}`,
    now = () => Date.now(),
    recordLimit = Number.POSITIVE_INFINITY,
  } = {}) {
    if (!sink) throw new Error('event sink is required');
    this.sink = sink;
    this.runId = String(runId);
    this.now = now;
    this.recordLimit = Number.isFinite(recordLimit)
      ? Math.max(0, Math.floor(recordLimit))
      : Number.POSITIVE_INFINITY;
    this.sequence = 0;
    this.market = null;
    this.books = new Map();
    this.marketKeys = new Set();
    this.pendingSinks = new Set();
    this.fatalSinkError = null;
    this.stats = {
      records: 0,
      persistedWsRecords: 0,
      quotaDroppedRecords: 0,
      recordsByType: {},
      discoveries: 0,
      marketWindows: 0,
      restBookSnapshots: 0,
      wsBookSnapshots: 0,
      priceLevelUpdates: 0,
      trades: 0,
      bestBidAsk: 0,
      lifecycleEvents: 0,
      feedEvents: 0,
      wsMessages: 0,
      malformedMessages: 0,
      unknownAssets: 0,
      ignoredMessages: 0,
      sinkErrors: 0,
    };
  }

  emit(recordType, data, {
    transport = 'internal',
    asset = null,
    exchangeTsMs = null,
    receivedTsMs = this.now(),
    force = false,
  } = {}) {
    if (this.fatalSinkError) throw this.fatalSinkError;
    if (!force && this.stats.records >= this.recordLimit) {
      this.stats.quotaDroppedRecords += 1;
      return null;
    }
    this.sequence += 1;
    const observedAtMs = timestampMs(receivedTsMs, this.now());
    const record = {
      schema: PUBLIC_EVIDENCE_SCHEMA,
      runId: this.runId,
      recordId: `${this.runId}:${this.sequence}`,
      sequence: this.sequence,
      recordType,
      eventKey: this.market?.slug || null,
      observedAt: new Date(observedAtMs).toISOString(),
      observedAtMs,
      effectiveAtMs: timestampMs(exchangeTsMs, null),
      source: {
        provider: 'polymarket',
        transport,
        access: 'public-read-only',
      },
      market: commonMarket(this.market),
      asset,
      data,
    };
    this.stats.records += 1;
    this.stats.recordsByType[recordType] =
      Number(this.stats.recordsByType[recordType] || 0) + 1;
    if (transport === 'ws') this.stats.persistedWsRecords += 1;
    try {
      const pending = dispatchSink(this.sink, record);
      if (pending && typeof pending.then === 'function') {
        const tracked = Promise.resolve(pending)
          .catch((error) => {
            this.stats.sinkErrors += 1;
            this.fatalSinkError = error;
          })
          .finally(() => this.pendingSinks.delete(tracked));
        this.pendingSinks.add(tracked);
      }
    } catch (error) {
      this.stats.sinkErrors += 1;
      this.fatalSinkError = error;
      throw error;
    }
    return record;
  }

  emitRunState(
    state,
    data = {},
    receivedTsMs = this.now(),
    { force = false } = {},
  ) {
    return this.emit(`run.${state}`, data, {
      transport: 'internal',
      receivedTsMs,
      force,
    });
  }

  noteFeed(status, data = {}, receivedTsMs = this.now()) {
    this.stats.feedEvents += 1;
    return this.emit('feed.status', { status, ...data }, {
      transport: 'ws',
      receivedTsMs,
    });
  }

  noteMalformed(error, raw = null, receivedTsMs = this.now()) {
    this.stats.malformedMessages += 1;
    return this.emit('feed.malformed', {
      error: String(error?.message || error),
      rawPreview: raw == null ? null : String(raw).slice(0, 300),
    }, {
      transport: 'ws',
      receivedTsMs,
    });
  }

  setMarket(market, receivedTsMs = this.now()) {
    if (
      !market?.slug ||
      !Array.isArray(market.tokens) ||
      market.tokens.length < 2
    ) {
      throw new Error('market requires slug and two tokens');
    }
    this.market = {
      ...market,
      tokens: market.tokens.map((row) => ({
        outcome: String(row.outcome).toUpperCase(),
        tokenId: String(row.tokenId),
      })),
    };
    this.books.clear();
    for (const token of this.market.tokens) {
      this.books.set(token.tokenId, {
        bids: new Map(),
        asks: new Map(),
        hash: null,
        lastExchangeTsMs: null,
      });
    }
    const marketKey = this.market.conditionId || this.market.slug;
    this.marketKeys.add(marketKey);
    this.stats.marketWindows = this.marketKeys.size;
    this.stats.discoveries += 1;
    return this.emit('market.discovery', {
      title: this.market.title || this.market.slug,
      tokens: this.market.tokens,
      discoveryHash: stableHash(this.market),
    }, {
      transport: 'rest',
      receivedTsMs,
    });
  }

  requireAsset(tokenId) {
    const asset = assetFromMarket(this.market, tokenId);
    if (!asset) this.stats.unknownAssets += 1;
    return asset;
  }

  applyBookSnapshot({
    tokenId,
    bids,
    asks,
    hash = null,
    lastTradePrice = null,
    exchangeTsMs = null,
    receivedTsMs = this.now(),
    transport = 'rest',
  }) {
    const asset = this.requireAsset(tokenId);
    if (!asset) return null;
    const normalizedBids = normalizeLevels(bids);
    const normalizedAsks = normalizeLevels(asks);
    const book = this.books.get(asset.tokenId);
    book.bids = new Map(normalizedBids.map((row) => [String(row.price), row.size]));
    book.asks = new Map(normalizedAsks.map((row) => [String(row.price), row.size]));
    book.hash = hash == null ? null : String(hash);
    book.lastExchangeTsMs = timestampMs(exchangeTsMs, null);
    if (transport === 'rest') this.stats.restBookSnapshots += 1;
    else this.stats.wsBookSnapshots += 1;
    return this.emit('book.snapshot', {
      bids: normalizedBids,
      asks: normalizedAsks,
      hash: book.hash,
      lastTradePrice: finiteNumber(lastTradePrice),
      bestBid: normalizedBids.length
        ? Math.max(...normalizedBids.map((row) => row.price))
        : null,
      bestAsk: normalizedAsks.length
        ? Math.min(...normalizedAsks.map((row) => row.price))
        : null,
    }, {
      transport,
      asset,
      exchangeTsMs,
      receivedTsMs,
    });
  }

  ingestRestBook(tokenId, rawBook, receivedTsMs = this.now()) {
    return this.applyBookSnapshot({
      tokenId,
      bids: rawBook?.bids,
      asks: rawBook?.asks,
      hash: rawBook?.hash,
      lastTradePrice: rawBook?.last_trade_price ?? rawBook?.lastTradePrice,
      exchangeTsMs: rawBook?.timestamp,
      receivedTsMs,
      transport: 'rest',
    });
  }

  applyPriceChange(change, context = {}) {
    const tokenId =
      change?.asset_id ?? change?.assetId ?? change?.tokenId ?? context.tokenId;
    const asset = this.requireAsset(tokenId);
    if (!asset) return null;
    const side = String(change?.side || '').toUpperCase();
    const price = finiteNumber(change?.price);
    const sizeAfter = finiteNumber(change?.size);
    if (
      !['BUY', 'SELL'].includes(side) ||
      price == null ||
      sizeAfter == null ||
      price < 0 ||
      price > 1 ||
      sizeAfter < 0
    ) {
      this.stats.malformedMessages += 1;
      return null;
    }
    const book = this.books.get(asset.tokenId);
    const levels = side === 'BUY' ? book.bids : book.asks;
    const key = String(price);
    const sizeBefore = levels.has(key) ? levels.get(key) : null;
    if (sizeAfter === 0) levels.delete(key);
    else levels.set(key, sizeAfter);
    if (change?.hash != null) book.hash = String(change.hash);
    book.lastExchangeTsMs = timestampMs(context.exchangeTsMs, null);
    this.stats.priceLevelUpdates += 1;
    return this.emit('book.level', {
      side,
      price,
      sizeBefore,
      sizeAfter,
      sizeDelta: sizeBefore == null ? null : sizeAfter - sizeBefore,
      changeReason: 'unknown',
      hash: change?.hash == null ? book.hash : String(change.hash),
      bestBid: finiteNumber(change?.best_bid ?? change?.bestBid),
      bestAsk: finiteNumber(change?.best_ask ?? change?.bestAsk),
    }, {
      transport: 'ws',
      asset,
      exchangeTsMs: context.exchangeTsMs,
      receivedTsMs: context.receivedTsMs,
    });
  }

  ingestWs(raw, receivedTsMs = this.now()) {
    if (Array.isArray(raw)) {
      const records = [];
      for (const item of raw) records.push(...this.ingestWs(item, receivedTsMs));
      return records;
    }
    if (!raw || typeof raw !== 'object') {
      this.stats.malformedMessages += 1;
      return [];
    }
    this.stats.wsMessages += 1;
    const type = String(raw.event_type ?? raw.type ?? '').toLowerCase();
    const body = raw.payload && typeof raw.payload === 'object'
      ? raw.payload
      : raw;
    const exchangeTsMs = timestampMs(
      body.timestamp ?? raw.timestamp,
      null,
    );

    if (type === 'book') {
      const record = this.applyBookSnapshot({
        tokenId: body.asset_id ?? body.assetId ?? body.tokenId,
        bids: body.bids,
        asks: body.asks,
        hash: body.hash,
        lastTradePrice: body.last_trade_price ?? body.lastTradePrice,
        exchangeTsMs,
        receivedTsMs,
        transport: 'ws',
      });
      return record ? [record] : [];
    }

    if (type === 'price_change') {
      const changes =
        body.price_changes ?? body.priceChanges ?? body.changes ?? [];
      if (!Array.isArray(changes)) {
        this.stats.malformedMessages += 1;
        return [];
      }
      return changes
        .map((change) => this.applyPriceChange(change, {
          tokenId: body.asset_id ?? body.assetId ?? body.tokenId,
          exchangeTsMs,
          receivedTsMs,
        }))
        .filter(Boolean);
    }

    if (type === 'last_trade_price') {
      const tokenId = body.asset_id ?? body.assetId ?? body.tokenId;
      const asset = this.requireAsset(tokenId);
      if (!asset) return [];
      const price = finiteNumber(body.price);
      const size = finiteNumber(body.size);
      const reportedSide = String(body.side || '').toUpperCase();
      if (
        price == null ||
        !['BUY', 'SELL'].includes(reportedSide)
      ) {
        this.stats.malformedMessages += 1;
        return [];
      }
      this.stats.trades += 1;
      return [this.emit('trade.match', {
        price,
        size,
        reportedSide,
        sideSemantics: 'polymarket-last-trade-price',
        feeRateBps: finiteNumber(body.fee_rate_bps ?? body.feeRateBps),
        transactionHash:
          body.transaction_hash ?? body.transactionHash ?? null,
      }, {
        transport: 'ws',
        asset,
        exchangeTsMs,
        receivedTsMs,
      })];
    }

    if (type === 'best_bid_ask') {
      const tokenId = body.asset_id ?? body.assetId ?? body.tokenId;
      const asset = this.requireAsset(tokenId);
      if (!asset) return [];
      this.stats.bestBidAsk += 1;
      return [this.emit('book.best', {
        bestBid: finiteNumber(body.best_bid ?? body.bestBid),
        bestAsk: finiteNumber(body.best_ask ?? body.bestAsk),
        spread: finiteNumber(body.spread),
      }, {
        transport: 'ws',
        asset,
        exchangeTsMs,
        receivedTsMs,
      })];
    }

    if (['tick_size_change', 'market_resolved'].includes(type)) {
      const tokenId = body.asset_id ?? body.assetId ?? body.tokenId;
      const asset = tokenId == null ? null : this.requireAsset(tokenId);
      this.stats.lifecycleEvents += 1;
      return [this.emit('market.lifecycle', {
        lifecycleType: type,
        oldTickSize: finiteNumber(body.old_tick_size ?? body.oldTickSize),
        newTickSize: finiteNumber(body.new_tick_size ?? body.newTickSize),
        winningTokenId:
          body.winning_token_id ?? body.winningTokenId ?? null,
        winningOutcome:
          body.winning_outcome ?? body.winningOutcome ?? null,
      }, {
        transport: 'ws',
        asset,
        exchangeTsMs,
        receivedTsMs,
      })];
    }

    this.stats.ignoredMessages += 1;
    return [];
  }

  snapshotStats() {
    return {
      ...this.stats,
      sequence: this.sequence,
      runId: this.runId,
      currentMarket: this.market?.slug || null,
    };
  }

  async flush() {
    if (this.pendingSinks.size) {
      await Promise.allSettled([...this.pendingSinks]);
    }
    if (this.fatalSinkError) throw this.fatalSinkError;
  }
}

export function evaluateEvidenceGates(stats, {
  minDiscoveries = 1,
  minBookSnapshots = 2,
  minWsMessages = 1,
  minTrades = 0,
  maxMalformedMessages = 0,
  maxUnknownAssets = 0,
  maxSinkErrors = 0,
} = {}) {
  const hasTypeCounts =
    stats.recordsByType && typeof stats.recordsByType === 'object';
  const discoveries = hasTypeCounts
    ? Number(stats.recordsByType['market.discovery'] || 0)
    : Number(stats.discoveries || 0);
  const bookSnapshots = hasTypeCounts
    ? Number(stats.recordsByType['book.snapshot'] || 0)
    : Number(stats.restBookSnapshots || 0) + Number(stats.wsBookSnapshots || 0);
  const trades = hasTypeCounts
    ? Number(stats.recordsByType['trade.match'] || 0)
    : Number(stats.trades || 0);
  const wsMessages = stats.persistedWsRecords == null
    ? Number(stats.wsMessages || 0)
    : Number(stats.persistedWsRecords);
  const checks = [
    {
      id: 'discoveries',
      pass: discoveries >= minDiscoveries,
      actual: discoveries,
      required: `>=${minDiscoveries}`,
    },
    {
      id: 'book_snapshots',
      pass: bookSnapshots >= minBookSnapshots,
      actual: bookSnapshots,
      required: `>=${minBookSnapshots}`,
    },
    {
      id: 'ws_messages',
      pass: wsMessages >= minWsMessages,
      actual: wsMessages,
      required: `>=${minWsMessages}`,
    },
    {
      id: 'trades',
      pass: trades >= minTrades,
      actual: trades,
      required: `>=${minTrades}`,
    },
    {
      id: 'malformed_messages',
      pass: Number(stats.malformedMessages || 0) <= maxMalformedMessages,
      actual: Number(stats.malformedMessages || 0),
      required: `<=${maxMalformedMessages}`,
    },
    {
      id: 'unknown_assets',
      pass: Number(stats.unknownAssets || 0) <= maxUnknownAssets,
      actual: Number(stats.unknownAssets || 0),
      required: `<=${maxUnknownAssets}`,
    },
    {
      id: 'sink_errors',
      pass: Number(stats.sinkErrors || 0) <= maxSinkErrors,
      actual: Number(stats.sinkErrors || 0),
      required: `<=${maxSinkErrors}`,
    },
  ];
  return {
    pass: checks.every((row) => row.pass),
    checks,
  };
}

export async function replayPublicTapeFixture(
  fixturePath,
  recorder,
  { maxMessages = Number.POSITIVE_INFINITY } = {},
) {
  const lines = fs
    .readFileSync(path.resolve(fixturePath), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  let messages = 0;
  for (const line of lines) {
    if (messages >= maxMessages) break;
    const row = JSON.parse(line);
    const receivedTsMs = timestampMs(row.receivedTsMs, Date.now());
    if (row.fixtureType === 'market') {
      recorder.setMarket(row.market, receivedTsMs);
    } else if (row.fixtureType === 'rest_book') {
      recorder.ingestRestBook(row.tokenId, row.book, receivedTsMs);
    } else if (row.fixtureType === 'ws') {
      recorder.ingestWs(row.payload, receivedTsMs);
    } else {
      throw new Error(`unknown fixtureType: ${row.fixtureType}`);
    }
    messages += 1;
  }
  await recorder.flush();
  return { messages, availableMessages: lines.length };
}
