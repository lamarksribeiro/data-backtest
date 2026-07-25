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
  defaultEndTimeForDate,
  defaultEndDateTimeForDate,
  applyDateSelectionDefaults,
  clampToAvailableEnd,
  lastCompleteEventEndMs,
  lastCompleteInclusiveDateTime,
  parseIntervalMs,
  isoToDateTimeLocal,
} from '../public/js/utils/dateRange.js';

test('normalizeContextDateTime migra date-only legado', () => {
  const now = new Date(2026, 6, 25, 16, 10, 0);
  assert.equal(normalizeContextDateTime('2026-06-02', { now }), '2026-06-02T00:00');
  assert.equal(normalizeContextDateTime('2026-06-07', { end: true, now }), '2026-06-07T23:59');
});

test('parseIntervalMs e lastCompleteEventEndMs alinham à grade UTC', () => {
  assert.equal(parseIntervalMs('5m'), 5 * 60_000);
  assert.equal(parseIntervalMs('15m'), 15 * 60_000);
  assert.equal(parseIntervalMs('1h'), 60 * 60_000);

  assert.equal(
    lastCompleteEventEndMs(new Date('2026-07-25T19:18:00.000Z'), '5m'),
    Date.parse('2026-07-25T19:15:00.000Z'),
  );
  assert.equal(
    lastCompleteEventEndMs(new Date('2026-07-25T19:15:00.000Z'), '5m'),
    Date.parse('2026-07-25T19:15:00.000Z'),
  );
  assert.equal(
    lastCompleteEventEndMs(new Date('2026-07-25T19:18:00.000Z'), '15m'),
    Date.parse('2026-07-25T19:15:00.000Z'),
  );
  assert.equal(
    lastCompleteEventEndMs(new Date('2026-07-25T19:18:00.000Z'), '1h'),
    Date.parse('2026-07-25T19:00:00.000Z'),
  );
});

test('lastCompleteInclusiveDateTime usa fim−1min (API +1min = event_end)', () => {
  const now = new Date('2026-07-25T19:18:00.000Z');
  assert.equal(
    lastCompleteInclusiveDateTime(now, '5m'),
    isoToDateTimeLocal(new Date('2026-07-25T19:14:00.000Z'), { end: true }),
  );
});

test('normalizeContextDateTime no dia parcial usa último evento completo', () => {
  const now = new Date('2026-07-25T19:18:00.000Z');
  const expected = lastCompleteInclusiveDateTime(now, '5m');
  const today = expected.slice(0, 10);
  assert.equal(normalizeContextDateTime(today, { end: true, now, interval: '5m' }), expected);
  assert.equal(normalizeContextDateTime(`${today}T23:59`, { end: true, now, interval: '5m' }), expected);
});

test('defaultEndTimeForDate distingue dia completo e parcial', () => {
  const now = new Date('2026-07-25T19:18:00.000Z');
  const expected = lastCompleteInclusiveDateTime(now, '5m');
  assert.equal(defaultEndTimeForDate('2026-07-24', now, '5m'), '23:59');
  assert.equal(defaultEndDateTimeForDate(expected.slice(0, 10), now, '5m'), expected);
});

test('applyDateSelectionDefaults preenche 00:00 e fim alinhado ao mudar a data', () => {
  const now = new Date('2026-07-25T19:18:00.000Z');
  const expectedToday = lastCompleteInclusiveDateTime(now, '5m');
  assert.equal(
    applyDateSelectionDefaults('2026-07-20T11:00', {
      end: false,
      previousDateKey: '2026-07-19',
      now,
      interval: '5m',
    }),
    '2026-07-20T00:00',
  );
  assert.equal(
    applyDateSelectionDefaults('2026-07-20T11:00', {
      end: true,
      previousDateKey: '2026-07-19',
      now,
      interval: '5m',
    }),
    '2026-07-20T23:59',
  );
  assert.equal(
    applyDateSelectionDefaults(`${expectedToday.slice(0, 10)}T11:00`, {
      end: true,
      previousDateKey: '2026-07-20',
      now,
      interval: '5m',
    }),
    expectedToday,
  );
});

test('applyDateSelectionDefaults preserva horário quando só o time muda', () => {
  const now = new Date('2026-07-25T21:00:00.000Z');
  assert.equal(
    applyDateSelectionDefaults('2026-07-20T08:15', {
      end: true,
      previousDateKey: '2026-07-20',
      now,
      interval: '5m',
    }),
    '2026-07-20T08:15',
  );
});

test('clampToAvailableEnd não passa do último evento completo', () => {
  const now = new Date('2026-07-25T19:18:00.000Z');
  const max = lastCompleteInclusiveDateTime(now, '5m');
  assert.equal(clampToAvailableEnd(`${max.slice(0, 10)}T23:59`, now, '5m'), max);
  assert.equal(clampToAvailableEnd('2026-07-24T23:59', now, '5m'), '2026-07-24T23:59');
});

test('contextToApiRange do fim alinhado corta no event_end', () => {
  const now = new Date('2026-07-25T19:18:00.000Z');
  const inclusive = lastCompleteInclusiveDateTime(now, '5m');
  const toIso = contextDateTimeToApiTo(inclusive);
  assert.equal(new Date(toIso).getTime(), Date.parse('2026-07-25T19:15:00.000Z'));
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
