import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  IdempotencyConflictError,
  LedgerCorruptionError,
  LedgerInvariantError,
  LedgerMaterializationError,
  LedgerValidationError,
  OperationalLedger,
  hashDescriptor,
  materializeOperationalLedger,
  readVerifiedJournal,
} from './operational-ledger.mjs';

const FIXED_CLOCK = () => '2026-07-30T14:00:00.000Z';

async function tempPaths(t) {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'pair-clip-operational-ledger-'),
  );
  t.after(async () => {
    const resolved = path.resolve(dir);
    const expectedRoot = path.resolve(os.tmpdir());
    assert.ok(
      resolved.startsWith(`${expectedRoot}${path.sep}`),
      `refusing to remove unexpected test directory ${resolved}`,
    );
    await fs.promises.rm(resolved, { recursive: true, force: true });
  });
  return {
    dir,
    journalPath: path.join(dir, 'operational.jsonl'),
    materializedPath: path.join(dir, 'operational.materialized.json'),
  };
}

async function openLedger(paths, overrides = {}) {
  return OperationalLedger.open({
    journalPath: paths.journalPath,
    ledgerId: 'pair-clip-operational-test',
    policy: {
      strategy: 'pair-clip',
      version: 7,
      decisionRule: 'frozen-test-policy',
    },
    build: {
      gitCommit: 'test-commit',
      module: 'operational-ledger.test.mjs',
    },
    clock: FIXED_CLOCK,
    lockTimeoutMs: 2_000,
    staleLockMs: 10_000,
    ...overrides,
  });
}

function seen(eventId, epoch, overrides = {}) {
  const eventStart = new Date(epoch * 1_000).toISOString();
  const eventEnd = new Date((epoch + 300) * 1_000).toISOString();
  return {
    eventType: 'event_seen',
    eventId,
    idempotencyKey: `seen:${eventId}`,
    effectiveAt: eventStart,
    source: 'lake.backtest_ticks',
    confidence: 'OBSERVED',
    payload: {
      condition_id: eventId,
      event_epoch: epoch,
      event_start: eventStart,
      event_end: eventEnd,
      universe: 'BTC-5M',
      data_status: 'OBSERVED',
      ...overrides,
    },
  };
}

function decision(eventId, action, suffix = action.toLowerCase()) {
  return {
    eventType: 'decision',
    eventId,
    idempotencyKey: `decision:${eventId}:${suffix}`,
    effectiveAt: '2026-07-29T03:20:20.000Z',
    source: 'pair-clip-policy',
    confidence: 'OBSERVED',
    payload: {
      decision_id: `decision-${eventId}-${suffix}`,
      action,
      eligible: action !== 'SKIP',
      reason_codes:
        action === 'SKIP' ? ['AVG_SUM_TOO_HIGH'] : ['PAIR_EDGE_PRESENT'],
      features: {
        tau: 280,
        avg_sum: action === 'SKIP' ? 1.01 : 0.94,
        residual: 0,
      },
    },
  };
}

function acceptedOrder(eventId, orderId = `order-${eventId}`) {
  return {
    eventType: 'order',
    eventId,
    idempotencyKey: `order:${orderId}:accepted`,
    effectiveAt: '2026-07-29T03:20:21.000Z',
    source: 'clob-order-evidence',
    confidence: 'REPORTED',
    payload: {
      order_id: orderId,
      status: 'ACCEPTED',
      side: 'BUY',
      outcome: 'UP',
      order_type: 'FAK',
      mode: 'HISTORICAL',
      limit_price: 0.55,
      requested_size: 10,
      post_only: false,
      reduce_only: false,
    },
  };
}

function partialFill(eventId, orderId = `order-${eventId}`) {
  return {
    eventType: 'fill',
    eventId,
    idempotencyKey: `fill:${orderId}:tx-1`,
    effectiveAt: '2026-07-29T03:20:21.200Z',
    source: 'clob-trade-evidence',
    confidence: 'REPORTED',
    payload: {
      fill_id: `fill-${orderId}-1`,
      order_id: orderId,
      side: 'BUY',
      outcome: 'UP',
      liquidity_role: 'TAKER',
      price: 0.54,
      size: 4,
      fee: 0.03,
    },
  };
}

