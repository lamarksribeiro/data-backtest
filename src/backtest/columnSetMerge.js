import { buildEventIndex } from './columnStore.js';

export function concatColumnSets(parts) {
	const valid = (parts || []).filter((p) => p && p.length > 0);
	if (!valid.length) {
		return emptyColumnSet();
	}
	if (valid.length === 1) return valid[0];

	const totalLength = valid.reduce((sum, part) => sum + part.length, 0);
	const columnNames = new Set();
	const codeNames = new Set();
	const flagNames = new Set();
	for (const part of valid) {
		for (const name of part.columns.keys()) columnNames.add(name);
		for (const name of part.codes.keys()) codeNames.add(name);
		for (const name of part.flags.keys()) flagNames.add(name);
	}

	const columns = new Map();
	for (const name of columnNames) {
		columns.set(name, new Float64Array(totalLength));
	}
	const codes = new Map();
	for (const name of codeNames) {
		codes.set(name, new Int32Array(totalLength));
	}
	const flags = new Map();
	for (const name of flagNames) {
		flags.set(name, new Uint8Array(totalLength));
	}

	const dictionaries = new Map();
	const dictIndexes = new Map();
	for (const name of codeNames) {
		dictionaries.set(name, []);
		dictIndexes.set(name, new Map());
	}

	let offset = 0;
	for (const part of valid) {
		for (const name of columnNames) {
			const src = part.columns.get(name);
			const dst = columns.get(name);
			if (src) dst.set(src, offset);
			else dst.fill(Number.NaN, offset, offset + part.length);
		}
		for (const name of codeNames) {
			const src = part.codes.get(name);
			const dst = codes.get(name);
			const dict = part.dictionaries.get(name) || [];
			if (!src) {
				dst.fill(0, offset, offset + part.length);
				continue;
			}
			const mergedDict = dictionaries.get(name);
			const indexMap = dictIndexes.get(name);
			for (let i = 0; i < part.length; i += 1) {
				const code = src[i];
				const value = dict[code] ?? '';
				let mergedCode = indexMap.get(value);
				if (mergedCode === undefined) {
					mergedCode = mergedDict.length;
					mergedDict.push(value);
					indexMap.set(value, mergedCode);
				}
				dst[offset + i] = mergedCode;
			}
		}
		for (const name of flagNames) {
			const src = part.flags.get(name);
			const dst = flags.get(name);
			if (src) dst.set(src, offset);
			else dst.fill(0, offset, offset + part.length);
		}
		offset += part.length;
	}

	return {
		length: totalLength,
		columns,
		codes,
		flags,
		dictionaries,
		events: buildEventIndex({ length: totalLength, codes, columns, dictionaries }),
	};
}

export function sliceColumnSet(columnSet, fromMs, toMs) {
	if (!columnSet?.length) return emptyColumnSet();
	const tsCol = columnSet.columns.get('_ts_ms');
	if (!tsCol) return columnSet;

	const start = findStartIndex(tsCol, columnSet.length, fromMs);
	const end = findEndIndex(tsCol, columnSet.length, toMs);
	if (start >= end) return emptyColumnSet();

	const length = end - start;
	const columns = new Map();
	for (const [name, arr] of columnSet.columns.entries()) {
		columns.set(name, arr.subarray(start, end));
	}
	const codes = new Map();
	for (const [name, arr] of columnSet.codes.entries()) {
		codes.set(name, arr.subarray(start, end));
	}
	const flags = new Map();
	for (const [name, arr] of columnSet.flags.entries()) {
		flags.set(name, arr.subarray(start, end));
	}

	return {
		length,
		columns,
		codes,
		flags,
		dictionaries: columnSet.dictionaries,
		events: buildEventIndex({ length, codes, columns, dictionaries: columnSet.dictionaries }),
	};
}

function findStartIndex(tsCol, length, fromMs) {
	let lo = 0;
	let hi = length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (tsCol[mid] < fromMs) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function findEndIndex(tsCol, length, toMs) {
	let lo = 0;
	let hi = length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (tsCol[mid] < toMs) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function emptyColumnSet() {
	return {
		length: 0,
		columns: new Map(),
		codes: new Map(),
		flags: new Map(),
		dictionaries: new Map(),
		events: [],
	};
}
