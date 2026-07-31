#!/usr/bin/env node
/**
 * Prospective public BTC 5m market evidence collector.
 *
 * Public/read-only surface only:
 *   GET gamma-api.polymarket.com/markets
 *   GET clob.polymarket.com/book
 *   WSS ws-subscriptions-clob.polymarket.com/ws/market
 *
 * It never loads wallet credentials and contains no order endpoint.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CLOB_MARKET_WS,
  CLOB_ORIGIN,
  PublicTapeRecorder,
  assertPublicReadOnlyUrl,
  createJsonlEventSink,
  currentBtc5mSlug,
  discoverCurrentBtc5mMarket,
  evaluateEvidenceGates,
  fetchPublicJson,
  replayPublicTapeFixture,
} from './public-tape-core.mjs';

const HELP = `
Public BTC 5m market evidence collector (read-only, zero orders)

Live:
  node labs/sandbox/pair-path-v0/public-tape-collector.mjs \\
    --minutes 2 --market-windows 1 --max-ws-messages 2000

Replay:
  node labs/sandbox/pair-path-v0/public-tape-collector.mjs \\
    --replay tests/fixtures/public-tape-btc5m.jsonl --out .tmp/tape-replay/events.jsonl

Quotas:
  --minutes N              Hard live runtime quota; decimals allowed (default 5)
  --market-windows N       Maximum distinct BTC 5m windows (default 1)
  --max-ws-messages N      Stop after N public WS envelopes (default 50000)
  --max-records N          Stop after N normalized ledger records (default 100000)
  --max-messages N         Replay input-line quota (default unlimited)

Evidence gates:
  --min-discoveries N      Default 1
  --min-book-snapshots N   REST + WS full snapshots; default 2
  --min-ws-messages N      Normalized public WS items; default 1
  --min-trades N           Default 0 (set >0 for a trade-bearing canary)
  --max-malformed N        Default 0
  --max-unknown-assets N   Default 0
  --no-fail-on-gate        Report failure without exit code 2

Other:
  --out FILE               Append-only normalized JSONL output
  --summary FILE           Summary JSON (default beside --out)
  --rest-resync-sec N      Public REST book resync cadence (default 30; 0 disables)
  --discovery-ms N         Rollover/discovery cadence (default 1000)
  --label TEXT              Output run label
  --help                    Show this help

The output is strategy-neutral. Feed a custom sink by importing
PublicTapeRecorder from public-tape-core.mjs and passing a function or an
object with onEvent(record)/append(record).
`.trim();

function parseCli(argv) {
  const raw = [...argv];
  const flag = (name) => raw.includes(`--${name}`);
  const value = (name, fallback = null) => {
    const prefix = `--${name}=`;
    const inline = raw.find((item) => item.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = raw.indexOf(`--${name}`);
    if (
      index >= 0 &&
      raw[index + 1] &&
      !raw[index + 1].startsWith('--')
    ) {
      return raw[index + 1];
    }
    return fallback;
  };
  const number = (name, fallback, { min = 0, integer = false } = {}) => {
    const parsed = Number(value(name, fallback));
    if (!Number.isFinite(parsed) || parsed < min) {
      throw new Error(`--${name} must be a number >= ${min}`);
    }
    return integer ? Math.floor(parsed) : parsed;
  };
  return {
    help: flag('help') || flag('h'),
    replay: value('replay', null),
    out: value('out', null),
    summary: value('summary', null),
    label: String(value('label', 'public-tape')).replace(
      /[^a-zA-Z0-9._-]+/g,
      '-',
    ),
    minutes: number('minutes', 5, { min: 0.01 }),
    marketWindows: number('market-windows', 1, { min: 1, integer: true }),
    maxWsMessages: number('max-ws-messages', 50_000, {
      min: 1,
      integer: true,
    }),
    maxRecords: number('max-records', 100_000, {
      min: 4,
      integer: true,
    }),
    maxMessages: value('max-messages', null) == null
      ? Number.POSITIVE_INFINITY
      : number('max-messages', 0, { min: 1, integer: true }),
    restResyncSec: number('rest-resync-sec', 30, { min: 0 }),
    discoveryMs: number('discovery-ms', 1000, { min: 250, integer: true }),
    failOnGate: !flag('no-fail-on-gate'),
    gates: {
      minDiscoveries: number('min-discoveries', 1, {
        min: 0,
        integer: true,
      }),
      minBookSnapshots: number('min-book-snapshots', 2, {
        min: 0,
        integer: true,
      }),
      minWsMessages: number('min-ws-messages', 1, {
        min: 0,
        integer: true,
      }),
      minTrades: number('min-trades', 0, { min: 0, integer: true }),
      maxMalformedMessages: number('max-malformed', 0, {
        min: 0,
        integer: true,
      }),
      maxUnknownAssets: number('max-unknown-assets', 0, {
        min: 0,
        integer: true,
      }),
      maxSinkErrors: 0,
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function outputPaths(options, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const defaultDir = path.resolve(
    '.tmp/public-market-tape',
    `${stamp}-${options.label}`,
  );
  const eventsPath = path.resolve(options.out || path.join(defaultDir, 'events.jsonl'));
  const summaryPath = path.resolve(
    options.summary || path.join(path.dirname(eventsPath), 'summary.json'),
  );
  return { eventsPath, summaryPath };
}

async function seedPublicBooks(recorder, market) {
  const results = await Promise.all(
    market.tokens.map(async (token) => {
      const url = `${CLOB_ORIGIN}/book?token_id=${encodeURIComponent(token.tokenId)}`;
      const book = await fetchPublicJson(url);
      recorder.ingestRestBook(token.tokenId, book, Date.now());
      return token.tokenId;
    }),
  );
  return results.length;
}

function addWsListener(socket, type, handler) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(type, handler);
    return;
  }
  if (typeof socket.on === 'function') {
    socket.on(type, handler);
    return;
  }
  throw new Error('unsupported WebSocket implementation');
}

function wsData(eventOrData) {
  const value = eventOrData?.data ?? eventOrData;
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
      'utf8',
    );
  }
  return value?.toString?.() ?? String(value);
}

export function openPublicMarketWs({
  recorder,
  market,
  onWireMessage,
  onFatal,
  WebSocketCtor = globalThis.WebSocket,
}) {
  assertPublicReadOnlyUrl(CLOB_MARKET_WS, 'ws');
  if (typeof WebSocketCtor !== 'function') {
    throw new Error('WebSocket unavailable; Node 22+ is required');
  }
  let stopped = false;
  let socket = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let pingTimer = null;

  const clearTimers = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pingTimer) clearInterval(pingTimer);
    reconnectTimer = null;
    pingTimer = null;
  };

  const connect = () => {
    if (stopped) return;
    try {
      socket = new WebSocketCtor(CLOB_MARKET_WS);
    } catch (error) {
      onFatal(error);
      return;
    }

    addWsListener(socket, 'open', () => {
      if (stopped) return;
      reconnectAttempt = 0;
      recorder.noteFeed('open', {
        slug: market.slug,
        tokenCount: market.tokens.length,
      });
      socket.send(JSON.stringify({
        assets_ids: market.tokens.map((row) => row.tokenId),
        type: 'market',
        custom_feature_enabled: true,
      }));
      pingTimer = setInterval(() => {
        try {
          socket?.send('PING');
        } catch {
          // close/reconnect path owns recovery
        }
      }, 10_000);
    });

    addWsListener(socket, 'message', (event) => {
      if (stopped) return;
      const receivedTsMs = Date.now();
      const text = wsData(event);
      if (!text || text === 'PONG') return;
      onWireMessage();
      try {
        recorder.ingestWs(JSON.parse(text), receivedTsMs);
      } catch (error) {
        recorder.noteMalformed(error, text, receivedTsMs);
      }
    });

    addWsListener(socket, 'close', (event) => {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      socket = null;
      // stop() already persisted a terminal feed record. A close callback can
      // arrive after finalize() writes run.stop; suppressing it keeps the
      // append-only tape closed at its declared terminal sequence.
      if (stopped) return;
      recorder.noteFeed('close', {
        code: event?.code ?? null,
        reason: event?.reason == null ? null : String(event.reason),
        stopped,
      });
      reconnectAttempt += 1;
      const delayMs = Math.min(10_000, 500 * 2 ** Math.min(reconnectAttempt, 5));
      recorder.noteFeed('reconnect_scheduled', {
        reconnectAttempt,
        delayMs,
      });
      reconnectTimer = setTimeout(connect, delayMs);
    });

    addWsListener(socket, 'error', () => {
      if (stopped) return;
      recorder.noteFeed('error', { reconnectAttempt });
    });
  };

  connect();
  return {
    stop(reason = 'requested') {
      if (stopped) return;
      stopped = true;
      clearTimers();
      recorder.noteFeed('stop', { reason });
      try {
        socket?.close(1000, reason.slice(0, 100));
      } catch {
        // best effort on shutdown
      }
      socket = null;
    },
  };
}

async function discoverWithRetry(deadlineMs) {
  let lastError = null;
  while (Date.now() < deadlineMs) {
    try {
      return await discoverCurrentBtc5mMarket();
    } catch (error) {
      lastError = error;
      await sleep(750);
    }
  }
  throw lastError || new Error('market discovery deadline exceeded');
}

async function runLive(recorder, options) {
  const deadlineMs = Date.now() + options.minutes * 60_000;
  let currentMarket = null;
  let controller = null;
  let stopReason = 'minutes_quota';
  let stopRequested = false;
  let wsMessages = 0;
  let nextRestResyncAt = 0;

  const requestStop = (reason) => {
    stopRequested = true;
    stopReason = reason;
  };
  const onSignal = () => requestStop('signal');
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    while (!stopRequested && Date.now() < deadlineMs) {
      if (recorder.stats.records >= recorder.recordLimit) {
        requestStop('records_quota');
        break;
      }
      if (wsMessages >= options.maxWsMessages) {
        requestStop('ws_messages_quota');
        break;
      }

      const slugNow = currentBtc5mSlug();
      const isRollover = currentMarket && currentMarket.slug !== slugNow;
      if (!currentMarket || isRollover) {
        if (isRollover && recorder.stats.marketWindows >= options.marketWindows) {
          requestStop('market_windows_quota');
          break;
        }
        controller?.stop('market_rollover');
        currentMarket = await discoverWithRetry(
          Math.min(deadlineMs, Date.now() + 30_000),
        );
        recorder.setMarket(currentMarket, Date.now());
        await seedPublicBooks(recorder, currentMarket);
        nextRestResyncAt = options.restResyncSec > 0
          ? Date.now() + options.restResyncSec * 1000
          : Number.POSITIVE_INFINITY;
        controller = openPublicMarketWs({
          recorder,
          market: currentMarket,
          onWireMessage() {
            wsMessages += 1;
            if (wsMessages >= options.maxWsMessages) {
              requestStop('ws_messages_quota');
            }
          },
          onFatal(error) {
            recorder.noteMalformed(error, 'ws-constructor');
            requestStop('ws_fatal');
          },
        });
      }

      if (Date.now() >= nextRestResyncAt) {
        try {
          await seedPublicBooks(recorder, currentMarket);
          recorder.noteFeed('rest_resync', { slug: currentMarket.slug });
        } catch (error) {
          recorder.noteFeed('rest_resync_error', {
            error: String(error?.message || error),
          });
        }
        nextRestResyncAt = Date.now() + options.restResyncSec * 1000;
      }
      await sleep(options.discoveryMs);
    }
  } finally {
    controller?.stop(stopReason);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  return { stopReason, wsMessages };
}

async function finalize({
  recorder,
  options,
  paths,
  mode,
  runResult,
  startedAt,
}) {
  await recorder.flush();
  const statsBeforeFinalRecords = recorder.snapshotStats();
  const gates = evaluateEvidenceGates(statsBeforeFinalRecords, options.gates);
  recorder.emit('run.gate', gates, {
    transport: 'internal',
    force: true,
  });
  recorder.emitRunState('stop', {
    mode,
    stopReason: runResult.stopReason,
    quotas: {
      minutes: options.minutes,
      marketWindows: options.marketWindows,
      maxWsMessages: options.maxWsMessages,
      maxRecords: options.maxRecords,
      maxMessages: Number.isFinite(options.maxMessages)
        ? options.maxMessages
        : null,
    },
  }, Date.now(), { force: true });
  await recorder.flush();
  const summary = {
    schema: 'polymarket-public-market-evidence-summary/v1',
    mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    output: paths.eventsPath,
    runResult,
    stats: recorder.snapshotStats(),
    gates,
  };
  fs.mkdirSync(path.dirname(paths.summaryPath), { recursive: true });
  fs.writeFileSync(paths.summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.help) {
    console.log(HELP);
    return { exitCode: 0, help: true };
  }

  const paths = outputPaths(options);
  const runId = `${options.label}-${new Date().toISOString()}`;
  const recorder = new PublicTapeRecorder({
    sink: createJsonlEventSink(paths.eventsPath),
    runId,
    // Keep terminal run.gate/run.stop inside the advertised hard record cap.
    recordLimit: options.maxRecords - 2,
  });
  const mode = options.replay ? 'replay' : 'live';
  const startedAt = new Date().toISOString();
  recorder.emitRunState('start', {
    mode,
    policy: 'public-read-only-zero-orders',
    endpoints: [
      'GET gamma-api.polymarket.com/markets',
      'GET clob.polymarket.com/book',
      'WSS ws-subscriptions-clob.polymarket.com/ws/market',
    ],
  });

  let runResult;
  if (mode === 'replay') {
    const replay = await replayPublicTapeFixture(
      options.replay,
      recorder,
      { maxMessages: options.maxMessages },
    );
    runResult = { stopReason: 'fixture_eof', ...replay, wsMessages: recorder.stats.wsMessages };
  } else {
    runResult = await runLive(recorder, options);
  }

  const summary = await finalize({
    recorder,
    options,
    paths,
    mode,
    runResult,
    startedAt,
  });
  console.log(JSON.stringify({
    mode,
    output: paths.eventsPath,
    summary: paths.summaryPath,
    stopReason: runResult.stopReason,
    stats: summary.stats,
    gatePass: summary.gates.pass,
  }, null, 2));
  return {
    exitCode: summary.gates.pass || !options.failOnGate ? 0 : 2,
    summary,
  };
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  runCli()
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error?.stack || error);
      process.exitCode = 1;
    });
}
