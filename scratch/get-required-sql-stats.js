import pg from 'pg';

const connectionGoldenlens = 'postgresql://postgres:ba1f652bf11649ddabc02b734942b7bb@localhost:5432/goldenlens';

async function main() {
  const pool = new pg.Pool({ connectionString: connectionGoldenlens, statement_timeout: 180000 });
  const client = await pool.connect();

  try {
    const FROM_TS = '2026-05-04T15:00:00.000Z';
    console.log("=== COMPREHENSIVE SQL EXPLORATION FOR RANGE ===");

    // 1 & 3. Ticks count & Timestamps
    const minMaxRes = await client.query(`
      SELECT MIN(ts) as primeiro_ts, MAX(ts) as ultimo_ts, COUNT(*) as total_ticks
      FROM ticks
      WHERE ts >= $1
    `, [FROM_TS]);
    const minTs = minMaxRes.rows[0].primeiro_ts;
    const maxTs = minMaxRes.rows[0].ultimo_ts;
    const totalTicks = parseInt(minMaxRes.rows[0].total_ticks, 10);

    console.log(`1. Total Ticks: ${totalTicks}`);
    console.log(`3. Primeiro Timestamp: ${minTs.toISOString()}`);
    console.log(`   Último Timestamp: ${maxTs.toISOString()}`);

    // 2. Events Count
    const evtRes = await client.query(`
      SELECT COUNT(DISTINCT event_start) as total_eventos
      FROM ticks
      WHERE ts >= $1
    `, [FROM_TS]);
    const totalEvents = parseInt(evtRes.rows[0].total_eventos, 10);
    console.log(`2. Total Eventos: ${totalEvents}`);

    // 4. Daily Coverage & Gaps
    console.log("\n4. Cobertura por dia:");
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
    
    console.table(dailyRes.rows.map(r => ({
      dia: r.dia ? r.dia.toISOString().slice(0, 10) : 'null',
      ticks: r.ticks,
      eventos: r.eventos,
      min_ts: r.min_ts ? r.min_ts.toISOString() : '',
      max_ts: r.max_ts ? r.max_ts.toISOString() : ''
    })));

    // 6, 7 & 8. Book & Ask/Bid Availability
    console.log("\n6, 7, 8. Cobertura de Books e Ask/Bid Válidos:");
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

    // 9, 10, 11, 12. Sum Distributions & Theoretical / Net Mispricing
    console.log("\n9, 10, 11, 12. Distribuição da Soma Ask e Bid & Oportunidades:");
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
        
        /* Oportunidades teóricas antes de taxas */
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 1.00) as teoric_under_1_00,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.99) as teoric_under_0_99,
        
        /* Oportunidades líquidas após taxas (considerando ~2% a 3.5% de taxa líquida Polymarket ~ 0.96 a 0.97) */
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.97) as net_under_0_97,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.95) as net_under_0_95,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.92) as net_under_0_92,
        COUNT(*) FILTER (WHERE (up_best_ask + down_best_ask) < 0.90) as net_under_0_90
      FROM ticks
      WHERE ts >= $1 AND up_best_ask > 0 AND down_best_ask > 0
    `, [FROM_TS]);
    console.log(sumRes.rows[0]);

  } catch (err) {
    console.error("Analysis error:", err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
