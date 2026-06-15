import { clearAllDatasetCaches } from './datasetCache.js';
import { closeSharedDuckInstance } from '../query/duckdbPool.js';

/** Libera caches e DuckDB após um backtest para ajudar o GC (workers/subprocessos). */
export async function releaseBacktestResources() {
	clearAllDatasetCaches();
	await closeSharedDuckInstance();
	if (typeof global.gc === 'function') global.gc();
}
