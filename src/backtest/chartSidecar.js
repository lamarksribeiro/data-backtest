import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

import { downsamplePoints } from '../utils/downsample.js';

const MAX_CHART_POINTS = 500;
const INDEX_CACHE_MAX = 8;
const READ_CHUNK_BYTES = 64 * 1024;

/** @type {Map<string, { jsonlMtimeMs: number, jsonlSize: number, index: Map<string, number> }>} */
const indexCache = new Map();
/** @type {Map<string, Promise<Map<string, number>>>} */
const indexBuildPromises = new Map();

export function chartSidecarPath(stateDbPath, runId) {
	const stateDir = path.dirname(stateDbPath);
	return path.join(stateDir, 'event-series', `run-${runId}.jsonl`);
}

export function chartSidecarIndexPath(jsonlPath) {
	return `${jsonlPath}.idx`;
}

export function ensureChartSidecarDir(stateDbPath) {
	const dir = path.join(path.dirname(stateDbPath), 'event-series');
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Limpa sidecar/índice no início de um run (evita resíduo de falha parcial). */
export function resetChartSidecarRun(jsonlPath) {
	const idxPath = chartSidecarIndexPath(jsonlPath);
	writeFileSync(jsonlPath, '', 'utf8');
	if (existsSync(idxPath)) unlinkSync(idxPath);
	indexCache.delete(jsonlPath);
	indexBuildPromises.delete(jsonlPath);
}

export function buildEventChartSeries(samples, side = 'UP') {
	const prefix = side === 'DOWN' ? 'down' : 'up';
	const underlying = [];
	const priceToBeat = [];
	const upPrice = [];
	const downPrice = [];
	const bid = [];
	const ask = [];
	for (const tick of samples || []) {
		const ts = tick.ts;
		underlying.push({ ts, value: num(tick.underlying_price ?? tick.underlyingPrice) });
		priceToBeat.push({ ts, value: num(tick.price_to_beat ?? tick.priceToBeat) });
		upPrice.push({ ts, value: num(tick.up_price ?? tick.upPrice) });
		downPrice.push({ ts, value: num(tick.down_price ?? tick.downPrice) });
		bid.push({ ts, value: num(tick[`${prefix}_best_bid`]) });
		ask.push({ ts, value: num(tick[`${prefix}_best_ask`]) });
	}
	const keepTs = [];
	return downsampleSeries({ underlying, priceToBeat, upPrice, downPrice, bid, ask }, keepTs);
}

function downsampleSeries(series, keepTs) {
	const base = series.underlying || [];
	if (base.length <= MAX_CHART_POINTS) {
		return { series, meta: { total_points: base.length, displayed_points: base.length, downsampled: false } };
	}
	const picked = downsamplePoints(base, { maxPoints: MAX_CHART_POINTS, keepTs });
	const pickedTs = new Set(picked.map((p) => p.ts));
	const pick = (arr) => (arr || []).filter((p) => pickedTs.has(p.ts));
	return {
		series: {
			underlying: pick(series.underlying),
			priceToBeat: pick(series.priceToBeat),
			upPrice: pick(series.upPrice),
			downPrice: pick(series.downPrice),
			bid: pick(series.bid),
			ask: pick(series.ask),
		},
		meta: { total_points: base.length, displayed_points: picked.length, downsampled: true },
	};
}

export function appendChartSidecarLine(filePath, conditionId, payload) {
	const line = JSON.stringify({ condition_id: conditionId, ...payload });
	const offset = existsSync(filePath) ? statSync(filePath).size : 0;
	appendFileSync(filePath, `${line}\n`, 'utf8');
	appendChartSidecarIndexEntry(chartSidecarIndexPath(filePath), String(conditionId), offset);
	invalidateIndexCache(filePath);
}

function appendChartSidecarIndexEntry(indexPath, conditionId, offset) {
	appendFileSync(indexPath, `${conditionId}\t${offset}\n`, 'utf8');
}

function invalidateIndexCache(jsonlPath) {
	indexCache.delete(jsonlPath);
}

function loadChartSidecarIndexFromFile(indexPath) {
	const content = readFileSync(indexPath, 'utf8');
	const index = new Map();
	for (const line of content.split('\n')) {
		if (!line) continue;
		const tab = line.indexOf('\t');
		if (tab < 0) continue;
		const id = line.slice(0, tab);
		const offset = Number(line.slice(tab + 1));
		if (id && Number.isFinite(offset)) index.set(id, offset);
	}
	return index;
}

function writeChartSidecarIndex(indexPath, index) {
	const lines = [];
	for (const [id, offset] of index) lines.push(`${id}\t${offset}`);
	const tmpPath = `${indexPath}.tmp`;
	writeFileSync(tmpPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
	renameSync(tmpPath, indexPath);
}

function indexLooksCurrent(jsonlPath, indexPath) {
	if (!existsSync(indexPath)) return false;
	const jsonlStat = statSync(jsonlPath);
	const indexStat = statSync(indexPath);
	return indexStat.mtimeMs >= jsonlStat.mtimeMs && indexStat.size > 0;
}

function rememberIndexCache(jsonlPath, index) {
	const jsonlStat = statSync(jsonlPath);
	if (indexCache.size >= INDEX_CACHE_MAX) {
		const oldest = indexCache.keys().next().value;
		indexCache.delete(oldest);
	}
	indexCache.set(jsonlPath, {
		jsonlMtimeMs: jsonlStat.mtimeMs,
		jsonlSize: jsonlStat.size,
		index,
	});
}

async function loadOrBuildChartSidecarIndex(jsonlPath) {
	const jsonlStat = statSync(jsonlPath);
	const cached = indexCache.get(jsonlPath);
	if (cached && cached.jsonlMtimeMs === jsonlStat.mtimeMs && cached.jsonlSize === jsonlStat.size) {
		return cached.index;
	}

	const indexPath = chartSidecarIndexPath(jsonlPath);
	if (indexLooksCurrent(jsonlPath, indexPath)) {
		const index = loadChartSidecarIndexFromFile(indexPath);
		rememberIndexCache(jsonlPath, index);
		return index;
	}

	let pending = indexBuildPromises.get(jsonlPath);
	if (!pending) {
		pending = buildChartSidecarIndex(jsonlPath).finally(() => indexBuildPromises.delete(jsonlPath));
		indexBuildPromises.set(jsonlPath, pending);
	}
	const index = await pending;
	rememberIndexCache(jsonlPath, index);
	return index;
}

async function buildChartSidecarIndex(jsonlPath) {
	const index = new Map();
	let byteOffset = 0;
	const stream = createReadStream(jsonlPath, { encoding: 'utf8' });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of rl) {
			const trimmed = line.trim();
			if (trimmed) {
				try {
					const row = JSON.parse(trimmed);
					if (row.condition_id != null) index.set(String(row.condition_id), byteOffset);
				} catch {
					// skip bad lines
				}
			}
			byteOffset += Buffer.byteLength(line, 'utf8') + 1;
		}
	} finally {
		rl.close();
		stream.destroy();
	}
	writeChartSidecarIndex(chartSidecarIndexPath(jsonlPath), index);
	return index;
}

