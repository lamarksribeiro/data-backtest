import {
	buildLiveNormalizationIndexForEvent,
	buildNormalizationIndexFromReport,
} from './eventNormalizationIndex.js';
import { buildParquetEventPreview, buildSourceEventPreview } from './eventPreview.js';
import { findLakePartitionForPreview, loadParquetScalarTicksForEvent } from './parquetEventTicks.js';
import { getScalarTicksForEvents, resolveMarketId } from '../source/postgres.js';

async function resolveNormalizationIndexForEvent(pool, partitionCtx, lakePartition, conditionId, config, { live = false } = {}) {
	const manifestNorm = lakePartition?.quality_details?.normalization;
	const normalizationIndex = buildNormalizationIndexFromReport(manifestNorm);

	if (live) {
		return buildLiveNormalizationIndexForEvent(pool, partitionCtx, conditionId, config);
	}

	if (normalizationIndex.has(conditionId)) {
		return normalizationIndex;
	}

	const eventIndex = await buildLiveNormalizationIndexForEvent(pool, partitionCtx, conditionId, config);
	for (const [key, value] of eventIndex) {
		normalizationIndex.set(key, value);
	}
	return normalizationIndex;
}

export async function resolveDualEventPreview({
	db,
	pool,
	config,
	dt,
	underlying,
	interval,
	conditionId,
	live = false,
}) {
	const marketId = await resolveMarketId(pool, { underlying, interval });
	if (!marketId) {
		return { ok: false, status: 404, code: 'MARKET_NOT_FOUND', message: 'Market not found in source database' };
	}

	const partitionCtx = { marketId, dt, underlying, interval };
	const sourceTicks = await getScalarTicksForEvents(pool, partitionCtx, [conditionId]);
	if (!sourceTicks.length) {
		return { ok: false, status: 404, code: 'NOT_FOUND', message: 'No ticks found for event' };
	}

	const previewConfig = { ...config, underlying };
	const original = buildSourceEventPreview(sourceTicks, previewConfig);
	const { partition, dataset: lakeDataset } = findLakePartitionForPreview(db, {
		dt,
		underlying,
		interval,
		bookDepth: config.backtestBookDepth,
	});
	const normalizationIndex = await resolveNormalizationIndexForEvent(
		pool,
		partitionCtx,
		partition,
		conditionId,
		config,
		{ live },
	);
	const normMeta = normalizationIndex.get(conditionId) || {};

	let parquet = null;
	let parquet_available = false;

	if (partition?.active_path) {
		parquet_available = true;
		const parquetTicks = await loadParquetScalarTicksForEvent(db, {
			dt,
			underlying,
			interval,
			conditionId,
			partition,
			dataset: lakeDataset ?? 'scalars',
			bookDepth: config.backtestBookDepth,
		});
		parquet = buildParquetEventPreview(parquetTicks, normMeta, previewConfig);
		parquet.partition_status = partition.status;
	}

	return {
		ok: true,
		status: 200,
		body: {
			dt,
			underlying,
			interval,
			condition_id: conditionId,
			event_start: sourceTicks[0]?.eventStart ?? null,
			event_end: sourceTicks[0]?.eventEnd ?? null,
			original,
			parquet,
			parquet_available,
			partition_status: partition?.status ?? 'missing',
		},
	};
}
