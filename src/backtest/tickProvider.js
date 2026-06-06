import { toLegacyBacktestTick } from '../legacy/polymarketTestAdapter.js';
import { openBacktestTickSession } from '../query/duckdbQuery.js';

const DEFAULT_BATCH_SIZE = 10_000;

export class DuckDbTickProvider {
  constructor(db, defaults = {}) {
    this.db = db;
    this.defaults = defaults;
  }

  async *streamTicks(request = {}) {
    const batchSize = normalizeBatchSize(request.batchSize ?? request.limit ?? DEFAULT_BATCH_SIZE);
    const session = await openBacktestTickSession(this.db, {
      ...this.defaults,
      ...request,
      bookDepth: this.defaults.bookDepth ?? request.bookDepth ?? 25,
      validBacktestRows: true,
    });

    try {
      let offset = 0;
      while (true) {
        const rows = await session.readBatch(offset, batchSize);
        if (!rows.length) break;
        yield rows.map((row, index) => toLegacyBacktestTick(row, {
          index: offset + index,
          bookDepth: session.bookDepth,
        }));
        offset += rows.length;
        if (rows.length < batchSize) break;
      }
    } finally {
      session.close();
    }
  }
}

function normalizeBatchSize(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_BATCH_SIZE), 10);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : DEFAULT_BATCH_SIZE, 1), 50_000);
}