function cancelRemainder(eventId, orderId = `order-${eventId}`) {
  return {
    eventType: 'cancel',
    eventId,
    idempotencyKey: `cancel:${orderId}:remainder`,
    effectiveAt: '2026-07-29T03:20:21.300Z',
    source: 'clob-order-evidence',
    confidence: 'REPORTED',
    payload: {
      cancel_id: `cancel-${orderId}-1`,
      order_id: orderId,
      status: 'CANCELED',
      canceled_size: 6,
      reason_code: 'FAK_REMAINDER',
    },
  };
}

function inventory(eventId, suffix = 'after-fill') {
  return {
    eventType: 'inventory',
    eventId,
    idempotencyKey: `inventory:${eventId}:${suffix}`,
    effectiveAt: '2026-07-29T03:20:22.000Z',
    source: 'account-reconciliation',
    confidence: 'OBSERVED',
    payload: {
      snapshot_id: `inventory-${eventId}-${suffix}`,
      up_shares: 4,
      down_shares: 0,
      cash_spent: 2.16,
      cash_received: 0,
      fees_paid: 0.03,
      realized_pnl: 0,
      pending_order_ids: [],
    },
  };
}

function resolution(eventId, winner, status, suffix = status.toLowerCase()) {
  return {
    eventType: 'resolution',
    eventId,
    idempotencyKey: `resolution:${eventId}:${suffix}`,
    effectiveAt: '2026-07-29T03:26:00.000Z',
    source: status === 'FINAL' ? 'clob-market-tokens' : 'gamma-market',
    confidence: status === 'FINAL' ? 'CANONICAL' : 'INFERRED',
    payload: {
      resolution_id: `resolution-${eventId}-${suffix}`,
      winner,
      status,
      payout_per_share: 1,
      resolution_source:
        status === 'FINAL' ? 'CLOB_EXPLICIT_WINNER' : 'GAMMA_OUTCOME_PRICE',
    },
  };
}

test('journal chains records and treats exact retries as idempotent', async (t) => {
  const paths = await tempPaths(t);
  const ledger = await openLedger(paths);
  const eventId = '0xevent-a';

  const first = await ledger.append('event_seen', seen(eventId, 1785295200));
  assert.equal(first.appended, true);
  assert.equal(first.record.seq, 1);
  assert.equal(first.record.prev_hash, '0'.repeat(64));
  assert.match(first.record.policy_hash, /^[a-f0-9]{64}$/);
  assert.match(first.record.build_hash, /^[a-f0-9]{64}$/);

  const retry = await ledger.append('event_seen', seen(eventId, 1785295200));
  assert.equal(retry.appended, false);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.record.record_id, first.record.record_id);

  const verified = ledger.verify();
  assert.equal(verified.records.length, 1);
  assert.equal(
    fs.readFileSync(paths.journalPath, 'utf8').trim().split(/\r?\n/).length,
    1,
  );

  await assert.rejects(
    ledger.append(
      'event_seen',
      seen(eventId, 1785295200, { data_status: 'DEGRADED' }),
    ),
    IdempotencyConflictError,
  );
  assert.equal(ledger.verify().records.length, 1);
});

test('two writers serialize and append one copy of the same fact', async (t) => {
  const paths = await tempPaths(t);
  const writerA = await openLedger(paths, { writerId: 'writer-a' });
  const writerB = await openLedger(paths, { writerId: 'writer-b' });
  const eventId = '0xevent-concurrent';

  const results = await Promise.all([
    writerA.append('event_seen', seen(eventId, 1785295500)),
    writerB.append('event_seen', seen(eventId, 1785295500)),
  ]);

  assert.equal(results.filter((result) => result.appended).length, 1);
  assert.equal(results.filter((result) => result.duplicate).length, 1);
  assert.equal(readVerifiedJournal(paths.journalPath).records.length, 1);
  assert.equal(fs.existsSync(`${paths.journalPath}.lock`), false);
});

