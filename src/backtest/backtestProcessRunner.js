import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER_PATH = fileURLToPath(new URL('./isolatedRunner.js', import.meta.url));

export { buildBacktestChildEnv };

function buildBacktestChildEnv(baseEnv = process.env) {
	const explicitHeap = Number.parseInt(String(baseEnv.BACKTEST_CHILD_MAX_OLD_SPACE_MB || ''), 10);
	const childHeapMb = Number.isFinite(explicitHeap) && explicitHeap > 0
		? explicitHeap
		: 7168;
	return {
		...baseEnv,
		NODE_OPTIONS: `--max-old-space-size=${childHeapMb} --disable-warning=ExperimentalWarning`,
	};
}

/**
 * Executa backtest em subprocesso Node separado para liberar RAM ao finalizar.
 * stderr é apenas log — avisos do Node/SQLite não devem marcar o run como falha.
 */
export function spawnIsolatedBacktest(payload, { onMessage, onStderr, onSpawnError, onExit }) {
	const payloadPath = path.join(tmpdir(), `data-backtest-run-${payload.runId}-${randomBytes(6).toString('hex')}.json`);
	writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');

	const child = spawn(process.execPath, [RUNNER_PATH, payloadPath], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: buildBacktestChildEnv(process.env),
	});

	let stdoutBuffer = '';

	child.stdout.on('data', (chunk) => {
		stdoutBuffer += chunk.toString();
		let newlineIndex = stdoutBuffer.indexOf('\n');
		while (newlineIndex >= 0) {
			const line = stdoutBuffer.slice(0, newlineIndex).trim();
			stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
			if (line) {
				try {
					onMessage?.(JSON.parse(line));
				} catch { /* ignore malformed line */ }
			}
			newlineIndex = stdoutBuffer.indexOf('\n');
		}
	});

	child.stderr.on('data', (chunk) => {
		const text = chunk.toString().trim();
		if (!text) return;
		onStderr?.(text, payload.runId);
	});

	child.on('error', (err) => onSpawnError?.(err));

	child.on('exit', (code, signal) => {
		try {
			unlinkSync(payloadPath);
		} catch { /* ignore */ }
		onExit?.(code, signal);
	});

	return child;
}

export function stopIsolatedBacktest(child) {
	if (!child || child.killed || child.exitCode != null) return;
	try {
		child.kill('SIGKILL');
	} catch { /* ignore */ }
}
