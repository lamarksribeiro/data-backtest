import { openSharedConnection } from './duckdbPool.js';
import { buildTicksSql, backtestTickSelectColumns } from './duckdbQuery.js';
import { requireDatasetAvailability } from './availability.js';
import {
  classifyColumnName,
  createColumnSetBuilder,
} from '../backtest/columnStore.js';

const TYPE = {
  BOOLEAN: 1,
  TINYINT: 2,
  SMALLINT: 3,
  INTEGER: 4,
  BIGINT: 5,
  UTINYINT: 6,
  USMALLINT: 7,
  UINTEGER: 8,
  UBIGINT: 9,
  FLOAT: 10,
  DOUBLE: 11,
  TIMESTAMP: 12,
  DATE: 13,
  TIMESTAMP_S: 20,
  TIMESTAMP_MS: 21,
  TIMESTAMP_NS: 22,
  DECIMAL: 19,
  TIMESTAMP_TZ: 31,
  HUGEINT: 16,
  UHUGEINT: 32,
};

const NUMERIC_TYPE_IDS = new Set([
  TYPE.TINYINT, TYPE.SMALLINT, TYPE.INTEGER, TYPE.BIGINT,
  TYPE.UTINYINT, TYPE.USMALLINT, TYPE.UINTEGER, TYPE.UBIGINT,
  TYPE.FLOAT, TYPE.DOUBLE, TYPE.HUGEINT, TYPE.UHUGEINT, TYPE.DECIMAL,
]);

const TIMESTAMP_TYPE_IDS = new Set([
  TYPE.TIMESTAMP, TYPE.TIMESTAMP_S, TYPE.TIMESTAMP_MS,
  TYPE.TIMESTAMP_NS, TYPE.TIMESTAMP_TZ, TYPE.DATE,
]);

/**
 * Carrega ticks do Parquet via DuckDB em ColumnSet (sem objetos-linha JS).
 */
export async function loadBacktestColumnSet(db, request) {
  const dataset = request.dataset || 'backtest_ticks';
  const availability = requireDatasetAvailability(db, { ...request, dataset });
  const bookDepth = request.bookDepth ?? 25;
  const selectCols = request.select
    ?? backtestTickSelectColumns(bookDepth, {
      scalarColumns: request.selectColumns,
      includeBook: request.includeBook !== false,
    });
  const sourceSql = buildTicksSql(availability, { ...request, dataset }, { select: selectCols, order: true });

  const connection = await openSharedConnection();
  let result = null;
  try {
    result = await connection.stream(sourceSql);
    const columnNames = result.columnNames();
    const columnTypes = result.columnTypes();
    const builder = createColumnSetBuilder();
    for (const name of columnNames) {
      builder.registerColumn(resolveStorageColumn(name), classifyColumnName(name));
    }

    for await (const chunk of result) {
      if (!chunk?.rowCount) continue;
      appendChunk(builder, chunk, columnNames, columnTypes);
    }

    return builder.finalize();
  } finally {
    connection.closeSync();
  }
}

function resolveStorageColumn(name) {
  if (name === 'ts') return '_ts_ms';
  if (name === 'event_start') return '_event_start_ms';
  if (name === 'event_end') return '_event_end_ms';
  return name;
}

function appendChunk(builder, chunk, columnNames, columnTypes) {
  const rowCount = chunk.rowCount;
  if (!rowCount) return;
  builder.ensureCapacity(rowCount);

  for (let colIndex = 0; colIndex < columnNames.length; colIndex += 1) {
    const rawName = columnNames[colIndex];
    const storageName = resolveStorageColumn(rawName);
    const kind = classifyColumnName(rawName);
    const vector = chunk.getColumnVector(colIndex);
    const typeId = columnTypes[colIndex]?.typeId ?? 17;
    const offset = builder.length;

    if (kind === 'code') {
      const target = builder.codes.get(storageName);
      appendStringCodes(builder, storageName, vector, target, offset, rowCount);
      continue;
    }

    if (kind === 'flag') {
      const target = builder.flags.get(storageName);
      appendFlags(vector, target, offset, rowCount);
      continue;
    }

    const target = builder.columns.get(storageName);
    if (kind === 'ms' || TIMESTAMP_TYPE_IDS.has(typeId)) {
      appendTimestampMs(vector, target, offset, rowCount, typeId);
    } else if (NUMERIC_TYPE_IDS.has(typeId)) {
      appendNumeric(vector, target, offset, rowCount);
    } else {
      appendNumericFromGeneric(vector, target, offset, rowCount);
    }
  }

  builder.length += rowCount;
}

function appendNumeric(vector, target, offset, rowCount) {
  if (vector.items instanceof Float64Array && vector.validity) {
    for (let i = 0; i < rowCount; i += 1) {
      target[offset + i] = vector.validity.itemValid(i) ? vector.items[i] : Number.NaN;
    }
    return;
  }
  if (vector.items instanceof Float32Array && vector.validity) {
    for (let i = 0; i < rowCount; i += 1) {
      target[offset + i] = vector.validity.itemValid(i) ? vector.items[i] : Number.NaN;
    }
    return;
  }
  appendNumericFromGeneric(vector, target, offset, rowCount);
}

function appendNumericFromGeneric(vector, target, offset, rowCount) {
  for (let i = 0; i < rowCount; i += 1) {
    const value = vector.getItem(i);
    if (value == null) target[offset + i] = Number.NaN;
    else if (typeof value === 'bigint') target[offset + i] = Number(value);
    else target[offset + i] = Number(value);
  }
}

function appendTimestampMs(vector, target, offset, rowCount, typeId) {
  if (vector.items instanceof BigInt64Array && vector.validity) {
    const divisor = timestampDivisor(typeId);
    for (let i = 0; i < rowCount; i += 1) {
      if (!vector.validity.itemValid(i)) {
        target[offset + i] = Number.NaN;
        continue;
      }
      const micros = vector.items[i];
      target[offset + i] = Number(micros / divisor);
    }
    return;
  }

  for (let i = 0; i < rowCount; i += 1) {
    const value = vector.getItem(i);
    target[offset + i] = duckdbTimestampToMs(value);
  }
}

function timestampDivisor(typeId) {
  if (typeId === TYPE.TIMESTAMP_S) return 1_000_000n;
  if (typeId === TYPE.TIMESTAMP_MS) return 1_000n;
  if (typeId === TYPE.TIMESTAMP_NS) return 1_000_000_000n;
  return 1_000n;
}

function duckdbTimestampToMs(value) {
  if (value == null) return Number.NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : Number.NaN;
  }
  if (typeof value === 'object' && value.micros != null) {
    return Number(value.micros / 1_000n);
  }
  if (typeof value === 'bigint') return Number(value / 1_000n);
  if (typeof value === 'number') return value;
  return Number.NaN;
}

function appendFlags(vector, target, offset, rowCount) {
  for (let i = 0; i < rowCount; i += 1) {
    const value = vector.getItem(i);
    target[offset + i] = value ? 1 : 0;
  }
}

function appendStringCodes(builder, columnName, vector, target, offset, rowCount) {
  for (let i = 0; i < rowCount; i += 1) {
    const value = vector.getItem(i);
    target[offset + i] = builder.internCode(columnName, value);
  }
}
