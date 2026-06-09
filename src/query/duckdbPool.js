import { DuckDBInstance } from '@duckdb/node-api';

let sharedInstancePromise = null;

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
  await connection.run('SET threads TO 4');
  return connection;
}

export function resetSharedDuckInstanceForTests() {
  sharedInstancePromise = null;
}
