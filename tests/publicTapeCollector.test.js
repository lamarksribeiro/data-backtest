import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PublicTapeRecorder,
  assertPublicReadOnlyUrl,
  evaluateEvidenceGates,
  normalizeGammaMarket,
  replayPublicTapeFixture,
} from '../labs/sandbox/pair-path-v0/public-tape-core.mjs';
import { openPublicMarketWs } from '../labs/sandbox/pair-path-v0/public-tape-collector.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/public-tape-btc5m.jsonl');
const CLI = path.join(
  ROOT,
  'labs/sandbox/pair-path-v0/public-tape-collector.mjs',
);

test('public endpoint allowlist rejects user/order surfaces', () => {
  assert.doesNotThrow(() =>
    assertPublicReadOnlyUrl(
      'https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-1',
    ),
  );
  assert.doesNotThrow(() =>
    assertPublicReadOnlyUrl(
      'https://clob.polymarket.com/book?token_id=1',
    ),
  );
  assert.throws(
    () => assertPublicReadOnlyUrl('https://clob.polymarket.com/order'),
    /blocked non-read-only endpoint/,
  );
  assert.throws(
    () =>
      assertPublicReadOnlyUrl(
        'wss://ws-subscriptions-clob.polymarket.com/ws/user',
        'ws',
      ),
    /blocked non-public market WebSocket/,
  );
});

test('Gamma discovery maps outcomes to their token IDs', () => {
  const market = normalizeGammaMarket(
    [
      {
        conditionId: '0xabc',
        question: 'fixture',
        outcomes: '["Down","Up"]',
        clobTokenIds: '["down-token","up-token"]',
      },
    ],
    'btc-updown-5m-1785357600',
  );
  assert.equal(market.eventEndSec - market.eventStartSec, 300);
  assert.deepEqual(market.tokens, [
    { outcome: 'UP', tokenId: 'up-token' },
    { outcome: 'DOWN', tokenId: 'down-token' },
  ]);
});

test('fixture replay preserves book deltas and explicit trade events', async () => {
  const records = [];
  const recorder = new PublicTapeRecorder({
    runId: 'fixture-test',
    sink: (record) => records.push(record),
  });
  const start = recorder.emitRunState('start');
  assert.equal(start.effectiveAtMs, null);
  const replay = await replayPublicTapeFixture(FIXTURE, recorder);
  const stats = recorder.snapshotStats();

  assert.equal(replay.messages, 7);
  assert.equal(stats.discoveries, 1);
  assert.equal(stats.restBookSnapshots, 2);
  assert.equal(stats.wsBookSnapshots, 1);
  assert.equal(stats.priceLevelUpdates, 2);
  assert.equal(stats.trades, 1);
  assert.equal(stats.malformedMessages, 0);
  assert.equal(stats.unknownAssets, 0);

  const upLevel = records.find(
    (row) =>
      row.recordType === 'book.level' &&
      row.asset?.tokenId === '1001',
  );
  assert.equal(upLevel.data.sizeBefore, 12);
  assert.equal(upLevel.data.sizeAfter, 7);
  assert.equal(upLevel.data.sizeDelta, -5);
  assert.equal(upLevel.data.changeReason, 'unknown');

  const trade = records.find((row) => row.recordType === 'trade.match');
  assert.equal(trade.data.reportedSide, 'BUY');
  assert.equal(trade.data.sideSemantics, 'polymarket-last-trade-price');
  assert.equal(trade.data.price, 0.51);
  assert.equal(trade.data.size, 4);
  assert.equal(trade.effectiveAtMs, 1785357600350);
  assert.equal(trade.source.access, 'public-read-only');

  const gate = evaluateEvidenceGates(stats, {
    minDiscoveries: 1,
    minBookSnapshots: 3,
    minWsMessages: 4,
    minTrades: 1,
  });
  assert.equal(gate.pass, true);
});

test('replay message quota is deterministic', async () => {
  const recorder = new PublicTapeRecorder({
    runId: 'quota-test',
    sink: () => {},
  });
  const replay = await replayPublicTapeFixture(FIXTURE, recorder, {
    maxMessages: 3,
  });
  assert.equal(replay.messages, 3);
  assert.equal(recorder.stats.discoveries, 1);
  assert.equal(recorder.stats.restBookSnapshots, 2);
  assert.equal(recorder.stats.wsMessages, 0);
});

test('CLI exposes help without starting discovery', () => {
  const result = spawnSync(process.execPath, [CLI, '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /read-only, zero orders/i);
  assert.match(result.stdout, /--market-windows/);
  assert.match(result.stdout, /--min-trades/);
});

test('CLI replay writes append-only evidence and passing summary', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-tape-test-'));
  t.after(() => {
    const resolved = path.resolve(tempDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
  const out = path.join(tempDir, 'events.jsonl');
  const summary = path.join(tempDir, 'summary.json');
  const result = spawnSync(
    process.execPath,
    [
      CLI,
      '--replay',
      FIXTURE,
      '--out',
      out,
      '--summary',
      summary,
      '--min-trades',
      '1',
      '--min-book-snapshots',
      '3',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const rows = fs
    .readFileSync(out, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const report = JSON.parse(fs.readFileSync(summary, 'utf8'));
  assert.equal(rows[0].recordType, 'run.start');
  assert.equal(rows.at(-2).recordType, 'run.gate');
  assert.equal(rows.at(-1).recordType, 'run.stop');
  assert.equal(report.gates.pass, true);
  assert.equal(report.stats.trades, 1);
  assert.equal(report.runResult.stopReason, 'fixture_eof');
});

test('CLI max-records is a hard append-only cap including terminal records', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-tape-cap-'));
  t.after(() => {
    const resolved = path.resolve(tempDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
  const out = path.join(tempDir, 'events.jsonl');
  const result = spawnSync(
    process.execPath,
    [
      CLI,
      '--replay',
      FIXTURE,
      '--out',
      out,
      '--max-records',
      '4',
      '--min-discoveries',
      '0',
      '--min-book-snapshots',
      '0',
      '--min-ws-messages',
      '0',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const rows = fs
    .readFileSync(out, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 4);
  assert.equal(rows.at(-2).recordType, 'run.gate');
  assert.equal(rows.at(-1).recordType, 'run.stop');
});

test('stopped live socket cannot append a late close record', async () => {
  class FakeWebSocket {
    static instance = null;

    constructor() {
      this.listeners = new Map();
      FakeWebSocket.instance = this;
    }

    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }

    emit(type, value = {}) {
      for (const handler of this.listeners.get(type) ?? []) handler(value);
    }

    send() {}

    close() {
      queueMicrotask(() => this.emit('close', { code: 1000, reason: 'done' }));
    }
  }

  const records = [];
  const recorder = new PublicTapeRecorder({
    runId: 'late-close-test',
    sink: (record) => records.push(record),
  });
  const controller = openPublicMarketWs({
    recorder,
    market: {
      slug: 'btc-updown-5m-1785357600',
      conditionId: '0xfixture',
      eventStartSec: 1785357600,
      eventEndSec: 1785357900,
      tokens: [
        { outcome: 'UP', tokenId: '1001' },
        { outcome: 'DOWN', tokenId: '1002' },
      ],
    },
    onWireMessage() {},
    onFatal(error) {
      throw error;
    },
    WebSocketCtor: FakeWebSocket,
  });
  FakeWebSocket.instance.emit('open');
  controller.stop('done');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    records.filter((row) => row.recordType === 'feed.status').map((row) => row.data.status),
    ['open', 'stop'],
  );
});
