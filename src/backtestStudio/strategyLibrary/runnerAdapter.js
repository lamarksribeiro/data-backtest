import { createTickCursorView } from '../../backtest/columnStore.js';
import { loadStrategyLibraryRunner } from './loadRunner.js';
import { legacyTickFromAny, legacyTickFromCursor } from './tickBridge.js';

export const LIBRARY_RUNNER_COLUMN_ANALYSIS = {
  needsBookLevels: true,
  bookDepth: 25,
  scalarColumns: [
    'market_id', 'underlying', 'interval', 'condition_id', 'event_start', 'event_end', 'ts',
    'underlying_price', 'price_to_beat', 'up_price', 'down_price',
    'up_best_bid', 'up_best_ask', 'down_best_bid', 'down_best_ask',
    'coverage', 'degraded', 'book_depth',
  ],
};

export function createLibraryRunnerAdapter(db, { slug, version }, rawParams = {}, options = {}) {
  const inner = loadStrategyLibraryRunner(db, slug, version, rawParams);
  if (!inner) throw new Error(`strategy library runner not found: ${slug}@${version}`);

  const bookDepth = options.bookDepth ?? 25;
  let columnSet = null;
  let tickCursor = null;
  let ticksProcessed = 0;

  return {
    executionMode: 'library-runner',
    bindColumnSet(nextColumnSet) {
      columnSet = nextColumnSet;
      tickCursor = createTickCursorView(columnSet);
    },
    beginEvent() {},
    endEvent() {},
    processTick(rawTick) {
      ticksProcessed += 1;
      inner.processTick(legacyTickFromAny(rawTick, bookDepth));
    },
    processIndex(rowIndex) {
      if (!columnSet || !tickCursor) return;
      tickCursor.setIndex(rowIndex);
      ticksProcessed += 1;
      inner.processTick(legacyTickFromCursor(tickCursor, columnSet, bookDepth));
    },
    importParallelSlices() {
      throw new Error('library-runner does not support parallel event slices yet');
    },
    finish() {
      const result = inner.finish();
      result.summary.ticksProcessed = ticksProcessed;
      return result;
    },
  };
}