import { buildLiveNormalizationIndex, buildNormalizationIndexFromReport } from './eventNormalizationIndex.js';

export function isNormalizationIndexIncomplete(manifestNorm, normalizationIndex) {
	if (!manifestNorm?.events_index?.length) return false;
	if (!manifestNorm.events_omitted) return false;
	const omitInIndex = [...normalizationIndex.values()].filter((row) => row.action === 'omit').length;
	return omitInIndex < manifestNorm.events_omitted;
}

/**
 * Live normalization is expensive (full-day Postgres tick scan). Only run when
 * explicitly requested or when a persisted index exists but is provably incomplete.
 */
export function shouldComputeLiveNormalization({ live, manifestNorm, normalizationIndex }) {
	if (live === true || live === '1') return true;
	if (!manifestNorm?.events_index?.length) return false;
	return isNormalizationIndexIncomplete(manifestNorm, normalizationIndex);
}

export async function resolveDayNormalizationIndex(pool, partition, manifestNorm, config, { live = false } = {}) {
	let normalizationIndex = buildNormalizationIndexFromReport(manifestNorm);
	if (shouldComputeLiveNormalization({ live, manifestNorm, normalizationIndex })) {
		normalizationIndex = await buildLiveNormalizationIndex(pool, partition, config);
		return { normalizationIndex, normalization_live: true };
	}
	return {
		normalizationIndex,
		normalization_live: false,
	};
}
