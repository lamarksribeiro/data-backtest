import pg from 'pg';

const url = process.env.DATABASE_URL
  || 'postgresql://postgres:ba1f652bf11649ddabc02b734942b7bb@localhost:5432/goldenlens';

const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 4000 });
try {
  await c.connect();
  const tables = await c.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY 1
    LIMIT 50
  `);
  console.log('tables:', tables.rows.map((r) => r.table_name).join(', '));
  // try common tick table names
  for (const t of ['ticks', 'backtest_ticks', 'market_ticks', 'crypto_updown_ticks', 'event_ticks']) {
    try {
      const r = await c.query(`SELECT count(*)::int AS n FROM ${t} LIMIT 1`);
      console.log(t, r.rows[0]);
    } catch (e) {
      console.log(t, 'missing');
    }
  }
} catch (e) {
  console.error('PG unavailable:', e.message);
} finally {
  try { await c.end(); } catch {}
}
