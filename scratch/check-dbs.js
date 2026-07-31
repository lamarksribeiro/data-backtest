import pg from 'pg';

const connectionGoldenlens = 'postgresql://postgres:ba1f652bf11649ddabc02b734942b7bb@localhost:5432/goldenlens';
const connectionDataCollector = 'postgresql://postgres:ba1f652bf11649ddabc02b734942b7bb@localhost:5432/data_collector';

async function checkDb(url, name) {
  const pool = new pg.Pool({ connectionString: url });
  try {
    const client = await pool.connect();
    const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    console.log(`\n=== Tables in ${name} ===`);
    console.log(res.rows.map(r => r.table_name));

    for (const row of res.rows) {
      const countRes = await client.query(`SELECT COUNT(*) FROM ${row.table_name}`);
      console.log(`Table ${row.table_name}: ${countRes.rows[0].count} rows`);
    }
    client.release();
  } catch (err) {
    console.error(`Error connecting to ${name}:`, err.message);
  } finally {
    await pool.end();
  }
}

async function main() {
  await checkDb(connectionGoldenlens, 'goldenlens');
  await checkDb(connectionDataCollector, 'data_collector');
}

main();
