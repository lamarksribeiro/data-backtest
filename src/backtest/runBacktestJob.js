import { runBacktest } from './engine.js';
import {
	appendChartSidecarLine,
	buildEventChartSeries,
	chartSidecarPath,
	ensureChartSidecarDir,
	resetChartSidecarRun,
} from './chartSidecar.js';
import { openStateDatabase, closeStateDatabase } from '../state/sqlite.js';
import {
	completeBacktestRun,
	failBacktestRun,
} from '../state/backtestRuns.js';
import { appendEventTraceBatch } from '../backtestStudio/state/eventTraces.js';
import { releaseBacktestResources } from './releaseResources.js';

const FLUSH_BATCH_EVENTS = 200;

export async function runBacktestJob({
	stateDbPath,
	runId,
	request,
	startedAt,
	onProgress = null,
}) {
	const db = openStateDatabase(stateDbPath);
	const fastRun = Boolean(request?.fastRun);
	const sidecarFile = chartSidecarPath(stateDbPath, runId);
	ensureChartSidecarDir(stateDbPath);
	if (!fastRun) resetChartSidecarRun(sidecarFile);

	let pendingEvents = [];

	const flushTraces = () => {
		if (!pendingEvents.length) return;
		appendEventTraceBatch(db, runId, { events: pendingEvents });
		pendingEvents = [];
	};

	try {
		const backtestRequest = {
			...request,
			fastRun,
			onEventFinalized: fastRun
				? null
				: (eventRecord, samples) => {
					const side = eventRecord.positionType || 'UP';
					const { series, meta } = buildEventChartSeries(samples, side);
					appendChartSidecarLine(sidecarFile, eventRecord.eventId, { series, meta });
					pendingEvents.push(normalizeEventForTrace(runId, eventRecord, sidecarFile));
					if (pendingEvents.length >= FLUSH_BATCH_EVENTS) flushTraces();
				},
		};

		const result = await runBacktest(db, backtestRequest, { onProgress });
		flushTraces();

		const run = completeBacktestRun(db, runId, {
			request,
			result,
			strategyMeta: request.strategyMeta ?? null,
			startedAt: result.timings?.runStartedAt ?? startedAt,
		});
		return { ok: true, runId: run.id };
	} catch (err) {
		flushTraces();
		const traceCount = db.prepare('SELECT COUNT(*) AS c FROM backtest_event_traces WHERE run_id = ?').get(runId)?.c || 0;
		const isPartial = Boolean(err.partialResult?.ticks) || traceCount > 0;
		const failedResult = err.partialResult || {
			strategy: request.strategyLabel || request.strategy,
			source: 'lakehouse',
			underlying: request.underlying,
			interval: request.interval,
			bookDepth: request.bookDepth,
			from: new Date(request.from).toISOString(),
			to: new Date(request.to).toISOString(),
			ticks: 0,
			batches: 0,
			summary: { failed: true, error: err.message },
			events: [],
			equity: [],
			log: [],
		};
		failBacktestRun(db, runId, {
			request,
			result: failedResult,
			strategyMeta: request.strategyMeta ?? null,
			error: err.message,
			startedAt,
			partial: isPartial,
		});
		return { ok: false, runId, error: err.message };
	} finally {
		closeStateDatabase(db);
		await releaseBacktestResources();
	}
}

function normalizeEventForTrace(runId, event, chartPath) {
	return {
		...event,
		eventStart: new Date(event.eventStart).toISOString(),
		eventEnd: new Date(event.eventEnd).toISOString(),
		closedAt: event.closedAt ? new Date(event.closedAt).toISOString() : new Date(event.eventEnd).toISOString(),
		chart_series_path: chartPath,
	};
}
