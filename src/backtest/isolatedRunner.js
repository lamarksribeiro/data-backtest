/**
 * Entry point de subprocesso: ao terminar, o SO libera toda a RAM do backtest.
 * Uso: node src/backtest/isolatedRunner.js <payload.json>
 */
import { readFileSync, unlinkSync } from 'node:fs';

import { runBacktestJob } from './runBacktestJob.js';

const payloadPath = process.argv[2];
if (!payloadPath) {
	console.error('missing payload path');
	process.exit(2);
}

let payload;
try {
	payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
} catch (err) {
	console.error(`invalid payload: ${err.message}`);
	process.exit(2);
}

const emit = (msg) => {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
};

try {
	const outcome = await runBacktestJob({
		stateDbPath: payload.stateDbPath,
		runId: payload.runId,
		request: payload.request,
		startedAt: payload.startedAt,
		onProgress: (progress) => emit({ type: 'progress', progress }),
	});
	emit(outcome);
	process.exit(outcome.ok ? 0 : 1);
} catch (err) {
	emit({ ok: false, runId: payload.runId, error: err.message });
	process.exit(1);
} finally {
	try {
		unlinkSync(payloadPath);
	} catch { /* ignore */ }
}
