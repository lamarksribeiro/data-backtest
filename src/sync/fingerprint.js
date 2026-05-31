import crypto from 'node:crypto';

export function createSourceFingerprint(input) {
  const payload = {
    dataset: input.dataset,
    marketId: input.marketId,
    underlying: input.underlying,
    interval: input.interval,
    dt: input.dt,
    rows: input.rows,
    valueChecksum: input.valueChecksum ?? null,
    events: [...input.events]
      .map((event) => ({
        conditionId: event.conditionId,
        ticksRecorded: event.ticksRecorded,
        actualCount: event.actualCount,
        recordedAt: event.recordedAt,
        minTs: event.minTs,
        maxTs: event.maxTs,
      }))
      .sort((left, right) => left.conditionId.localeCompare(right.conditionId)),
  };

  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function createScalarRowsChecksum(rows) {
  const hash = crypto.createHash('sha256');
  for (const row of rows) {
    hash.update([
      row.conditionId,
      row.ts,
      formatNumber(row.underlyingPrice),
      formatNumber(row.priceToBeat),
      formatNumber(row.upPrice),
      formatNumber(row.downPrice),
      formatNumber(row.upBestBid),
      formatNumber(row.upBestAsk),
      formatNumber(row.downBestBid),
      formatNumber(row.downBestAsk),
    ].join('|'));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function createBooksRowsChecksum(rows) {
  const hash = crypto.createHash('sha256');
  for (const row of rows) {
    hash.update([
      row.conditionId,
      row.ts,
      normalizeJson(row.upBookAsks),
      normalizeJson(row.upBookBids),
      normalizeJson(row.downBookAsks),
      normalizeJson(row.downBookBids),
    ].join('|'));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function createBacktestTicksRowsChecksum(rows, bookDepth) {
  const hash = crypto.createHash('sha256');
  for (const row of rows) {
    const values = [
      row.conditionId,
      row.ts,
      formatNumber(row.underlyingPrice),
      formatNumber(row.priceToBeat),
      formatNumber(row.upPrice),
      formatNumber(row.downPrice),
      formatNumber(row.upBestBid),
      formatNumber(row.upBestAsk),
      formatNumber(row.downBestBid),
      formatNumber(row.downBestAsk),
    ];
    for (const side of ['up_ask', 'up_bid', 'down_ask', 'down_bid']) {
      for (let i = 1; i <= bookDepth; i += 1) {
        values.push(formatNumber(row[`${side}_px_${i}`]));
        values.push(formatNumber(row[`${side}_sz_${i}`]));
      }
    }
    hash.update(values.join('|'));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function normalizeJson(value) {
  if (value == null) return '[]';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function formatNumber(value) {
  if (value == null) return '';
  return Number(value).toFixed(8);
}

export function createRunId(prefix = 'run') {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}
