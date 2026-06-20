import { toLegacyBacktestTick } from '../../legacy/polymarketTestAdapter.js';

export function legacyTickFromCursor(cursor, columnSet, bookDepth = 25) {
  const index = cursor.index;
  const row = {
    ts: cursor.ts,
    event_start: cursor.event_start,
    event_end: cursor.event_end,
    condition_id: cursor.condition_id,
  };
  for (const [name, column] of columnSet.columns.entries()) {
    if (name.startsWith('_')) continue;
    if (name in row) continue;
    const value = column[index];
    row[name] = Number.isNaN(value) ? null : value;
  }
  return toLegacyBacktestTick(row, { index, bookDepth });
}

export function legacyTickFromAny(tick, bookDepth = 25) {
  if (tick?.up_book_asks != null || tick?._parsed_up_book_asks != null) return tick;
  const row = {
    ts: tick.ts,
    event_start: tick.event_start,
    event_end: tick.event_end,
    condition_id: tick.condition_id,
    underlying_price: tick.btc_price ?? tick.underlyingPrice ?? tick.underlying_price,
    price_to_beat: tick.price_to_beat ?? tick.priceToBeat,
    up_price: tick.up_price ?? tick.upPrice,
    down_price: tick.down_price ?? tick.downPrice,
    up_best_ask: tick.up_best_ask ?? tick.upBestAsk,
    up_best_bid: tick.up_best_bid ?? tick.upBestBid,
    down_best_ask: tick.down_best_ask ?? tick.downBestAsk,
    down_best_bid: tick.down_best_bid ?? tick.downBestBid,
  };
  for (const key of Object.keys(tick)) {
    if (/^(up|down)_(ask|bid)_px_\d+$/.test(key) || /^(up|down)_(ask|bid)_sz_\d+$/.test(key)) {
      row[key] = tick[key];
    }
  }
  return toLegacyBacktestTick(row, { index: tick.id ?? 0, bookDepth });
}