function readJsonlLineAtOffset(filePath, offset) {
	const fd = openSync(filePath, 'r');
	try {
		let collected = '';
		let pos = offset;
		const buf = Buffer.alloc(READ_CHUNK_BYTES);
		while (true) {
			const bytesRead = readSync(fd, buf, 0, READ_CHUNK_BYTES, pos);
			if (bytesRead <= 0) break;
			const slice = buf.subarray(0, bytesRead).toString('utf8');
			const newlineAt = slice.indexOf('\n');
			if (newlineAt >= 0) {
				collected += slice.slice(0, newlineAt);
				break;
			}
			collected += slice;
			pos += bytesRead;
		}
		const trimmed = collected.trim();
		if (!trimmed) return null;
		return JSON.parse(trimmed);
	} finally {
		closeSync(fd);
	}
}

async function readChartSidecarForEventStreaming(filePath, conditionId) {
	const target = String(conditionId);
	const stream = createReadStream(filePath, { encoding: 'utf8' });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of rl) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const row = JSON.parse(trimmed);
				if (String(row.condition_id) === target) return row;
			} catch {
				// skip bad lines
			}
		}
	} finally {
		rl.close();
		stream.destroy();
	}
	return null;
}

/** Lê série de um evento via índice de offset (O(1) após índice carregado). */
export async function readChartSidecarForEvent(filePath, conditionId) {
	if (!existsSync(filePath)) return null;
	const target = String(conditionId);
	const index = await loadOrBuildChartSidecarIndex(filePath);
	const offset = index.get(target);
	if (offset != null) {
		try {
			const row = readJsonlLineAtOffset(filePath, offset);
			if (row && String(row.condition_id) === target) return row;
		} catch {
			// índice desatualizado — reconstrói na próxima leitura
			invalidateIndexCache(filePath);
			if (existsSync(chartSidecarIndexPath(filePath))) unlinkSync(chartSidecarIndexPath(filePath));
		}
	}
	return readChartSidecarForEventStreaming(filePath, conditionId);
}

