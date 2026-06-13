/**
 * ColumnSet — formato colunar do hot path V4 (Struct-of-Arrays).
 * Dados permanecem em TypedArrays da fronteira DuckDB até a estratégia.
 */

const MS_COLUMNS = new Set(['ts', 'event_start', 'event_end']);
const CODE_COLUMNS = new Set(['market_id', 'underlying', 'interval', 'condition_id']);
const FLAG_COLUMNS = new Set(['degraded']);

const TICK_PROP_ALIASES = {
  underlyingPrice: 'underlying_price',
  priceToBeat: 'price_to_beat',
  upPrice: 'up_price',
  downPrice: 'down_price',
  upBestAsk: 'up_best_ask',
  upBestBid: 'up_best_bid',
  downBestAsk: 'down_best_ask',
  downBestBid: 'down_best_bid',
  conditionId: 'condition_id',
  eventStart: 'event_start',
  eventEnd: 'event_end',
  marketId: 'market_id',
};

export function createColumnSetBuilder({ initialCapacity = 65536 } = {}) {
  return new ColumnSetBuilder(initialCapacity);
}

class ColumnSetBuilder {
  constructor(initialCapacity) {
    this.capacity = Math.max(initialCapacity, 1024);
    this.length = 0;
    this.columns = new Map();
    this.codes = new Map();
    this.dictionaries = new Map();
    this.flags = new Map();
    this.dictIndexes = new Map();
    this.columnNames = [];
  }

  registerColumn(name, kind) {
    if (!this.columnNames.includes(name)) this.columnNames.push(name);
    if (kind === 'code') {
      if (!this.codes.has(name)) {
        this.codes.set(name, new Int32Array(this.capacity));
        this.dictionaries.set(name, []);
        this.dictIndexes.set(name, new Map());
      }
      return;
    }
    if (kind === 'flag') {
      if (!this.flags.has(name)) this.flags.set(name, new Uint8Array(this.capacity));
      return;
    }
    if (!this.columns.has(name)) this.columns.set(name, new Float64Array(this.capacity));
  }

  ensureCapacity(extraRows) {
    const needed = this.length + extraRows;
    if (needed <= this.capacity) return;
    let next = this.capacity;
    while (next < needed) next *= 2;
    this.capacity = next;
    for (const [name, arr] of this.columns) {
      const grown = new Float64Array(next);
      grown.set(arr.subarray(0, this.length));
      this.columns.set(name, grown);
    }
    for (const [name, arr] of this.codes) {
      const grown = new Int32Array(next);
      grown.set(arr.subarray(0, this.length));
      this.codes.set(name, grown);
    }
    for (const [name, arr] of this.flags) {
      const grown = new Uint8Array(next);
      grown.set(arr.subarray(0, this.length));
      this.flags.set(name, grown);
    }
  }

  internCode(columnName, value) {
    const dict = this.dictionaries.get(columnName);
    const indexMap = this.dictIndexes.get(columnName);
    const key = value == null ? '' : String(value);
    let code = indexMap.get(key);
    if (code === undefined) {
      code = dict.length;
      dict.push(key);
      indexMap.set(key, code);
    }
    return code;
  }

  finalize() {
    const length = this.length;
    const trimFloat = (arr) => (arr.length === length ? arr : arr.subarray(0, length));
    const trimInt = (arr) => (arr.length === length ? arr : arr.subarray(0, length));
    const trimFlag = (arr) => (arr.length === length ? arr : arr.subarray(0, length));

    const columns = new Map();
    for (const [name, arr] of this.columns) columns.set(name, trimFloat(arr));

    const codes = new Map();
    for (const [name, arr] of this.codes) codes.set(name, trimInt(arr));

    const flags = new Map();
    for (const [name, arr] of this.flags) flags.set(name, trimFlag(arr));

    const columnSet = {
      length,
      columns,
      codes,
      dictionaries: new Map(this.dictionaries),
      flags,
      events: buildEventIndex({ length, codes, columns }),
    };
    return columnSet;
  }
}

export function classifyColumnName(name) {
  if (CODE_COLUMNS.has(name)) return 'code';
  if (FLAG_COLUMNS.has(name)) return 'flag';
  if (MS_COLUMNS.has(name)) return 'ms';
  return 'numeric';
}

function firstValidPriceToBeat(priceToBeat, startRow, endRow, minPriceToBeat = 1000) {
  if (!priceToBeat) return Number.NaN;
  for (let row = startRow; row < endRow; row += 1) {
    const value = priceToBeat[row];
    if (value != null && Number.isFinite(value) && value > minPriceToBeat) return value;
  }
  const fallback = priceToBeat[startRow];
  return fallback != null && Number.isFinite(fallback) ? fallback : Number.NaN;
}

