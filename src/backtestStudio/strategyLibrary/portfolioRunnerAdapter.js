import { loadStrategyLibraryRunner } from './loadRunner.js';
import { legacyTickFromAny } from './tickBridge.js';
import { createLegacyTickFacadeBinding } from './legacyTickFacade.js';
import { getStrategyLibraryValidation } from './kind.js';

export const PORTFOLIO_RUNNER_COLUMN_ANALYSIS = {
  needsBookLevels: true,
  bookDepth: 25,
  scalarColumns: [
    'market_id', 'underlying', 'interval', 'condition_id', 'event_start', 'event_end', 'ts',
    'underlying_price', 'price_to_beat', 'up_price', 'down_price',
    'up_best_bid', 'up_best_ask', 'down_best_bid', 'down_best_ask',
    'coverage', 'degraded', 'book_depth',
  ],
};

export function createPortfolioRunnerAdapter(db, { slug, version }, rawParams = {}, options = {}) {
  const validation = getStrategyLibraryValidation(db, slug, version);
  if (!validation || validation.kind !== 'portfolio') {
    throw new Error(`strategy library is not a portfolio runner: ${slug}@${version}`);
  }

  const loadChildRunner = (childSlug, childVersion, childParams) => (
    loadStrategyLibraryRunner(db, childSlug, childVersion, childParams, { loadChildRunner })
  );

  const inner = loadStrategyLibraryRunner(db, slug, version, rawParams, { loadChildRunner });
  if (!inner) throw new Error(`portfolio runner not found: ${slug}@${version}`);

  const bookDepth = options.bookDepth ?? 25;
  let columnSet = null;
  let tickBinding = null;
  let ticksProcessed = 0;

  return {
    executionMode: 'portfolio-runner-soa',
    bindColumnSet(nextColumnSet) {
      columnSet = nextColumnSet;
      tickBinding = createLegacyTickFacadeBinding(columnSet, bookDepth);
    },
    beginEvent() {},
    endEvent() {},
    processTick(rawTick) {
      ticksProcessed += 1;
      inner.processTick(legacyTickFromAny(rawTick, bookDepth));
    },
    processIndex(rowIndex) {
      if (!columnSet || !tickBinding) return;
      ticksProcessed += 1;
      const facade = tickBinding.atRow(rowIndex);
      if (typeof inner.processIndex === 'function') {
        inner.processIndex(tickBinding.cursor, facade);
        return;
      }
      inner.processTick(facade);
    },
    importParallelSlices() {
      throw new Error('portfolio-runner does not support parallel event slices yet');
    },
    finish() {
      const result = inner.finish();
      result.summary.ticksProcessed = ticksProcessed;
      return result;
    },
  };
}