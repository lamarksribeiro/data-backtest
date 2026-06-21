import { createTickCursorView } from '../../backtest/columnStore.js';
import {
  bestPrice,
  buildSortedBookLevels,
  finiteOrNull,
  levelsFromFlattened,
} from './runtime/bookLevels.js';

export function createLegacyTickFacade(cursor, bookDepth = 25) {
  let booksRow = -1;
  let upAsksParsed = null;
  let upBidsParsed = null;
  let downAsksParsed = null;
  let downBidsParsed = null;
  let upBestAsk = null;
  let upBestBid = null;
  let downBestAsk = null;
  let downBestBid = null;

  function ensureBooks() {
    const row = cursor.index;
    if (booksRow === row) return;
    booksRow = row;

    const upAsksRaw = [];
    const upBidsRaw = [];
    const downAsksRaw = [];
    const downBidsRaw = [];
    for (let level = 1; level <= bookDepth; level += 1) {
      const upAskPrice = finiteOrNull(cursor[`up_ask_px_${level}`]);
      const upAskSize = finiteOrNull(cursor[`up_ask_sz_${level}`]);
      if (upAskPrice != null && upAskSize != null && upAskSize > 0) {
        upAsksRaw.push({ price: upAskPrice, size: upAskSize });
      }
      const upBidPrice = finiteOrNull(cursor[`up_bid_px_${level}`]);
      const upBidSize = finiteOrNull(cursor[`up_bid_sz_${level}`]);
      if (upBidPrice != null && upBidSize != null && upBidSize > 0) {
        upBidsRaw.push({ price: upBidPrice, size: upBidSize });
      }
      const downAskPrice = finiteOrNull(cursor[`down_ask_px_${level}`]);
      const downAskSize = finiteOrNull(cursor[`down_ask_sz_${level}`]);
      if (downAskPrice != null && downAskSize != null && downAskSize > 0) {
        downAsksRaw.push({ price: downAskPrice, size: downAskSize });
      }
      const downBidPrice = finiteOrNull(cursor[`down_bid_px_${level}`]);
      const downBidSize = finiteOrNull(cursor[`down_bid_sz_${level}`]);
      if (downBidPrice != null && downBidSize != null && downBidSize > 0) {
        downBidsRaw.push({ price: downBidPrice, size: downBidSize });
      }
    }

    upAsksParsed = buildSortedBookLevels(upAsksRaw, 'ask');
    upBidsParsed = buildSortedBookLevels(upBidsRaw, 'bid');
    downAsksParsed = buildSortedBookLevels(downAsksRaw, 'ask');
    downBidsParsed = buildSortedBookLevels(downBidsRaw, 'bid');
    upBestAsk = bestPrice(upAsksRaw, 'ask') ?? finiteOrNull(cursor.up_best_ask);
    upBestBid = bestPrice(upBidsRaw, 'bid') ?? finiteOrNull(cursor.up_best_bid);
    downBestAsk = bestPrice(downAsksRaw, 'ask') ?? finiteOrNull(cursor.down_best_ask);
    downBestBid = bestPrice(downBidsRaw, 'bid') ?? finiteOrNull(cursor.down_best_bid);
  }

  const facade = {
    get id() { return cursor.index + 1; },
    get ts() { return cursor.ts; },
    get _tsMs() { return cursor._tsMs; },
    get _eventStartMs() { return cursor._eventStartMs; },
    get _eventEndMs() { return cursor._eventEndMs; },
    get event_start() { return cursor.event_start; },
    get event_end() { return cursor.event_end; },
    get condition_id() { return cursor.condition_id; },
    get btc_price() { return finiteOrNull(cursor.underlying_price); },
    get btc_binance() { return null; },
    get price_to_beat() { return finiteOrNull(cursor.price_to_beat); },
    get up_price() { return finiteOrNull(cursor.up_price); },
    get down_price() { return finiteOrNull(cursor.down_price); },
    get up_best_ask() { ensureBooks(); return upBestAsk; },
    get up_best_bid() { ensureBooks(); return upBestBid; },
    get down_best_ask() { ensureBooks(); return downBestAsk; },
    get down_best_bid() { ensureBooks(); return downBestBid; },
    get up_book_asks() { ensureBooks(); return upAsksParsed; },
    get up_book_bids() { ensureBooks(); return upBidsParsed; },
    get down_book_asks() { ensureBooks(); return downAsksParsed; },
    get down_book_bids() { ensureBooks(); return downBidsParsed; },
    get _parsed_up_book_asks() { ensureBooks(); return upAsksParsed; },
    get _parsed_up_book_bids() { ensureBooks(); return upBidsParsed; },
    get _parsed_down_book_asks() { ensureBooks(); return downAsksParsed; },
    get _parsed_down_book_bids() { ensureBooks(); return downBidsParsed; },
    get coverage() { return finiteOrNull(cursor.coverage); },
    get degraded() { return cursor.degraded; },
    get book_depth() { return finiteOrNull(cursor.book_depth); },
  };

  return facade;
}

