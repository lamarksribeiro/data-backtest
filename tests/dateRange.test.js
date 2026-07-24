import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeContextDateTime,
  contextToApiRange,
  contextDateTimeToApiFrom,
  contextDateTimeToApiTo,
  inclusiveEndFromExclusive,
  formatStoredRange,
  isDateOnlyValue,
} from '../public/js/utils/dateRange.js';

test('normalizeContextDateTime migra date-only legado', () => {
  assert.equal(normalizeContextDateTime('2026-06-02'), '2026-06-02T00:00');
  assert.equal(normalizeContextDateTime('2026-06-07', { end: true }), '2026-06-07T23:59');
});

test('contextToApiRange mantém date-only e converte datetime-local', () => {
  assert.deepEqual(
    contextToApiRange({ from: '2026-06-02', to: '2026-06-07' }),
    { from: '2026-06-02', to: '2026-06-07' },
  );

  const fromIso = contextDateTimeToApiFrom('2026-06-07T14:30');
  const toIso = contextDateTimeToApiTo('2026-06-07T18:45');
  assert.match(fromIso, /2026-06-07T\d{2}:30:00\.000Z/);
  assert.equal(new Date(toIso).getTime() - new Date(fromIso).getTime(), 4 * 60 * 60_000 + 16 * 60_000);
});

test('inclusiveEndFromExclusive distingue dia inteiro e precisão de minuto', () => {
  const dateOnlyEnd = inclusiveEndFromExclusive('2026-06-08T00:00:00.000Z', '2026-06-02T00:00:00.000Z');
  assert.equal(dateOnlyEnd.toISOString().slice(0, 10), '2026-06-07');

  const minuteEnd = inclusiveEndFromExclusive('2026-06-07T18:46:00.000Z', '2026-06-07T14:30:00.000Z');
  assert.equal(minuteEnd.toISOString(), '2026-06-07T18:45:00.000Z');
});

test('formatStoredRange exibe horário quando presente', () => {
  const text = formatStoredRange('2026-06-07T14:30:00.000Z', '2026-06-07T18:46:00.000Z');
  assert.match(text, /\d{2}:\d{2}/);
  assert.match(text, /→/);
  const fromMs = new Date('2026-06-07T14:30:00.000Z').getTime();
  const toInclusiveMs = new Date('2026-06-07T18:45:00.000Z').getTime();
  assert.equal(toInclusiveMs - fromMs, 4 * 60 * 60_000 + 15 * 60_000);
});

test('isDateOnlyValue', () => {
  assert.equal(isDateOnlyValue('2026-06-02'), true);
  assert.equal(isDateOnlyValue('2026-06-02T14:30'), false);
});
