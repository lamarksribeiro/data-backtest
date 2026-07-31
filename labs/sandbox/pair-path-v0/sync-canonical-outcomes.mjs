/**
 * Build a resumable, append-only resolved-outcome research journal for the
 * BTC 5m lake.
 *
 * Compatibility note: artifact filenames retain the historical
 * "canonical-outcomes-v1" name. Gamma labels are not represented as
 * CLOB/on-chain finality.
 *
 * Read-only external source:
 *   GET https://gamma-api.polymarket.com/events/keyset
 *
 * Generated artifacts (gitignored):
 *   scratch/canonical-outcomes-v1.jsonl  append-only observation journal
 *   scratch/canonical-outcomes-v1.csv    latest materialized view
 *   .tmp/canonical-outcomes-v1/report.json
 *   .tmp/canonical-outcomes-v1/REPORT.md
 *
 * Existing scratch/gamma-outcomes.csv is accepted as a seed. The source file is
 * never modified.
 *
 * Usage:
 *   node labs/sandbox/pair-path-v0/sync-canonical-outcomes.mjs
 *   node labs/sandbox/pair-path-v0/sync-canonical-outcomes.mjs --audit-only
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const LAKE = path.join(
  ROOT,
  'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25',
);
const SCRATCH = path.join(ROOT, 'scratch');
const OUT_DIR = path.join(ROOT, '.tmp/canonical-outcomes-v1');
const JOURNAL = path.join(SCRATCH, 'canonical-outcomes-v1.jsonl');
const MATERIALIZED_CSV = path.join(SCRATCH, 'canonical-outcomes-v1.csv');
const LEGACY_SEED = path.join(SCRATCH, 'gamma-outcomes.csv');
const GAMMA_API = 'https://gamma-api.polymarket.com/events/keyset';
const SERIES_ID = '10684';
const SCHEMA_VERSION = 1;

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = process.argv.slice(2).find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  return process.argv.includes(`--${name}`) ? true : fallback;
}

const AUDIT_ONLY = Boolean(arg('audit-only', false));
const POINT_ONLY = Boolean(arg('point-only', false));
const PAGE_LIMIT = Math.max(1, Math.min(500, Number(arg('page-limit', 500))));
const REQUEST_DELAY_MS = Math.max(0, Number(arg('request-delay-ms', 125)));
const MAX_PAGES = Math.max(1, Number(arg('max-pages', 1000)));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvCells(line) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      cells.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  cells.push(value);
  return cells;
}

function csvValue(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseCsv(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  if (!lines.length || !lines[0]) return [];
  const header = csvCells(lines.shift());
  return lines.filter(Boolean).map((line) => {
    const values = csvCells(line);
    return Object.fromEntries(header.map((key, index) => [key, values[index] ?? '']));
  });
}

function toIso(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeWinner(value) {
  const text = String(value ?? '').trim().toUpperCase();
  if (text === 'UP' || text === '1') return 'UP';
  if (text === 'DOWN' || text === '-1') return 'DOWN';
  return null;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function resolvedWinner(market) {
  const outcomes = parseJsonArray(market?.outcomes);
  const prices = parseJsonArray(market?.outcomePrices).map(Number);
  if (outcomes.length !== prices.length || outcomes.length < 2) return null;
  const maxPrice = Math.max(...prices);
  const winners = prices
    .map((price, index) => ({ price, index }))
    .filter((row) => row.price === maxPrice && row.price >= 0.99);
  if (winners.length !== 1) return null;
  return normalizeWinner(outcomes[winners[0].index]);
}

function observationKey(row) {
  return [
    row.condition_id,
    row.winner,
    row.source,
    row.gamma_updated_at ?? '',
    row.response_sha256 ?? '',
  ].join('|');
}

function sourceRank(source) {
  if (String(source).startsWith('onchain_')) return 4;
  if (String(source).startsWith('clob_')) return 3;
  if (String(source).startsWith('gamma_')) return 2;
  if (String(source).includes('proxy')) return 1;
  return 0;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function loadJournal() {
  if (!fs.existsSync(JOURNAL)) return [];
  return fs
    .readFileSync(JOURNAL, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid JSONL at ${JOURNAL}:${index + 1}: ${error.message}`);
      }
    });
}

function latestByCondition(observations) {
  const map = new Map();
  for (const row of observations) {
    if (!row?.condition_id || !normalizeWinner(row.winner)) continue;
    const previous = map.get(row.condition_id);
    if (
      !previous ||
      sourceRank(row.source) > sourceRank(previous.source) ||
      (
        sourceRank(row.source) === sourceRank(previous.source) &&
        String(row.observed_at ?? '').localeCompare(
          String(previous.observed_at ?? ''),
        ) >= 0
      )
    ) {
      map.set(row.condition_id, row);
    }
  }
  return map;
}

async function loadLakeEvents() {
  const days = fs
    .readdirSync(LAKE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('dt='))
    .map((entry) => entry.name.slice(3))
    .sort();
  if (!days.length) throw new Error(`no dt partitions under ${LAKE}`);
  const files = [];
  for (const day of days) {
    const dir = path.join(LAKE, `dt=${day}`);
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.parquet')) files.push(path.join(dir, name));
    }
  }
  const parquet = `[${files.map((file) => quotedString(file)).join(',')}]`;
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const result = await connection.runAndReadAll(`
    SELECT
      condition_id,
      min(event_start)::VARCHAR AS event_start,
      min(dt)::VARCHAR AS dt
    FROM read_parquet(${parquet}, hive_partitioning = true)
    WHERE condition_id IS NOT NULL
      AND event_start IS NOT NULL
    GROUP BY condition_id
    ORDER BY event_start, condition_id
  `);
  return result.getRowObjectsJS().map((row) => ({
    condition_id: String(row.condition_id),
    event_start: toIso(row.event_start),
    event_epoch: Math.floor(Date.parse(row.event_start) / 1000),
    dt: String(row.dt),
  }));
}

function legacySeedObservations(lakeByCondition, observedAt) {
  return parseCsv(LEGACY_SEED)
    .map((row) => {
      const conditionId = row.condition_id;
      const lake = lakeByCondition.get(conditionId);
      const winner = normalizeWinner(row.winner);
      if (!lake || !winner) return null;
      return {
        schema_version: SCHEMA_VERSION,
        observed_at: observedAt,
        source: 'gamma_legacy_seed',
        source_file: path.relative(ROOT, LEGACY_SEED).replaceAll('\\', '/'),
        condition_id: conditionId,
        event_start: lake.event_start,
        event_epoch: lake.event_epoch,
        dt: lake.dt,
        slug: row.slug || null,
        winner,
        winner_numeric: winner === 'UP' ? 1 : -1,
        final_price: Number.isFinite(Number(row.final_price))
          ? Number(row.final_price)
          : null,
        price_to_beat: Number.isFinite(Number(row.price_to_beat))
          ? Number(row.price_to_beat)
          : null,
        automatically_resolved: row.automatically_resolved === '1',
        gamma_event_id: null,
        gamma_updated_at: null,
        outcome_prices: null,
        response_sha256: null,
      };
    })
    .filter(Boolean);
}

async function fetchJson(url, attempts = 7) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'data-backtest-canonical-outcomes/1.0',
        },
      });
      if (!response.ok) {
        const body = await response.text();
        const error = new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const retryAfter = Number(error?.status === 429 ? 1000 : 0);
      await sleep(Math.max(retryAfter, Math.min(8000, 250 * (2 ** attempt))));
    }
  }
  throw lastError;
}

async function fetchGammaEvents(minStart, maxStart) {
  const common = new URLSearchParams({
    series_id: SERIES_ID,
    closed: 'true',
    limit: String(PAGE_LIMIT),
    order: 'startTime',
    ascending: 'true',
    end_date_min: new Date(Date.parse(minStart)).toISOString().replace('.000Z', 'Z'),
    end_date_max: new Date(Date.parse(maxStart) + 5 * 60_000)
      .toISOString()
      .replace('.000Z', 'Z'),
  });
  const events = [];
  let cursor = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams(common);
    if (cursor) query.set('after_cursor', cursor);
    const payload = await fetchJson(`${GAMMA_API}?${query}`);
    const batch = Array.isArray(payload.events) ? payload.events : [];
    events.push(...batch);
    process.stderr.write(
      `Gamma page ${page}: +${batch.length}, total=${events.length}\n`,
    );
    const next = payload.next_cursor;
    if (!batch.length || !next || next === cursor || next === 'LTE=') break;
    if (page === MAX_PAGES) {
      throw new Error(`max page limit reached with cursor ${next}`);
    }
    cursor = next;
    if (REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS);
  }
  return events;
}

function gammaObservations(
  events,
  lakeByCondition,
  observedAt,
  source = 'gamma_events_keyset',
) {
  const observations = [];
  const unresolved = [];
  for (const event of events) {
    for (const market of event.markets ?? []) {
      const conditionId = String(market.conditionId ?? '');
      const lake = lakeByCondition.get(conditionId);
      if (!lake) continue;
      const winner = resolvedWinner(market);
      if (!winner) {
        unresolved.push({
          condition_id: conditionId,
          event_start: lake.event_start,
          slug: event.slug ?? null,
          outcome_prices: parseJsonArray(market.outcomePrices).map(Number),
        });
        continue;
      }
      observations.push({
        schema_version: SCHEMA_VERSION,
        observed_at: observedAt,
        source,
        source_file: null,
        condition_id: conditionId,
        event_start: lake.event_start,
        event_epoch: lake.event_epoch,
        dt: lake.dt,
        slug: event.slug ?? null,
        winner,
        winner_numeric: winner === 'UP' ? 1 : -1,
        final_price: Number.isFinite(Number(event.eventMetadata?.finalPrice))
          ? Number(event.eventMetadata.finalPrice)
          : null,
        price_to_beat: Number.isFinite(Number(event.eventMetadata?.priceToBeat))
          ? Number(event.eventMetadata.priceToBeat)
          : null,
        automatically_resolved: Boolean(event.automaticallyResolved),
        gamma_event_id: event.id != null ? String(event.id) : null,
        gamma_updated_at: event.updatedAt ?? market.updatedAt ?? null,
        outcome_prices: parseJsonArray(market.outcomePrices).map(Number),
        response_sha256: sha256(JSON.stringify({ event, market })),
      });
    }
  }
  return { observations, unresolved };
}

async function fetchPointObservations(
  missingLakeEvents,
  lakeByCondition,
  observedAt,
) {
  const observations = [];
  const unresolved = [];
  let gammaSlugFetched = 0;
  let clobFetched = 0;
  for (const lake of missingLakeEvents) {
    const slug = `btc-updown-5m-${lake.event_epoch}`;
    const gammaEvent = await fetchJson(
      `https://gamma-api.polymarket.com/events/slug/${slug}`,
    );
    gammaSlugFetched += 1;
    const gamma = gammaObservations(
      [gammaEvent],
      lakeByCondition,
      observedAt,
      'gamma_event_slug',
    );
    if (gamma.observations.length) {
      observations.push(...gamma.observations);
      continue;
    }

    const clob = await fetchJson(
      `https://clob.polymarket.com/markets/${lake.condition_id}`,
    );
    clobFetched += 1;
    const winners = (clob.tokens ?? []).filter((token) => token.winner);
    const winner =
      winners.length === 1 ? normalizeWinner(winners[0].outcome) : null;
    if (!winner) {
      unresolved.push({
        condition_id: lake.condition_id,
        event_start: lake.event_start,
        slug,
        gamma_outcome_prices:
          gamma.unresolved[0]?.outcome_prices ?? null,
        clob_tokens: clob.tokens ?? null,
      });
      continue;
    }
    observations.push({
      schema_version: SCHEMA_VERSION,
      observed_at: observedAt,
      source: 'clob_market_tokens',
      source_file: null,
      condition_id: lake.condition_id,
      event_start: lake.event_start,
      event_epoch: lake.event_epoch,
      dt: lake.dt,
      slug: clob.market_slug ?? slug,
      winner,
      winner_numeric: winner === 'UP' ? 1 : -1,
      final_price: null,
      price_to_beat: null,
      automatically_resolved: null,
      gamma_event_id: gammaEvent?.id != null ? String(gammaEvent.id) : null,
      gamma_updated_at: gammaEvent?.updatedAt ?? null,
      outcome_prices: (clob.tokens ?? []).map((token) => Number(token.price)),
      response_sha256: sha256(JSON.stringify(clob)),
    });
  }
  return {
    observations,
    unresolved,
    gammaSlugFetched,
    clobFetched,
  };
}

function appendObservations(rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
  fs.appendFileSync(
    JOURNAL,
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  );
}

function materializeCsv(latest) {
  const header = [
    'event_start',
    'event_epoch',
    'dt',
    'condition_id',
    'slug',
    'winner',
    'winner_numeric',
    'source',
    'observed_at',
    'gamma_event_id',
    'gamma_updated_at',
    'final_price',
    'price_to_beat',
    'automatically_resolved',
    'outcome_prices',
    'response_sha256',
  ];
  const rows = [...latest.values()].sort(
    (a, b) =>
      String(a.event_start).localeCompare(String(b.event_start)) ||
      String(a.condition_id).localeCompare(String(b.condition_id)),
  );
  const lines = [
    header.join(','),
    ...rows.map((row) =>
      header
        .map((key) =>
          csvValue(
            key === 'outcome_prices'
              ? JSON.stringify(row[key] ?? null)
              : row[key],
          ),
        )
        .join(',')),
  ];
  atomicWrite(MATERIALIZED_CSV, `${lines.join('\n')}\n`);
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
}

function groupMissingByDay(lakeEvents, latest) {
  const counts = new Map();
  for (const row of lakeEvents) {
    if (latest.has(row.condition_id)) continue;
    counts.set(row.dt, (counts.get(row.dt) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort());
}

function reportMarkdown(report) {
  const missingDays = Object.entries(report.missingByDay);
  return `# Research-resolved BTC 5m outcomes v1

Generated: ${report.generatedAt}

## Coverage

- Lake events: ${report.lakeEvents}
- Research-resolved outcomes: ${report.researchResolvedOutcomes}
- Coverage: ${report.coveragePct}%
- Missing: ${report.missing}
- Conflicts observed: ${report.conflicts.length}
- Journal observations: ${report.journalObservations}
- New observations appended: ${report.appended}
- Latest source mix: ${JSON.stringify(report.latestSources)}

## Sources

- Existing Gamma seed imported: ${report.seedImported}
- Gamma events fetched this run: ${report.gammaEventsFetched}
- Gamma market observations matched to lake: ${report.gammaMatched}
- Point fallbacks matched: ${report.pointFetch.matched}
- Gamma rows unresolved: ${report.gammaUnresolved}

## Missing by day

${missingDays.length
    ? missingDays.map(([day, count]) => `- ${day}: ${count}`).join('\n')
    : '- none'}

## Boundary

- Gamma outcome prices are a resolved research label, not CLOB/on-chain finality.
- Source precedence is on-chain > explicit CLOB winner > Gamma > proxy.
- The journal is append-only; the CSV is a reproducible latest-state view.
- This cache does not prove fills and does not authorize live orders.
`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const lakeEvents = await loadLakeEvents();
  const lakeByCondition = new Map(
    lakeEvents.map((row) => [row.condition_id, row]),
  );
  const existing = loadJournal();
  const existingKeys = new Set(existing.map(observationKey));
  let seedImported = 0;
  if (!existing.length && fs.existsSync(LEGACY_SEED)) {
    const observedAt = fs.statSync(LEGACY_SEED).mtime.toISOString();
    const seed = legacySeedObservations(lakeByCondition, observedAt);
    appendObservations(seed);
    existing.push(...seed);
    for (const row of seed) existingKeys.add(observationKey(row));
    seedImported = seed.length;
  }

  let gammaEvents = [];
  let gamma = { observations: [], unresolved: [] };
  let point = {
    observations: [],
    unresolved: [],
    gammaSlugFetched: 0,
    clobFetched: 0,
  };
  if (!AUDIT_ONLY && !POINT_ONLY) {
    gammaEvents = await fetchGammaEvents(
      lakeEvents[0].event_start,
      lakeEvents[lakeEvents.length - 1].event_start,
    );
    gamma = gammaObservations(gammaEvents, lakeByCondition, generatedAt);
  }
  if (!AUDIT_ONLY) {
    const provisional = latestByCondition([
      ...existing,
      ...gamma.observations,
    ]);
    const missingAfterKeyset = lakeEvents.filter(
      (row) => !provisional.has(row.condition_id),
    );
    if (missingAfterKeyset.length) {
      point = await fetchPointObservations(
        missingAfterKeyset,
        lakeByCondition,
        generatedAt,
      );
    }
  }

  const latestBefore = latestByCondition(existing);
  const conflicts = [];
  const appended = [];
  const comparisonLatest = new Map(latestBefore);
  for (const row of [...gamma.observations, ...point.observations]) {
    const previous = comparisonLatest.get(row.condition_id);
    if (previous && previous.winner !== row.winner) {
      conflicts.push({
        condition_id: row.condition_id,
        event_start: row.event_start,
        previous_winner: previous.winner,
        new_winner: row.winner,
        previous_source: previous.source,
      });
    }
    const key = observationKey(row);
    if (!existingKeys.has(key)) {
      appended.push(row);
      existingKeys.add(key);
    }
    const candidate = latestByCondition([previous, row].filter(Boolean));
    comparisonLatest.set(row.condition_id, candidate.get(row.condition_id));
  }
  appendObservations(appended);
  const all = [...existing, ...appended];
  const latest = latestByCondition(all);
  materializeCsv(latest);

  const researchResolvedOutcomes = lakeEvents.filter((row) =>
    latest.has(row.condition_id),
  ).length;
  const countSources = (rows) =>
    Object.fromEntries(
      [...rows.reduce((counts, row) => {
        const source = row.source ?? 'unknown';
        counts.set(source, (counts.get(source) ?? 0) + 1);
        return counts;
      }, new Map()).entries()].sort(),
    );
  const report = {
    generatedAt,
    auditOnly: AUDIT_ONLY,
    pointOnly: POINT_ONLY,
    lakeWindow: {
      from: lakeEvents[0].event_start,
      to: lakeEvents[lakeEvents.length - 1].event_start,
    },
    lakeEvents: lakeEvents.length,
    journalObservations: all.length,
    journalSources: countSources(all),
    latestSources: countSources([...latest.values()]),
    researchResolvedOutcomes,
    // Compatibility alias for earlier lab consumers. Do not interpret this as
    // proof of CLOB/on-chain finality.
    canonicalOutcomes: researchResolvedOutcomes,
    canonicalOutcomesDeprecated: true,
    coveragePct: Number(
      (100 * researchResolvedOutcomes / lakeEvents.length).toFixed(4),
    ),
    missing: lakeEvents.length - researchResolvedOutcomes,
    missingByDay: groupMissingByDay(lakeEvents, latest),
    seedImported,
    gammaEventsFetched: gammaEvents.length,
    gammaMatched: gamma.observations.length,
    gammaUnresolved: gamma.unresolved.length + point.unresolved.length,
    pointFetch: {
      gammaSlugFetched: point.gammaSlugFetched,
      clobFetched: point.clobFetched,
      matched: point.observations.length,
    },
    unresolved: [...gamma.unresolved, ...point.unresolved],
    appended: appended.length,
    conflicts,
    artifacts: {
      journal: path.relative(ROOT, JOURNAL).replaceAll('\\', '/'),
      materializedCsv: path.relative(ROOT, MATERIALIZED_CSV).replaceAll('\\', '/'),
    },
  };
  atomicWrite(
    path.join(OUT_DIR, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  atomicWrite(
    path.join(OUT_DIR, 'REPORT.md'),
    reportMarkdown(report),
  );
  console.log(JSON.stringify(report, null, 2));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}

export {
  latestByCondition,
  normalizeWinner,
  resolvedWinner,
};
