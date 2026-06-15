import { resolveLakeActivePath } from '../lake/paths.js';
import { loadConfig } from '../config.js';

export function findManifestPartitionRow(db, request, dt) {
	const params = [request.dataset, request.underlying, request.interval, dt];
	let sql = `
    SELECT * FROM lake_manifest
    WHERE dataset = ?
      AND underlying = ?
      AND interval = ?
      AND dt = ?`;

	if (request.resolution) {
		params.push(request.resolution);
		sql += ' AND resolution = ?';
	} else {
		sql += ' AND resolution IS NULL';
	}

	if (request.bookDepth != null) {
		params.push(request.bookDepth);
		sql += ' AND book_depth = ?';
	} else {
		sql += ' AND book_depth IS NULL';
	}

	sql += ' LIMIT 1';
	return db.prepare(sql).get(...params) ?? null;
}

export function availabilityForSinglePartition(db, request, dt, config = loadConfig()) {
	const row = findManifestPartitionRow(db, request, dt);
	if (!row || !['valid', 'accepted'].includes(row.status) || !row.active_path) {
		return null;
	}
	const lakeRoot = request.lakeRoot ?? config.lakeRoot;
	return {
		ok: true,
		files: [resolveLakeActivePath(lakeRoot, row.active_path)],
		partitions: [{
			dt,
			status: row.status,
			usable: true,
			rows: row.rows ?? null,
			active_path: row.active_path,
			source_fingerprint: row.source_fingerprint ?? null,
		}],
	};
}
