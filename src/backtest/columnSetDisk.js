import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildEventIndex } from './columnStore.js';

const MAGIC = Buffer.from('GLCS');
const VERSION = 1;

const KIND_FLOAT = 0;
const KIND_CODE = 1;
const KIND_FLAG = 2;

export function columnSignatureHash(selectSql) {
	return createHash('sha256').update(String(selectSql || '')).digest('hex').slice(0, 16);
}

export function partitionBinPath(dir, dt) {
	return path.join(dir, `dt=${dt}.columns.bin`);
}

export function partitionMetaPath(dir, dt) {
	return path.join(dir, `dt=${dt}.meta.json`);
}

export function writeColumnSetPartition({ binPath, metaPath, columnSet, meta }) {
	mkdirSync(path.dirname(binPath), { recursive: true });
	const tmpBin = `${binPath}.tmp`;
	const tmpMeta = `${metaPath}.tmp`;
	const bin = serializeColumnSet(columnSet);
	writeFileSync(tmpBin, bin);
	writeFileSync(tmpMeta, `${JSON.stringify({
		version: 1,
		...meta,
		rows: columnSet.length,
		bytes: bin.byteLength,
		built_at: new Date().toISOString(),
	})}\n`, 'utf8');
	renameSync(tmpBin, binPath);
	renameSync(tmpMeta, metaPath);
	return bin.byteLength;
}

export function readColumnSetPartition(binPath) {
	if (!existsSync(binPath)) return null;
	return deserializeColumnSet(readFileSync(binPath));
}

export function readPartitionMeta(metaPath) {
	if (!existsSync(metaPath)) return null;
	try {
		return JSON.parse(readFileSync(metaPath, 'utf8'));
	} catch {
		return null;
	}
}

export function serializeColumnSet(columnSet) {
	const rowCount = columnSet.length;
	const columnEntries = [];
	const codeEntries = [];
	const flagEntries = [];
	const buffers = [];

	const dictObj = {};
	for (const [name, dict] of columnSet.dictionaries.entries()) {
		dictObj[name] = dict;
	}
	const dictJson = Buffer.from(JSON.stringify(dictObj), 'utf8');

	for (const [name, arr] of columnSet.columns.entries()) {
		const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
		columnEntries.push({ name, kind: KIND_FLOAT, offset: sumBufferLength(buffers), byteLength: buf.byteLength });
		buffers.push(buf);
	}
	for (const [name, arr] of columnSet.codes.entries()) {
		const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
		codeEntries.push({ name, kind: KIND_CODE, offset: sumBufferLength(buffers), byteLength: buf.byteLength });
		buffers.push(buf);
	}
	for (const [name, arr] of columnSet.flags.entries()) {
		const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
		flagEntries.push({ name, kind: KIND_FLAG, offset: sumBufferLength(buffers), byteLength: buf.byteLength });
		buffers.push(buf);
	}

	const schemaEntries = [...columnEntries, ...codeEntries, ...flagEntries];
	const headerSize = 16 + schemaEntries.reduce((sum, e) => sum + 2 + Buffer.byteLength(e.name, 'utf8') + 1 + 4 + 4, 0) + 4;
	const payloadSize = sumBufferLength(buffers);
	const out = Buffer.alloc(headerSize + dictJson.byteLength + payloadSize);

	let pos = 0;
	MAGIC.copy(out, pos); pos += 4;
	out.writeUInt32LE(VERSION, pos); pos += 4;
	out.writeUInt32LE(rowCount, pos); pos += 4;
	out.writeUInt32LE(schemaEntries.length, pos); pos += 4;

	for (const entry of schemaEntries) {
		const nameBuf = Buffer.from(entry.name, 'utf8');
		out.writeUInt16LE(nameBuf.byteLength, pos); pos += 2;
		nameBuf.copy(out, pos); pos += nameBuf.byteLength;
		out.writeUInt8(entry.kind, pos); pos += 1;
		out.writeUInt32LE(entry.offset, pos); pos += 4;
		out.writeUInt32LE(entry.byteLength, pos); pos += 4;
	}

	out.writeUInt32LE(dictJson.byteLength, pos); pos += 4;
	dictJson.copy(out, pos); pos += dictJson.byteLength;

	const payloadStart = pos;
	let payloadOffset = payloadStart;
	for (const buf of buffers) {
		buf.copy(out, payloadOffset);
		payloadOffset += buf.byteLength;
	}

	return out;
}

function sumBufferLength(buffers) {
	return buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
}

function float64FromBytes(bytes) {
	const length = bytes.byteLength / 8;
	const out = new Float64Array(length);
	out.set(new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
	return out;
}

function int32FromBytes(bytes) {
	const length = bytes.byteLength / 4;
	const out = new Int32Array(length);
	out.set(new Int32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
	return out;
}

function uint8FromBytes(bytes) {
	const out = new Uint8Array(bytes.byteLength);
	out.set(bytes);
	return out;
}

export function deserializeColumnSet(buffer) {
	let pos = 0;
	if (buffer.byteLength < 16) throw new Error('Invalid column set blob: too small');
	if (buffer.subarray(0, 4).compare(MAGIC) !== 0) throw new Error('Invalid column set blob: bad magic');
	const version = buffer.readUInt32LE(4);
	if (version !== VERSION) throw new Error(`Unsupported column set version: ${version}`);
	const rowCount = buffer.readUInt32LE(8);
	const schemaCount = buffer.readUInt32LE(12);
	pos = 16;

	const columns = new Map();
	const codes = new Map();
	const flags = new Map();
	const schemaEntries = [];

	for (let i = 0; i < schemaCount; i += 1) {
		const nameLen = buffer.readUInt16LE(pos); pos += 2;
		const name = buffer.subarray(pos, pos + nameLen).toString('utf8'); pos += nameLen;
		const kind = buffer.readUInt8(pos); pos += 1;
		const offset = buffer.readUInt32LE(pos); pos += 4;
		const byteLength = buffer.readUInt32LE(pos); pos += 4;
		schemaEntries.push({ name, kind, offset, byteLength });
	}

	const dictJsonLen = buffer.readUInt32LE(pos); pos += 4;
	const dictJson = buffer.subarray(pos, pos + dictJsonLen); pos += dictJsonLen;
	const payloadStart = pos;
	const dictObj = JSON.parse(dictJson.toString('utf8'));
	const dictionaries = new Map(Object.entries(dictObj));

	for (const entry of schemaEntries) {
		const absStart = payloadStart + entry.offset;
		const absEnd = absStart + entry.byteLength;
		const raw = buffer.subarray(absStart, absEnd);
		if (entry.kind === KIND_FLOAT) {
			columns.set(entry.name, float64FromBytes(raw));
		} else if (entry.kind === KIND_CODE) {
			codes.set(entry.name, int32FromBytes(raw));
		} else if (entry.kind === KIND_FLAG) {
			flags.set(entry.name, uint8FromBytes(raw));
		}
	}

	const columnSet = {
		length: rowCount,
		columns,
		codes,
		flags,
		dictionaries,
		events: buildEventIndex({ length: rowCount, codes, columns, dictionaries }),
	};
	return columnSet;
}

export function deletePartitionFiles(binPath, metaPath) {
	if (existsSync(binPath)) unlinkSync(binPath);
	if (existsSync(metaPath)) unlinkSync(metaPath);
}
