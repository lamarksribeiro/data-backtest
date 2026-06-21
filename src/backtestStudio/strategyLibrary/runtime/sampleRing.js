/**
 * Ring buffer para amostras temporais nos runners portados.
 * Expõe API compatível com array para sampleAgo/recentVol existentes.
 */
export function createSampleRing(maxEntries = 4096) {
  const buffer = new Array(maxEntries);
  let start = 0;
  let size = 0;

  const ring = {
    push(sample) {
      const index = (start + size) % maxEntries;
      if (size < maxEntries) {
        buffer[index] = sample;
        size += 1;
        return;
      }
      buffer[start] = sample;
      start = (start + 1) % maxEntries;
    },
    shift() {
      if (!size) return undefined;
      const value = buffer[start];
      buffer[start] = undefined;
      start = (start + 1) % maxEntries;
      size -= 1;
      return value;
    },
    get length() {
      return size;
    },
    at(offset) {
      if (offset < 0 || offset >= size) return undefined;
      return buffer[(start + offset) % maxEntries];
    },
    latest() {
      if (!size) return undefined;
      return buffer[(start + size - 1) % maxEntries];
    },
    toArray() {
      const out = [];
      for (let index = 0; index < size; index += 1) out.push(ring.at(index));
      return out;
    },
    filter(predicate) {
      const out = [];
      for (let index = 0; index < size; index += 1) {
        const item = ring.at(index);
        if (predicate(item)) out.push(item);
      }
      return out;
    },
    find(predicate) {
      for (let index = 0; index < size; index += 1) {
        const item = ring.at(index);
        if (predicate(item)) return item;
      }
      return undefined;
    },
    slice(start = 0, end = size) {
      const out = [];
      const from = Math.max(0, start < 0 ? size + start : start);
      const to = Math.min(size, end < 0 ? size + end : end);
      for (let index = from; index < to; index += 1) out.push(ring.at(index));
      return out;
    },
    pruneOlderThan(cutoffTimeMs) {
      while (size > 1) {
        const oldest = ring.at(0);
        if (!oldest || oldest.timeMs > cutoffTimeMs) break;
        ring.shift();
      }
    },
  };

  return new Proxy(ring, {
    get(target, prop) {
      if (prop in target) {
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      }
      if (prop === Symbol.iterator) {
        return function* iterator() {
          for (let index = 0; index < target.length; index += 1) yield target.at(index);
        };
      }
      const index = Number(prop);
      if (Number.isInteger(index) && index >= 0) return target.at(index);
      return undefined;
    },
  });
}
