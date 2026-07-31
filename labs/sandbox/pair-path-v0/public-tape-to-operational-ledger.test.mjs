import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importPublicTape } from './public-tape-to-operational-ledger.mjs';

const FIXTURE = path.resolve('tests/fixtures/public-tape-btc5m.jsonl');
const FIXED_CLOCK = () => '2026-07-30T14:30:00.000Z';

test('fixture becomes one seen and explicitly skipped denominator event', async (t) => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'pair-clip-public-shadow-'),
  );
  t.after(async () => {
    await fs.promises.rm(directory, { recursive: true, force: true });
  });

  // First normalize the raw fixture through the public recorder CLI test
  // surface, then import the generated public evidence.
  const normalized = path.join(directory, 'public-events.jsonl');
  const summaryPath = path.join(directory, 'public-summary.json');
  const { spawnSync } = await import('node:child_process');
  const replay = spawnSync(
    process.execPath,
    [
      'labs/sandbox/pair-path-v0/public-tape-collector.mjs',
      '--replay',
      FIXTURE,
      '--out',
      normalized,
      '--summary',
      summaryPath,
      '--min-trades',
      '1',
      '--min-book-snapshots',
      '3',
    ],
    { cwd: path.resolve('.'), encoding: 'utf8' },
  );
  assert.equal(replay.status, 0, replay.stderr);

  const outputDirectory = path.join(directory, 'ledger');
  const first = await importPublicTape({
    inputPath: normalized,
    outputDirectory,
    clock: FIXED_CLOCK,
  });
  assert.equal(first.uniqueMarkets, 1);
  assert.equal(first.appended, 2);
  assert.deepEqual(first.denominator, {
    events_seen: 1,
    events_with_decision: 1,
    events_without_decision: 0,
    events_entered: 0,
    events_skipped_only: 1,
    events_with_orders: 0,
    events_with_fills: 0,
    events_with_cancels: 0,
    events_with_inventory: 0,
    events_finally_resolved: 0,
  });

  const retry = await importPublicTape({
    inputPath: normalized,
    outputDirectory,
    clock: FIXED_CLOCK,
  });
  assert.equal(retry.appended, 0);
  assert.equal(retry.duplicates, 2);
  assert.deepEqual(retry.denominator, first.denominator);

  const lines = fs
    .readFileSync(path.join(outputDirectory, 'operational-shadow.jsonl'), 'utf8')
    .trim()
    .split(/\r?\n/);
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).event_type),
    ['event_seen', 'decision'],
  );
});
