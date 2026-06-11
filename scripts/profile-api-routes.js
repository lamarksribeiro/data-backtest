/**
 * One-off profiler for studio/data API hot paths.
 * Usage: node scripts/profile-api-routes.js [--synthetic]
 */
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

import { loadConfig } from '../src/config.js';
import { openStateDatabase } from '../src/state/sqlite.js';
import { createApiServer } from '../src/api/server.js';
import { createTestAuthService } from '../tests/testAuth.js';
import { listBacktestRuns, getBacktestRun } from '../src/state/backtestRuns.js';
import { listEventTraces, getEventTrace, getChartData } from '../src/backtestStudio/state/eventTraces.js';
import { getDataCoverage } from '../src/query/coverageUi.js';
import { listManifest, manifestStats } from '../src/state/manifest.js';
import { listStrategiesWithStats } from '../src/backtestStudio/state/strategyStats.js';
import { getRunAnalysis } from '../src/backtest/analysis.js';

const synthetic = process.argv.includes('--synthetic');

function benchSync(name, fn, n = 20) {
	for (let i = 0; i < 3; i++) fn();
	const times = [];
	for (let i = 0; i < n; i++) {
		const t0 = performance.now();
		fn();
		times.push(performance.now() - t0);
	}
	times.sort((a, b) => a - b);
	return {
		name,
		p50: +times[Math.floor(times.length * 0.5)].toFixed(2),
		p95: +times[Math.floor(times.length * 0.95)].toFixed(2),
	};
}

async function benchAsync(name, fn, n = 12) {
	for (let i = 0; i < 2; i++) await fn();
	const times = [];
	for (let i = 0; i < n; i++) {
		const t0 = performance.now();
		await fn();
		times.push(performance.now() - t0);
	}
	times.sort((a, b) => a - b);
	return {
		name,
		p50: +times[Math.floor(times.length * 0.5)].toFixed(2),
		p95: +times[Math.floor(times.length * 0.95)].toFixed(2),
	};
}

