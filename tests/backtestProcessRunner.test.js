import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBacktestChildEnv } from '../src/backtest/backtestProcessRunner.js';

test('buildBacktestChildEnv caps heap and suppresses sqlite experimental warning', () => {
	const env = buildBacktestChildEnv({
		...process.env,
		NODE_OPTIONS: '--max-old-space-size=10240',
		BACKTEST_CHILD_MAX_OLD_SPACE_MB: '6144',
	});
	assert.match(env.NODE_OPTIONS, /--max-old-space-size=6144/);
	assert.match(env.NODE_OPTIONS, /--disable-warning=ExperimentalWarning/);
	assert.doesNotMatch(env.NODE_OPTIONS, /--max-old-space-size=10240/);
});

test('buildBacktestChildEnv defaults child heap to 7168 MB', () => {
	const env = buildBacktestChildEnv({ PATH: process.env.PATH });
	assert.match(env.NODE_OPTIONS, /--max-old-space-size=7168/);
});
