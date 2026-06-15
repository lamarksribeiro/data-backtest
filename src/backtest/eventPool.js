import { Worker } from 'node:worker_threads';

import { columnSetToShared, wrapSharedColumnSet } from './columnStore.js';

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
  if (sharedColumnSet !== columnSet) {
    columnSet = wrapSharedColumnSet(sharedColumnSet);
  }
  const chunks = partitionEventIndices(columnSet.events.length, workers, EVENTS_PER_CHUNK);
  if (chunks.length <= 1) return null;

  const results = await Promise.all(chunks.map((eventIndices, chunkIndex) => runChunk({
    ast,
    params,
    sharedColumnSet: columnSet,
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
  const timeoutMs = Math.max(Number(workerData.timeoutMs) || 0, 0) || 30 * 60 * 1000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const worker = new Worker(new URL('./eventWorker.js', import.meta.url), { workerData });
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(reject, new Error('event worker timed out'));
    }, timeoutMs);

    worker.once('message', (msg) => {
      worker.terminate().catch(() => {});
      if (!msg?.ok) {
        finish(reject, new Error(msg?.error || 'event worker failed'));
        return;
      }
      finish(resolve, msg);
    });
    worker.once('error', (err) => {
      worker.terminate().catch(() => {});
      finish(reject, err);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      if (code !== 0) finish(reject, new Error(`event worker exited with code ${code}`));
    });
  });
}
