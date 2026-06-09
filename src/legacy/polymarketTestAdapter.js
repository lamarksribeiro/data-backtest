import { openBacktestTickSession, queryTicks } from '../query/duckdbQuery.js';

const DEFAULT_BATCH_SIZE = 10_000;

export function createPolymarketTestAdapter(db, defaults = {}) {
  return {
    getTicksForBacktest: (from, to, opts = {}) => getTicksForBacktest(db, { ...defaults, ...opts, from, to }),
    getTicksForBacktestBatch: (from, to, opts = {}) => getTicksForBacktestBatch(db, { ...defaults, ...opts, from, to }),
    getTicksForBacktestBatches: (from, to, batchSize = DEFAULT_BATCH_SIZE) => {
      const opts = typeof batchSize === 'object' && batchSize != null ? batchSize : { batchSize };
      return getTicksForBacktestBatches(db, { ...defaults, ...opts, from, to });
    },
  };
}

export async function getTicksForBacktest(db, { from, to, underlying = 'BTC', interval = '5m', bookDepth = 25, limit = 100000 } = {}) {
  const rows = await queryTicks(db, {
    dataset: 'backtest_ticks',
    underlying,
    interval,
    bookDepth,
    from,
    to: toExclusiveForLegacyInclusiveRange(to),
    limit,
    validBacktestRows: true,
  });
  return rows.map((row, index) => toLegacyBacktestTick(row, { index, bookDepth }));
}

export async function getTicksForBacktestBatch(db, {
  from,
  to,
  underlying = 'BTC',
  interval = '5m',
  bookDepth = 25,
  limit = DEFAULT_BATCH_SIZE,
  offset = 0,
} = {}) {
  const rows = await queryTicks(db, {
    dataset: 'backtest_ticks',
    underlying,
    interval,
    bookDepth,
    from,
    to: toExclusiveForLegacyInclusiveRange(to),
    limit,
    offset,
    validBacktestRows: true,
  });
  return rows.map((row, index) => toLegacyBacktestTick(row, { index: offset + index, bookDepth }));
}

export async function* getTicksForBacktestBatches(db, opts = {}) {
  const batchSize = normalizeBatchSize(opts.batchSize ?? opts.limit ?? DEFAULT_BATCH_SIZE);
  const bookDepth = opts.bookDepth ?? 25;
  const session = await openBacktestTickSession(db, {
    ...opts,
    bookDepth,
    to: toExclusiveForLegacyInclusiveRange(opts.to),
    validBacktestRows: true,
  });
  try {
    let offset = 0;
    while (true) {
      const rows = await session.readBatch(offset, batchSize);
      if (!rows.length) break;
      yield rows.map((row, index) => toLegacyBacktestTick(row, { index: offset + index, bookDepth }));
      offset += rows.length;
      if (rows.length < batchSize) break;
    }
  } finally {
    session.close();
  }
}

export function toLegacyBacktestTick(row, { index = 0, bookDepth = 25 } = {}) {
  const upBookAsks = levelsFromFlattened(row, 'up_ask', bookDepth);
  const upBookBids = levelsFromFlattened(row, 'up_bid', bookDepth);
  const downBookAsks = levelsFromFlattened(row, 'down_ask', bookDepth);
  const downBookBids = levelsFromFlattened(row, 'down_bid', bookDepth);

  const upBookAsksParsed = upBookAsks.map(l => ({ price: l.price, size: l.size, key: String(l.price) }));
  Object.defineProperty(upBookAsksParsed, '_isParsed', { value: true, enumerable: false });
  const upBookBidsParsed = upBookBids.map(l => ({ price: l.price, size: l.size, key: String(l.price) }));
  Object.defineProperty(upBookBidsParsed, '_isParsed', { value: true, enumerable: false });
  const downBookAsksParsed = downBookAsks.map(l => ({ price: l.price, size: l.size, key: String(l.price) }));
  Object.defineProperty(downBookAsksParsed, '_isParsed', { value: true, enumerable: false });
  const downBookBidsParsed = downBookBids.map(l => ({ price: l.price, size: l.size, key: String(l.price) }));
  Object.defineProperty(downBookBidsParsed, '_isParsed', { value: true, enumerable: false });

  const tick = {
    id: index + 1,
    event_start: row.event_start,
    event_end: row.event_end,
    condition_id: row.condition_id,
    ts: row.ts,
    btc_price: row.underlying_price,
    btc_binance: null,
    price_to_beat: row.price_to_beat,
    up_price: row.up_price,
    down_price: row.down_price,
    up_best_bid: bestPrice(upBookBids, 'bid') ?? row.up_best_bid,
    up_best_ask: bestPrice(upBookAsks, 'ask') ?? row.up_best_ask,
    down_best_bid: bestPrice(downBookBids, 'bid') ?? row.down_best_bid,
    down_best_ask: bestPrice(downBookAsks, 'ask') ?? row.down_best_ask,
    up_book_asks: JSON.stringify(upBookAsks),
    up_book_bids: JSON.stringify(upBookBids),
    down_book_asks: JSON.stringify(downBookAsks),
    down_book_bids: JSON.stringify(downBookBids),
  };

  tick._parsed_up_book_asks = upBookAsksParsed;
  tick._parsed_up_book_bids = upBookBidsParsed;
  tick._parsed_down_book_asks = downBookAsksParsed;
  tick._parsed_down_book_bids = downBookBidsParsed;

  if (row._tsMs !== undefined) tick._tsMs = row._tsMs;
  if (row._eventStartMs !== undefined) tick._eventStartMs = row._eventStartMs;
  if (row._eventEndMs !== undefined) tick._eventEndMs = row._eventEndMs;

  return tick;
}

function levelsFromFlattened(row, prefix, depth) {
  const levels = [];
  for (let i = 1; i <= depth; i += 1) {
    const price = finiteOrNull(row[`${prefix}_px_${i}`]);
    const size = finiteOrNull(row[`${prefix}_sz_${i}`]);
    if (price == null || size == null || size <= 0) continue;
    levels.push({ price, size });
  }
  return levels;
}

function bestPrice(levels, direction) {
  const prices = levels.map((level) => level.price).filter(Number.isFinite);
  if (!prices.length) return null;
  return direction === 'bid' ? Math.max(...prices) : Math.min(...prices);
}

function finiteOrNull(value) {
  if (value == null) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function normalizeBatchSize(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_BATCH_SIZE), 10);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : DEFAULT_BATCH_SIZE, 1), 50_000);
}

function toExclusiveForLegacyInclusiveRange(to) {
  const date = new Date(to);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${to}`);
  return new Date(date.getTime() + 1).toISOString();
}
