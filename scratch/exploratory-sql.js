import pg from 'pg';

const connectionGoldenlens = 'postgresql://postgres:ba1f652bf11649ddabc02b734942b7bb@localhost:5432/goldenlens';

async function runExploratoryAnalysis() {
  const pool = new pg.Pool({ connectionString: connectionGoldenlens, statement_timeout: 300000 });
  const client = await pool.connect();
  
  try {
    console.log("=== STARTING EXPLORATORY SQL ANALYSIS ===");
    const FROM_TS = '2026-05-04T15:00:00.000Z';

    // 1. Quantidade de ticks, min/max timestamp, total de eventos distintos
    console.log("\n--- Query 1: Basic Range Stats ---");
    const q1 = await client.query(`
      SELECT 
        COUNT(*) as total_ticks,
        COUNT(DISTINCT event_start) as total_eventos,
        COUNT(DISTINCT condition_id) as total_conditions,
        MIN(ts) as primeiro_ts,
        MAX(ts) as ultimo_ts
      FROM ticks
      WHERE ts >= $1
    `, [FROM_TS]);
    console.log(q1.rows[0]);

    // 2. Cobertura por dia
    console.log("\n--- Query 2: Daily Coverage ---");
    const q2 = await client.query(`
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
    console.table(q2.rows);

    // 3. Cobertura de Book UP / DOWN e bids/asks válidos
    console.log("\n--- Query 3: Book & Best Bid/Ask Availability ---");
    const q3 = await client.query(`
      SELECT 
        COUNT(*) FILTER (WHERE up_best_ask IS NOT NULL AND up_best_ask > 0) as up_ask_valid,
        COUNT(*) FILTER (WHERE down_best_ask IS NOT NULL AND down_best_ask > 0) as down_ask_valid,
        COUNT(*) FILTER (WHERE up_best_bid IS NOT NULL AND up_best_bid > 0) as up_bid_valid,
        COUNT(*) FILTER (WHERE down_best_bid IS NOT NULL AND down_best_bid > 0) as down_bid_valid,
        COUNT(*) FILTER (WHERE up_best_ask > 0 AND down_best_ask > 0) as both_asks_valid,
        COUNT(*) FILTER (WHERE up_best_bid > 0 AND down_best_bid > 0) as both_bids_valid,
        COUNT(*) FILTER (WHERE up_book_asks IS NOT NULL AND jsonb_array_length(up_book_asks) > 0) as up_book_has_asks,
        COUNT(*) FILTER (WHERE down_book_asks IS NOT NULL AND jsonb_array_length(down_book_asks) > 0) as down_book_has_asks
      FROM ticks
      WHERE ts >= $1
    `, [FROM_TS]);
    console.log(q3.rows[0]);

    // 4. Distribuição da soma ask_UP + ask_DOWN e bid_UP + bid_DOWN
    console.log("\n--- Query 4: Sum Distributions ---");
    const q4 = await client.query(`
      SELECT 
        AVG(up_best_ask + down_best_ask) as avg_sum_ask,
        PERCENTILE_CONT(0.01) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p01_sum_ask,
        PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p05_sum_ask,
        PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p10_sum_ask,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p50_sum_ask,
        PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p90_sum_ask,
        AVG(up_best_bid + down_best_bid) as avg_sum_bid,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY up_best_bid + down_best_bid) as p50_sum_bid
      FROM ticks
      WHERE ts >= $1 AND up_best_ask > 0 AND down_best_ask > 0
    `, [FROM_TS]);
    console.log(q4.rows[0]);

    // 5. Frequência de oportunidades teóricas (ask_UP + ask_DOWN < 1.0)
    // e oportunidades com margem para taxas (ex: < 0.98, < 0.96, < 0.95, < 0.92)
    console.log("\n--- Query 5: Mispricing / Arbitrage Thresholds ---");
    const q5 = await client.query(`
      SELECT 
        COUNT(*) as total_valid_ticks,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 1.00) as sum_ask_under_1_00,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.99) as sum_ask_under_0_99,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.98) as sum_ask_under_0_98,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.96) as sum_ask_under_0_96,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.95) as sum_ask_under_0_95,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.90) as sum_ask_under_0_90,
        COUNT(*) FILTER (WHERE (up_best_bid + down_best_bid) > 1.00) as sum_bid_over_1_00
      FROM ticks
      WHERE ts >= $1 AND up_best_ask > 0 AND down_best_ask > 0
    `, [FROM_TS]);
    console.log(q5.rows[0]);

  } catch (err) {
    console.error("SQL Error:", err);
  } finally {
    client.release();
    await pool.end();
  }
}

runExploratoryAnalysis();
