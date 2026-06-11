import { datasetRequestFromObject } from '../query/request.js';
import { buildNormalizationIndex, mergeDayEvents, summarizeHours } from '../quality/dayEvents.js';
import { checkDatasetAvailability } from '../query/availability.js';
import {
  addEventExclusion,
  listEventExclusionsForDay,
  markDayManifestStale,
  removeEventExclusion,
} from '../state/eventExclusions.js';
import { getPartitionEvents, resolveMarketId } from '../source/postgres.js';

function nextDayIso(dt) {
  const date = new Date(`${dt}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function parseDayRequest(body, config) {
  const dt = String(body.dt || '').trim();
  const underlying = String(body.underlying || '').trim().toUpperCase();
  const interval = String(body.interval || '').trim();
  if (!dt || !underlying || !interval) {
    throw new Error('dt, underlying and interval are required');
  }
  return { dt, underlying, interval, bookDepth: body.book_depth ?? body.bookDepth ?? config.backtestBookDepth };
}

export async function handleQualityDayEvents(pool, db, config, params) {
  const dt = String(params.get('dt') || '').trim();
  const underlying = String(params.get('underlying') || '').trim().toUpperCase();
  const interval = String(params.get('interval') || '').trim();
  if (!dt || !underlying || !interval) {
    return { ok: false, status: 400, body: { error: { code: 'INVALID_REQUEST', message: 'dt, underlying and interval are required' } } };
  }

  const marketId = await resolveMarketId(pool, { underlying, interval });
  if (!marketId) {
    return { ok: false, status: 404, body: { error: { code: 'MARKET_NOT_FOUND', message: 'Market not found in source database' } } };
  }

  const events = await getPartitionEvents(pool, { marketId, dt, underlying, interval });
  const exclusions = listEventExclusionsForDay(db, { dt, underlying, interval, marketId });
  const availability = checkDatasetAvailability(db, {
    dataset: 'scalars',
    from: `${dt}T00:00:00.000Z`,
    to: `${nextDayIso(dt)}T00:00:00.000Z`,
    underlying,
    interval,
  });
  const partition = availability.partitions.find((row) => row.dt === dt);
  const normalizationIndex = buildNormalizationIndex(partition?.quality_details);
  const merged = mergeDayEvents({ events, exclusions, normalizationIndex });

  return {
    ok: true,
    status: 200,
    body: {
      dt,
      underlying,
      interval,
      market_id: marketId,
      events: merged,
      hours: summarizeHours(merged),
      exclusions,
      normalization: partition?.quality_details?.normalization ?? null,
    },
  };
}

export async function handleQualityExclude(db, config, prepareRunner, pool, body, excludedBy = null) {
  const { dt, underlying, interval } = parseDayRequest(body, config);
  const conditionId = String(body.condition_id || body.conditionId || '').trim();
  const eventStart = String(body.event_start || body.eventStart || '').trim();
  if (!conditionId || !eventStart) {
    return { ok: false, status: 400, body: { error: { code: 'INVALID_REQUEST', message: 'condition_id and event_start are required' } } };
  }

  const marketId = body.market_id || (pool ? await resolveMarketId(pool, { underlying, interval }) : null);
  if (!marketId) {
    return { ok: false, status: 404, body: { error: { code: 'MARKET_NOT_FOUND', message: 'Market not found' } } };
  }

  addEventExclusion(db, {
    marketId,
    conditionId,
    eventStart,
    dt,
    underlying,
    interval,
    reason: String(body.reason || 'manual'),
    notes: body.notes ?? null,
    excludedBy,
  });

  const staleChanged = markDayManifestStale(
    db,
    { underlying, interval, dt, marketId },
    `manual exclusion for ${conditionId}`,
  );

  let job = null;
  if (body.resync !== false) {
    job = prepareRunner.enqueue({
      request: datasetRequestFromObject({
        dataset: 'backtest_ticks',
        from: dt,
        to: dt,
        underlying,
        interval,
        book_depth: body.book_depth ?? body.bookDepth ?? config.backtestBookDepth,
      }, config),
      mode: 'prepare',
      dryRun: false,
    });
  }

  return {
    ok: true,
    status: 202,
    body: {
      excluded: true,
      condition_id: conditionId,
      dt,
      stale_partitions_updated: staleChanged,
      job,
    },
  };
}

export async function handleQualityRestore(db, config, prepareRunner, pool, body) {
  const { dt, underlying, interval } = parseDayRequest(body, config);
  const conditionId = String(body.condition_id || body.conditionId || '').trim();
  if (!conditionId) {
    return { ok: false, status: 400, body: { error: { code: 'INVALID_REQUEST', message: 'condition_id is required' } } };
  }

  const marketId = body.market_id || (pool ? await resolveMarketId(pool, { underlying, interval }) : null);
  if (!marketId) {
    return { ok: false, status: 404, body: { error: { code: 'MARKET_NOT_FOUND', message: 'Market not found' } } };
  }

  const removed = removeEventExclusion(db, { marketId, conditionId });
  if (!removed) {
    return { ok: false, status: 404, body: { error: { code: 'NOT_FOUND', message: 'Exclusion not found' } } };
  }

  const staleChanged = markDayManifestStale(
    db,
    { underlying, interval, dt, marketId },
    `manual exclusion restored for ${conditionId}`,
  );

  let job = null;
  if (body.resync !== false) {
    job = prepareRunner.enqueue({
      request: datasetRequestFromObject({
        dataset: 'backtest_ticks',
        from: dt,
        to: dt,
        underlying,
        interval,
        book_depth: body.book_depth ?? body.bookDepth ?? config.backtestBookDepth,
      }, config),
      mode: 'prepare',
      dryRun: false,
    });
  }

  return {
    ok: true,
    status: 202,
    body: {
      restored: true,
      condition_id: conditionId,
      dt,
      stale_partitions_updated: staleChanged,
      job,
    },
  };
}

export function handleQualityListExclusions(db, params) {
  const dt = String(params.get('dt') || '').trim();
  const underlying = String(params.get('underlying') || '').trim().toUpperCase();
  const interval = String(params.get('interval') || '').trim();
  if (!dt || !underlying || !interval) {
    return { ok: false, status: 400, body: { error: { code: 'INVALID_REQUEST', message: 'dt, underlying and interval are required' } } };
  }
  return {
    ok: true,
    status: 200,
    body: {
      exclusions: listEventExclusionsForDay(db, { dt, underlying, interval }),
    },
  };
}
