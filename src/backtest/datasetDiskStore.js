import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../config.js';
import {
	columnSignatureHash,
	deletePartitionFiles,
	partitionBinPath,
	partitionMetaPath,
	readPartitionMeta,
} from './columnSetDisk.js';

export function datasetDiskCacheRoot(config = loadConfig()) {
	return config.datasetDiskCacheDir
		?? path.join(path.dirname(config.stateDbPath), 'dataset-cache');
}

export function partitionCacheDir(config, { dataset, underlying, interval, bookDepth, colsHash }) {
	const depthLabel = bookDepth == null ? 'none' : String(bookDepth);
	return path.join(
		datasetDiskCacheRoot(config),
		dataset,
		`underlying=${underlying}`,
		`interval=${interval}`,
		`book_depth=${depthLabel}`,
		`cols=${colsHash}`,
	);
}

export function resolveColsHash(selectSql) {
	return columnSignatureHash(selectSql);
}

export function partitionPaths(config, key, dt) {
	const dir = partitionCacheDir(config, key);
	return {
		dir,
		binPath: partitionBinPath(dir, dt),
		metaPath: partitionMetaPath(dir, dt),
	};
}

export function isPartitionCacheValid(meta, manifestRow, binPath) {
	if (!meta || !manifestRow) return false;
	if (!['valid', 'accepted'].includes(manifestRow.status)) return false;
	if (meta.source_fingerprint !== (manifestRow.source_fingerprint ?? null)) return false;
	if (meta.active_path !== (manifestRow.active_path ?? null)) return false;
	return existsSync(binPath);
}

export function readValidPartitionMeta(binPath, metaPath, manifestRow) {
	if (!existsSync(binPath) || !existsSync(metaPath)) return null;
	const meta = readPartitionMeta(metaPath);
	if (!meta || !isPartitionCacheValid(meta, manifestRow, binPath)) return null;
	if (meta.rows === 0 && (manifestRow?.rows ?? 0) > 0) return null;
	return meta;
}

export function scanDatasetDiskCache(config = loadConfig()) {
	const root = datasetDiskCacheRoot(config);
	if (!existsSync(root)) {
		return { total_bytes: 0, total_files: 0, groups: [] };
	}

	const groups = new Map();
	let totalBytes = 0;
	let totalFiles = 0;

	walkFiles(root, (filePath) => {
		if (!filePath.endsWith('.columns.bin') && !filePath.endsWith('.meta.json')) return;
		const stat = statSync(filePath);
		totalBytes += stat.size;
		totalFiles += 1;

		const rel = path.relative(root, filePath).split(path.sep);
		const dataset = rel[0] || '?';
		const underlying = parseKeySegment(rel[1], 'underlying');
		const interval = parseKeySegment(rel[2], 'interval');
		const bookDepth = parseKeySegment(rel[3], 'book_depth');
		const cols = parseKeySegment(rel[4], 'cols');
		const groupKey = `${dataset}|${underlying}|${interval}|${bookDepth}|${cols}`;
		if (!groups.has(groupKey)) {
			groups.set(groupKey, {
				dataset,
				underlying,
				interval,
				book_depth: bookDepth === 'none' ? null : Number.parseInt(bookDepth, 10) || bookDepth,
				cols,
				files: 0,
				bytes: 0,
				days: new Set(),
				oldest_dt: null,
				newest_dt: null,
			});
		}
		const group = groups.get(groupKey);
		group.files += 1;
		group.bytes += stat.size;
		const dtMatch = path.basename(filePath).match(/^dt=(\d{4}-\d{2}-\d{2})\./);
		if (dtMatch) {
			group.days.add(dtMatch[1]);
			if (!group.oldest_dt || dtMatch[1] < group.oldest_dt) group.oldest_dt = dtMatch[1];
			if (!group.newest_dt || dtMatch[1] > group.newest_dt) group.newest_dt = dtMatch[1];
		}
	});

	const groupList = [...groups.values()].map((g) => ({
		...g,
		days_count: g.days.size,
		days: undefined,
	}));
	return { total_bytes: totalBytes, total_files: totalFiles, groups: groupList };
}

