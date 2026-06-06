export function parseDateStart(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00.000Z`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

export function parseDateEnd(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00.000Z`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

export function rangeFromParams(params) {
  const fromRaw = requiredParam(params, 'from');
  const toRaw = requiredParam(params, 'to');
  const from = parseDateStart(fromRaw);
  const to = parseDateEnd(normalizeDateOnlyEnd(fromRaw, toRaw));
  if (to <= from) throw new Error('to must be after from');
  return { from: from.toISOString(), to: to.toISOString() };
}

function normalizeDateOnlyEnd(fromRaw, toRaw) {
  if (fromRaw !== toRaw || !/^\d{4}-\d{2}-\d{2}$/.test(toRaw)) return toRaw;
  const end = new Date(`${toRaw}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return end.toISOString();
}

import { normalizeInterval } from '../source/postgres.js';

export function datasetRequestFromParams(params, config) {
  const range = rangeFromParams(params);
  const dataset = String(params.get('dataset') || 'backtest_ticks');
  const request = {
    dataset,
    from: range.from,
    to: range.to,
    underlying: requiredParam(params, 'underlying').toUpperCase(),
    interval: normalizeInterval(requiredParam(params, 'interval')),
    limit: positiveIntParam(params, 'limit') ?? 1000,
  };

  if (dataset === 'backtest_ticks') request.bookDepth = positiveIntParam(params, 'book_depth') ?? positiveIntParam(params, 'book-depth') ?? config.backtestBookDepth;
  if (dataset === 'ohlc') request.resolution = requiredParam(params, 'resolution');
  request.rebuild = boolParam(params, 'rebuild');
  return request;
}

export function datasetRequestFromObject(input, config) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input || {})) {
    if (value != null) params.set(key, String(value));
  }
  return datasetRequestFromParams(params, config);
}

export function requiredParam(params, key) {
  const value = params.get(key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export function positiveIntParam(params, key) {
  const value = params.get(key);
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${key} must be a positive integer`);
  return parsed;
}

export function boolParam(params, key) {
  const value = params.get(key);
  if (value == null || value === '') return false;
  if (value === 'true' || value === '1' || value === 'on') return true;
  if (value === 'false' || value === '0' || value === 'off') return false;
  throw new Error(`${key} must be a boolean`);
}