test('batch is atomic and lifecycle invariants reject phantom evidence', async (t) => {
  const paths = await tempPaths(t);
  const ledger = await openLedger(paths);
  const eventId = '0xevent-lifecycle';

  await assert.rejects(
    ledger.appendMany([
      seen(eventId, 1785295800),
      acceptedOrder(eventId),
    ]),
    LedgerInvariantError,
  );
  assert.equal(ledger.verify().records.length, 0);

  const skippedId = '0xevent-skip-cannot-order';
  await assert.rejects(
    ledger.appendMany([
      seen(skippedId, 1785295650),
      decision(skippedId, 'SKIP'),
      acceptedOrder(skippedId),
    ]),
    /no prior actionable decision/,
  );
  assert.equal(ledger.verify().records.length, 0);

  const valid = await ledger.appendMany([
    seen(eventId, 1785295800),
    decision(eventId, 'ENTER'),
    acceptedOrder(eventId),
    partialFill(eventId),
    cancelRemainder(eventId),
    inventory(eventId),
    resolution(eventId, 'DOWN', 'PROVISIONAL', 'gamma'),
    resolution(eventId, 'UP', 'FINAL', 'clob'),
  ]);
  assert.equal(valid.appended, 8);
  assert.equal(valid.duplicates, 0);

  const overfill = {
    ...partialFill(eventId),
    idempotencyKey: `fill:order-${eventId}:tx-2`,
    payload: {
      ...partialFill(eventId).payload,
      fill_id: `fill-order-${eventId}-2`,
      size: 1,
    },
  };
  await assert.rejects(ledger.append('fill', overfill), LedgerInvariantError);

  await assert.rejects(
    ledger.append(
      'resolution',
      resolution(eventId, 'DOWN', 'FINAL', 'conflicting-clob'),
    ),
    LedgerInvariantError,
  );
  assert.equal(ledger.verify().records.length, 8);
});

test('resumed materialization equals a clean rebuild', async (t) => {
  const paths = await tempPaths(t);
  const ledger = await openLedger(paths);
  const skippedId = '0xevent-skip';
  const enteredId = '0xevent-enter';

  await ledger.appendMany([
    seen(skippedId, 1785296100),
    decision(skippedId, 'SKIP'),
  ]);
  const first = await materializeOperationalLedger({
    journalPath: paths.journalPath,
    materializedPath: paths.materializedPath,
    clock: FIXED_CLOCK,
  });
  assert.equal(first.resumed, false);
  assert.equal(first.appliedRecords, 2);
  assert.equal(first.materialized.state.denominator.events_skipped_only, 1);

  await ledger.appendMany([
    seen(enteredId, 1785296400),
    decision(enteredId, 'ENTER'),
    acceptedOrder(enteredId),
    partialFill(enteredId),
    cancelRemainder(enteredId),
    inventory(enteredId),
    resolution(enteredId, 'UP', 'FINAL', 'clob'),
  ]);
  const resumed = await materializeOperationalLedger({
    journalPath: paths.journalPath,
    materializedPath: paths.materializedPath,
    clock: FIXED_CLOCK,
  });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.appliedRecords, 7);
  assert.deepEqual(resumed.materialized.state.denominator, {
    events_seen: 2,
    events_with_decision: 2,
    events_without_decision: 0,
    events_entered: 1,
    events_skipped_only: 1,
    events_with_orders: 1,
    events_with_fills: 1,
    events_with_cancels: 1,
    events_with_inventory: 1,
    events_finally_resolved: 1,
  });
  assert.equal(resumed.materialized.state.totals.fill_size, 4);
  assert.equal(resumed.materialized.state.totals.fill_notional, 2.16);
  assert.equal(resumed.materialized.state.totals.fees, 0.03);

  const rebuildPath = path.join(paths.dir, 'clean-rebuild.json');
  const rebuilt = await materializeOperationalLedger({
    journalPath: paths.journalPath,
    materializedPath: rebuildPath,
    resume: false,
    clock: FIXED_CLOCK,
  });
  assert.deepEqual(rebuilt.materialized.state, resumed.materialized.state);
  assert.equal(rebuilt.appliedRecords, 9);
});

