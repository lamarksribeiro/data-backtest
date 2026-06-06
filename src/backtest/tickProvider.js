import { toLegacyBacktestTick } from '../legacy/polymarketTestAdapter.js';
import { queryTicks } from '../query/duckdbQuery.js';

const DEFAULT_BATCH_SIZE = 5000;

export class DuckDbTickProvider {
  constructor(db, defaults = {}) {
    this.db = db;
    this.defaults = defaults;
  }

  async *streamTicks(request = {}) {
    const batchSize = normalizeBatchSize(request.batchSize ?? request.limit ?? DEFAULT_BATCH_SIZE);
    let offset = 0;
    while (true) {
      const rows = await queryTicks(this.db, {
        dataset: 'backtest_ticks',
        ...this.defaults,
        ...request,
        limit: batchSize,
        offset,
        validBacktestRows: true,
      });
      const batch = rows.map((row, index) => toLegacyBacktestTick(row, {
        index: offset + index,
        bookDepth: this.defaults.bookDepth ?? request.bookDepth ?? 25,
      }));
      if (!batch.length) break;
      yield batch;
      offset += batch.length;
      if (batch.length < batchSize) break;
    }
  }
}

function normalizeBatchSize(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_BATCH_SIZE), 10);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : DEFAULT_BATCH_SIZE, 1), 100000);
}
