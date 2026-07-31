import assert from 'node:assert/strict';
import test from 'node:test';
import {
  latestByCondition,
  normalizeWinner,
  resolvedWinner,
} from './sync-canonical-outcomes.mjs';

test('normalizes numeric and textual BTC outcomes', () => {
  assert.equal(normalizeWinner('Up'), 'UP');
  assert.equal(normalizeWinner('-1'), 'DOWN');
  assert.equal(normalizeWinner('flat'), null);
});

test('accepts exactly one resolved outcome at or above 0.99', () => {
  assert.equal(
    resolvedWinner({
      outcomes: '["Up","Down"]',
      outcomePrices: '["1","0"]',
    }),
    'UP',
  );
  assert.equal(
    resolvedWinner({
      outcomes: ['Up', 'Down'],
      outcomePrices: [0.5, 0.5],
    }),
    null,
  );
});

test('materialized view keeps the latest append-only observation', () => {
  const rows = [
    {
      condition_id: '0xabc',
      winner: 'UP',
      observed_at: '2026-07-27T00:00:00.000Z',
    },
    {
      condition_id: '0xabc',
      winner: 'DOWN',
      observed_at: '2026-07-30T00:00:00.000Z',
    },
  ];
  assert.equal(latestByCondition(rows).get('0xabc').winner, 'DOWN');
});

test('stronger explicit source outranks a newer weaker research source', () => {
  const rows = [
    {
      condition_id: '0xabc',
      winner: 'UP',
      source: 'clob_market_tokens',
      observed_at: '2026-07-29T00:00:00.000Z',
    },
    {
      condition_id: '0xabc',
      winner: 'DOWN',
      source: 'gamma_events_keyset',
      observed_at: '2026-07-30T00:00:00.000Z',
    },
  ];
  assert.equal(latestByCondition(rows).get('0xabc').winner, 'UP');
});
