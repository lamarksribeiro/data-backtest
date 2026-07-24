const DATETIME_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function parseDateStart(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00.000Z`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

export function parseDateEnd(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date;
  }
  if (DATETIME_LOCAL_RE.test(value)) {
    const inclusive = new Date(value);
    if (Number.isNaN(inclusive.getTime())) throw new Error(`Invalid date: ${value}`);
    return new Date(inclusive.getTime() + 60_000);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

/** Converte fim exclusivo (ISO) para a data inclusiva exibida na UI (YYYY-MM-DD). */
export function inclusiveEndDateFromExclusive(value, fromIso = null) {
  const text = String(value || '');
  const dateOnly = text.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return dateOnly || '?';
  if (text.length <= 10) return dateOnly;
  const exclusive = new Date(text.includes('T') ? text : `${text}T00:00:00.000Z`);
  if (Number.isNaN(exclusive.getTime())) return dateOnly;

  const fromText = String(fromIso || '');
  const dateOnlyEnd = /T00:00:00\.000Z$/.test(text)
    && (!fromText || /T00:00:00\.000Z$/.test(fromText));

  const inclusive = dateOnlyEnd
    ? new Date(exclusive.getTime() - 86_400_000)
    : new Date(exclusive.getTime() - 60_000);
  return inclusive.toISOString().slice(0, 10);
}

/** Fim exclusivo → instante inclusivo (ISO) para exibição com hora. */
export function inclusiveEndInstantFromExclusive(value, fromIso = null) {
  const text = String(value || '');
  if (!text) return null;
  const exclusive = new Date(text.includes('T') ? text : `${text}T00:00:00.000Z`);
  if (Number.isNaN(exclusive.getTime())) return text;

  const fromText = String(fromIso || '');
  const dateOnlyEnd = /T00:00:00\.000Z$/.test(text)
    && (!fromText || /T00:00:00\.000Z$/.test(fromText));

  const inclusive = dateOnlyEnd
    ? new Date(exclusive.getTime() - 86_400_000)
    : new Date(exclusive.getTime() - 60_000);
  return inclusive.toISOString();
}

export function inclusiveDateRangeFromRequest(request) {
  return {
    from_date: String(request.from).slice(0, 10),
    to_date: inclusiveEndDateFromExclusive(request.to, request.from),
  };
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
  return toRaw;
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
    acceptMismatchRatio: config.syncAcceptCountMismatchRatio,
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
