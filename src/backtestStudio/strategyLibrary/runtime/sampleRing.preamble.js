function __runnerCreateSampleStore(maxEntries) {
  const capacity = Math.max(64, maxEntries || 4096);
  const buffer = new Array(capacity);
  let start = 0;
  let size = 0;
  const store = {
    push(sample) {
      if (size < capacity) {
        buffer[(start + size) % capacity] = sample;
        size += 1;
        return;
      }
      buffer[start] = sample;
      start = (start + 1) % capacity;
    },
    shift() {
      if (!size) return undefined;
      const value = buffer[start];
      buffer[start] = undefined;
      start = (start + 1) % capacity;
      size -= 1;
      return value;
    },
    at(offset) {
      if (offset < 0 || offset >= size) return undefined;
      return buffer[(start + offset) % capacity];
    },
    filter(predicate) {
      const out = [];
      for (let index = 0; index < size; index += 1) {
        const item = store.at(index);
        if (predicate(item)) out.push(item);
      }
      return out;
    },
    find(predicate) {
      for (let index = 0; index < size; index += 1) {
        const item = store.at(index);
        if (predicate(item)) return item;
      }
      return undefined;
    },
    slice(start, end) {
      const out = [];
      const from = Math.max(0, (start ?? 0) < 0 ? size + (start ?? 0) : (start ?? 0));
      const to = Math.min(size, (end ?? size) < 0 ? size + (end ?? size) : (end ?? size));
      for (let index = from; index < to; index += 1) out.push(store.at(index));
      return out;
    },
    pruneOlderThan(cutoffTimeMs) {
      while (size > 1) {
        const oldest = store.at(0);
        if (!oldest || oldest.timeMs > cutoffTimeMs) break;
        store.shift();
      }
    },
  };
  Object.defineProperty(store, 'length', {
    enumerable: false,
    get() { return size; },
  });
  return new Proxy(store, {
    get(target, prop) {
      if (prop in target) {
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      }
      if (prop === 'length') return size;
      const index = Number(prop);
      if (Number.isInteger(index) && index >= 0) return target.at(index);
      return undefined;
    },
  });
}
