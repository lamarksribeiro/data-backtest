import os from 'node:os';
import { DuckDBInstance } from '@duckdb/node-api';

let sharedInstancePromise = null;

function resolveThreadCount() {
  const fromEnv = Number.parseInt(process.env.DUCKDB_THREADS ?? '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const cores = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : (os.cpus()?.length || 4);
  return Math.min(Math.max(cores, 4), 8);
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
