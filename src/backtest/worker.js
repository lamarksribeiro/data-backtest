import { parentPort, workerData } from 'node:worker_threads';

import { runBacktestJob } from './runBacktestJob.js';

const outcome = await runBacktestJob({
	stateDbPath: workerData.stateDbPath,
	runId: workerData.runId,
	request: workerData.request,
	startedAt: workerData.startedAt,
	onProgress: (progress) => parentPort?.postMessage({ type: 'progress', progress }),
});

parentPort?.postMessage(outcome);
