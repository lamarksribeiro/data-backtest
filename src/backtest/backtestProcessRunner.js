import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER_PATH = fileURLToPath(new URL('./isolatedRunner.js', import.meta.url));

/**
 * Executa backtest em subprocesso Node separado para liberar RAM ao finalizar.
 */
export function spawnIsolatedBacktest(payload, { onMessage, onError, onExit }) {
	const payloadPath = path.join(tmpdir(), `data-backtest-run-${payload.runId}-${randomBytes(6).toString('hex')}.json`);
	writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');

	const child = spawn(process.execPath, [RUNNER_PATH, payloadPath], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: process.env,
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
		if (text) onError?.(new Error(text));
	});

	child.on('error', (err) => onError?.(err));

	child.on('exit', (code) => {
		try {
			unlinkSync(payloadPath);
		} catch { /* ignore */ }
		onExit?.(code);
	});

	return child;
}
