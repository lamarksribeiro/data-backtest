import pg from 'pg';

const connectionGoldenlens = 'postgresql://postgres:ba1f652bf11649ddabc02b734942b7bb@localhost:5432/goldenlens';

async function main() {
  const pool = new pg.Pool({ connectionString: connectionGoldenlens });
  try {
    const client = await pool.connect();
    
    // Check columns of ticks table in goldenlens
    const colRes = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'ticks'
      ORDER BY ordinal_position
    `);
    console.log("=== Goldenlens 'ticks' columns ===");
    colRes.rows.forEach(r => console.log(`${r.column_name}: ${r.data_type}`));

    // Count rows in ticks
    const countRes = await client.query("SELECT COUNT(*) FROM ticks");
    console.log(`Total ticks in goldenlens: ${countRes.rows[0].count}`);

    // Min and max timestamp in ticks
    const timeRes = await client.query("SELECT MIN(ts) as min_ts, MAX(ts) as max_ts FROM ticks");
    console.log(`Min TS: ${timeRes.rows[0].min_ts}, Max TS: ${timeRes.rows[0].max_ts}`);

    client.release();
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await pool.end();
  }
}

main();
