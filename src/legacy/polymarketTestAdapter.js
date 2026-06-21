import { openBacktestTickSession, queryTicks } from '../query/duckdbQuery.js';
import {
  bestPrice,
  buildSortedBookLevels,
  finiteOrNull,
  levelsFromFlattened,
} from '../backtestStudio/strategyLibrary/runtime/bookLevels.js';

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

/**
 * @param {'both'|'parsed'|'string'} bookFormat
 *   - both: JSON strings + _parsed_* (legacy duckdb batches)
 *   - parsed: sorted arrays on book fields (fast library-runner path)
 *   - string: JSON strings only
 */
export function toLegacyBacktestTick(row, {
  index = 0,
  bookDepth = 25,
  bookFormat = 'both',
  target = null,
} = {}) {
  const upBookAsks = levelsFromFlattened(row, 'up_ask', bookDepth);
  const upBookBids = levelsFromFlattened(row, 'up_bid', bookDepth);
  const downBookAsks = levelsFromFlattened(row, 'down_ask', bookDepth);
  const downBookBids = levelsFromFlattened(row, 'down_bid', bookDepth);

  const upBookAsksParsed = buildSortedBookLevels(upBookAsks, 'ask');
  const upBookBidsParsed = buildSortedBookLevels(upBookBids, 'bid');
  const downBookAsksParsed = buildSortedBookLevels(downBookAsks, 'ask');
  const downBookBidsParsed = buildSortedBookLevels(downBookBids, 'bid');

  const useParsedBooks = bookFormat === 'parsed';
  const useStringBooks = bookFormat === 'string' || bookFormat === 'both';

  const tick = target ?? {
    _parsed_up_book_asks: upBookAsksParsed,
    _parsed_up_book_bids: upBookBidsParsed,
    _parsed_down_book_asks: downBookAsksParsed,
    _parsed_down_book_bids: downBookBidsParsed,
  };

  tick.id = index + 1;
  tick.event_start = row.event_start;
  tick.event_end = row.event_end;
  tick.condition_id = row.condition_id;
  tick.ts = row.ts;
  tick.btc_price = row.underlying_price;
  tick.btc_binance = null;
  tick.price_to_beat = row.price_to_beat;
  tick.up_price = row.up_price;
  tick.down_price = row.down_price;
  tick.up_best_bid = bestPrice(upBookBids, 'bid') ?? row.up_best_bid;
  tick.up_best_ask = bestPrice(upBookAsks, 'ask') ?? row.up_best_ask;
  tick.down_best_bid = bestPrice(downBookBids, 'bid') ?? row.down_best_bid;
  tick.down_best_ask = bestPrice(downBookAsks, 'ask') ?? row.down_best_ask;

  if (useParsedBooks) {
    tick.up_book_asks = upBookAsksParsed;
    tick.up_book_bids = upBookBidsParsed;
    tick.down_book_asks = downBookAsksParsed;
    tick.down_book_bids = downBookBidsParsed;
  } else if (useStringBooks) {
    tick.up_book_asks = JSON.stringify(upBookAsks);
    tick.up_book_bids = JSON.stringify(upBookBids);
    tick.down_book_asks = JSON.stringify(downBookAsks);
    tick.down_book_bids = JSON.stringify(downBookBids);
  }

  tick._parsed_up_book_asks = upBookAsksParsed;
  tick._parsed_up_book_bids = upBookBidsParsed;
  tick._parsed_down_book_asks = downBookAsksParsed;
  tick._parsed_down_book_bids = downBookBidsParsed;

  if (row._tsMs !== undefined) tick._tsMs = row._tsMs;
  else delete tick._tsMs;
  if (row._eventStartMs !== undefined) tick._eventStartMs = row._eventStartMs;
  else delete tick._eventStartMs;
  if (row._eventEndMs !== undefined) tick._eventEndMs = row._eventEndMs;
  else delete tick._eventEndMs;

  return tick;
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
