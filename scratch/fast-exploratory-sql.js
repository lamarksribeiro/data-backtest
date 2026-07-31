import pg from 'pg';

const connectionGoldenlens = 'postgresql://postgres:ba1f652bf11649ddabc02b734942b7bb@localhost:5432/goldenlens';

async function runFastAnalysis() {
  const pool = new pg.Pool({ connectionString: connectionGoldenlens, statement_timeout: 120000 });
  const client = await pool.connect();
  
  try {
    const FROM_TS = '2026-05-04T15:00:00.000Z';
    console.log("=== FAST EXPLORATORY ANALYSIS FROM:", FROM_TS, "===");

    // 1. Min / Max TS
    console.log("\n1. Min / Max TS:");
    const minMaxRes = await client.query(`
      SELECT MIN(ts) as primeiro_ts, MAX(ts) as ultimo_ts, COUNT(*) as total_ticks
      FROM ticks
      WHERE ts >= $1
    `, [FROM_TS]);
    console.log(minMaxRes.rows[0]);

    // 2. Count distinct events & conditions
    console.log("\n2. Event count:");
    const evtRes = await client.query(`
      SELECT COUNT(DISTINCT event_start) as total_eventos
      FROM ticks
      WHERE ts >= $1
    `, [FROM_TS]);
    console.log(evtRes.rows[0]);

    // 3. Daily breakdown
    console.log("\n3. Daily Coverage:");
    const dailyRes = await client.query(`
      SELECT 
        DATE(ts AT TIME ZONE 'UTC') as dia,
        COUNT(*) as ticks,
        COUNT(DISTINCT event_start) as eventos,
        MIN(ts) as min_ts,
        MAX(ts) as max_ts
      FROM ticks
      WHERE ts >= $1
      GROUP BY DATE(ts AT TIME ZONE 'UTC')
      ORDER BY dia ASC
    `, [FROM_TS]);
    console.table(dailyRes.rows);

    // 4. Book & Best Bid/Ask Coverage
    console.log("\n4. Book & Bid/Ask Coverage:");
    const covRes = await client.query(`
      SELECT 
        COUNT(*) as total_ticks,
        COUNT(*) FILTER (WHERE up_best_ask > 0) as up_ask_valid,
        COUNT(*) FILTER (WHERE down_best_ask > 0) as down_ask_valid,
        COUNT(*) FILTER (WHERE up_best_bid > 0) as up_bid_valid,
        COUNT(*) FILTER (WHERE down_best_bid > 0) as down_bid_valid,
        COUNT(*) FILTER (WHERE up_best_ask > 0 AND down_best_ask > 0) as both_asks_valid,
        COUNT(*) FILTER (WHERE up_best_bid > 0 AND down_best_bid > 0) as both_bids_valid,
        COUNT(*) FILTER (WHERE up_book_asks IS NOT NULL AND jsonb_array_length(up_book_asks) > 0) as up_book_has_asks,
        COUNT(*) FILTER (WHERE down_book_asks IS NOT NULL AND jsonb_array_length(down_book_asks) > 0) as down_book_has_asks
      FROM ticks
      WHERE ts >= $1
    `, [FROM_TS]);
    console.log(covRes.rows[0]);

    // 5. Ask sum & Bid sum metrics
    console.log("\n5. Odds Sum Statistics (ask_UP + ask_DOWN):");
    const sumRes = await client.query(`
      SELECT 
        AVG(up_best_ask + down_best_ask) as avg_sum_ask,
        PERCENTILE_CONT(0.01) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p01_sum_ask,
        PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p05_sum_ask,
        PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p10_sum_ask,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p50_sum_ask,
        PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p90_sum_ask,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 1.00) as sum_ask_lt_1_00,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.99) as sum_ask_lt_0_99,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.98) as sum_ask_lt_0_98,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.96) as sum_ask_lt_0_96,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.95) as sum_ask_lt_0_95,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.92) as sum_ask_lt_0_92,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.90) as sum_ask_lt_0_90
      FROM ticks
      WHERE ts >= $1 AND up_best_ask > 0 AND down_best_ask > 0
    `, [FROM_TS]);
    console.log(sumRes.rows[0]);

  } catch (err) {
    console.error("Analysis Error:", err);
  } finally {
    client.release();
    await pool.end();
  }
}

runFastAnalysis();
