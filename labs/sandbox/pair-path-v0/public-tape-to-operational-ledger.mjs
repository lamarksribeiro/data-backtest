#!/usr/bin/env node
/**
 * Import public market-tape evidence into the Pair/Clip operational denominator.
 *
 * This is deliberately a HOLD policy importer:
 *   - every discovered BTC 5m market becomes event_seen;
 *   - every event receives exactly one deterministic SKIP decision because no
 *     executable Pair/Clip policy currently passes the research gates;
 *   - raw public tape remains the evidence source; the operational projection
 *     is disposable and reproducible.
 *
 * It has no network client, credentials, account access, or order surface.
 *
 * Usage:
 *   node labs/sandbox/pair-path-v0/public-tape-to-operational-ledger.mjs \
 *     --input=.tmp/public-market-tape/<run>/events.jsonl \
 *     --out=.tmp/pair-clip-operational-shadow
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OperationalLedger,
  materializeOperationalLedger,
  sha256Hex,
} from './operational-ledger.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = process.argv.slice(2).find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (
    index >= 0 &&
    process.argv[index + 1] &&
    !process.argv[index + 1].startsWith('--')
  ) {
    return process.argv[index + 1];
  }
  return fallback;
}

const POLICY = Object.freeze({
  strategy: 'pair-clip-denominator-shadow',
  version: 1,
  status: 'HOLD_PARITY_GAP',
  action: 'SKIP',
  executableCandidateCount: 0,
  rationale:
    'No Pair/Clip/TSC protection candidate passes PnL, fill realism, and hard-risk gates.',
});

const BUILD = Object.freeze({
  module: 'public-tape-to-operational-ledger.mjs',
  schema: 1,
  orderSurface: false,
});

function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid JSONL at ${file}:${index + 1}: ${error.message}`);
      }
    });
}

function isoFromSeconds(seconds) {
  return new Date(Number(seconds) * 1000).toISOString();
}

function assertDiscovery(record) {
  if (record?.recordType !== 'market.discovery') return false;
  const market = record.market;
  if (
    !market ||
    typeof market.conditionId !== 'string' ||
    !market.conditionId ||
    !Number.isSafeInteger(Number(market.eventStartSec)) ||
    !Number.isSafeInteger(Number(market.eventEndSec)) ||
    !String(market.slug ?? '').startsWith('btc-updown-5m-')
  ) {
    throw new Error(
      `malformed market.discovery ${record?.recordId ?? '<unknown>'}`,
    );
  }
  return true;
}

function discoveryEntries(record) {
  const market = record.market;
  const eventId = market.conditionId;
  const eventStart = isoFromSeconds(market.eventStartSec);
  const eventEnd = isoFromSeconds(market.eventEndSec);
  const discoveryHash =
    record.data?.discoveryHash ??
    sha256Hex(
      JSON.stringify({
        conditionId: eventId,
        slug: market.slug,
        eventStartSec: market.eventStartSec,
        eventEndSec: market.eventEndSec,
      }),
    );
  return [
    {
      eventType: 'event_seen',
      eventId,
      idempotencyKey: `public-seen:${eventId}`,
      effectiveAt: eventStart,
      source: 'polymarket-public-market-tape',
      confidence: 'OBSERVED',
      payload: {
        condition_id: eventId,
        event_epoch: Number(market.eventStartSec),
        event_start: eventStart,
        event_end: eventEnd,
        universe: 'BTC-5M',
        data_status: 'OBSERVED',
      },
    },
    {
      eventType: 'decision',
      eventId,
      idempotencyKey: `hold-v1:${eventId}`,
      effectiveAt: eventStart,
      source: 'pair-clip-denominator-shadow-hold-v1',
      confidence: 'OBSERVED',
      payload: {
        decision_id: `hold-v1-${eventId}`,
        action: 'SKIP',
        eligible: false,
        reason_codes: [
          'HOLD_PARITY_GAP',
          'NO_FROZEN_EXECUTABLE_POLICY',
          'RISK_GATE_FAILED',
        ],
        features: {
          event_slug: market.slug,
          public_discovery_hash: discoveryHash,
          candidate_count: 0,
          policy_status: 'HOLD_PARITY_GAP',
        },
      },
    },
  ];
}

export async function importPublicTape({
  inputPath,
  outputDirectory,
  clock = () => new Date().toISOString(),
}) {
  const input = path.resolve(inputPath);
  const out = path.resolve(outputDirectory);
  fs.mkdirSync(out, { recursive: true });
  const journalPath = path.join(out, 'operational-shadow.jsonl');
  const materializedPath = path.join(
    out,
    'operational-shadow.materialized.json',
  );
  const records = readJsonl(input);
  const discoveries = records.filter(assertDiscovery);
  const byCondition = new Map();
  for (const discovery of discoveries) {
    const conditionId = discovery.market.conditionId;
    const previous = byCondition.get(conditionId);
    if (
      previous &&
      JSON.stringify(discoveryEntries(previous)) !==
        JSON.stringify(discoveryEntries(discovery))
    ) {
      throw new Error(`conflicting discoveries for ${conditionId}`);
    }
    if (!previous) byCondition.set(conditionId, discovery);
  }

  const ledger = await OperationalLedger.open({
    journalPath,
    ledgerId: 'pair-clip-operational-shadow-v1',
    policy: POLICY,
    build: BUILD,
    clock,
  });
  let appended = 0;
  let duplicates = 0;
  for (const discovery of byCondition.values()) {
    const result = await ledger.appendMany(discoveryEntries(discovery));
    appended += result.appended;
    duplicates += result.duplicates;
  }
  const materialized = await materializeOperationalLedger({
    journalPath,
    materializedPath,
    clock,
  });
  const summary = {
    schema: 'pair-clip-public-shadow-import/v1',
    input,
    input_sha256: sha256Hex(fs.readFileSync(input)),
    journalPath,
    materializedPath,
    publicRecords: records.length,
    marketDiscoveries: discoveries.length,
    uniqueMarkets: byCondition.size,
    appended,
    duplicates,
    policy: POLICY,
    denominator: materialized.materialized.state.denominator,
    tail: materialized.materialized.checkpoint,
  };
  fs.writeFileSync(
    path.join(out, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  return summary;
}

async function main() {
  const input = arg('input');
  if (!input) throw new Error('--input is required');
  const outputDirectory = path.resolve(
    arg('out', path.join(ROOT, '.tmp/pair-clip-operational-shadow')),
  );
  const summary = await importPublicTape({
    inputPath: path.resolve(input),
    outputDirectory,
  });
  console.log(JSON.stringify(summary, null, 2));
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

