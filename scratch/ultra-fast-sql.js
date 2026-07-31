import pg from 'pg';

const connectionGoldenlens = 'postgresql://postgres:ba1f652bf11649ddabc02b734942b7bb@localhost:5432/goldenlens';

async function main() {
  const pool = new pg.Pool({ connectionString: connectionGoldenlens, statement_timeout: 60000 });
  const client = await pool.connect();

  try {
    const FROM_TS = '2026-05-04T15:00:00.000Z';
    console.log("=== ULTRA FAST EXPLORATORY ANALYSIS FROM:", FROM_TS, "===");

    // 1. Min tick ID for ts >= FROM_TS
    const minRow = await client.query(`SELECT id, ts FROM ticks WHERE ts >= $1 ORDER BY ts ASC LIMIT 1`, [FROM_TS]);
    const maxRow = await client.query(`SELECT id, ts FROM ticks ORDER BY ts DESC LIMIT 1`);

    const minId = minRow.rows[0].id;
    const maxId = maxRow.rows[0].id;
    const minTs = minRow.rows[0].ts;
    const maxTs = maxRow.rows[0].ts;

    console.log(`Min ID: ${minId} (${minTs.toISOString()}), Max ID: ${maxId} (${maxTs.toISOString()})`);

    // Total ticks in ID range
    const totalTicksRes = await client.query(`SELECT COUNT(*) FROM ticks WHERE id >= $1 AND id <= $2`, [minId, maxId]);
    const totalTicks = parseInt(totalTicksRes.rows[0].count, 10);
    console.log(`Total Ticks in range: ${totalTicks}`);

    // Total events
    const totalEventsRes = await client.query(`SELECT COUNT(DISTINCT event_start) FROM ticks WHERE id >= $1 AND id <= $2`, [minId, maxId]);
    const totalEvents = parseInt(totalEventsRes.rows[0].count, 10);
    console.log(`Total Events in range: ${totalEvents}`);

    // Daily breakdown
    console.log("\n--- Cobertura por Dia ---");
    const dailyRes = await client.query(`
      SELECT 
        DATE(ts AT TIME ZONE 'UTC') as dia,
        COUNT(*) as ticks,
        COUNT(DISTINCT event_start) as eventos,
        MIN(ts) as min_ts,
        MAX(ts) as max_ts
      FROM ticks
      WHERE id >= $1 AND id <= $2
      GROUP BY DATE(ts AT TIME ZONE 'UTC')
      ORDER BY dia ASC
    `, [minId, maxId]);
    console.table(dailyRes.rows.map(r => ({
      dia: r.dia ? r.dia.toISOString().slice(0, 10) : 'null',
      ticks: r.ticks,
      eventos: r.eventos,
      min_ts: r.min_ts ? r.min_ts.toISOString() : '',
      max_ts: r.max_ts ? r.max_ts.toISOString() : ''
    })));

    // Coverage of best ask / bid & books
    console.log("\n--- Cobertura de Book e Asks/Bids ---");
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
      WHERE id >= $1 AND id <= $2
    `, [minId, maxId]);
    console.log(covRes.rows[0]);

    // Sum Distribution & Mispricing
    console.log("\n--- Distribuição da Soma Ask_UP + Ask_DOWN ---");
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
      WHERE id >= $1 AND id <= $2 AND up_best_ask > 0 AND down_best_ask > 0
    `, [minId, maxId]);
    console.log(sumRes.rows[0]);

  } catch (err) {
    console.error("SQL Error:", err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