function parseKeySegment(segment, prefix) {
	if (!segment?.startsWith(`${prefix}=`)) return '?';
	return segment.slice(prefix.length + 1);
}

function walkFiles(dir, onFile) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkFiles(full, onFile);
		else onFile(full);
	}
}

export function clearDatasetDiskCache(config = loadConfig(), filters = {}) {
	const root = datasetDiskCacheRoot(config);
	if (!existsSync(root)) return { removed_files: 0, removed_bytes: 0 };

	const { underlying, interval, bookDepth, dataset } = filters;
	let removedFiles = 0;
	let removedBytes = 0;

	if (!underlying && !interval && bookDepth == null && !dataset) {
		walkFiles(root, (filePath) => {
			if (filePath.endsWith('.columns.bin') || filePath.endsWith('.meta.json')) {
				removedBytes += statSync(filePath).size;
				removedFiles += 1;
				unlinkSync(filePath);
			}
		});
		cleanupEmptyDirs(root);
		return { removed_files: removedFiles, removed_bytes: removedBytes };
	}

	walkFiles(root, (filePath) => {
		const rel = path.relative(root, filePath);
		if (underlying && !rel.includes(`underlying=${underlying}`)) return;
		if (interval && !rel.includes(`interval=${interval}`)) return;
		if (dataset && !rel.startsWith(`${dataset}${path.sep}`)) return;
		if (bookDepth != null) {
			const depthLabel = bookDepth == null ? 'none' : String(bookDepth);
			if (!rel.includes(`book_depth=${depthLabel}`)) return;
		}
		if (filePath.endsWith('.columns.bin') || filePath.endsWith('.meta.json')) {
			removedBytes += statSync(filePath).size;
			removedFiles += 1;
			unlinkSync(filePath);
		}
	});
	cleanupEmptyDirs(root);
	return { removed_files: removedFiles, removed_bytes: removedBytes };
}

function cleanupEmptyDirs(dir) {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const full = path.join(dir, entry.name);
		cleanupEmptyDirs(full);
		try {
			if (!readdirSync(full).length) rmSync(full, { recursive: true });
		} catch { /* ignore */ }
	}
}

export function evictDatasetDiskCacheIfNeeded(config = loadConfig()) {
	const maxGb = config.datasetDiskCacheMaxGb;
	if (!maxGb || maxGb <= 0) return { evicted_files: 0, evicted_bytes: 0 };

	const root = datasetDiskCacheRoot(config);
	if (!existsSync(root)) return { evicted_files: 0, evicted_bytes: 0 };

	const maxBytes = maxGb * 1024 * 1024 * 1024;
	const entries = [];
	walkFiles(root, (filePath) => {
		if (!filePath.endsWith('.meta.json')) return;
		const metaPath = filePath;
		const binPath = metaPath.replace(/\.meta\.json$/, '.columns.bin');
		try {
			const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
			const binSize = existsSync(binPath) ? statSync(binPath).size : 0;
			const metaSize = statSync(metaPath).size;
			entries.push({
				metaPath,
				binPath,
				built_at: meta.built_at || '1970-01-01T00:00:00.000Z',
				bytes: binSize + metaSize,
			});
		} catch { /* skip */ }
	});

	let total = entries.reduce((sum, e) => sum + e.bytes, 0);
	if (total <= maxBytes) return { evicted_files: 0, evicted_bytes: 0 };

	entries.sort((a, b) => String(a.built_at).localeCompare(String(b.built_at)));
	let evictedFiles = 0;
	let evictedBytes = 0;
	for (const entry of entries) {
		if (total <= maxBytes) break;
		deletePartitionFiles(entry.binPath, entry.metaPath);
		evictedFiles += 2;
		evictedBytes += entry.bytes;
		total -= entry.bytes;
	}
	cleanupEmptyDirs(root);
	return { evicted_files: evictedFiles, evicted_bytes: evictedBytes };
}

export { deletePartitionFiles };
