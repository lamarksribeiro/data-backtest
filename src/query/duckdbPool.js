import { DuckDBInstance } from '@duckdb/node-api';

let sharedInstancePromise = null;

// Default conservador (4) compatível com o comportamento histórico.
// Containers (Coolify) têm CPU limitada por cgroup, mas os.availableParallelism()
// retorna os núcleos do HOST, não a cota do container — oversubscribir threads do
// DuckDB nesse cenário causa thrashing e trava o backtest. Só aumente via env
// DUCKDB_THREADS quando souber que há CPU dedicada disponível.
function resolveThreadCount() {
  const fromEnv = Number.parseInt(process.env.DUCKDB_THREADS ?? '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 4;
}

const THREAD_COUNT = resolveThreadCount();

export async function getSharedDuckInstance() {
  if (!sharedInstancePromise) {
    sharedInstancePromise = DuckDBInstance.create(':memory:');
  }
  return sharedInstancePromise;
}

/** Abre conexão na instância compartilhada; o caller deve fechar com closeSync(). */
export async function openSharedConnection() {
  const instance = await getSharedDuckInstance();
  const connection = await instance.connect();
  await connection.run(`SET threads TO ${THREAD_COUNT}`);
  return connection;
}

export function resetSharedDuckInstanceForTests() {
  sharedInstancePromise = null;
}
