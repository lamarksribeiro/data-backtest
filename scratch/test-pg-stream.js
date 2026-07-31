import pg from 'pg';

const connectionGoldenlens = 'postgresql://postgres:ba1f652bf11649ddabc02b734942b7bb@localhost:5432/goldenlens';

export async function* getTicksForBacktestBatches(from, to, batchSize = 10000) {
  const pool = new pg.Pool({ connectionString: connectionGoldenlens });
  const client = await pool.connect();
  
  try {
    let offset = 0;
    while (true) {
      const res = await client.query(`
        SELECT 
          id, event_start, condition_id, ts, btc_price, price_to_beat,
          up_price, down_price, up_best_bid, up_best_ask, down_best_bid, down_best_ask,
          up_book_asks, up_book_bids, down_book_asks, down_book_bids
        FROM ticks
        WHERE ts >= $1 AND ts <= $2
        ORDER BY ts ASC, id ASC
        LIMIT $3 OFFSET $4
      `, [from, to, batchSize, offset]);

      if (res.rows.length === 0) break;
      yield res.rows;
      offset += res.rows.length;
      if (res.rows.length < batchSize) break;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

async function test() {
  const from = '2026-05-04T15:00:00.000Z';
  const to = '2026-05-04T18:00:00.000Z';
  let totalRows = 0;
  let batches = 0;
  const start = Date.now();
  for await (const batch of getTicksForBacktestBatches(from, to, 5000)) {
    batches++;
    totalRows += batch.length;
  }
  console.log(`Streamed ${totalRows} ticks across ${batches} batches in ${Date.now() - start} ms`);
}

test();
