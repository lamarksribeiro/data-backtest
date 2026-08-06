import test from 'node:test';
import assert from 'node:assert/strict';

import { findFirstFavoriteCross } from '../src/research/earlyFavoriteRush.js';

test('selects the first causal rush instead of a later recross', () => {
  const ticks = [
    { tau: 299, upAsk: 0.55, downAsk: 0.46 },
    { tau: 210, upAsk: 0.86, downAsk: 0.15 },
    { tau: 120, upAsk: 0.75, downAsk: 0.26 },
    { tau: 60, upAsk: 0.9, downAsk: 0.11 },
  ];

  const hit = findFirstFavoriteCross(ticks, 0.85);
  assert.equal(hit.index, 1);
  assert.equal(hit.tau, 210);
  assert.equal(hit.side, 'UP');
});

test('does not re-arm when the first rush is outside the entry window', () => {
  const ticks = [
    { tau: 250, upAsk: 0.86, downAsk: 0.15 },
    { tau: 160, upAsk: 0.7, downAsk: 0.31 },
    { tau: 100, upAsk: 0.9, downAsk: 0.11 },
  ];

  assert.equal(
    findFirstFavoriteCross(ticks, 0.85, { minTau: 60, maxTau: 180 }),
    null,
  );
});

test('rejects reverse-ordered tick buffers', () => {
  assert.throws(
    () =>
      findFirstFavoriteCross(
        [
          { tau: 10, upAsk: 0.5, downAsk: 0.51 },
          { tau: 20, upAsk: 0.86, downAsk: 0.15 },
        ],
        0.85,
      ),
    /tau descending/,
  );
});
