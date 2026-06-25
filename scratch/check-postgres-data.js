import pg from 'pg';
import 'dotenv/config';

const connectionString = process.env.DATA_COLLECTOR_DATABASE_URL;
if (!connectionString) {
  console.error("DATA_COLLECTOR_DATABASE_URL não configurada no .env");
  process.exit(1);
}

console.log("Conectando ao banco de dados Postgres...");
console.log("URL:", connectionString.replace(/:[^:]+@/, ':****@')); // esconde a senha

const pool = new pg.Pool({ connectionString });

async function check() {
  try {
    const client = await pool.connect();
    console.log("Conexão bem sucedida!");
    
    // Consulta para listar contagem de ticks por dia
    const query = `
      SELECT 
        DATE(ts) as dia, 
        COUNT(*) as total_ticks,
        MIN(ts) as primeiro_tick,
        MAX(ts) as ultimo_tick
      FROM ticks
      WHERE ts >= '2026-06-10 00:00:00+00'
      GROUP BY DATE(ts)
      ORDER BY DATE(ts) ASC
    `;
    
    console.log("Executando consulta...");
    const res = await client.query(query);
    
    console.log("\nResultado por dia:");
    console.table(res.rows);
    
    client.release();
  } catch (err) {
    console.error("Erro ao executar consulta:", err);
  } finally {
    await pool.end();
  }
}

check();
