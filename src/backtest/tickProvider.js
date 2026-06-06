import { toLegacyBacktestTick } from '../legacy/polymarketTestAdapter.js';
import { queryAllTicksForBacktest } from '../query/duckdbQuery.js';

const DEFAULT_BATCH_SIZE = 50_000;

export class DuckDbTickProvider {
  constructor(db, defaults = {}) {
    this.db = db;
    this.defaults = defaults;
  }

  async *streamTicks(request = {}) {
    const batchSize = normalizeBatchSize(request.batchSize ?? request.limit ?? DEFAULT_BATCH_SIZE);
    const bookDepth = this.defaults.bookDepth ?? request.bookDepth ?? 25;
    const rows = await queryAllTicksForBacktest(this.db, {
      ...this.defaults,
      ...request,
      bookDepth,
      validBacktestRows: true,
    });

    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const slice = rows.slice(offset, offset + batchSize);
      yield slice.map((row, index) => toLegacyBacktestTick(row, {
        index: offset + index,
        bookDepth,
      }));
    }
  }
}

function normalizeBatchSize(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_BATCH_SIZE), 10);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : DEFAULT_BATCH_SIZE, 1), 200_000);
}
