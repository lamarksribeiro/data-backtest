import pg from 'pg';

const connectionGoldenlens = 'postgresql://postgres:ba1f652bf11649ddabc02b734942b7bb@localhost:5432/goldenlens';

async function main() {
  const pool = new pg.Pool({ connectionString: connectionGoldenlens });
  const client = await pool.connect();

  try {
    const minId = 1643769;
    const maxId = 7656531;

    console.log("1 & 3. Ticks Count & Min/Max TS:");
    const r1 = await client.query(`
      SELECT COUNT(*) as ticks, MIN(ts) as min_ts, MAX(ts) as max_ts
      FROM ticks WHERE id >= $1 AND id <= $2
    `, [minId, maxId]);
    console.log(r1.rows[0]);

    console.log("\n2. Events Count (using events table):");
    const r2 = await client.query(`
      SELECT COUNT(*) as events
      FROM (
        SELECT DISTINCT event_start FROM ticks WHERE id >= $1 AND id <= $2
      ) sub
    `, [minId, maxId]);
    console.log(r2.rows[0]);

    console.log("\n6, 7, 8. Book & Ask/Bid Coverage:");
    const r3 = await client.query(`
      SELECT 
        COUNT(*) as total_ticks,
        COUNT(*) FILTER (WHERE up_best_ask > 0) as up_ask_valid,
        COUNT(*) FILTER (WHERE down_best_ask > 0) as down_ask_valid,
        COUNT(*) FILTER (WHERE up_best_bid > 0) as up_bid_valid,
        COUNT(*) FILTER (WHERE down_best_bid > 0) as down_bid_valid,
        COUNT(*) FILTER (WHERE up_best_ask > 0 AND down_best_ask > 0) as both_asks_valid,
        COUNT(*) FILTER (WHERE up_best_bid > 0 AND down_best_bid > 0) as both_bids_valid
      FROM ticks WHERE id >= $1 AND id <= $2
    `, [minId, maxId]);
    console.log(r3.rows[0]);

    console.log("\n9, 10, 11, 12. Sum Distribution & Mispricing (sampled 1 in 10 for ultra speed):");
    const r4 = await client.query(`
      SELECT 
        AVG(up_best_ask + down_best_ask) as avg_sum_ask,
        PERCENTILE_CONT(0.01) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p01_sum_ask,
        PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p05_sum_ask,
        PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p10_sum_ask,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p50_sum_ask,
        PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p90_sum_ask,
        AVG(up_best_bid + down_best_bid) as avg_sum_bid,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY up_best_bid + down_best_bid) as p50_sum_bid,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 1.00) as sum_ask_lt_1_00,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.99) as sum_ask_lt_0_99,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.98) as sum_ask_lt_0_98,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.96) as sum_ask_lt_0_96,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.95) as sum_ask_lt_0_95,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.92) as sum_ask_lt_0_92,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.90) as sum_ask_lt_0_90,
        COUNT(*) FILTER (WHERE (up_best_bid + down_best_bid) > 1.00) as sum_bid_gt_1_00
      FROM ticks 
      WHERE id >= $1 AND id <= $2 AND id % 10 = 0 AND up_best_ask > 0 AND down_best_ask > 0
    `, [minId, maxId]);
    console.log(r4.rows[0]);

  } catch (err) {
    console.error(err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
