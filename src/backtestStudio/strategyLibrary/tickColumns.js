import { bookLevelColumnNames } from './runtime/bookLevels.js';

export const LIBRARY_RUNNER_SCALAR_COLUMNS = [
  'market_id', 'underlying', 'interval', 'condition_id', 'event_start', 'event_end', 'ts',
  'underlying_price', 'price_to_beat', 'up_price', 'down_price',
  'up_best_bid', 'up_best_ask', 'down_best_bid', 'down_best_ask',
  'coverage', 'degraded', 'book_depth',
];

export function libraryRunnerTickColumnNames(bookDepth = 25) {
  return [...LIBRARY_RUNNER_SCALAR_COLUMNS, ...bookLevelColumnNames(bookDepth)];
}
