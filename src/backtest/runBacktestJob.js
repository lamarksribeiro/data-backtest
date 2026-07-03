import { buildProgress, runBacktest } from './engine.js';
import {
	appendChartSidecarLine,
	buildEventChartSeries,
	chartSidecarPath,
	ensureChartSidecarDir,
	resetChartSidecarRun,
} from './chartSidecar.js';
import { openStateDatabase, closeStateDatabase } from '../state/sqlite.js';
import { bindStrategyLibraryDatabase } from '../backtestStudio/nativeLibrary/registry.js';
import {
	completeBacktestRun,
	failBacktestRun,
	markBacktestRunRunning,
	minimalResultForRequest,
} from '../state/backtestRuns.js';
import { appendEventTraceBatch } from '../backtestStudio/state/eventTraces.js';
import { releaseBacktestResources } from './releaseResources.js';
import { rehydrateBacktestRequest } from './rehydrateRequest.js';

const FLUSH_BATCH_EVENTS = 200;

export async function runBacktestJob({
	stateDbPath,
	runId,
	request,
	startedAt,
	onProgress = null,
}) {
	const db = openStateDatabase(stateDbPath);
	bindStrategyLibraryDatabase(db);
	markBacktestRunRunning(db, runId, { startedAt });
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
		const hydrated = rehydrateBacktestRequest(db, request, { runId });
		const backtestRequest = {
			...hydrated,
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

		if (typeof onProgress === 'function') {
			onProgress(buildProgress({
				phase: 'saving',
				ticks: result.ticks,
				batches: result.batches,
				totalTicks: result.ticks || null,
				startedAt: result.timings?.runStartedAt ?? startedAt,
			}));
		}

		const run = completeBacktestRun(db, runId, {
			request: hydrated,
			result,
			strategyMeta: hydrated.strategyMeta ?? null,
			startedAt: result.timings?.runStartedAt ?? startedAt,
		});
		return { ok: true, runId: run.id };
	} catch (err) {
		flushTraces();
		const traceCount = db.prepare('SELECT COUNT(*) AS c FROM backtest_event_traces WHERE run_id = ?').get(runId)?.c || 0;
		const isPartial = Boolean(err.partialResult?.ticks) || traceCount > 0;
		const hydrated = rehydrateBacktestRequest(db, request, { runId });
		const failedResult = err.partialResult || minimalResultForRequest(hydrated, {
			summary: { failed: true, error: err.message },
		});
		failBacktestRun(db, runId, {
			request: hydrated,
			result: failedResult,
			strategyMeta: hydrated.strategyMeta ?? null,
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
