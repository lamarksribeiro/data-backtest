import { datasetRequestFromObject } from '../query/request.js';
import { mergeDayEvents, summarizeHours } from '../quality/dayEvents.js';
import { buildEventPreviewFromTicks } from '../quality/eventPreview.js';
import { buildLiveNormalizationIndex, buildNormalizationIndexFromReport } from '../quality/eventNormalizationIndex.js';
import { checkDatasetAvailability } from '../query/availability.js';
import {
  addEventExclusion,
  listEventExclusionsForDay,
  markDayManifestStale,
  removeEventExclusion,
} from '../state/eventExclusions.js';
import { getPartitionEvents, getScalarTicksForEvents, resolveMarketId } from '../source/postgres.js';

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
  
  const bookDepthVal = params.get('book_depth') || params.get('bookDepth');
  const bookDepth = bookDepthVal ? Number(bookDepthVal) : Number(config.backtestBookDepth);

  const availability = checkDatasetAvailability(db, {
    dataset: 'backtest_ticks',
    from: `${dt}T00:00:00.000Z`,
    to: `${nextDayIso(dt)}T00:00:00.000Z`,
    underlying,
    interval,
    bookDepth,
  });
  
  let partition = availability.partitions.find((row) => row.dt === dt && row.usable);
  if (!partition) {
    const scalarsAvailability = checkDatasetAvailability(db, {
      dataset: 'scalars',
      from: `${dt}T00:00:00.000Z`,
      to: `${nextDayIso(dt)}T00:00:00.000Z`,
      underlying,
      interval,
    });
    partition = scalarsAvailability.partitions.find((row) => row.dt === dt);
  }

  let normalizationIndex = buildNormalizationIndexFromReport(partition?.quality_details?.normalization);
  const manifestNorm = partition?.quality_details?.normalization;
  const indexLooksIncomplete = manifestNorm?.events_omitted > 0
    && [...normalizationIndex.values()].filter((row) => row.action === 'omit').length < manifestNorm.events_omitted;
  if (!manifestNorm?.events_index?.length || indexLooksIncomplete) {
    normalizationIndex = await buildLiveNormalizationIndex(pool, { marketId, dt, underlying, interval }, config);
  }

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
      normalization: manifestNorm ?? null,
      normalization_live: !manifestNorm?.events_index?.length || indexLooksIncomplete,
    },
  };
}

export async function handleQualityEventPreview(pool, config, params) {
  const dt = String(params.get('dt') || '').trim();
  const underlying = String(params.get('underlying') || '').trim().toUpperCase();
  const interval = String(params.get('interval') || '').trim();
  const conditionId = String(params.get('condition_id') || params.get('conditionId') || '').trim();
  if (!dt || !underlying || !interval || !conditionId) {
    return { ok: false, status: 400, body: { error: { code: 'INVALID_REQUEST', message: 'dt, underlying, interval and condition_id are required' } } };
  }

  const marketId = await resolveMarketId(pool, { underlying, interval });
  if (!marketId) {
    return { ok: false, status: 404, body: { error: { code: 'MARKET_NOT_FOUND', message: 'Market not found in source database' } } };
  }

  const partition = { marketId, dt, underlying, interval };
  const ticks = await getScalarTicksForEvents(pool, partition, [conditionId]);
  if (!ticks.length) {
    return { ok: false, status: 404, body: { error: { code: 'NOT_FOUND', message: 'No ticks found for event' } } };
  }

  return {
    ok: true,
    status: 200,
    body: {
      dt,
      underlying,
      interval,
      condition_id: conditionId,
      event_start: ticks[0]?.eventStart ?? null,
      event_end: ticks[0]?.eventEnd ?? null,
      preview: buildEventPreviewFromTicks(ticks, config),
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