export function buildEventIndex({ length, codes, columns }) {
  const conditionCodes = codes.get('condition_id');
  const eventStartMs = columns.get('_event_start_ms') ?? columns.get('event_start');
  const eventEndMs = columns.get('_event_end_ms') ?? columns.get('event_end');
  const priceToBeat = columns.get('price_to_beat');
  if (!conditionCodes || !eventStartMs) return [];

  const events = [];
  let startRow = 0;
  let prevKey = null;

  for (let i = 0; i < length; i += 1) {
    const key = `${conditionCodes[i]}|${eventStartMs[i]}`;
    if (prevKey !== null && key !== prevKey) {
      events.push({
        conditionCode: conditionCodes[startRow],
        startRow,
        endRow: i,
        eventStart: eventStartMs[startRow],
        eventEnd: eventEndMs?.[startRow] ?? Number.NaN,
        priceToBeat: firstValidPriceToBeat(priceToBeat, startRow, i),
      });
      startRow = i;
    }
    prevKey = key;
  }

  if (length > 0) {
    events.push({
      conditionCode: conditionCodes[startRow],
      startRow,
      endRow: length,
      eventStart: eventStartMs[startRow],
      eventEnd: eventEndMs?.[startRow] ?? Number.NaN,
      priceToBeat: firstValidPriceToBeat(priceToBeat, startRow, length),
    });
  }

  return events;
}

export function estimateColumnSetSize(columnSet) {
  if (!columnSet) return 0;
  let bytes = 0;
  for (const arr of columnSet.columns?.values() ?? []) bytes += arr.byteLength;
  for (const arr of columnSet.codes?.values() ?? []) bytes += arr.byteLength;
  for (const arr of columnSet.flags?.values() ?? []) bytes += arr.byteLength;
  for (const dict of columnSet.dictionaries?.values() ?? []) {
    for (const entry of dict) bytes += (entry?.length ?? 0) * 2;
  }
  return bytes;
}

export function getColumnValue(columnSet, columnName, rowIndex) {
  if (columnSet.columns.has(columnName)) {
    const value = columnSet.columns.get(columnName)[rowIndex];
    return Number.isNaN(value) ? null : value;
  }
  if (columnSet.codes.has(columnName)) {
    const code = columnSet.codes.get(columnName)[rowIndex];
    return columnSet.dictionaries.get(columnName)[code] ?? '';
  }
  if (columnSet.flags.has(columnName)) {
    return columnSet.flags.get(columnName)[rowIndex] !== 0;
  }
  return null;
}