function seedSyntheticDb(db, eventCount = 3000) {
	const sampleOrders = JSON.stringify(
		Array.from({ length: 8 }, (_, i) => ({
			type: 'entry',
			ts: `2026-01-01T12:0${i}:00.000Z`,
			price: 0.45,
			size: 10,
		})),
	);
	const sampleLogs = JSON.stringify(
		Array.from({ length: 120 }, (_, i) => ({
			ts: `2026-01-01T12:${String(i % 60).padStart(2, '0')}:00.000Z`,
			msg: `tick eval ${i}`,
		})),
	);
	const sampleMarks = JSON.stringify(
		Array.from({ length: 20 }, (_, i) => ({
			ts: `2026-01-01T12:${String(i).padStart(2, '0')}:00.000Z`,
			kind: 'mark',
		})),
	);
	const sampleMetrics = JSON.stringify({ edge: [{ ts: '2026-01-01T12:00:00.000Z', value: 0.1 }] });
	const sampleSummary = JSON.stringify({ eventId: 'x', diagnostics: { lastNoEntryReason: null }, exits: [] });

	db.prepare(`
    INSERT INTO backtest_runs (
      strategy, underlying, interval, from_ts, to_ts, batch_size,
      params_json, summary_json, result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('TEST', 'BTC', '5m', '2026-01-01', '2026-01-08', 10000, '{}', '{"totalPnl":0}', '{"equity":[]}');
	const runId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);

	const insert = db.prepare(`
    INSERT INTO backtest_event_traces (
      run_id, condition_id, event_start, event_end, final_pnl, result,
      summary_json, orders_json, logs_json, marks_json, metrics_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

	db.exec('BEGIN');
	for (let i = 0; i < eventCount; i++) {
		const day = 1 + (i % 7);
		const ts = `2026-01-0${day}T12:00:00.000Z`;
		insert.run(
			runId,
			`0x${String(i).padStart(64, 'a')}`,
			ts,
			ts.replace('T12:00', 'T12:05'),
			(i % 50) - 25,
			i % 3 === 0 ? 'win' : 'loss',
			sampleSummary,
			sampleOrders,
			sampleLogs,
			sampleMarks,
			sampleMetrics,
		);
	}
	db.exec('COMMIT');
	return runId;
}

async function main() {
	let cleanupDir = null;
	let config;
	let db;

	if (synthetic) {
		cleanupDir = mkdtempSync(path.join(os.tmpdir(), 'data-backtest-profile-'));
		config = {
			...loadConfig(),
			stateDbPath: path.join(cleanupDir, 'bench.db'),
			lakeRoot: path.join(cleanupDir, 'lake'),
			TEST_MODE: true,
			NODE_ENV: 'test',
		};
		db = openStateDatabase(config.stateDbPath);
		seedSyntheticDb(db, 3000);
	} else {
		config = { ...loadConfig(), TEST_MODE: true, NODE_ENV: 'test' };
		db = openStateDatabase(config.stateDbPath);
	}

	const run = db.prepare('SELECT id FROM backtest_runs ORDER BY id DESC LIMIT 1').get();
	if (!run) {
		console.log('Nenhum run no banco. Use --synthetic ou rode um backtest primeiro.');
		process.exit(1);
	}

	const event = db.prepare(`
    SELECT id, condition_id, chart_series_path,
      length(orders_json) + length(logs_json) + length(marks_json) +
      length(metrics_json) + length(summary_json) AS blob_bytes
    FROM backtest_event_traces
    WHERE run_id = ?
    ORDER BY blob_bytes DESC, id ASC
    LIMIT 1
  `).get(run.id);

	const scale = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM backtest_runs) AS runs,
      (SELECT COUNT(*) FROM backtest_event_traces WHERE run_id = ?) AS events_in_run,
      (SELECT SUM(length(orders_json)+length(logs_json)+length(marks_json)+length(metrics_json)+length(summary_json))
         FROM backtest_event_traces WHERE run_id = ?) AS trace_blob_bytes,
      (SELECT length(result_json) FROM backtest_runs WHERE id = ?) AS result_json_bytes
  `).get(run.id, run.id, run.id);

	console.log('Dataset:', JSON.stringify({ runId: run.id, eventId: event?.id, ...scale, mode: synthetic ? 'synthetic' : 'local' }, null, 2));

	const direct = [
		benchSync('sqlite listBacktestRuns(50)', () => listBacktestRuns(db, { limit: 50 })),
		benchSync('sqlite getBacktestRun slim', () => getBacktestRun(db, run.id, { includeResult: false, includeEquity: false })),
		benchSync('sqlite getBacktestRun +equity', () => getBacktestRun(db, run.id, { includeResult: false, includeEquity: true })),
		benchSync('sqlite listEventTraces(100)', () => listEventTraces(db, run.id, { limit: 100 })),
		benchSync('sqlite listEventTraces(500)', () => listEventTraces(db, run.id, { limit: 500 })),
		benchSync('sqlite getRunAnalysis', () => getRunAnalysis(db, run.id)),
		benchSync('sqlite getDataCoverage', () => getDataCoverage(db, new URLSearchParams({
			underlying: 'BTC', interval: '5m', book_depth: '25', from: '2026-01-01', to: '2026-06-11',
		}), config)),
		benchSync('sqlite manifestStats', () => manifestStats(db)),
	];

	if (event) {
		direct.push(benchSync('sqlite getEventTrace detail', () => getEventTrace(db, run.id, event.id, { stateDbPath: config.stateDbPath })));
		if (!synthetic) {
			const runObj = getBacktestRun(db, run.id, { includeResult: false, includeEquity: false });
			direct.push(await benchAsync('duckdb getChartData', () => getChartData(db, config, runObj, event.condition_id)));
		}
	}

	console.log('\nFunções diretas (ms):');
	console.table(direct.sort((a, b) => b.p50 - a.p50));

	const authService = createTestAuthService(db, config);
	const server = createApiServer({ config, db, authService });
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const base = `http://127.0.0.1:${server.address().port}`;

	async function httpBench(route) {
		for (let i = 0; i < 2; i++) await fetch(base + route);
		const times = [];
		let bytes = 0;
		for (let i = 0; i < 12; i++) {
			const t0 = performance.now();
			const res = await fetch(base + route);
			const body = await res.arrayBuffer();
			times.push(performance.now() - t0);
			if (i === 0) bytes = body.byteLength;
		}
		times.sort((a, b) => a - b);
		return {
			route,
			p50: +times[Math.floor(times.length * 0.5)].toFixed(2),
			p95: +times[Math.floor(times.length * 0.95)].toFixed(2),
			kb: Math.round(bytes / 1024),
		};
	}

	const routes = [
		'/api/backtest/runs?limit=50',
		`/api/backtest/runs/${run.id}?slim=1&equity=1`,
		`/api/backtest/runs/${run.id}/events?limit=100`,
		`/api/backtest/runs/${run.id}/analysis`,
		'/api/data/coverage?underlying=BTC&interval=5m&book_depth=25&from=2026-01-01&to=2026-06-11',
	];
	if (event) {
		routes.push(`/api/backtest/runs/${run.id}/events/${event.id}`);
		if (!synthetic) {
			routes.push(`/api/backtest/runs/${run.id}/chart-data?condition_id=${encodeURIComponent(event.condition_id)}`);
		}
	}

	const http = [];
	for (const route of routes) http.push(await httpBench(route));

	console.log('\nHTTP (ms, KB resposta):');
	console.table(http.sort((a, b) => b.p50 - a.p50));

	const t0 = performance.now();
	await fetch(base + `/api/backtest/runs/${run.id}?slim=1&equity=1`);
	await fetch(base + `/api/backtest/runs/${run.id}/events?limit=100`);
	await fetch(base + `/api/backtest/runs/${run.id}/analysis`);
	console.log(`\nFluxo Estúdio (abrir run): ${(performance.now() - t0).toFixed(2)} ms`);

	if (event) {
		const t1 = performance.now();
		await fetch(base + `/api/backtest/runs/${run.id}/events/${event.id}`);
		if (!synthetic) {
			await fetch(base + `/api/backtest/runs/${run.id}/chart-data?condition_id=${encodeURIComponent(event.condition_id)}`);
			console.log(`Fluxo Estúdio (abrir 1 evento + gráfico): ${(performance.now() - t1).toFixed(2)} ms`);
		} else {
			console.log(`Fluxo Estúdio (abrir 1 evento, sem gráfico): ${(performance.now() - t1).toFixed(2)} ms`);
		}
	}

	await new Promise((resolve) => server.close(resolve));
	if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true });
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