export function clearChartSidecarCache() {
	indexCache.clear();
}

const RUN_SIDECAR_RE = /^run-(\d+)\.jsonl$/;

export function eventSeriesDir(stateDbPath) {
	return path.join(path.dirname(stateDbPath), 'event-series');
}

export function removeChartSidecarRun(stateDbPath, runId) {
	const jsonlPath = chartSidecarPath(stateDbPath, runId);
	let removedBytes = 0;
	let removedFiles = 0;
	for (const filePath of [jsonlPath, chartSidecarIndexPath(jsonlPath)]) {
		if (!existsSync(filePath)) continue;
		removedBytes += statSync(filePath).size;
		removedFiles += 1;
		unlinkSync(filePath);
	}
	indexCache.delete(jsonlPath);
	indexBuildPromises.delete(jsonlPath);
	return { removed_files: removedFiles, removed_bytes: removedBytes };
}

export function scanChartSidecarDir(stateDbPath) {
	const dir = eventSeriesDir(stateDbPath);
	if (!existsSync(dir)) {
		return { total_bytes: 0, total_files: 0, run_files: 0, runs: [] };
	}

	const runs = [];
	let totalBytes = 0;
	let totalFiles = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const match = entry.name.match(RUN_SIDECAR_RE);
		if (!match) continue;
		const jsonlPath = path.join(dir, entry.name);
		const idxPath = chartSidecarIndexPath(jsonlPath);
		let bytes = statSync(jsonlPath).size;
		totalFiles += 1;
		if (existsSync(idxPath)) {
			bytes += statSync(idxPath).size;
			totalFiles += 1;
		}
		totalBytes += bytes;
		runs.push({ run_id: Number(match[1]), bytes });
	}
	runs.sort((a, b) => a.run_id - b.run_id);
	return { total_bytes: totalBytes, total_files: totalFiles, run_files: runs.length, runs };
}

export function pruneOrphanChartSidecars(stateDbPath, db, { dryRun = false } = {}) {
	const scan = scanChartSidecarDir(stateDbPath);
	if (!scan.run_files) {
		return { dry_run: dryRun, removed_files: 0, removed_bytes: 0, orphan_runs: [] };
	}

	const activeIds = new Set(
		db.prepare('SELECT id FROM backtest_runs').all().map((row) => Number(row.id)),
	);
	const orphanRuns = scan.runs.filter((row) => !activeIds.has(row.run_id));
	let removedFiles = 0;
	let removedBytes = 0;

	if (!dryRun) {
		for (const row of orphanRuns) {
			const result = removeChartSidecarRun(stateDbPath, row.run_id);
			removedFiles += result.removed_files;
			removedBytes += result.removed_bytes;
		}
	} else {
		for (const row of orphanRuns) {
			removedFiles += existsSync(chartSidecarPath(stateDbPath, row.run_id)) ? 1 : 0;
			const idxPath = chartSidecarIndexPath(chartSidecarPath(stateDbPath, row.run_id));
			if (existsSync(idxPath)) removedFiles += 1;
			removedBytes += row.bytes;
		}
	}

	return {
		dry_run: dryRun,
		removed_files: removedFiles,
		removed_bytes: removedBytes,
		orphan_runs: orphanRuns.map((row) => row.run_id),
	};
}

function num(value) {
	if (value == null) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}
