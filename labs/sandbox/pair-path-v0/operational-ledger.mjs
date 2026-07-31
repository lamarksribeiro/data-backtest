/**
 * Pair/Clip operational denominator ledger.
 *
 * This module only persists evidence supplied by a caller. It has no exchange
 * client, credential handling, order-routing, or network side effects.
 *
 * The journal is immutable JSONL. Materialized projections are disposable and
 * may be rebuilt or resumed from a verified checkpoint.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const GENESIS_HASH = '0'.repeat(64);
const EVENT_TYPES = new Set([
  'event_seen',
  'decision',
  'order',
  'fill',
  'cancel',
  'inventory',
  'resolution',
]);
const CONFIDENCE_LEVELS = new Set([
  'OBSERVED',
  'REPORTED',
  'INFERRED',
  'CANONICAL',
]);
const DECISION_ACTIONS = new Set([
  'ENTER',
  'SKIP',
  'HOLD',
  'ADD',
  'EXIT',
  'CANCEL',
  'NO_ACTION',
]);
const ORDER_STATUSES = new Set([
  'INTENT',
  'SUBMITTED',
  'ACCEPTED',
  'PARTIAL',
  'FILLED',
  'REJECTED',
  'DENIED',
  'CANCELED',
  'EXPIRED',
  'UNKNOWN',
]);
const TERMINAL_ORDER_STATUSES = new Set([
  'FILLED',
  'REJECTED',
  'DENIED',
  'CANCELED',
  'EXPIRED',
]);
const CANCEL_STATUSES = new Set([
  'CANCELED',
  'EXPIRED',
  'FAILED',
  'NOT_FOUND',
]);
const ORDER_TYPES = new Set(['GTC', 'GTD', 'FOK', 'FAK', 'UNKNOWN']);
const EXECUTION_MODES = new Set([
  'HISTORICAL',
  'SIMULATION',
  'SHADOW',
  'LIVE',
]);
const SIDES = new Set(['BUY', 'SELL']);
const OUTCOMES = new Set(['UP', 'DOWN']);
const LIQUIDITY_ROLES = new Set(['MAKER', 'TAKER', 'UNKNOWN']);
const RESOLUTION_STATUSES = new Set(['PROVISIONAL', 'FINAL']);
const DATA_STATUSES = new Set(['OBSERVED', 'DEGRADED', 'MISSING']);
const SECRET_KEY_PATTERN =
  /^(api[-_]?key|private[-_]?key|secret|passphrase|authorization|cookie|mnemonic|seed[-_]?phrase|signature)$/i;
const OPERATIONAL_PROJECTION_ID = 'pair-clip-operational-denominator';
const OPERATIONAL_PROJECTION_VERSION = 1;
const OPERATIONAL_PROJECTION_HASH = sha256Hex(
  `${OPERATIONAL_PROJECTION_ID}:${OPERATIONAL_PROJECTION_VERSION}`,
);

class LedgerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
  }
}

class LedgerValidationError extends LedgerError {}
class LedgerInvariantError extends LedgerError {}
class LedgerCorruptionError extends LedgerError {}
class IdempotencyConflictError extends LedgerError {}
class LedgerLockError extends LedgerError {}
class LedgerMaterializationError extends LedgerError {}

function isPlainObject(value) {
  if (value == null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value, at = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new LedgerValidationError(`non-finite number at ${at}`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalize(entry, `${at}[${index}]`));
  }
  if (!isPlainObject(value)) {
    throw new LedgerValidationError(`non-JSON value at ${at}`);
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) {
      throw new LedgerValidationError(`undefined value at ${at}.${key}`);
    }
    result[key] = canonicalize(value[key], `${at}.${key}`);
  }
  return result;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return crypto.createHash('sha256').update(input).digest('hex');
}

function hashDescriptor(value) {
  return sha256Hex(canonicalJson(value));
}

function assertString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LedgerValidationError(`${name} must be a non-empty string`);
  }
}

function assertBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw new LedgerValidationError(`${name} must be boolean`);
  }
}

function assertFinite(value, name, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new LedgerValidationError(
      `${name} must be finite in [${min}, ${max}]`,
    );
  }
}

function assertInteger(value, name, { min = Number.MIN_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new LedgerValidationError(
      `${name} must be a safe integer >= ${min}`,
    );
  }
}

function assertEnum(value, allowed, name) {
  assertString(value, name);
  if (!allowed.has(value)) {
    throw new LedgerValidationError(
      `${name} has unsupported value ${JSON.stringify(value)}`,
    );
  }
}

function normalizeTimestamp(value, name) {
  assertString(value, name);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new LedgerValidationError(`${name} must be an ISO-compatible timestamp`);
  }
  return new Date(ms).toISOString();
}

function assertDigest(value, name) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new LedgerValidationError(`${name} must be a SHA-256 hex digest`);
  }
  return value.toLowerCase();
}

function assertNoSecretFields(value, at = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoSecretFields(entry, `${at}[${index}]`),
    );
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new LedgerValidationError(
        `secret-like field ${JSON.stringify(key)} is forbidden at ${at}`,
      );
    }
    assertNoSecretFields(entry, `${at}.${key}`);
  }
}

function resolveDescriptorHash(name, descriptor, explicitHash) {
  if (descriptor == null && explicitHash == null) {
    throw new LedgerValidationError(
      `${name} or ${name}Hash must be provided`,
    );
  }
  if (descriptor != null) {
    canonicalize(descriptor, name);
    assertNoSecretFields(descriptor, name);
  }
  const computed = descriptor == null ? null : hashDescriptor(descriptor);
  const explicit =
    explicitHash == null ? null : assertDigest(explicitHash, `${name}Hash`);
  if (computed && explicit && computed !== explicit) {
    throw new LedgerValidationError(
      `${name}Hash does not match the supplied ${name}`,
    );
  }
  return explicit ?? computed;
}

function normalizeCommonInput(input) {
  if (!isPlainObject(input)) {
    throw new LedgerValidationError('ledger append input must be an object');
  }
  assertString(input.eventId, 'eventId');
  assertString(input.idempotencyKey, 'idempotencyKey');
  assertString(input.source, 'source');
  assertEnum(input.confidence, CONFIDENCE_LEVELS, 'confidence');
  if (!isPlainObject(input.payload)) {
    throw new LedgerValidationError('payload must be a plain object');
  }
  canonicalize(input.payload, 'payload');
  assertNoSecretFields(input.payload, 'payload');
  return {
    eventId: input.eventId,
    idempotencyKey: input.idempotencyKey,
    source: input.source,
    confidence: input.confidence,
    effectiveAt:
      input.effectiveAt == null
        ? null
        : normalizeTimestamp(input.effectiveAt, 'effectiveAt'),
    payload: canonicalize(input.payload, 'payload'),
  };
}

function validatePayload(eventType, eventId, payload) {
  if (!EVENT_TYPES.has(eventType)) {
    throw new LedgerValidationError(`unsupported event type ${eventType}`);
  }
  switch (eventType) {
    case 'event_seen': {
      assertString(payload.condition_id, 'payload.condition_id');
      if (payload.condition_id !== eventId) {
        throw new LedgerValidationError(
          'payload.condition_id must equal eventId',
        );
      }
      assertInteger(payload.event_epoch, 'payload.event_epoch', { min: 1 });
      normalizeTimestamp(payload.event_start, 'payload.event_start');
      normalizeTimestamp(payload.event_end, 'payload.event_end');
      assertString(payload.universe, 'payload.universe');
      assertEnum(
        payload.data_status,
        DATA_STATUSES,
        'payload.data_status',
      );
      break;
    }
    case 'decision': {
      assertString(payload.decision_id, 'payload.decision_id');
      assertEnum(payload.action, DECISION_ACTIONS, 'payload.action');
      assertBoolean(payload.eligible, 'payload.eligible');
      if (payload.action === 'SKIP' && payload.eligible) {
        throw new LedgerValidationError(
          'SKIP decisions must have payload.eligible=false',
        );
      }
      if (
        (payload.action === 'ENTER' || payload.action === 'ADD') &&
        !payload.eligible
      ) {
        throw new LedgerValidationError(
          `${payload.action} decisions must have payload.eligible=true`,
        );
      }
      if (
        !Array.isArray(payload.reason_codes) ||
        payload.reason_codes.length === 0
      ) {
        throw new LedgerValidationError(
          'payload.reason_codes must be a non-empty array',
        );
      }
      payload.reason_codes.forEach((reason, index) =>
        assertString(reason, `payload.reason_codes[${index}]`),
      );
      if (!isPlainObject(payload.features)) {
        throw new LedgerValidationError('payload.features must be an object');
      }
      if (
        payload.features_hash != null &&
        assertDigest(payload.features_hash, 'payload.features_hash') !==
          hashDescriptor(payload.features)
      ) {
        throw new LedgerValidationError(
          'payload.features_hash does not match payload.features',
        );
      }
      break;
    }
    case 'order': {
      assertString(payload.order_id, 'payload.order_id');
      assertEnum(payload.status, ORDER_STATUSES, 'payload.status');
      assertEnum(payload.side, SIDES, 'payload.side');
      assertEnum(payload.outcome, OUTCOMES, 'payload.outcome');
      assertEnum(payload.order_type, ORDER_TYPES, 'payload.order_type');
      assertEnum(payload.mode, EXECUTION_MODES, 'payload.mode');
      assertFinite(payload.limit_price, 'payload.limit_price', {
        min: 0,
        max: 1,
      });
      assertFinite(payload.requested_size, 'payload.requested_size', {
        min: Number.EPSILON,
      });
      assertBoolean(payload.post_only, 'payload.post_only');
      assertBoolean(payload.reduce_only, 'payload.reduce_only');
      break;
    }
    case 'fill': {
      assertString(payload.fill_id, 'payload.fill_id');
      assertString(payload.order_id, 'payload.order_id');
      assertEnum(payload.side, SIDES, 'payload.side');
      assertEnum(payload.outcome, OUTCOMES, 'payload.outcome');
      assertEnum(
        payload.liquidity_role,
        LIQUIDITY_ROLES,
        'payload.liquidity_role',
      );
      assertFinite(payload.price, 'payload.price', { min: 0, max: 1 });
      assertFinite(payload.size, 'payload.size', {
        min: Number.EPSILON,
      });
      assertFinite(payload.fee, 'payload.fee', { min: 0 });
      break;
    }
    case 'cancel': {
      assertString(payload.cancel_id, 'payload.cancel_id');
      assertString(payload.order_id, 'payload.order_id');
      assertEnum(payload.status, CANCEL_STATUSES, 'payload.status');
      assertFinite(payload.canceled_size, 'payload.canceled_size', { min: 0 });
      assertString(payload.reason_code, 'payload.reason_code');
      break;
    }
    case 'inventory': {
      assertString(payload.snapshot_id, 'payload.snapshot_id');
      for (const field of [
        'up_shares',
        'down_shares',
        'cash_spent',
        'cash_received',
        'fees_paid',
      ]) {
        assertFinite(payload[field], `payload.${field}`, { min: 0 });
      }
      if (
        payload.realized_pnl != null &&
        !Number.isFinite(payload.realized_pnl)
      ) {
        throw new LedgerValidationError(
          'payload.realized_pnl must be finite when present',
        );
      }
      if (!Array.isArray(payload.pending_order_ids)) {
        throw new LedgerValidationError(
          'payload.pending_order_ids must be an array',
        );
      }
      payload.pending_order_ids.forEach((orderId, index) =>
        assertString(orderId, `payload.pending_order_ids[${index}]`),
      );
      break;
    }
    case 'resolution': {
      assertString(payload.resolution_id, 'payload.resolution_id');
      assertEnum(payload.winner, OUTCOMES, 'payload.winner');
      assertEnum(
        payload.status,
        RESOLUTION_STATUSES,
        'payload.status',
      );
      assertFinite(payload.payout_per_share, 'payload.payout_per_share', {
        min: 0,
        max: 1,
      });
      assertString(payload.resolution_source, 'payload.resolution_source');
      break;
    }
    default:
      throw new LedgerValidationError(`unsupported event type ${eventType}`);
  }
}

function logicalContent(record) {
  return {
    ledger_id: record.ledger_id,
    idempotency_key: record.idempotency_key,
    event_type: record.event_type,
    event_id: record.event_id,
    effective_at: record.effective_at,
    source: record.source,
    confidence: record.confidence,
    policy_hash: record.policy_hash,
    build_hash: record.build_hash,
    payload: record.payload,
  };
}

function recordId(ledgerId, idempotencyKey) {
  return `op_${sha256Hex(canonicalJson({
    ledger_id: ledgerId,
    idempotency_key: idempotencyKey,
  }))}`;
}

function hashRecord(recordWithoutHash) {
  return sha256Hex(canonicalJson(recordWithoutHash));
}

function createInvariantState() {
  return {
    ledgerId: null,
    events: new Map(),
    decisions: new Map(),
    orders: new Map(),
    fills: new Map(),
    cancels: new Map(),
    inventories: new Map(),
    resolutions: new Map(),
  };
}

function cloneInvariantState(state) {
  return {
    ledgerId: state.ledgerId,
    events: new Map(
      [...state.events].map(([key, value]) => [
        key,
        {
          ...value,
          decisionIds: new Set(value.decisionIds),
          decisionActions: new Set(value.decisionActions),
          orderIds: new Set(value.orderIds),
          fillIds: new Set(value.fillIds),
          cancelIds: new Set(value.cancelIds),
          inventoryIds: new Set(value.inventoryIds),
          resolutionIds: new Set(value.resolutionIds),
          provisionalWinners: new Set(value.provisionalWinners),
        },
      ]),
    ),
    decisions: new Map(state.decisions),
    orders: new Map(
      [...state.orders].map(([key, value]) => [key, { ...value }]),
    ),
    fills: new Map(state.fills),
    cancels: new Map(state.cancels),
    inventories: new Map(state.inventories),
    resolutions: new Map(state.resolutions),
  };
}

function eventState(record, state) {
  const event = state.events.get(record.event_id);
  if (!event) {
    throw new LedgerInvariantError(
      `${record.event_type} requires event_seen for ${record.event_id}`,
      { seq: record.seq, eventId: record.event_id },
    );
  }
  return event;
}

function bindUniqueId(map, value, record, name) {
  const previous = map.get(value);
  if (previous) {
    throw new LedgerInvariantError(
      `${name} ${value} already belongs to ${previous.event_id}`,
      {
        seq: record.seq,
        eventId: record.event_id,
        previousSeq: previous.seq,
      },
    );
  }
  map.set(value, {
    event_id: record.event_id,
    record_id: record.record_id,
    seq: record.seq,
  });
}

function applyInvariant(record, state) {
  if (state.ledgerId == null) state.ledgerId = record.ledger_id;
  if (state.ledgerId !== record.ledger_id) {
    throw new LedgerInvariantError(
      `journal mixes ledger IDs ${state.ledgerId} and ${record.ledger_id}`,
    );
  }
  const payload = record.payload;
  switch (record.event_type) {
    case 'event_seen': {
      if (state.events.has(record.event_id)) {
        throw new LedgerInvariantError(
          `event_seen already exists for ${record.event_id}`,
          { seq: record.seq },
        );
      }
      state.events.set(record.event_id, {
        seenSeq: record.seq,
        decisionIds: new Set(),
        decisionActions: new Set(),
        orderIds: new Set(),
        fillIds: new Set(),
        cancelIds: new Set(),
        inventoryIds: new Set(),
        resolutionIds: new Set(),
        provisionalWinners: new Set(),
        finalWinner: null,
      });
      break;
    }
    case 'decision': {
      const event = eventState(record, state);
      bindUniqueId(
        state.decisions,
        payload.decision_id,
        record,
        'decision_id',
      );
      event.decisionIds.add(payload.decision_id);
      event.decisionActions.add(payload.action);
      break;
    }
    case 'order': {
      const event = eventState(record, state);
      const allowedByDecision =
        payload.side === 'BUY'
          ? event.decisionActions.has('ENTER') ||
            event.decisionActions.has('ADD')
          : event.decisionActions.has('EXIT');
      if (!allowedByDecision) {
        throw new LedgerInvariantError(
          `order ${payload.order_id} has no prior actionable decision`,
          {
            seq: record.seq,
            eventId: record.event_id,
            side: payload.side,
            decisionActions: [...event.decisionActions],
          },
        );
      }
      const previous = state.orders.get(payload.order_id);
      if (!previous) {
        state.orders.set(payload.order_id, {
          event_id: record.event_id,
          side: payload.side,
          outcome: payload.outcome,
          order_type: payload.order_type,
          mode: payload.mode,
          limit_price: payload.limit_price,
          requested_size: payload.requested_size,
          status: payload.status,
          filled_size: 0,
          canceled_size: 0,
          first_seq: record.seq,
          last_seq: record.seq,
        });
        event.orderIds.add(payload.order_id);
        break;
      }
      for (const field of [
        'side',
        'outcome',
        'order_type',
        'mode',
        'limit_price',
        'requested_size',
      ]) {
        if (previous[field] !== payload[field]) {
          throw new LedgerInvariantError(
            `order ${payload.order_id} changed immutable field ${field}`,
            { seq: record.seq, previousSeq: previous.first_seq },
          );
        }
      }
      if (previous.event_id !== record.event_id) {
        throw new LedgerInvariantError(
          `order ${payload.order_id} changed event`,
          { seq: record.seq, previousEventId: previous.event_id },
        );
      }
      if (
        TERMINAL_ORDER_STATUSES.has(previous.status) &&
        previous.status !== payload.status
      ) {
        throw new LedgerInvariantError(
          `terminal order ${payload.order_id} cannot transition ` +
            `${previous.status} -> ${payload.status}`,
          { seq: record.seq },
        );
      }
      previous.status = payload.status;
      previous.last_seq = record.seq;
      break;
    }
    case 'fill': {
      const event = eventState(record, state);
      bindUniqueId(state.fills, payload.fill_id, record, 'fill_id');
      const order = state.orders.get(payload.order_id);
      if (!order || order.event_id !== record.event_id) {
        throw new LedgerInvariantError(
          `fill ${payload.fill_id} references an unknown order for this event`,
          { seq: record.seq, orderId: payload.order_id },
        );
      }
      if (order.side !== payload.side || order.outcome !== payload.outcome) {
        throw new LedgerInvariantError(
          `fill ${payload.fill_id} side/outcome differs from its order`,
          { seq: record.seq, orderId: payload.order_id },
        );
      }
      if (order.status === 'REJECTED' || order.status === 'DENIED') {
        throw new LedgerInvariantError(
          `rejected/denied order ${payload.order_id} cannot fill`,
          { seq: record.seq },
        );
      }
      const newFilled = order.filled_size + payload.size;
      if (
        newFilled + order.canceled_size >
        order.requested_size + Number.EPSILON * 16
      ) {
        throw new LedgerInvariantError(
          `fill ${payload.fill_id} over-consumes order ${payload.order_id}`,
          {
            seq: record.seq,
            requestedSize: order.requested_size,
            filledSize: newFilled,
            canceledSize: order.canceled_size,
          },
        );
      }
      order.filled_size = newFilled;
      event.fillIds.add(payload.fill_id);
      break;
    }
    case 'cancel': {
      const event = eventState(record, state);
      bindUniqueId(state.cancels, payload.cancel_id, record, 'cancel_id');
      const order = state.orders.get(payload.order_id);
      if (!order || order.event_id !== record.event_id) {
        throw new LedgerInvariantError(
          `cancel ${payload.cancel_id} references an unknown order`,
          { seq: record.seq, orderId: payload.order_id },
        );
      }
      if (
        order.filled_size + payload.canceled_size >
        order.requested_size + Number.EPSILON * 16
      ) {
        throw new LedgerInvariantError(
          `cancel ${payload.cancel_id} over-consumes order ${payload.order_id}`,
          {
            seq: record.seq,
            requestedSize: order.requested_size,
            filledSize: order.filled_size,
            canceledSize: payload.canceled_size,
          },
        );
      }
      if (
        order.status === 'FILLED' &&
        (payload.status === 'CANCELED' || payload.status === 'EXPIRED')
      ) {
        throw new LedgerInvariantError(
          `filled order ${payload.order_id} cannot be canceled`,
          { seq: record.seq },
        );
      }
      order.canceled_size = Math.max(
        order.canceled_size,
        payload.canceled_size,
      );
      if (payload.status === 'CANCELED' || payload.status === 'EXPIRED') {
        order.status = payload.status;
      }
      event.cancelIds.add(payload.cancel_id);
      break;
    }
    case 'inventory': {
      const event = eventState(record, state);
      bindUniqueId(
        state.inventories,
        payload.snapshot_id,
        record,
        'snapshot_id',
      );
      for (const orderId of payload.pending_order_ids) {
        const order = state.orders.get(orderId);
        if (!order || order.event_id !== record.event_id) {
          throw new LedgerInvariantError(
            `inventory references unknown pending order ${orderId}`,
            { seq: record.seq },
          );
        }
      }
      event.inventoryIds.add(payload.snapshot_id);
      break;
    }
    case 'resolution': {
      const event = eventState(record, state);
      bindUniqueId(
        state.resolutions,
        payload.resolution_id,
        record,
        'resolution_id',
      );
      if (
        payload.status === 'FINAL' &&
        event.finalWinner != null &&
        event.finalWinner !== payload.winner
      ) {
        throw new LedgerInvariantError(
          `conflicting FINAL resolution for ${record.event_id}`,
          {
            seq: record.seq,
            previousWinner: event.finalWinner,
            newWinner: payload.winner,
          },
        );
      }
      if (payload.status === 'FINAL') event.finalWinner = payload.winner;
      else event.provisionalWinners.add(payload.winner);
      event.resolutionIds.add(payload.resolution_id);
      break;
    }
    default:
      throw new LedgerInvariantError(
        `unhandled event type ${record.event_type}`,
      );
  }
  return state;
}

function validateRecordShape(record, expectedSeq, expectedPrevHash) {
  if (!isPlainObject(record)) {
    throw new LedgerCorruptionError(`record ${expectedSeq} is not an object`);
  }
  if (record.schema_version !== SCHEMA_VERSION) {
    throw new LedgerCorruptionError(
      `record ${expectedSeq} has unsupported schema_version`,
    );
  }
  if (record.seq !== expectedSeq) {
    throw new LedgerCorruptionError(
      `record sequence gap: expected ${expectedSeq}, received ${record.seq}`,
    );
  }
  assertString(record.ledger_id, 'record.ledger_id');
  assertString(record.idempotency_key, 'record.idempotency_key');
  assertString(record.event_id, 'record.event_id');
  assertString(record.source, 'record.source');
  assertEnum(record.event_type, EVENT_TYPES, 'record.event_type');
  assertEnum(record.confidence, CONFIDENCE_LEVELS, 'record.confidence');
  normalizeTimestamp(record.ingested_at, 'record.ingested_at');
  if (record.effective_at != null) {
    normalizeTimestamp(record.effective_at, 'record.effective_at');
  }
  assertDigest(record.policy_hash, 'record.policy_hash');
  assertDigest(record.build_hash, 'record.build_hash');
  assertDigest(record.content_hash, 'record.content_hash');
  assertDigest(record.prev_hash, 'record.prev_hash');
  assertDigest(record.record_hash, 'record.record_hash');
  if (record.prev_hash !== expectedPrevHash) {
    throw new LedgerCorruptionError(
      `record ${record.seq} prev_hash does not match the verified tail`,
    );
  }
  const expectedRecordId = recordId(
    record.ledger_id,
    record.idempotency_key,
  );
  if (record.record_id !== expectedRecordId) {
    throw new LedgerCorruptionError(
      `record ${record.seq} has an invalid record_id`,
    );
  }
  canonicalize(record.payload, 'record.payload');
  assertNoSecretFields(record.payload, 'record.payload');
  validatePayload(record.event_type, record.event_id, record.payload);
  const expectedContentHash = hashDescriptor(logicalContent(record));
  if (record.content_hash !== expectedContentHash) {
    throw new LedgerCorruptionError(
      `record ${record.seq} content_hash mismatch`,
    );
  }
  const { record_hash: ignored, ...withoutHash } = record;
  void ignored;
  const expectedRecordHash = hashRecord(withoutHash);
  if (record.record_hash !== expectedRecordHash) {
    throw new LedgerCorruptionError(
      `record ${record.seq} record_hash mismatch`,
    );
  }
}

function parseJournalBuffer(buffer, journalPath = '<memory>') {
  if (buffer.length > 0 && buffer.at(-1) !== 0x0a) {
    throw new LedgerCorruptionError(
      `journal ${journalPath} has a partial final line`,
    );
  }
  const records = [];
  const entries = [];
  const ids = new Map();
  const invariantState = createInvariantState();
  let start = 0;
  let previousHash = GENESIS_HASH;
  while (start < buffer.length) {
    const newline = buffer.indexOf(0x0a, start);
    const end = newline + 1;
    const raw = buffer.subarray(start, newline);
    if (raw.length === 0) {
      throw new LedgerCorruptionError(
        `journal ${journalPath} contains a blank line at byte ${start}`,
      );
    }
    let record;
    try {
      record = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      throw new LedgerCorruptionError(
        `invalid JSON at ${journalPath}:${records.length + 1}: ${error.message}`,
      );
    }
    try {
      validateRecordShape(record, records.length + 1, previousHash);
      if (ids.has(record.record_id)) {
        throw new LedgerCorruptionError(
          `duplicate record_id ${record.record_id} at seq ${record.seq}`,
        );
      }
      applyInvariant(record, invariantState);
    } catch (error) {
      if (error instanceof LedgerCorruptionError) throw error;
      throw new LedgerCorruptionError(
        `invalid record at ${journalPath}:${records.length + 1}: ${error.message}`,
        { cause: error, seq: records.length + 1 },
      );
    }
    records.push(record);
    entries.push({ startOffset: start, endOffset: end });
    ids.set(record.record_id, record);
    previousHash = record.record_hash;
    start = end;
  }
  return {
    records,
    entries,
    idIndex: ids,
    invariantState,
    ledgerId: invariantState.ledgerId,
    tailHash: previousHash,
    size: buffer.length,
    journalHash: sha256Hex(buffer),
    buffer,
  };
}

function readVerifiedJournal(journalPath) {
  let buffer;
  try {
    buffer = fs.readFileSync(journalPath);
  } catch (error) {
    if (error.code === 'ENOENT') buffer = Buffer.alloc(0);
    else throw error;
  }
  return parseJournalBuffer(buffer, journalPath);
}

async function ensureParent(file) {
  await fs.promises.mkdir(path.dirname(path.resolve(file)), {
    recursive: true,
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireFileLock(
  lockPath,
  {
    timeoutMs = 10_000,
      staleMs = 300_000,
    pollMs = 25,
    writerId = crypto.randomUUID(),
  } = {},
) {
  await ensureParent(lockPath);
  const started = Date.now();
  const token = crypto.randomUUID();
  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx', 0o600);
      const body = `${JSON.stringify({
        token,
        writer_id: writerId,
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      })}\n`;
      await handle.writeFile(body, 'utf8');
      await handle.sync();
      return async () => {
        await handle.close();
        try {
          const current = JSON.parse(
            (await fs.promises.readFile(lockPath, 'utf8')).trim(),
          );
          if (current.token === token) await fs.promises.unlink(lockPath);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.promises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.promises.unlink(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new LedgerLockError(
          `timed out waiting for ledger lock ${lockPath}`,
          { timeoutMs },
        );
      }
      const jitter = Math.floor(Math.random() * Math.max(1, pollMs));
      await wait(pollMs + jitter);
    }
  }
}

async function appendDurably(journalPath, records) {
  if (!records.length) return 0;
  await ensureParent(journalPath);
  const data = Buffer.from(
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
  const handle = await fs.promises.open(journalPath, 'a', 0o600);
  try {
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await handle.write(
        data,
        offset,
        data.length - offset,
      );
      if (bytesWritten <= 0) {
        throw new LedgerError(`zero-byte append to ${journalPath}`);
      }
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return data.length;
}

class OperationalLedger {
  constructor(options) {
    if (!isPlainObject(options)) {
      throw new LedgerValidationError('ledger options must be an object');
    }
    assertString(options.journalPath, 'journalPath');
    assertString(options.ledgerId, 'ledgerId');
    this.journalPath = path.resolve(options.journalPath);
    this.lockPath = path.resolve(
      options.lockPath ?? `${this.journalPath}.lock`,
    );
    this.ledgerId = options.ledgerId;
    this.policyHash = resolveDescriptorHash(
      'policy',
      options.policy,
      options.policyHash,
    );
    this.buildHash = resolveDescriptorHash(
      'build',
      options.build,
      options.buildHash,
    );
    this.writerId = options.writerId ?? crypto.randomUUID();
    assertString(this.writerId, 'writerId');
    this.clock = options.clock ?? (() => new Date().toISOString());
    if (typeof this.clock !== 'function') {
      throw new LedgerValidationError('clock must be a function');
    }
    this.lockOptions = {
      timeoutMs: options.lockTimeoutMs ?? 10_000,
      staleMs: options.staleLockMs ?? 300_000,
      pollMs: options.lockPollMs ?? 25,
      writerId: this.writerId,
    };
    this._state = null;
    this._queue = Promise.resolve();
  }

  static async open(options) {
    const ledger = new OperationalLedger(options);
    await ledger.refresh();
    return ledger;
  }

  async refresh() {
    const release = await acquireFileLock(this.lockPath, this.lockOptions);
    try {
      return await this.#refreshUnlocked();
    } finally {
      await release();
    }
  }

  async #refreshUnlocked() {
    const verified = readVerifiedJournal(this.journalPath);
    if (verified.ledgerId && verified.ledgerId !== this.ledgerId) {
      throw new LedgerInvariantError(
        `journal belongs to ${verified.ledgerId}, not ${this.ledgerId}`,
      );
    }
    try {
      const stat = await fs.promises.stat(this.journalPath);
      if (stat.size !== verified.size) {
        throw new LedgerCorruptionError(
          `journal changed while being refreshed: ${this.journalPath}`,
        );
      }
      verified.mtimeMs = stat.mtimeMs;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      verified.mtimeMs = 0;
    }
    this._state = verified;
    return verified;
  }

  append(eventType, input) {
    return this.appendMany([{ ...input, eventType }]).then(
      (result) => result.results[0],
    );
  }

  appendMany(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return Promise.reject(
        new LedgerValidationError('appendMany requires at least one entry'),
      );
    }
    const execute = () => this.#appendMany(entries);
    const result = this._queue.then(execute, execute);
    this._queue = result.catch(() => {});
    return result;
  }

  async #appendMany(entries) {
    const release = await acquireFileLock(this.lockPath, this.lockOptions);
    try {
      let statSize = 0;
      let statMtimeMs = 0;
      try {
        const stat = await fs.promises.stat(this.journalPath);
        statSize = stat.size;
        statMtimeMs = stat.mtimeMs;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (
        !this._state ||
        this._state.size !== statSize ||
        this._state.mtimeMs !== statMtimeMs
      ) {
        await this.#refreshUnlocked();
      }
      const idIndex = new Map(this._state.idIndex);
      const invariantState = cloneInvariantState(this._state.invariantState);
      const newRecords = [];
      const results = [];
      let seq = this._state.records.length;
      let prevHash = this._state.tailHash;

      for (const rawEntry of entries) {
        if (!isPlainObject(rawEntry)) {
          throw new LedgerValidationError('batch entry must be an object');
        }
        const eventType = rawEntry.eventType;
        assertEnum(eventType, EVENT_TYPES, 'eventType');
        const input = normalizeCommonInput(rawEntry);
        const policyHash =
          rawEntry.policyHash == null
            ? this.policyHash
            : assertDigest(rawEntry.policyHash, 'policyHash');
        const buildHash =
          rawEntry.buildHash == null
            ? this.buildHash
            : assertDigest(rawEntry.buildHash, 'buildHash');
        const payload =
          eventType === 'decision' && input.payload.features_hash == null
            ? {
                ...input.payload,
                features_hash: hashDescriptor(input.payload.features),
              }
            : input.payload;
        validatePayload(eventType, input.eventId, payload);
        const id = recordId(this.ledgerId, input.idempotencyKey);
        const logical = {
          ledger_id: this.ledgerId,
          idempotency_key: input.idempotencyKey,
          event_type: eventType,
          event_id: input.eventId,
          effective_at: input.effectiveAt,
          source: input.source,
          confidence: input.confidence,
          policy_hash: policyHash,
          build_hash: buildHash,
          payload,
        };
        const contentHash = hashDescriptor(logical);
        const existing = idIndex.get(id);
        if (existing) {
          if (existing.content_hash !== contentHash) {
            throw new IdempotencyConflictError(
              `idempotency key ${input.idempotencyKey} already has different content`,
              {
                recordId: id,
                existingSeq: existing.seq,
                existingContentHash: existing.content_hash,
                newContentHash: contentHash,
              },
            );
          }
          results.push({
            appended: false,
            duplicate: true,
            record: existing,
          });
          continue;
        }
        const recordWithoutHash = {
          schema_version: SCHEMA_VERSION,
          ledger_id: this.ledgerId,
          seq: seq + 1,
          record_id: id,
          idempotency_key: input.idempotencyKey,
          event_type: eventType,
          event_id: input.eventId,
          ingested_at: normalizeTimestamp(this.clock(), 'clock()'),
          effective_at: input.effectiveAt,
          source: input.source,
          confidence: input.confidence,
          policy_hash: policyHash,
          build_hash: buildHash,
          payload,
          content_hash: contentHash,
          prev_hash: prevHash,
        };
        const record = {
          ...recordWithoutHash,
          record_hash: hashRecord(recordWithoutHash),
        };
        applyInvariant(record, invariantState);
        newRecords.push(record);
        idIndex.set(id, record);
        results.push({
          appended: true,
          duplicate: false,
          record,
        });
        seq = record.seq;
        prevHash = record.record_hash;
      }

      const bytesWritten = await appendDurably(this.journalPath, newRecords);
      if (newRecords.length) {
        await this.#refreshUnlocked();
      }
      return {
        appended: newRecords.length,
        duplicates: results.length - newRecords.length,
        bytesWritten,
        results,
        tail: {
          seq: this._state.records.length,
          recordHash: this._state.tailHash,
        },
      };
    } finally {
      await release();
    }
  }

  verify() {
    return readVerifiedJournal(this.journalPath);
  }
}

function createOperationalProjection() {
  return {
    schema_version: 1,
    totals: {
      records: 0,
      by_type: Object.fromEntries([...EVENT_TYPES].map((type) => [type, 0])),
      fill_size: 0,
      fill_notional: 0,
      fees: 0,
    },
    events: {},
    denominator: {
      events_seen: 0,
      events_with_decision: 0,
      events_without_decision: 0,
      events_entered: 0,
      events_skipped_only: 0,
      events_with_orders: 0,
      events_with_fills: 0,
      events_with_cancels: 0,
      events_with_inventory: 0,
      events_finally_resolved: 0,
    },
  };
}

function projectionEvent(record, state) {
  const event = state.events[record.event_id];
  if (!event) {
    throw new LedgerMaterializationError(
      `projection is missing event_seen for ${record.event_id}`,
      { seq: record.seq },
    );
  }
  return event;
}

function reduceOperationalRecord(state, record) {
  state.totals.records += 1;
  state.totals.by_type[record.event_type] += 1;
  const payload = record.payload;
  switch (record.event_type) {
    case 'event_seen':
      state.events[record.event_id] = {
        condition_id: payload.condition_id,
        event_epoch: payload.event_epoch,
        event_start: payload.event_start,
        event_end: payload.event_end,
        universe: payload.universe,
        data_status: payload.data_status,
        seen_seq: record.seq,
        policy_hash: record.policy_hash,
        build_hash: record.build_hash,
        decision_count: 0,
        decisions_by_action: {},
        reason_counts: {},
        latest_decision: null,
        orders: {},
        fill_count: 0,
        fill_size: 0,
        fill_notional: 0,
        fees: 0,
        cancel_count: 0,
        inventory_count: 0,
        latest_inventory: null,
        provisional_winners: [],
        final_resolution: null,
        last_seq: record.seq,
      };
      break;
    case 'decision': {
      const event = projectionEvent(record, state);
      event.decision_count += 1;
      event.decisions_by_action[payload.action] =
        (event.decisions_by_action[payload.action] ?? 0) + 1;
      for (const reason of payload.reason_codes) {
        event.reason_counts[reason] = (event.reason_counts[reason] ?? 0) + 1;
      }
      event.latest_decision = {
        seq: record.seq,
        decision_id: payload.decision_id,
        action: payload.action,
        eligible: payload.eligible,
        reason_codes: payload.reason_codes,
        features_hash: payload.features_hash,
        policy_hash: record.policy_hash,
        build_hash: record.build_hash,
      };
      event.last_seq = record.seq;
      break;
    }
    case 'order': {
      const event = projectionEvent(record, state);
      const previous = event.orders[payload.order_id] ?? {
        first_seq: record.seq,
        observations: 0,
        filled_size: 0,
        fill_notional: 0,
        fees: 0,
        canceled_size: 0,
      };
      event.orders[payload.order_id] = {
        ...previous,
        last_seq: record.seq,
        observations: previous.observations + 1,
        status: payload.status,
        side: payload.side,
        outcome: payload.outcome,
        order_type: payload.order_type,
        mode: payload.mode,
        limit_price: payload.limit_price,
        requested_size: payload.requested_size,
        post_only: payload.post_only,
        reduce_only: payload.reduce_only,
      };
      event.last_seq = record.seq;
      break;
    }
    case 'fill': {
      const event = projectionEvent(record, state);
      const order = event.orders[payload.order_id];
      order.filled_size += payload.size;
      order.fill_notional += payload.size * payload.price;
      order.fees += payload.fee;
      event.fill_count += 1;
      event.fill_size += payload.size;
      event.fill_notional += payload.size * payload.price;
      event.fees += payload.fee;
      event.last_seq = record.seq;
      state.totals.fill_size += payload.size;
      state.totals.fill_notional += payload.size * payload.price;
      state.totals.fees += payload.fee;
      break;
    }
    case 'cancel': {
      const event = projectionEvent(record, state);
      const order = event.orders[payload.order_id];
      order.canceled_size = Math.max(
        order.canceled_size,
        payload.canceled_size,
      );
      order.cancel_status = payload.status;
      if (payload.status === 'CANCELED' || payload.status === 'EXPIRED') {
        order.status = payload.status;
      }
      event.cancel_count += 1;
      event.last_seq = record.seq;
      break;
    }
    case 'inventory': {
      const event = projectionEvent(record, state);
      event.inventory_count += 1;
      event.latest_inventory = {
        seq: record.seq,
        ...payload,
      };
      event.last_seq = record.seq;
      break;
    }
    case 'resolution': {
      const event = projectionEvent(record, state);
      if (payload.status === 'FINAL') {
        event.final_resolution = {
          seq: record.seq,
          winner: payload.winner,
          payout_per_share: payload.payout_per_share,
          resolution_source: payload.resolution_source,
          source: record.source,
          confidence: record.confidence,
        };
      } else if (!event.provisional_winners.includes(payload.winner)) {
        event.provisional_winners.push(payload.winner);
        event.provisional_winners.sort();
      }
      event.last_seq = record.seq;
      break;
    }
    default:
      throw new LedgerMaterializationError(
        `projection cannot handle ${record.event_type}`,
      );
  }
  return state;
}

function finalizeOperationalProjection(state) {
  const denominator = {
    events_seen: 0,
    events_with_decision: 0,
    events_without_decision: 0,
    events_entered: 0,
    events_skipped_only: 0,
    events_with_orders: 0,
    events_with_fills: 0,
    events_with_cancels: 0,
    events_with_inventory: 0,
    events_finally_resolved: 0,
  };
  for (const event of Object.values(state.events)) {
    denominator.events_seen += 1;
    if (event.decision_count > 0) denominator.events_with_decision += 1;
    else denominator.events_without_decision += 1;
    const entered =
      (event.decisions_by_action.ENTER ?? 0) > 0 ||
      (event.decisions_by_action.ADD ?? 0) > 0;
    if (entered) denominator.events_entered += 1;
    if (!entered && (event.decisions_by_action.SKIP ?? 0) > 0) {
      denominator.events_skipped_only += 1;
    }
    if (Object.keys(event.orders).length > 0) {
      denominator.events_with_orders += 1;
    }
    if (event.fill_count > 0) denominator.events_with_fills += 1;
    if (event.cancel_count > 0) denominator.events_with_cancels += 1;
    if (event.inventory_count > 0) denominator.events_with_inventory += 1;
    if (event.final_resolution) denominator.events_finally_resolved += 1;
  }
  state.denominator = denominator;
  return state;
}

async function writeJsonAtomically(targetPath, value) {
  await ensureParent(targetPath);
  const absolute = path.resolve(targetPath);
  const temp = `${absolute}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await fs.promises.open(temp, 'wx', 0o600);
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temp, absolute);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temp).catch(() => {});
    throw error;
  }
}

function loadMaterialized(materializedPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(materializedPath, 'utf8'));
    if (!isPlainObject(parsed)) {
      throw new Error('materialization root is not an object');
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new LedgerMaterializationError(
      `cannot load materialization ${materializedPath}: ${error.message}`,
      { cause: error },
    );
  }
}

function validateResumeCheckpoint(materialized, verified) {
  if (
    materialized.schema_version !== 1 ||
    materialized.projection_id !== OPERATIONAL_PROJECTION_ID ||
    materialized.projection_hash !== OPERATIONAL_PROJECTION_HASH
  ) {
    return false;
  }
  if (materialized.ledger_id !== verified.ledgerId) {
    throw new LedgerMaterializationError(
      'materialization belongs to a different ledger',
    );
  }
  const checkpoint = materialized.checkpoint;
  if (
    !isPlainObject(checkpoint) ||
    !Number.isSafeInteger(checkpoint.last_seq) ||
    checkpoint.last_seq < 0 ||
    checkpoint.last_seq > verified.records.length
  ) {
    throw new LedgerMaterializationError('invalid materialization checkpoint');
  }
  const expectedHash =
    checkpoint.last_seq === 0
      ? GENESIS_HASH
      : verified.records[checkpoint.last_seq - 1].record_hash;
  const expectedOffset =
    checkpoint.last_seq === 0
      ? 0
      : verified.entries[checkpoint.last_seq - 1].endOffset;
  if (
    checkpoint.last_record_hash !== expectedHash ||
    checkpoint.journal_offset !== expectedOffset
  ) {
    throw new LedgerMaterializationError(
      'materialization checkpoint does not match the journal chain',
    );
  }
  const prefixHash = sha256Hex(
    verified.buffer.subarray(0, checkpoint.journal_offset),
  );
  if (checkpoint.journal_prefix_hash !== prefixHash) {
    throw new LedgerMaterializationError(
      'materialized journal prefix hash mismatch',
    );
  }
  if (!isPlainObject(materialized.state)) {
    throw new LedgerMaterializationError('materialized state is invalid');
  }
  if (
    assertDigest(materialized.state_hash, 'materialized.state_hash') !==
    hashDescriptor(materialized.state)
  ) {
    throw new LedgerMaterializationError(
      'materialized state hash mismatch',
    );
  }
  return true;
}

async function materializeOperationalLedger({
  journalPath,
  materializedPath,
  resume = true,
  clock = () => new Date().toISOString(),
  journalLockPath = null,
  lockTimeoutMs = 10_000,
  staleLockMs = 300_000,
}) {
  assertString(journalPath, 'journalPath');
  assertString(materializedPath, 'materializedPath');
  if (typeof clock !== 'function') {
    throw new LedgerValidationError('clock must be a function');
  }
  const absoluteJournal = path.resolve(journalPath);
  const absoluteMaterialized = path.resolve(materializedPath);
  const materializedRelease = await acquireFileLock(
    `${absoluteMaterialized}.lock`,
    {
      timeoutMs: lockTimeoutMs,
      staleMs: staleLockMs,
      writerId: `materializer:${process.pid}`,
    },
  );
  try {
    const journalRelease = await acquireFileLock(
      path.resolve(journalLockPath ?? `${absoluteJournal}.lock`),
      {
        timeoutMs: lockTimeoutMs,
        staleMs: staleLockMs,
        writerId: `materializer-snapshot:${process.pid}`,
      },
    );
    let verified;
    try {
      verified = readVerifiedJournal(absoluteJournal);
    } finally {
      await journalRelease();
    }
    let state = createOperationalProjection();
    let startSeq = 0;
    let resumed = false;
    if (resume) {
      const existing = loadMaterialized(absoluteMaterialized);
      if (existing && validateResumeCheckpoint(existing, verified)) {
        state = existing.state;
        startSeq = existing.checkpoint.last_seq;
        resumed = true;
      }
    }
    for (let index = startSeq; index < verified.records.length; index += 1) {
      reduceOperationalRecord(state, verified.records[index]);
    }
    finalizeOperationalProjection(state);
    const lastSeq = verified.records.length;
    const lastOffset =
      lastSeq === 0 ? 0 : verified.entries[lastSeq - 1].endOffset;
    const materialized = {
      schema_version: 1,
      projection_id: OPERATIONAL_PROJECTION_ID,
      projection_version: OPERATIONAL_PROJECTION_VERSION,
      projection_hash: OPERATIONAL_PROJECTION_HASH,
      ledger_id: verified.ledgerId,
      generated_at: normalizeTimestamp(clock(), 'clock()'),
      checkpoint: {
        last_seq: lastSeq,
        last_record_hash: verified.tailHash,
        journal_offset: lastOffset,
        journal_prefix_hash: sha256Hex(
          verified.buffer.subarray(0, lastOffset),
        ),
      },
      state,
      state_hash: hashDescriptor(state),
    };
    await writeJsonAtomically(absoluteMaterialized, materialized);
    return {
      resumed,
      appliedRecords: verified.records.length - startSeq,
      materialized,
    };
  } finally {
    await materializedRelease();
  }
}

export {
  CONFIDENCE_LEVELS,
  EVENT_TYPES,
  GENESIS_HASH,
  IdempotencyConflictError,
  LedgerCorruptionError,
  LedgerError,
  LedgerInvariantError,
  LedgerLockError,
  LedgerMaterializationError,
  LedgerValidationError,
  OPERATIONAL_PROJECTION_HASH,
  OperationalLedger,
  SCHEMA_VERSION,
  canonicalJson,
  createOperationalProjection,
  finalizeOperationalProjection,
  hashDescriptor,
  materializeOperationalLedger,
  parseJournalBuffer,
  readVerifiedJournal,
  recordId,
  reduceOperationalRecord,
  sha256Hex,
};
