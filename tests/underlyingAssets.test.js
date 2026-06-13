import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	minSpotUsd,
	underlyingDecimals,
	listedUnderlyings,
	resolveChartThresholds,
} from '../src/quality/underlyingThresholds.js';

describe('underlyingAssets', () => {
	it('minSpotUsd resolves known underlyings', () => {
		assert.equal(minSpotUsd('btc'), 1000);
		assert.equal(minSpotUsd('SOL'), 10);
		assert.equal(minSpotUsd('doge'), 0.001);
	});

	it('minSpotUsd falls back to BTC threshold for unknown assets', () => {
		assert.equal(minSpotUsd('AVAX'), 1000);
	});

	it('underlyingDecimals matches asset precision', () => {
		assert.equal(underlyingDecimals('XRP'), 4);
		assert.equal(underlyingDecimals('DOGE'), 6);
		assert.equal(underlyingDecimals('UNKNOWN'), 2);
	});

	it('listedUnderlyings includes all mapped assets', () => {
		const listed = listedUnderlyings();
		assert.ok(listed.includes('BTC'));
		assert.ok(listed.includes('SOL'));
		assert.equal(listed.length, 7);
	});

	it('resolveChartThresholds uses per-asset defaults', () => {
		const thresholds = resolveChartThresholds(
			{ underlying: 'SOL' },
			[{ underlying: 'SOL', underlyingPrice: 180 }],
		);
		assert.equal(thresholds.minSpot, 10);
		assert.equal(thresholds.minPtb, 10);
	});
});
