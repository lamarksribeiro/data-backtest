import pg from 'pg';
import 'dotenv/config';

const connectionString = process.env.DATA_COLLECTOR_DATABASE_URL;

async function main() {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    console.log('Conectado ao Postgres local com sucesso.');

    // Consulta correta baseada na lógica do projeto
    const res = await client.query(`
      SELECT
        m.underlying,
        m.type AS market_type,
        (eq.event_start AT TIME ZONE 'UTC')::date::text AS dt,
        COUNT(*) AS events_count
      FROM event_quality eq
      JOIN markets m ON m.id = eq.market_id
      GROUP BY m.underlying, m.type, dt
      ORDER BY dt DESC
      LIMIT 30
    `);

    console.log('Partições disponíveis no data_collector do Postgres local:');
    console.log(JSON.stringify(res.rows, null, 2));

  } catch (err) {
    console.error('Erro ao consultar banco:', err);
  } finally {
    await client.end();
  }
}

main();
