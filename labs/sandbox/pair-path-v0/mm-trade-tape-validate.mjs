/**
 * Validate selected maker policies against public, observed taker trades.
 *
 * A hypothetical resting BUY is counted only when a later taker SELL executes
 * strictly below its price. This avoids inferring fills from BBO movement,
 * cancellation, same-price queue depletion, or same-second ambiguity.
 *
 * External access is read-only:
 *   GET https://data-api.polymarket.com/trades
 *
 * Usage:
 *   node labs/sandbox/pair-path-v0/mm-trade-tape-validate.mjs
 *   node labs/sandbox/pair-path-v0/mm-trade-tape-validate.mjs \
 *     --from=2026-07-29 --to=2026-07-29 --concurrency=4
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';
import {
  defaultPolicy,
  runEvent,
  summarize,
} from './mm-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const LAKE = path.join(
  ROOT,
  'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25',
);
const DATA_API = 'https://data-api.polymarket.com/trades';

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const FROM = arg('from', '2026-07-29');
const TO = arg('to', '2026-07-29');
const CONCURRENCY = Math.max(1, Math.min(8, Number(arg('concurrency', '4'))));
const MAX_EVENTS = Math.max(0, Number(arg('max-events', '0')));
const ONLY = arg('only', null);
const TAG = arg('tag', 'v1');
const OUT_DIR = path.join(ROOT, `.tmp/mm-trade-tape-${TAG}`);
const CACHE_DIR = path.join(ROOT, '.tmp/mm-trade-tape-v1/cache');
const WINNER_CSV = path.resolve(
  ROOT,
  arg('winnerCsv', 'scratch/canonical-outcomes-v1.csv'),
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadCanonicalWinners(file) {
  if (!fs.existsSync(file)) throw new Error(`winner CSV not found: ${file}`);
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const header = lines.shift()?.split(',') ?? [];
  const conditionIndex = header.indexOf('condition_id');
  const winnerIndex = header.indexOf('winner');
  if (conditionIndex < 0 || winnerIndex < 0) {
    throw new Error(`winner CSV needs condition_id,winner: ${file}`);
  }
  return new Map(
    lines
      .filter(Boolean)
      .map((line) => line.split(','))
      .filter((values) => ['UP', 'DOWN'].includes(values[winnerIndex]))
      .map((values) => [values[conditionIndex], values[winnerIndex]]),
  );
}

function policies(fillModel, tradeTape = null) {
  const common = {
    size: 5,
    stopQuoteTau: 5,
    quoteMode: 'join',
    staticQuotes: true,
    skew: true,
    maxImbalance: 5,
    maxSets: 3,
    maxPairSum: 0.999,
    maxNakedPx: 0.05,
    cut: null,
    makerFeeRate: 0,
    makerFillModel: fillModel,
    tradeTape,
  };
  const rows = [
    defaultPolicy({
      ...common,
      id: 'late-x88-t120_10-nk05-nocut',
      entryTau: 120,
      stopQuoteTau: 10,
      zoneLo: 0.88,
      zoneHi: 0.995,
    }),
    defaultPolicy({
      ...common,
      id: 'late-h75-t30_5-nk05-nocut',
      entryTau: 30,
      zoneLo: 0.75,
      zoneHi: 0.92,
    }),
    defaultPolicy({
      ...common,
      id: 'late-h75-t60_5-nk05-nocut',
      entryTau: 60,
      zoneLo: 0.75,
      zoneHi: 0.92,
    }),
  ];
  if (!ONLY) return rows;
  const pattern = new RegExp(ONLY);
  return rows.filter((row) => pattern.test(row.id));
}

function listDays() {
  return fs
    .readdirSync(LAKE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('dt='))
    .map((entry) => entry.name.slice(3))
    .filter((day) => day >= FROM && day <= TO)
    .sort();
}

async function loadEvents() {
  const days = listDays();
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const events = [];
  for (const day of days) {
    const dir = path.join(LAKE, `dt=${day}`);
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.parquet'))
      .map((name) => path.join(dir, name));
    if (!files.length) continue;
    const parquet = `[${files.map((file) => quotedString(file)).join(',')}]`;
    const rows = (
      await connection.runAndReadAll(`
        SELECT
          condition_id,
          epoch(try_cast(event_start AS TIMESTAMPTZ))::BIGINT AS event_epoch,
          epoch(try_cast(ts AS TIMESTAMPTZ))::DOUBLE AS ts_epoch,
          extract(epoch FROM (
            try_cast(event_end AS TIMESTAMPTZ) -
            try_cast(ts AS TIMESTAMPTZ)
          ))::DOUBLE AS tau,
          up_best_bid,
          up_best_ask,
          down_best_bid,
          down_best_ask
        FROM read_parquet(${parquet})
        WHERE coverage >= 0.99
          AND coalesce(degraded, false) = false
          AND up_best_bid IS NOT NULL
          AND up_best_ask IS NOT NULL
          AND down_best_bid IS NOT NULL
          AND down_best_ask IS NOT NULL
        QUALIFY row_number() OVER (
          PARTITION BY condition_id, event_start, ts
          ORDER BY coverage DESC
        ) = 1
        ORDER BY condition_id, event_epoch, ts_epoch
      `)
    ).getRowObjectsJS();
    let conditionId = null;
    let eventEpoch = null;
    let ticks = [];
    const flush = () => {
      if (!ticks.length || ticks[0].tau < 240 || ticks.at(-1).tau > 15) return;
      events.push({
        day,
        conditionId,
        eventEpoch,
        ticks,
      });
    };
    for (const row of rows) {
      const nextCondition = String(row.condition_id);
      if (conditionId != null && nextCondition !== conditionId) {
        flush();
        ticks = [];
      }
      conditionId = nextCondition;
      eventEpoch = Number(row.event_epoch);
      ticks.push({
        tsMs: Number(row.ts_epoch) * 1000,
        tau: Number(row.tau),
        upBid: Number(row.up_best_bid),
        upAsk: Number(row.up_best_ask),
        downBid: Number(row.down_best_bid),
        downAsk: Number(row.down_best_ask),
      });
    }
    flush();
  }
  return events;
}

async function fetchJson(url, attempts = 7) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'data-backtest-maker-tape/1.0',
        },
      });
      if (!response.ok) {
        const error = new Error(
          `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
        );
        error.status = response.status;
        const retryAfter = Number(response.headers.get('retry-after'));
        error.retryAfterMs = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : null;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay =
        error.retryAfterMs ??
        Math.min(8000, 250 * (2 ** attempt)) + Math.random() * 250;
      await sleep(delay);
    }
  }
  throw lastError;
}

function minimalTrades(rows, conditionId) {
  const seen = new Set();
  const trades = [];
  for (const row of rows) {
    if (String(row.conditionId) !== conditionId) continue;
    const side = String(row.side ?? '').toUpperCase();
    const outcome = String(row.outcome ?? '').toUpperCase();
    if (!['BUY', 'SELL'].includes(side) || !['UP', 'DOWN'].includes(outcome)) {
      continue;
    }
    const trade = {
      timestamp: Number(row.timestamp),
      side,
      outcome,
      price: Number(row.price),
      size: Number(row.size),
      asset: String(row.asset ?? ''),
      transactionHash: String(row.transactionHash ?? ''),
    };
    if (
      !Number.isFinite(trade.timestamp) ||
      !Number.isFinite(trade.price) ||
      !Number.isFinite(trade.size)
    ) {
      continue;
    }
    const key = [
      trade.transactionHash,
      trade.side,
      trade.outcome,
      trade.price,
      trade.size,
      trade.timestamp,
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    trades.push(trade);
  }
  return trades.sort(
    (a, b) =>
      a.timestamp - b.timestamp ||
      a.price - b.price ||
      a.transactionHash.localeCompare(b.transactionHash),
  );
}

async function getTape(conditionId) {
  const file = path.join(CACHE_DIR, `${conditionId}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const query = new URLSearchParams({
    market: conditionId,
    limit: '10000',
    offset: '0',
    takerOnly: 'true',
  });
  const payload = await fetchJson(`${DATA_API}?${query}`);
  if (!Array.isArray(payload)) {
    throw new Error(`unexpected trades payload for ${conditionId}`);
  }
  const cache = {
    conditionId,
    fetchedAt: new Date().toISOString(),
    rawRows: payload.length,
    truncated: payload.length >= 10000,
    trades: minimalTrades(payload, conditionId),
  };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(cache)}\n`, 'utf8');
  fs.renameSync(temporary, file);
  return cache;
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
      await sleep(50);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}

function byDay(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.day)) groups.set(row.day, []);
    groups.get(row.day).push(row);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, values]) => [day, summarize(values)]),
  );
}

function bootstrapDays(rows, samples = 4000) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.day)) groups.set(row.day, []);
    groups.get(row.day).push(row.pnl);
  }
  const days = [...groups.keys()];
  if (days.length < 3) return null;
  const totals = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let index = 0; index < days.length; index += 1) {
      const day = days[(Math.random() * days.length) | 0];
      total += groups.get(day).reduce((sum, pnl) => sum + pnl, 0);
    }
    totals.push(total);
  }
  totals.sort((a, b) => a - b);
  const value = (quantile) =>
    Number(totals[Math.floor((totals.length - 1) * quantile)].toFixed(4));
  return {
    days: days.length,
    samples,
    pnlP05: value(0.05),
    pnlP50: value(0.5),
    pnlP95: value(0.95),
  };
}

function markdown(report) {
  return `# Maker validation with public trade-through proof

Generated: ${report.generatedAt}
Window: ${report.window.from}..${report.window.to}

## Coverage

- Eligible lake events: ${report.events}
- Book-model candidate events: ${report.tape.candidateEvents}
- Public tapes fetched/cached: ${report.tape.tapes}
- Minimal deduplicated taker trades: ${report.tape.trades}
- Truncated markets: ${report.tape.truncated}

## Comparison

| policy | book PnL | tape PnL | tape p05 | proven fills | proven/book |
|---|---:|---:|---:|---:|---:|
${report.policies.map((row) =>
    `| \`${row.id}\` | ${row.book.totalPnl} | ${row.tradeThrough.totalPnl} | ${row.tradeThroughBootstrap?.pnlP05 ?? '-'} | ${row.tradeThrough.makerFills} | ${row.provenFillPct}% |`,
  ).join('\n')}

## Interpretation

- Book movement is not fill proof.
- Same-price trades are excluded because queue position is unknown.
- Trades in the posting second are excluded because public timestamps have
  one-second precision.
- A later taker trade strictly through our resting price is treated as proof
  that a still-live better-priced order would have executed.
- This is a conservative historical validation, not live authorization.
`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const winners = loadCanonicalWinners(WINNER_CSV);
  const events = await loadEvents();
  const bookPolicies = policies('book_depletion');
  const bookRows = new Map(bookPolicies.map((policy) => [policy.id, []]));
  const candidates = [];
  for (const event of events) {
    const winner = winners.get(event.conditionId);
    if (!winner) continue;
    let needsTape = false;
    for (const policy of bookPolicies) {
      const result = runEvent(event.ticks, policy, winner);
      bookRows.get(policy.id).push({ day: event.day, ...result });
      if (result.makerFills > 0) needsTape = true;
    }
    if (needsTape) candidates.push(event);
  }
  const selected =
    MAX_EVENTS > 0 ? candidates.slice(0, MAX_EVENTS) : candidates;
  console.log(
    `events=${events.length} tape candidates=${candidates.length} selected=${selected.length}`,
  );
  const tapes = await mapConcurrent(
    selected,
    CONCURRENCY,
    async (event, index) => {
      const tape = await getTape(event.conditionId);
      if (
        index === 0 ||
        index === selected.length - 1 ||
        (index + 1) % 25 === 0
      ) {
        console.log(
          `[${index + 1}/${selected.length}] ${event.conditionId} trades=${tape.trades.length}`,
        );
      }
      return tape;
    },
  );
  const tapeByCondition = new Map(
    tapes.map((tape) => [tape.conditionId, tape]),
  );

  const tradeRows = new Map(bookPolicies.map((policy) => [policy.id, []]));
  for (const event of events) {
    const winner = winners.get(event.conditionId);
    if (!winner) continue;
    const tradeTape = tapeByCondition.get(event.conditionId)?.trades ?? [];
    for (const policy of policies('trade_through', tradeTape)) {
      tradeRows
        .get(policy.id)
        .push({
          day: event.day,
          ...runEvent(event.ticks, policy, winner),
        });
    }
  }

  const policyReports = bookPolicies.map((policy) => {
    const bookEventRows = bookRows.get(policy.id);
    const tradeEventRows = tradeRows.get(policy.id);
    const book = summarize(bookEventRows);
    const tradeThrough = summarize(tradeEventRows);
    return {
      id: policy.id,
      params: policy,
      book,
      bookByDay: byDay(bookEventRows),
      bookBootstrap: bootstrapDays(bookEventRows),
      tradeThrough,
      tradeThroughByDay: byDay(tradeEventRows),
      tradeThroughBootstrap: bootstrapDays(tradeEventRows),
      provenFillPct:
        book.makerFills > 0
          ? Number((100 * tradeThrough.makerFills / book.makerFills).toFixed(2))
          : null,
    };
  });
  const report = {
    generatedAt: new Date().toISOString(),
    window: { from: FROM, to: TO },
    events: events.length,
    outcomeSource: path.relative(ROOT, WINNER_CSV).replaceAll('\\', '/'),
    tape: {
      endpoint: DATA_API,
      candidateEvents: candidates.length,
      selectedEvents: selected.length,
      tapes: tapes.length,
      rawRows: tapes.reduce((sum, tape) => sum + tape.rawRows, 0),
      trades: tapes.reduce((sum, tape) => sum + tape.trades.length, 0),
      truncated: tapes.filter((tape) => tape.truncated).length,
    },
    policies: policyReports,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(OUT_DIR, 'REPORT.md'),
    markdown(report),
    'utf8',
  );
  console.log(markdown(report));
}

await main();
