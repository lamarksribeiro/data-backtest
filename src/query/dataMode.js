import { checkDatasetAvailability } from './availability.js';

const VALID_QUERY_MODES = new Set(['strict', 'prepare']);

export function resolveDataRequest(db, request, mode = 'strict') {
  if (!VALID_QUERY_MODES.has(mode)) throw new Error(`Unsupported data mode for query resolution: ${mode}`);
  const availability = checkDatasetAvailability(db, request);

  if (availability.ok && !(mode === 'prepare' && request.rebuild)) {
    return {
      mode,
      ready: true,
      status: 'ready',
      availability,
      preparation: [],
    };
  }

  if (mode === 'strict') {
    return {
      mode,
      ready: false,
      status: 'blocked',
      reason: 'dataset_not_available',
      availability,
      preparation: [],
    };
  }

  return {
    mode,
    ready: false,
    status: 'prepare_required',
    reason: 'dataset_not_available',
    availability,
    preparation: buildPreparationPlan(request, availability),
  };
}

export function requireStrictDataRequest(db, request) {
  const result = resolveDataRequest(db, request, 'strict');
  if (!result.ready) {
    const missing = result.availability.missing.join(',');
    const unavailable = result.availability.unavailable.map((item) => `${item.dt}:${item.status}`).join(',');
    throw new Error(`Dataset not available for strict mode: ${[missing && `missing=${missing}`, unavailable && `unavailable=${unavailable}`].filter(Boolean).join('; ')}`);
  }
  return result;
}

export function buildPreparationPlan(request, availability) {
  const dates = request.rebuild
    ? availability.expected_partitions
    : [...availability.missing, ...availability.unavailable.map((item) => item.dt)];
  const uniqueDates = [...new Set(dates)].sort();
  if (!uniqueDates.length) return [];

  const ranges = collapseDatesToRanges(uniqueDates);
  const actions = [];
  for (const range of ranges) {
    actions.push(...actionsForRange(request, range));
  }
  return actions;
}

function actionsForRange(request, range) {
  const base = {
    from: `${range.from}T00:00:00.000Z`,
    to: nextDayIso(range.to),
    underlying: request.underlying,
    interval: request.interval,
  };

  if (request.dataset === 'scalars') return [syncAction('sync:backfill', base, request)];
  if (request.dataset === 'books') return [syncAction('sync:backfill-books', base, request)];
  if (request.dataset === 'backtest_ticks') {
    return [syncAction('sync:backfill-backtest-ticks', { ...base, bookDepth: request.bookDepth }, request)];
  }
  if (request.dataset === 'ohlc') {
    return [
      syncAction('sync:backfill', base, request, { prerequisite: true }),
      syncAction('sync:backfill-ohlc', { ...base, resolution: request.resolution }, request),
    ];
  }
  throw new Error(`Unsupported dataset for prepare mode: ${request.dataset}`);
}

function syncAction(command, params, request, extra = {}) {
  const args = [
    '--from', params.from,
    '--to', params.to,
    '--underlying', params.underlying,
    '--interval', params.interval,
  ];
  if (params.bookDepth != null) args.push('--book-depth', String(params.bookDepth));
  if (params.resolution) args.push('--resolution', params.resolution);
  if (request.rebuild) args.push('--rebuild');
  return { command, args, ...extra };
}

function collapseDatesToRanges(dates) {
  const ranges = [];
  let start = dates[0];
  let previous = dates[0];
  for (const dt of dates.slice(1)) {
    if (dt === nextDate(previous)) {
      previous = dt;
      continue;
    }
    ranges.push({ from: start, to: previous });
    start = dt;
    previous = dt;
  }
  ranges.push({ from: start, to: previous });
  return ranges;
}

function nextDate(dt) {
  const date = new Date(`${dt}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function nextDayIso(dt) {
  return `${nextDate(dt)}T00:00:00.000Z`;
}
