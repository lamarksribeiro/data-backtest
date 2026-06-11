/**
 * LRU cache de ColumnSet (V4) — zero re-materialização em cache hit.
 */

import { estimateColumnSetSize } from './columnStore.js';

const caches = new Map();

export function datasetCacheKey(request, columnSignature) {
  return JSON.stringify({
    dataset: request.dataset || 'backtest_ticks',
    underlying: request.underlying,
    interval: request.interval,
    bookDepth: request.bookDepth,
    from: new Date(request.from).toISOString(),
    to: new Date(request.to).toISOString(),
    columns: columnSignature || null,
    engine: 'soa',
  });
}

export function getDatasetCache(maxMb) {
  if (!maxMb || maxMb <= 0) return nullCache();
  const key = String(maxMb);
  if (!caches.has(key)) caches.set(key, new DatasetCache(maxMb));
  return caches.get(key);
}

class DatasetCache {
  constructor(maxMb) {
    this.maxBytes = maxMb * 1024 * 1024;
    this.bytes = 0;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.columnSet;
  }

  set(key, columnSet) {
    const size = estimateColumnSetSize(columnSet);
    if (size > this.maxBytes) return;

    if (this.map.has(key)) {
      const old = this.map.get(key);
      this.bytes -= old.size;
      this.map.delete(key);
    }

    while (this.bytes + size > this.maxBytes && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value;
      const oldest = this.map.get(oldestKey);
      this.bytes -= oldest.size;
      this.map.delete(oldestKey);
    }

    this.map.set(key, { columnSet, size });
    this.bytes += size;
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }

  stats() {
    return {
      max_mb: Math.round(this.maxBytes / 1024 / 1024),
      used_mb: Math.round((this.bytes / 1024 / 1024) * 10) / 10,
      entries: this.map.size,
    };
  }
}

function nullCache() {
  return { get: () => null, set: () => {}, clear: () => {} };
}

export function clearAllDatasetCaches() {
  for (const cache of caches.values()) cache.clear();
  caches.clear();
}

export function getDatasetCacheStats() {
  const out = [];
  for (const cache of caches.values()) {
    if (typeof cache.stats === 'function') out.push(cache.stats());
  }
  return out;
}

/** @deprecated legado V2 — mantido para testes de roundtrip colunar */
export function toColumnarBatch(batch) {
  if (!batch?.length) return { __columnar: true, keys: [], columns: {}, length: 0 };
  const keys = Object.keys(batch[0]);
  const columns = {};
  for (const key of keys) {
    const sample = batch[0][key];
    if (typeof sample === 'number' && Number.isFinite(sample)) {
      columns[key] = Float64Array.from(batch, (row) => {
        const value = row[key];
        return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
      });
    } else {
      columns[key] = batch.map((row) => row[key]);
    }
  }
  return { __columnar: true, keys, columns, length: batch.length };
}

/** @deprecated legado V2 */
export function fromColumnarBatch(batch) {
  if (!batch?.__columnar) return batch;
  const rows = new Array(batch.length);
  for (let i = 0; i < batch.length; i += 1) {
    const row = {};
    for (const key of batch.keys) {
      const column = batch.columns[key];
      row[key] = column instanceof Float64Array ? column[i] : column[i];
    }
    rows[i] = row;
  }
  return rows;
}

/** @deprecated legado V2 */
export function materializeBatches(batches) {
  return batches.map((batch) => (batch?.__columnar ? fromColumnarBatch(batch) : batch));
}