test('verification detects mutation and partial tail', async (t) => {
  const paths = await tempPaths(t);
  const ledger = await openLedger(paths);
  await ledger.append('event_seen', seen('0xevent-corrupt', 1785296700));

  const original = fs.readFileSync(paths.journalPath, 'utf8');
  const mutated = original.replace(
    '"data_status":"OBSERVED"',
    '"data_status":"DEGRADED"',
  );
  assert.notEqual(mutated, original);
  fs.writeFileSync(paths.journalPath, mutated, 'utf8');
  assert.throws(
    () => readVerifiedJournal(paths.journalPath),
    LedgerCorruptionError,
  );

  fs.writeFileSync(paths.journalPath, original.trimEnd(), 'utf8');
  assert.throws(
    () => readVerifiedJournal(paths.journalPath),
    /partial final line/,
  );
});

test('resume rejects a materialized state changed outside the journal', async (t) => {
  const paths = await tempPaths(t);
  const ledger = await openLedger(paths);
  const eventId = '0xevent-materialized-tamper';
  await ledger.appendMany([
    seen(eventId, 1785296850),
    decision(eventId, 'SKIP'),
  ]);
  await materializeOperationalLedger({
    journalPath: paths.journalPath,
    materializedPath: paths.materializedPath,
    clock: FIXED_CLOCK,
  });

  const changed = JSON.parse(
    fs.readFileSync(paths.materializedPath, 'utf8'),
  );
  changed.state.denominator.events_seen = 999;
  fs.writeFileSync(
    paths.materializedPath,
    `${JSON.stringify(changed, null, 2)}\n`,
    'utf8',
  );

  await assert.rejects(
    materializeOperationalLedger({
      journalPath: paths.journalPath,
      materializedPath: paths.materializedPath,
      clock: FIXED_CLOCK,
    }),
    LedgerMaterializationError,
  );
});

test('secret-like fields and invalid feature hashes are never journaled', async (t) => {
  const paths = await tempPaths(t);
  const ledger = await openLedger(paths);
  const eventId = '0xevent-secret';

  await assert.rejects(
    ledger.append('event_seen', {
      ...seen(eventId, 1785297000),
      payload: {
        ...seen(eventId, 1785297000).payload,
        api_key: 'must-not-be-written',
      },
    }),
    LedgerValidationError,
  );
  assert.equal(fs.existsSync(paths.journalPath), false);

  await ledger.append('event_seen', seen(eventId, 1785297000));
  const wrongHashDecision = decision(eventId, 'SKIP', 'wrong-hash');
  wrongHashDecision.payload.features_hash = 'a'.repeat(64);
  await assert.rejects(
    ledger.append('decision', wrongHashDecision),
    LedgerValidationError,
  );
  assert.equal(ledger.verify().records.length, 1);
});

test('descriptor hashing is canonical and records pin policy/build versions', async (t) => {
  assert.equal(
    hashDescriptor({ beta: 2, alpha: { y: 2, x: 1 } }),
    hashDescriptor({ alpha: { x: 1, y: 2 }, beta: 2 }),
  );

  const paths = await tempPaths(t);
  const ledger = await openLedger(paths);
  const row = await ledger.append(
    'event_seen',
    seen('0xevent-hashes', 1785297300),
  );
  const parsed = JSON.parse(
    fs.readFileSync(paths.journalPath, 'utf8').trim(),
  );
  assert.equal(parsed.policy_hash, row.record.policy_hash);
  assert.equal(parsed.build_hash, row.record.build_hash);
  assert.equal(parsed.policy, undefined);
  assert.equal(parsed.build, undefined);
});
