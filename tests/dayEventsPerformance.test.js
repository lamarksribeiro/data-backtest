import test from 'node:test';
import assert from 'node:assert/strict';

import {
	isNormalizationIndexIncomplete,
	shouldComputeLiveNormalization,
} from '../src/quality/normalizationResolve.js';
import {
	dayEventsCacheKey,
	getCachedDayEvents,
	invalidateDayEventsCache,
	setCachedDayEvents,
} from '../src/quality/dayEventsCache.js';
import { buildPartitionQualityDetails } from '../src/sync/qualityDetails.js';
import { mapEventResultsToIndex } from '../src/quality/eventNormalizationIndex.js';

test('shouldComputeLiveNormalization skips live when manifest has no events_index', () => {
	const index = new Map();
	assert.equal(shouldComputeLiveNormalization({ live: false, manifestNorm: null, normalizationIndex: index }), false);
	assert.equal(shouldComputeLiveNormalization({ live: false, manifestNorm: {}, normalizationIndex: index }), false);
});

test('shouldComputeLiveNormalization honors explicit live=1', () => {
	assert.equal(shouldComputeLiveNormalization({
		live: '1',
		manifestNorm: null,
		normalizationIndex: new Map(),
	}), true);
});

test('isNormalizationIndexIncomplete detects partial omit index', () => {
	const index = new Map([['a', { action: 'omit' }]]);
	const manifestNorm = { events_index: [{ condition_id: 'a', action: 'omit' }], events_omitted: 3 };
	assert.equal(isNormalizationIndexIncomplete(manifestNorm, index), true);
});

test('dayEventsCache stores and invalidates by day prefix', () => {
	const key = dayEventsCacheKey({ dt: '2026-06-01', underlying: 'BTC', interval: '5m', bookDepth: 25, hourUtc: 0 });
	const result = { ok: true, status: 200, body: { dt: '2026-06-01', hour_loaded: 0 } };
	setCachedDayEvents(key, result);
	assert.deepEqual(getCachedDayEvents(key)?.body, result.body);
	invalidateDayEventsCache({ dt: '2026-06-01', underlying: 'BTC', interval: '5m' });
	assert.equal(getCachedDayEvents(key), null);
});

test('dayEventsCache keys differ per hour', () => {
	const base = { dt: '2026-06-01', underlying: 'BTC', interval: '5m', bookDepth: 25 };
	assert.notEqual(dayEventsCacheKey({ ...base, hourUtc: 0 }), dayEventsCacheKey({ ...base, hourUtc: 1 }));
});

test('buildPartitionQualityDetails persists events_index even when normalization not applied', () => {
	const normalization = {
		applied: false,
		events_total: 2,
		events_omitted: 0,
		events_index: mapEventResultsToIndex([
			{
				conditionId: '0x1',
				eventStart: '2026-06-01T12:00:00.000Z',
				action: 'keep',
				issues: [],
				stats: { ticksIn: 100, ticksOut: 100, badRatio: 0 },
			},
		]),
	};
	const details = buildPartitionQualityDetails({
		partition: { hasDegraded: false },
		events: [{
			conditionId: '0x1',
			eventStart: '2026-06-01T12:00:00.000Z',
			eventEnd: '2026-06-01T12:05:00.000Z',
			coverage: 1,
			degraded: false,
			ticksRecorded: 100,
			ticksExpected: 100,
		}],
		actualRows: 100,
		expectedRows: 100,
		quality: { diverged: false },
		normalization,
	});
	assert.ok(details);
	assert.equal(details.normalization?.events_index?.length, 1);
	assert.equal(details.normalization.applied, false);
});
