import { datasetRequestFromObject } from '../query/request.js';
import { mergeDayEvents, summarizeHours } from '../quality/dayEvents.js';
import {
	dayEventsCacheKey,
	getCachedDayEvents,
	invalidateDayEventsCache,
	setCachedDayEvents,
} from '../quality/dayEventsCache.js';
import { resolveDualEventPreview } from '../quality/eventPreviewSource.js';
import { resolveDayNormalizationIndex } from '../quality/normalizationResolve.js';
import { checkDatasetAvailability } from '../query/availability.js';
import {
	addEventExclusion,
	listEventExclusionsForDay,
	markDayManifestStale,
	removeEventExclusion,
} from '../state/eventExclusions.js';
import { getPartitionEvents, getPartitionEventStubs, resolveMarketId } from '../source/postgres.js';

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

function findPartitionForDay(db, config, { dt, underlying, interval, bookDepth }) {
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
	return partition;
}

function parseHourUtcParam(params) {
	if (!params.has('hour')) return 0;
	const raw = String(params.get('hour') ?? '').trim().toLowerCase();
	if (!raw || raw === 'all') return null;
	const hour = Number(raw);
	if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
		return { error: 'hour must be an integer between 0 and 23, or "all"' };
	}
	return hour;
}

export async function handleQualityDayEvents(pool, db, config, params) {
	const dt = String(params.get('dt') || '').trim();
	const underlying = String(params.get('underlying') || '').trim().toUpperCase();
	const interval = String(params.get('interval') || '').trim();
	const live = params.get('live') === '1';
	const hourParsed = parseHourUtcParam(params);
	if (hourParsed !== null && typeof hourParsed === 'object' && hourParsed.error) {
		return { ok: false, status: 400, body: { error: { code: 'INVALID_REQUEST', message: hourParsed.error } } };
	}
	const hourUtc = hourParsed;
	if (!dt || !underlying || !interval) {
		return { ok: false, status: 400, body: { error: { code: 'INVALID_REQUEST', message: 'dt, underlying and interval are required' } } };
	}

	const bookDepthVal = params.get('book_depth') || params.get('bookDepth');
	const bookDepth = bookDepthVal ? Number(bookDepthVal) : Number(config.backtestBookDepth);
	const cacheKey = dayEventsCacheKey({ dt, underlying, interval, bookDepth, hourUtc });
	if (!live) {
		const cached = getCachedDayEvents(cacheKey);
		if (cached) return cached;
	}

	const marketId = await resolveMarketId(pool, { underlying, interval });
	if (!marketId) {
		return { ok: false, status: 404, body: { error: { code: 'MARKET_NOT_FOUND', message: 'Market not found in source database' } } };
	}

	const partitionCtx = { marketId, dt, underlying, interval };
	const exclusions = listEventExclusionsForDay(db, { dt, underlying, interval, marketId });
	const partition = findPartitionForDay(db, config, { dt, underlying, interval, bookDepth });
	const manifestNorm = partition?.quality_details?.normalization ?? null;
	const { normalizationIndex, normalization_live } = await resolveDayNormalizationIndex(
		pool,
		partitionCtx,
		manifestNorm,
		config,
		{ live },
	);

	const stubs = await getPartitionEventStubs(pool, partitionCtx);
	const hours = summarizeHours(mergeDayEvents({ events: stubs, exclusions, normalizationIndex }));
	const events = await getPartitionEvents(pool, partitionCtx, { hourUtc });
	const merged = mergeDayEvents({ events, exclusions, normalizationIndex });

	const result = {
		ok: true,
		status: 200,
		body: {
			dt,
			underlying,
			interval,
			market_id: marketId,
			hour_loaded: hourUtc,
			events: merged,
			hours,
			exclusions,
			normalization: manifestNorm ?? null,
			normalization_live,
			partition_status: partition?.status ?? 'missing',
		},
	};

	if (!live) setCachedDayEvents(cacheKey, result);
	return result;
}

export async function handleQualityEventPreview(pool, db, config, params) {
	const dt = String(params.get('dt') || '').trim();
	const underlying = String(params.get('underlying') || '').trim().toUpperCase();
	const interval = String(params.get('interval') || '').trim();
	const conditionId = String(params.get('condition_id') || params.get('conditionId') || '').trim();
	const live = params.get('live') === '1';
	if (!dt || !underlying || !interval || !conditionId) {
		return { ok: false, status: 400, body: { error: { code: 'INVALID_REQUEST', message: 'dt, underlying, interval and condition_id are required' } } };
	}

	const result = await resolveDualEventPreview({
		db,
		pool,
		config,
		dt,
		underlying,
		interval,
		conditionId,
		live,
	});
	if (!result.ok) {
		return {
			ok: false,
			status: result.status,
			body: { error: { code: result.code || 'NOT_FOUND', message: result.message || 'Event preview failed' } },
		};
	}
	return { ok: true, status: result.status, body: result.body };
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
	invalidateDayEventsCache({ dt, underlying, interval });

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
	invalidateDayEventsCache({ dt, underlying, interval });

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

export { invalidateDayEventsCache };
