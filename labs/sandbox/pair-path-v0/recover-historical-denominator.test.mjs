import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRecovery,
  groupAssertions,
  parseBriefing,
  parseRawReport,
  resolveEpochSuffix,
  stableJson,
} from './recover-historical-denominator.mjs';

function source(text, sourceClass = 'fixture') {
  return {
    path: 'fixture.txt',
    sourceClass,
    text,
    lines: text.split(/\r?\n/),
  };
}

test('resolves a documented suffix uniquely near an anchor', () => {
  assert.equal(resolveEpochSuffix('8600', [1785258900]), 1785258600);
  assert.equal(resolveEpochSuffix('22600', [1785224700], 24 * 3600), 1785222600);
});

test('parses official CLOB rows and keeps repeated clip detail in one event group', () => {
  const parsed = parseBriefing(
    source(
      [
        '| 2026-07-29 01:46 | **Clip tight** sh10 | DN@0,57×10 + UP@0,37×5 + UP@0,36×5 | 9,35 | **0,935** | +0,65 | +0,32 |',
        '### 6.2 Clip live detalhado (…1785289500)',
      ].join('\n'),
      'clob_briefing',
    ),
  );
  assert.equal(parsed.official.length, 1);
  assert.equal(parsed.official[0].event_slug, 'btc-updown-5m-1785289500');
  const events = groupAssertions(parsed.assertions);
  assert.equal(events.length, 1);
  assert.equal(events[0].evidence.length, 2);
  assert.equal(events[0].classification.activity, 'complete_set');
});

test('keeps documented day-28 miss suffixes away from the next-day clip anchor', () => {
  const parsed = parseBriefing(
    source(
      [
        '| 2026-07-28 17:16 | V0 1+1 sh25 | DN@0,55×25 + UP@0,41×25 | 24,00 | **0,960** | +1,00 | +0,14 |',
        '| 2026-07-29 01:46 | **Clip tight** sh10 | DN@0,57×10 + UP@0,37×5 + UP@0,36×5 | 9,35 | **0,935** | +0,65 | +0,32 |',
        '| …9800 (série “protegida”) | **OPEN_PAIR_NOT_CHEAP ×261** — $0 |',
      ].join('\n'),
      'clob_briefing',
    ),
  );
  const miss = parsed.assertions.find(
    (assertion) => assertion.details.reason === 'OPEN_PAIR_NOT_CHEAP',
  );
  assert.equal(miss.event_slug, 'btc-updown-5m-1785259800');
});

test('raw zero-fill report becomes idle/no-order without inventing a fill', () => {
  const assertion = parseRawReport(
    source('{\n  "generatedAt": "2026-07-28T17:19:59.032Z"\n}', 'raw_local_live_report'),
    {
      generatedAt: '2026-07-28T17:19:59.032Z',
      live: true,
      event: { slug: 'btc-updown-5m-1785258900' },
      mode: 'idle',
      inv: {
        UP: { shares: 0 },
        DOWN: { shares: 0 },
      },
      fills: [],
      orders: [],
      openAttempts: 3,
      blockCounts: { OPEN_MISS_CAP: 3 },
    },
  );
  assert.deepEqual(assertion.categories, ['event_seen', 'idle', 'no_fill', 'no_order']);
});

test('fill and no-fill assertions for the same slug remain a conflict', () => {
  const base = {
    event_key: 'btc-updown-5m-1785258900',
    event_slug: 'btc-updown-5m-1785258900',
    event_epoch: 1785258900,
    event_start: '2026-07-28T17:15:00.000Z',
    scope_roles: [],
    overlap_status: 'exact',
    details: {},
  };
  const events = groupAssertions([
    {
      ...base,
      assertion_id: 'a_fill',
      source: 'clob.md',
      source_line: 1,
      source_class: 'clob_account_summary',
      categories: ['event_seen', 'order', 'fill', 'complete_set'],
    },
    {
      ...base,
      assertion_id: 'a_idle',
      source: 'raw.json',
      source_line: 1,
      source_class: 'raw_local_live_report',
      categories: ['event_seen', 'idle', 'no_order', 'no_fill'],
    },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].classification.activity, 'conflict');
  assert.deepEqual(
    events[0].classification.conflicts.map((conflict) => conflict.type),
    ['fill_vs_no_fill', 'order_vs_no_order'],
  );
});

test('winner proxy disagreement is a warning, not a complete-set fill conflict', () => {
  const base = {
    event_key: 'btc-updown-5m-1785259500',
    event_slug: 'btc-updown-5m-1785259500',
    event_epoch: 1785259500,
    event_start: '2026-07-28T17:25:00.000Z',
    scope_roles: [],
    overlap_status: 'exact',
  };
  const events = groupAssertions([
    {
      ...base,
      assertion_id: 'a_raw',
      source: 'raw.json',
      source_line: 1,
      source_class: 'raw_local_live_report',
      categories: ['event_seen', 'order', 'fill', 'complete_set'],
      details: { winner_proxy: 'UP', residual: 0 },
    },
    {
      ...base,
      assertion_id: 'a_resolution',
      source: 'outcomes.jsonl',
      source_line: 1,
      source_class: 'research_resolved_market_outcome',
      categories: ['resolution'],
      details: { winner: 'DOWN' },
    },
  ]);
  assert.equal(events[0].classification.activity, 'complete_set');
  assert.equal(events[0].classification.conflict, false);
  assert.deepEqual(events[0].classification.warnings, [
    {
      type: 'winner_proxy_vs_research_resolution',
      winner_proxy: 'UP',
      resolved_winner: 'DOWN',
      complete_set_pnl_invariant_when_residual_zero: true,
    },
  ]);
});

test('stable JSON is independent of object insertion order', () => {
  assert.equal(
    stableJson({ z: 1, a: { d: 2, b: 3 } }),
    stableJson({ a: { b: 3, d: 2 }, z: 1 }),
  );
});

test('known micro-live #1 descriptions converge on the exact suffix event', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..', '..', '..');
  const recovery = buildRecovery({
    root,
    robotRoot: path.resolve(root, '..', 'data-robot'),
  });
  const exact = recovery.events.find(
    (event) => event.event_slug === 'btc-updown-5m-1785222600',
  );
  assert.ok(exact);
  assert.ok(exact.evidence.length >= 2);
  assert.equal(
    recovery.events.some((event) => event.event_key === 'session:micro-live-1:event-1'),
    false,
  );
});
