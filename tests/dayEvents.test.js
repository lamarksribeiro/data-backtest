import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeDayEvents, summarizeHours } from '../src/quality/dayEvents.js';

test('summarizeHours aggregates omit trim and manual counts', () => {
  const events = mergeDayEvents({
    events: [
      { conditionId: 'a', eventStart: '2026-06-01T14:00:00.000Z', eventEnd: '2026-06-01T14:05:00.000Z', coverage: 1, degraded: false, ticksRecorded: 100 },
      { conditionId: 'b', eventStart: '2026-06-01T14:05:00.000Z', eventEnd: '2026-06-01T14:10:00.000Z', coverage: 1, degraded: false, ticksRecorded: 100 },
      { conditionId: 'c', eventStart: '2026-06-01T15:00:00.000Z', eventEnd: '2026-06-01T15:05:00.000Z', coverage: 1, degraded: false, ticksRecorded: 100 },
    ],
    exclusions: [{ conditionId: 'b' }],
    normalizationIndex: new Map([
      ['a', { action: 'keep', issues: [] }],
      ['c', { action: 'omit', issues: ['clob_stale'] }],
    ]),
  });

  const hours = summarizeHours(events);
  const hour14 = hours.find((row) => row.hour === 14);
  const hour15 = hours.find((row) => row.hour === 15);
  assert.equal(hour14.total, 2);
  assert.equal(hour14.manual, 1);
  assert.equal(hour15.omitted, 1);
});
