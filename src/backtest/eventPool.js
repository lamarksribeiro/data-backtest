import { Worker } from 'node:worker_threads';

import { columnSetToShared } from './columnStore.js';

const EVENTS_PER_CHUNK = 50;

/**
 * Processa eventos GLS compiled-soa em paralelo (F4).
 * Retorna slices ordenados para merge no runner principal.
 */
export async function runParallelEventSlices({
  ast,
  params,
  columnSet,
  workerCount,
  fastRun = false,
  bookDepth = 25,
}) {
  const workers = Math.max(1, Math.min(workerCount, columnSet.events.length));
  if (workers <= 1) return null;

  const sharedColumnSet = columnSetToShared(columnSet);
  const chunks = partitionEventIndices(columnSet.events.length, workers, EVENTS_PER_CHUNK);
  if (chunks.length <= 1) return null;

  const results = await Promise.all(chunks.map((eventIndices, chunkIndex) => runChunk({
    ast,
    params,
    sharedColumnSet,
    eventIndices,
    eventIndexOffset: eventIndices[0] ?? 0,
    fastRun,
    bookDepth,
    chunkIndex,
  })));

  return results.sort((left, right) => left.eventIndexOffset - right.eventIndexOffset);
}

function partitionEventIndices(eventCount, workers, chunkSize) {
  const indices = Array.from({ length: eventCount }, (_, index) => index);
  if (eventCount <= 1) return [indices];

  const targetWorkers = Math.min(workers, eventCount);
  const maxChunk = Math.max(1, chunkSize);
  const minChunks = Math.min(targetWorkers, Math.ceil(eventCount / maxChunk));
  const chunkCount = Math.max(minChunks, Math.min(targetWorkers, eventCount));
  const perChunk = Math.ceil(eventCount / chunkCount);
  const chunks = [];
  for (let start = 0; start < indices.length; start += perChunk) {
    chunks.push(indices.slice(start, start + perChunk));
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

function runChunk(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./eventWorker.js', import.meta.url), { workerData });
    worker.once('message', (msg) => {
      worker.terminate().catch(() => {});
      if (!msg?.ok) {
        reject(new Error(msg?.error || 'event worker failed'));
        return;
      }
      resolve(msg);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`event worker exited with code ${code}`));
    });
  });
}
