import pg from 'pg';

const connectionGoldenlens = 'postgresql://postgres:ba1f652bf11649ddabc02b734942b7bb@localhost:5432/goldenlens';

async function main() {
  const pool = new pg.Pool({ connectionString: connectionGoldenlens });
  const client = await pool.connect();
  try {
    const res = await client.query(`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename = 'ticks'
    `);
    console.log("Indexes on ticks:", res.rows);
  } catch(e) {
    console.error(e);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