export function createLegacyTickFacadeBinding(columnSet, bookDepth = 25) {
  const cursor = createTickCursorView(columnSet);
  const facade = createLegacyTickFacade(cursor, bookDepth);
  return {
    cursor,
    facade,
    atRow(rowIndex) {
      cursor.setIndex(rowIndex);
      return facade;
    },
  };
}

export function materializeLegacyTickFromFacade(facade, cursor, bookDepth = 25) {
  const row = {
    ts: facade.ts,
    event_start: facade.event_start,
    event_end: facade.event_end,
    condition_id: facade.condition_id,
    underlying_price: facade.btc_price,
    price_to_beat: facade.price_to_beat,
    up_price: facade.up_price,
    down_price: facade.down_price,
    up_best_ask: facade.up_best_ask,
    up_best_bid: facade.up_best_bid,
    down_best_ask: facade.down_best_ask,
    down_best_bid: facade.down_best_bid,
    _tsMs: facade._tsMs,
    _eventStartMs: facade._eventStartMs,
    _eventEndMs: facade._eventEndMs,
  };
  for (let level = 1; level <= bookDepth; level += 1) {
    for (const key of [
      `up_ask_px_${level}`, `up_ask_sz_${level}`,
      `up_bid_px_${level}`, `up_bid_sz_${level}`,
      `down_ask_px_${level}`, `down_ask_sz_${level}`,
      `down_bid_px_${level}`, `down_bid_sz_${level}`,
    ]) {
      row[key] = finiteOrNull(cursor[key]);
    }
  }
  const upAsks = levelsFromFlattened(row, 'up_ask', bookDepth);
  const upBids = levelsFromFlattened(row, 'up_bid', bookDepth);
  const downAsks = levelsFromFlattened(row, 'down_ask', bookDepth);
  const downBids = levelsFromFlattened(row, 'down_bid', bookDepth);
  const upAsksParsed = buildSortedBookLevels(upAsks, 'ask');
  const upBidsParsed = buildSortedBookLevels(upBids, 'bid');
  const downAsksParsed = buildSortedBookLevels(downAsks, 'ask');
  const downBidsParsed = buildSortedBookLevels(downBids, 'bid');
  return {
    id: facade.id,
    ts: facade.ts,
    event_start: facade.event_start,
    event_end: facade.event_end,
    condition_id: facade.condition_id,
    btc_price: facade.btc_price,
    btc_binance: null,
    price_to_beat: facade.price_to_beat,
    up_price: facade.up_price,
    down_price: facade.down_price,
    up_best_ask: facade.up_best_ask,
    up_best_bid: facade.up_best_bid,
    down_best_ask: facade.down_best_ask,
    down_best_bid: facade.down_best_bid,
    up_book_asks: upAsksParsed,
    up_book_bids: upBidsParsed,
    down_book_asks: downAsksParsed,
    down_book_bids: downBidsParsed,
    _parsed_up_book_asks: upAsksParsed,
    _parsed_up_book_bids: upBidsParsed,
    _parsed_down_book_asks: downAsksParsed,
    _parsed_down_book_bids: downBidsParsed,
    _tsMs: facade._tsMs,
    _eventStartMs: facade._eventStartMs,
    _eventEndMs: facade._eventEndMs,
  };
}
