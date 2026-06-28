import { loadConfig } from '../config.js';
import { partitionDatesForRange } from '../query/availability.js';
import { backtestColumnSetSelectColumns } from '../query/duckdbQuery.js';
import { loadBacktestColumnSetFromDuckdb } from '../query/columnChunkReader.js';
import { concatColumnSets, sliceColumnSet } from './columnSetMerge.js';
import {
	readColumnSetPartition,
	writeColumnSetPartition,
} from './columnSetDisk.js';
import {
	evictDatasetDiskCacheIfNeeded,
	partitionPaths,
	readValidPartitionMeta,
	resolveColsHash,
} from './datasetDiskStore.js';
import { findManifestPartitionRow } from '../query/manifestPartitions.js';

export async function loadBacktestColumnSetWithDiskCache(db, request, { onProgress, config = loadConfig() } = {}) {
	if (!config.datasetDiskCacheEnabled) {
		return loadBacktestColumnSetFromDuckdb(db, request, { onProgress });
	}

	const dataset = request.dataset || 'backtest_ticks';
	const bookDepth = request.bookDepth ?? 25;
	const selectBookDepth = request.selectBookDepth ?? bookDepth;
	const selectCols = request.select
		?? backtestColumnSetSelectColumns(selectBookDepth, {
			scalarColumns: request.selectColumns,
			includeBook: request.includeBook !== false,
		});
	const colsHash = resolveColsHash(selectCols);
	const cacheKey = {
		dataset,
		underlying: request.underlying,
		interval: request.interval,
		bookDepth: dataset === 'backtest_ticks_lite' ? null : bookDepth,
		colsHash,
	};

	const fromMs = new Date(request.from).getTime();
	const toMs = new Date(request.to).getTime();
	const dates = partitionDatesForRange(request.from, request.to);
	const parts = [];
	let loadedRows = 0;

	const reportProgress = (extra = {}) => {
		if (typeof onProgress === 'function') {
			onProgress({ loadedRows, ...extra });
		}
	};

	for (const dt of dates) {
		const manifestRow = findManifestPartitionRow(db, { ...request, dataset, bookDepth: cacheKey.bookDepth }, dt);
		if (!manifestRow || !['valid', 'accepted'].includes(manifestRow.status) || !manifestRow.active_path) {
			throw new Error(`Dataset partition not available for ${dt}`);
		}

		const { binPath, metaPath } = partitionPaths(config, cacheKey, dt);
		let columnSet = null;
		const validMeta = readValidPartitionMeta(binPath, metaPath, manifestRow);
		if (validMeta) {
			columnSet = readColumnSetPartition(binPath);
		}

		if (!columnSet) {
			const dayFrom = new Date(`${dt}T00:00:00.000Z`).toISOString();
			const dayTo = new Date(new Date(`${dt}T00:00:00.000Z`).getTime() + 86_400_000).toISOString();
			columnSet = await loadBacktestColumnSetFromDuckdb(db, {
				...request,
				dataset,
				from: dayFrom,
				to: dayTo,
				select: selectCols,
			}, {
				onProgress: ({ loadedRows: n }) => {
					if (typeof onProgress === 'function') {
						onProgress({ loadedRows: loadedRows + n });
					}
				},
			});
			writeColumnSetPartition({
				binPath,
				metaPath,
				columnSet,
				meta: {
					dt,
					source_fingerprint: manifestRow.source_fingerprint ?? null,
					active_path: manifestRow.active_path ?? null,
					dataset,
					underlying: request.underlying,
					interval: request.interval,
					book_depth: cacheKey.bookDepth,
					cols: colsHash,
				},
			});
			evictDatasetDiskCacheIfNeeded(config);
		}

		const dayStartMs = new Date(`${dt}T00:00:00.000Z`).getTime();
		const dayEndMs = dayStartMs + 86_400_000;
		const sliceFrom = Math.max(fromMs, dayStartMs);
		const sliceTo = Math.min(toMs, dayEndMs);
		if (sliceFrom < sliceTo) {
			const sliced = sliceColumnSet(columnSet, sliceFrom, sliceTo);
			columnSet = null;
			if (sliced.length > 0) {
				parts.push(sliced);
				loadedRows += sliced.length;
			}
		}
		reportProgress({ loadingStep: 'day', dt });
		await new Promise((resolve) => setImmediate(resolve));
	}

	if (!parts.length) {
		return sliceColumnSet(concatColumnSets([]), fromMs, toMs);
	}

	reportProgress({ loadingStep: 'merge' });
	await new Promise((resolve) => setImmediate(resolve));
	return concatColumnSets(parts);
}

export async function warmupDatasetDiskCache(db, request, { onProgress, config = loadConfig() } = {}) {
	const result = await loadBacktestColumnSetWithDiskCache(db, request, { onProgress, config });
	return {
		ok: true,
		ticks: result.length,
		events: result.events?.length ?? 0,
	};
}