export function msToIso(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * View mutável reutilizada — um único objeto por run; getters leem colunas no índice corrente.
 */
export function createTickCursorView(columnSet) {
  let index = 0;
  const view = {
    setIndex(i) {
      index = i;
    },
    get index() {
      return index;
    },
  };

  const defineGetter = (prop, reader) => {
    Object.defineProperty(view, prop, {
      enumerable: true,
      configurable: true,
      get: reader,
    });
  };

  defineGetter('ts', () => msToIso(columnSet.columns.get('_ts_ms')?.[index]));
  defineGetter('_tsMs', () => columnSet.columns.get('_ts_ms')?.[index] ?? Number.NaN);
  defineGetter('_eventStartMs', () => columnSet.columns.get('_event_start_ms')?.[index] ?? Number.NaN);
  defineGetter('_eventEndMs', () => columnSet.columns.get('_event_end_ms')?.[index] ?? Number.NaN);
  defineGetter('event_start', () => msToIso(columnSet.columns.get('_event_start_ms')?.[index]));
  defineGetter('event_end', () => msToIso(columnSet.columns.get('_event_end_ms')?.[index]));
  defineGetter('condition_id', () => getColumnValue(columnSet, 'condition_id', index));
  defineGetter('market_id', () => getColumnValue(columnSet, 'market_id', index));
  defineGetter('underlying', () => getColumnValue(columnSet, 'underlying', index));
  defineGetter('interval', () => getColumnValue(columnSet, 'interval', index));
  defineGetter('underlying_price', () => columnSet.columns.get('underlying_price')?.[index] ?? Number.NaN);
  defineGetter('underlyingPrice', () => view.underlying_price);
  defineGetter('price_to_beat', () => columnSet.columns.get('price_to_beat')?.[index] ?? Number.NaN);
  defineGetter('priceToBeat', () => view.price_to_beat);
  defineGetter('up_price', () => columnSet.columns.get('up_price')?.[index] ?? Number.NaN);
  defineGetter('upPrice', () => view.up_price);
  defineGetter('down_price', () => columnSet.columns.get('down_price')?.[index] ?? Number.NaN);
  defineGetter('downPrice', () => view.down_price);
  defineGetter('up_best_ask', () => columnSet.columns.get('up_best_ask')?.[index] ?? Number.NaN);
  defineGetter('up_best_bid', () => columnSet.columns.get('up_best_bid')?.[index] ?? Number.NaN);
  defineGetter('upBestAsk', () => view.up_best_ask);
  defineGetter('upBestBid', () => view.up_best_bid);
  defineGetter('down_best_ask', () => columnSet.columns.get('down_best_ask')?.[index] ?? Number.NaN);
  defineGetter('down_best_bid', () => columnSet.columns.get('down_best_bid')?.[index] ?? Number.NaN);
  defineGetter('downBestAsk', () => view.down_best_ask);
  defineGetter('downBestBid', () => view.down_best_bid);
  defineGetter('coverage', () => columnSet.columns.get('coverage')?.[index] ?? Number.NaN);
  defineGetter('degraded', () => getColumnValue(columnSet, 'degraded', index));
  defineGetter('book_depth', () => columnSet.columns.get('book_depth')?.[index] ?? Number.NaN);

  for (const name of columnSet.columns.keys()) {
    if (name.startsWith('up_') || name.startsWith('down_')) {
      if (name in view) continue;
      defineGetter(name, () => {
        const value = columnSet.columns.get(name)[index];
        return Number.isNaN(value) ? null : value;
      });
    }
  }

  return view;
}

/** Captura valores do cursor mutável para sidecar/gráfico (evita referência compartilhada). */
export function snapshotTickCursorView(view) {
  if (!view) return null;
  return {
    ts: view.ts,
    underlying_price: finiteOrNull(view.underlying_price),
    price_to_beat: finiteOrNull(view.price_to_beat),
    up_price: finiteOrNull(view.up_price),
    down_price: finiteOrNull(view.down_price),
    up_best_bid: finiteOrNull(view.up_best_bid),
    up_best_ask: finiteOrNull(view.up_best_ask),
    down_best_bid: finiteOrNull(view.down_best_bid),
    down_best_ask: finiteOrNull(view.down_best_ask),
  };
}

function finiteOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function eventRecordFromColumnSet(columnSet, eventMeta) {
  const dict = columnSet.dictionaries.get('condition_id');
  const conditionId = dict?.[eventMeta.conditionCode] ?? '';
  return {
    eventId: conditionId,
    start: msToIso(eventMeta.eventStart),
    end: msToIso(eventMeta.eventEnd),
    eventStart: msToIso(eventMeta.eventStart),
    eventEnd: msToIso(eventMeta.eventEnd),
    _eventEndMs: eventMeta.eventEnd,
    priceToBeat: eventMeta.priceToBeat,
  };
}

/**
 * Converte ColumnSet para buffers compartilhados (zero-copy entre worker_threads).
 */
export function columnSetToShared(columnSet) {
  const columns = new Map();
  for (const [name, arr] of columnSet.columns) {
    if (arr.buffer instanceof SharedArrayBuffer) {
      columns.set(name, arr);
      continue;
    }
    const sab = new SharedArrayBuffer(arr.byteLength);
    new Float64Array(sab).set(arr);
    columns.set(name, new Float64Array(sab));
  }

  const codes = new Map();
  for (const [name, arr] of columnSet.codes) {
    if (arr.buffer instanceof SharedArrayBuffer) {
      codes.set(name, arr);
      continue;
    }
    const sab = new SharedArrayBuffer(arr.byteLength);
    new Int32Array(sab).set(arr);
    codes.set(name, new Int32Array(sab));
  }

  const flags = new Map();
  for (const [name, arr] of columnSet.flags) {
    if (arr.buffer instanceof SharedArrayBuffer) {
      flags.set(name, arr);
      continue;
    }
    const sab = new SharedArrayBuffer(arr.byteLength);
    new Uint8Array(sab).set(arr);
    flags.set(name, new Uint8Array(sab));
  }

  return {
    length: columnSet.length,
    columns,
    codes,
    flags,
    dictionaries: columnSet.dictionaries,
    events: columnSet.events,
  };
}

export function wrapSharedColumnSet(shared) {
  return {
    length: shared.length,
    columns: shared.columns,
    codes: shared.codes,
    flags: shared.flags,
    dictionaries: shared.dictionaries,
    events: shared.events,
  };
}

export { TICK_PROP_ALIASES, CODE_COLUMNS, MS_COLUMNS };
