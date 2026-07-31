import pg from 'pg';

const connectionGoldenlens = 'postgresql://postgres:ba1f652bf11649ddabc02b734942b7bb@localhost:5432/goldenlens';

async function main() {
  const pool = new pg.Pool({ connectionString: connectionGoldenlens });
  const client = await pool.connect();

  try {
    const FROM_TS = '2026-05-04T15:00:00.000Z';
    console.log("=== FAST INDEXED EXPLORATORY ANALYSIS ===");

    // 1. First & Last TS, Total Events using idx_ticks_event
    const evtRes = await client.query(`
      SELECT 
        COUNT(DISTINCT event_start) as total_eventos,
        MIN(event_start) as min_event,
        MAX(event_start) as max_event
      FROM ticks
      WHERE event_start >= $1
    `, [FROM_TS]);
    console.log("1. Event Summary:", evtRes.rows[0]);

    // 2. Ticks count using idx_ticks_ts
    const tickCountRes = await client.query(`
      SELECT COUNT(*) as total_ticks, MIN(ts) as primeiro_ts, MAX(ts) as ultimo_ts
      FROM ticks
      WHERE ts >= $1
    `, [FROM_TS]);
    console.log("2. Ticks Summary:", tickCountRes.rows[0]);

    // 3. Daily Breakdown using DATE(event_start)
    console.log("\n3. Daily Coverage (by event_start):");
    const dailyRes = await client.query(`
      SELECT 
        DATE(event_start AT TIME ZONE 'UTC') as dia,
        COUNT(*) as ticks,
        COUNT(DISTINCT event_start) as eventos
      FROM ticks
      WHERE event_start >= $1
      GROUP BY DATE(event_start AT TIME ZONE 'UTC')
      ORDER BY dia ASC
    `, [FROM_TS]);
    console.table(dailyRes.rows.map(r => ({
      dia: r.dia ? r.dia.toISOString().slice(0, 10) : 'null',
      ticks: r.ticks,
      eventos: r.eventos
    })));

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

    // 5. Sum Distribution & Mispricing Thresholds
    console.log("\n5. Odds Sum Statistics (ask_UP + ask_DOWN):");
    const sumRes = await client.query(`
      SELECT 
        AVG(up_best_ask + down_best_ask) as avg_sum_ask,
        PERCENTILE_CONT(0.01) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p01_sum_ask,
        PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p05_sum_ask,
        PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p10_sum_ask,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p50_sum_ask,
        PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY up_best_ask + down_best_ask) as p90_sum_ask,
        AVG(up_best_bid + down_best_bid) as avg_sum_bid,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY up_best_bid + down_best_bid) as p50_sum_bid,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 1.00) as ask_sum_lt_1_00,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.99) as ask_sum_lt_0_99,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.98) as ask_sum_lt_0_98,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.96) as ask_sum_lt_0_96,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.95) as ask_sum_lt_0_95,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.92) as ask_sum_lt_0_92,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.90) as ask_sum_lt_0_90,
        COUNT(*) FILTER (WHERE (up_best_bid + down_best_bid) > 1.00) as bid_sum_gt_1_00
      FROM ticks
      WHERE ts >= $1 AND up_best_ask > 0 AND down_best_ask > 0
    `, [FROM_TS]);
    console.log(sumRes.rows[0]);

  } catch (err) {
    console.error("SQL Error:", err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
