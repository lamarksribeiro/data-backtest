import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isDailyScheduleDue,
  localDateKey,
  nextDailyRunAt,
  scheduledInstantForLocalDay,
} from '../src/scheduler/scheduleTime.js';

test('nextDailyRunAt uses local timezone instead of UTC', () => {
  const now = new Date('2026-06-13T01:00:00.000Z');
  assert.equal(
    nextDailyRunAt('03:00', now, 'UTC'),
    '2026-06-13T03:00:00.000Z',
  );
  assert.equal(
    nextDailyRunAt('03:00', now, 'America/Sao_Paulo'),
    '2026-06-13T06:00:00.000Z',
  );
});

test('scheduledInstantForLocalDay handles Brazil offset', () => {
  const instant = scheduledInstantForLocalDay({
    year: 2026,
    month: 6,
    day: 13,
    hour: 3,
    minute: 0,
  }, 'America/Sao_Paulo');
  assert.equal(instant.toISOString(), '2026-06-13T06:00:00.000Z');
});

test('isDailyScheduleDue and localDateKey follow scheduler timezone', () => {
  const before = new Date('2026-06-13T05:59:00.000Z');
  const after = new Date('2026-06-13T06:01:00.000Z');
  const previousLocalDay = new Date('2026-06-13T02:59:00.000Z');
  assert.equal(isDailyScheduleDue('03:00', before, 'America/Sao_Paulo'), false);
  assert.equal(isDailyScheduleDue('03:00', after, 'America/Sao_Paulo'), true);
  assert.equal(localDateKey(after, 'America/Sao_Paulo'), '2026-06-13');
  assert.equal(localDateKey(previousLocalDay, 'America/Sao_Paulo'), '2026-06-12');
});
