/**
 * Valida os labels locais do estudo anti-flip contra os resultados resolvidos
 * publicados pela Gamma API da Polymarket.
 *
 * Entradas:
 *   scratch/flip-features.csv
 *   scratch/tick-exit-codex.csv
 *
 * Saidas:
 *   scratch/gamma-outcomes.csv
 *   scratch/gamma-validation-report.json
 *   scratch/gamma-validation-report.md
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/Projetos/projeto-goldenlens/data-backtest';
const FEATURE_CSV = path.join(ROOT, 'scratch/flip-features.csv');
const TICK_CSV = path.join(ROOT, 'scratch/tick-exit-codex.csv');
const OUT_CSV = path.join(ROOT, 'scratch/gamma-outcomes.csv');
const OUT_JSON = path.join(ROOT, 'scratch/gamma-validation-report.json');
const OUT_MD = path.join(ROOT, 'scratch/gamma-validation-report.md');
const SERIES_ID = '10684';
const API = 'https://gamma-api.polymarket.com/events/keyset';

function parseCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const header = lines.shift().split(',');
  return lines.filter(Boolean).map((line) => {
    const values = line.split(',');
    return Object.fromEntries(header.map((key, i) => [key, values[i] ?? '']));
  });
}

function isoNoMillis(ms) {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

async function fetchJson(url, attempts = 6) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'data-backtest-gamma-validation/1.0' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 250 * (2 ** attempt))));
    }
  }
  throw lastError;
}

async function fetchResolvedEvents(minStartMs, maxStartMs) {
  const common = new URLSearchParams({
    series_id: SERIES_ID,
    closed: 'true',
    limit: '100',
    order: 'startTime',
    ascending: 'true',
    end_date_min: isoNoMillis(minStartMs),
    end_date_max: isoNoMillis(maxStartMs + 5 * 60_000),
  });
  const events = [];
  let cursor = null;
  let page = 0;

  for (;;) {
    const query = new URLSearchParams(common);
    if (cursor) query.set('after_cursor', cursor);
    const payload = await fetchJson(`${API}?${query}`);
    const batch = Array.isArray(payload.events) ? payload.events : [];
    events.push(...batch);
    page += 1;
    if (page % 25 === 0) {
      process.stderr.write(`Gamma: ${page} paginas, ${events.length} eventos\n`);
    }
    const next = payload.next_cursor;
    if (!batch.length || !next || next === cursor || next === 'LTE=') break;
    cursor = next;
  }
  return events;
}

function resolvedWinner(event) {
  const market = event.markets?.[0];
  if (!market) return null;
  let outcomes;
  let prices;
  try {
    outcomes = JSON.parse(market.outcomes);
    prices = JSON.parse(market.outcomePrices).map(Number);
  } catch {
    return null;
  }
  const index = prices.indexOf(Math.max(...prices));
  if (!(prices[index] >= 0.99)) return null;
  if (String(outcomes[index]).toLowerCase() === 'up') return 1;
  if (String(outcomes[index]).toLowerCase() === 'down') return -1;
  return null;
}

function auc(rows, labelKey, scoreKey) {
  const sorted = rows
    .map((row) => ({ y: Number(row[labelKey]), score: Number(row[scoreKey]) }))
    .filter((row) => Number.isFinite(row.score) && (row.y === 0 || row.y === 1))
    .sort((a, b) => a.score - b.score);
  const positives = sorted.reduce((sum, row) => sum + row.y, 0);
  const negatives = sorted.length - positives;
  if (!positives || !negatives) return null;
  let rankSum = 0;
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].score === sorted[i].score) j += 1;
    const averageRank = ((i + 1) + j) / 2;
    for (let k = i; k < j; k += 1) if (sorted[k].y === 1) rankSum += averageRank;
    i = j;
  }
  return (rankSum - positives * (positives + 1) / 2) / (positives * negatives);
}

function percent(value, digits = 2) {
  return `${(100 * value).toFixed(digits)}%`;
}

function money(value) {
  return `$${value.toFixed(2)}`;
}

function maxDrawdown(pnls) {
  let equity = 0;
  let peak = 0;
  let dd = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }
  return dd;
}

const featureRows = parseCsv(FEATURE_CSV);
const tickRows = parseCsv(TICK_CSV);
const eventStarts = [...new Set([
  ...featureRows.map((row) => row.event_start),
  ...tickRows.map((row) => row.event_start),
])].sort();
const minStartMs = Math.min(...eventStarts.map(Date.parse));
const maxStartMs = Math.max(...eventStarts.map(Date.parse));

const gammaEvents = await fetchResolvedEvents(minStartMs, maxStartMs);
const outcomes = new Map();
for (const event of gammaEvents) {
  const start = new Date(event.startTime).toISOString();
  const winner = resolvedWinner(event);
  if (winner == null) continue;
  outcomes.set(start, {
    eventStart: start,
    slug: event.slug,
    conditionId: event.markets?.[0]?.conditionId ?? '',
    winner,
    finalPrice: Number(event.eventMetadata?.finalPrice),
    priceToBeat: Number(event.eventMetadata?.priceToBeat),
    automaticallyResolved: Boolean(event.automaticallyResolved),
  });
}

const outcomeLines = [
  'event_start,slug,condition_id,winner,final_price,price_to_beat,automatically_resolved',
  ...[...outcomes.values()]
    .sort((a, b) => a.eventStart.localeCompare(b.eventStart))
    .map((row) => [
      row.eventStart, row.slug, row.conditionId, row.winner,
      row.finalPrice, row.priceToBeat, row.automaticallyResolved ? 1 : 0,
    ].join(',')),
];
fs.writeFileSync(OUT_CSV, `${outcomeLines.join('\n')}\n`);

const uniqueFeatures = new Map();
for (const row of featureRows) {
  if (!uniqueFeatures.has(row.event_start)) uniqueFeatures.set(row.event_start, row);
}
let localWinnerMismatches = 0;
let matchedFeatureEvents = 0;
const mismatchRows = [];
for (const [eventStart, row] of uniqueFeatures) {
  const gamma = outcomes.get(eventStart);
  if (!gamma) continue;
  matchedFeatureEvents += 1;
  const localWinner = Number(row.winner);
  if (localWinner !== gamma.winner) {
    localWinnerMismatches += 1;
    mismatchRows.push({
      eventStart,
      localWinner,
      gammaWinner: gamma.winner,
      chainlinkMargin: gamma.finalPrice - gamma.priceToBeat,
    });
  }
}

const byTau = [];
for (const tau of [60, 30, 20, 10]) {
  const rows = featureRows
    .filter((row) => Number(row.tau) === tau && outcomes.has(row.event_start))
    .map((row) => {
      const gammaWinner = outcomes.get(row.event_start).winner;
      return {
        ...row,
        localFlip: Number(row.flip),
        canonicalFlip: Number(row.leader) === gammaWinner ? 0 : 1,
        marketRisk: 1 - Number(row.favMid),
      };
    });
  const localFlips = rows.reduce((sum, row) => sum + row.localFlip, 0);
  const canonicalFlips = rows.reduce((sum, row) => sum + row.canonicalFlip, 0);
  byTau.push({
    tau,
    n: rows.length,
    localFlips,
    localRate: localFlips / rows.length,
    canonicalFlips,
    canonicalRate: canonicalFlips / rows.length,
    canonicalMarketAuc: auc(rows, 'canonicalFlip', 'marketRisk'),
  });
}

const ruleRows = featureRows
  .filter((row) => Number(row.tau) === 30 && row.day >= '2026-07-01' && outcomes.has(row.event_start))
  .map((row) => {
    const canonicalFlip = Number(row.leader) === outcomes.get(row.event_start).winner ? 0 : 1;
    const signal = (1 - Number(row.favMid)) >= 0.30 && Number(row.z) <= 4;
    return { canonicalFlip, signal };
  });
const ruleSignals = ruleRows.filter((row) => row.signal);
const ruleTrue = ruleSignals.reduce((sum, row) => sum + row.canonicalFlip, 0);
const ruleFlips = ruleRows.reduce((sum, row) => sum + row.canonicalFlip, 0);

const pnlColumns = Object.keys(tickRows[0]).filter((key) => key.startsWith('pnl_'));
const variants = pnlColumns.map((key) => key.slice(4));
const splitOf = (day) => day < '2026-06-15'
  ? 'train'
  : day < '2026-07-01' ? 'validation' : 'holdout';
const tickMatched = tickRows.filter((row) => outcomes.has(row.event_start));
const canonicalHoldPnl = (row) => {
  const ask = Number(row.ask);
  const shares = 10 / ask;
  const entryFee = 0.07 * ask * (1 - ask) * shares;
  const won = Number(row.side) === outcomes.get(row.event_start).winner;
  return won ? shares * 0.995 - 10 - entryFee : -10 - entryFee;
};

const exitResults = [];
for (const variant of variants) {
  const allPnls = [];
  const localPnls = [];
  let exits = 0;
  const split = {};
  for (const name of ['train', 'validation', 'holdout']) {
    split[name] = { n: 0, localPnl: 0, canonicalPnl: 0, exits: 0 };
  }
  for (const row of tickMatched) {
    const splitName = splitOf(row.day);
    const exited = variant !== 'hold' && row[`t_${variant}`] !== '';
    const localPnl = Number(row[`pnl_${variant}`]);
    const canonicalPnl = exited ? localPnl : canonicalHoldPnl(row);
    exits += exited ? 1 : 0;
    allPnls.push(canonicalPnl);
    localPnls.push(localPnl);
    split[splitName].n += 1;
    split[splitName].localPnl += localPnl;
    split[splitName].canonicalPnl += canonicalPnl;
    split[splitName].exits += exited ? 1 : 0;
  }
  exitResults.push({
    variant,
    n: tickMatched.length,
    exits,
    exitRate: exits / tickMatched.length,
    localPnl: localPnls.reduce((a, b) => a + b, 0),
    canonicalPnl: allPnls.reduce((a, b) => a + b, 0),
    canonicalMaxDrawdown: maxDrawdown(allPnls),
    split,
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  source: API,
  range: { minEventStart: isoNoMillis(minStartMs), maxEventStart: isoNoMillis(maxStartMs) },
  gammaEventsFetched: gammaEvents.length,
  targetEvents: eventStarts.length,
  canonicalOutcomesInRange: outcomes.size,
  targetCanonicalOutcomes: eventStarts.filter((eventStart) => outcomes.has(eventStart)).length,
  featureValidation: {
    localEvents: uniqueFeatures.size,
    matchedEvents: matchedFeatureEvents,
    localWinnerMismatches,
    mismatchRate: localWinnerMismatches / matchedFeatureEvents,
    mismatches: mismatchRows,
    byTau,
    holdoutSimpleRuleTau30: {
      n: ruleRows.length,
      signals: ruleSignals.length,
      trueSignals: ruleTrue,
      flips: ruleFlips,
      precision: ruleTrue / ruleSignals.length,
      recall: ruleTrue / ruleFlips,
      coverage: ruleSignals.length / ruleRows.length,
    },
  },
  tickExitValidation: {
    localTrades: tickRows.length,
    matchedTrades: tickMatched.length,
    variants: exitResults,
  },
};
fs.writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`);

const selected = exitResults.filter((row) => ['hold', 'lead', 'lead_bid45', 'lead_bid40', 'bid45', 'shock'].includes(row.variant));
const md = [
  '# BTC 5m — validação contra resultados resolvidos da Polymarket',
  '',
  `Gerado: ${report.generatedAt}`,
  `Eventos com label local: ${matchedFeatureEvents}; resultados canônicos encontrados: ${outcomes.size}.`,
  '',
  '## Concordância de vencedor',
  '',
  `Divergências entre último spot local e resultado resolvido: **${localWinnerMismatches}/${matchedFeatureEvents} (${percent(report.featureValidation.mismatchRate)})**.`,
  '',
  '| antecedência | n | flip local | flip canônico | AUC canônico do preço |',
  '|---:|---:|---:|---:|---:|',
  ...byTau.map((row) => `| ${row.tau}s | ${row.n} | ${percent(row.localRate)} | ${percent(row.canonicalRate)} | ${row.canonicalMarketAuc.toFixed(3)} |`),
  '',
  '## Regra pré-entrada simples no holdout (30s)',
  '',
  '`favMid <= 0.70 AND z <= 4`',
  '',
  `Sinais: ${ruleSignals.length}/${ruleRows.length} (${percent(ruleSignals.length / ruleRows.length)}); precisão ${percent(ruleTrue / ruleSignals.length)}; recall ${percent(ruleTrue / ruleFlips)}.`,
  '',
  '## Saída tick-a-tick com settlement canônico',
  '',
  '| variante | saídas | PnL local | PnL canônico | maxDD canônico | canônico holdout |',
  '|---|---:|---:|---:|---:|---:|',
  ...selected.map((row) => `| ${row.variant} | ${row.exits} (${percent(row.exitRate)}) | ${money(row.localPnl)} | ${money(row.canonicalPnl)} | ${money(row.canonicalMaxDrawdown)} | ${money(row.split.holdout.canonicalPnl)} |`),
  '',
  'Observação: quando uma variante saiu antes do fim, o PnL da saída independe do vencedor; o label canônico altera apenas os trades mantidos até o settlement.',
  '',
];
fs.writeFileSync(OUT_MD, `${md.join('\n')}\n`);

process.stdout.write(`${JSON.stringify({
  canonicalOutcomes: outcomes.size,
  targetCanonicalOutcomes: report.targetCanonicalOutcomes,
  matchedFeatureEvents,
  localWinnerMismatches,
  mismatchRate: report.featureValidation.mismatchRate,
  rule: report.featureValidation.holdoutSimpleRuleTau30,
  exits: Object.fromEntries(selected.map((row) => [row.variant, {
    localPnl: row.localPnl,
    canonicalPnl: row.canonicalPnl,
    maxDrawdown: row.canonicalMaxDrawdown,
    holdoutPnl: row.split.holdout.canonicalPnl,
  }])),
}, null, 2)}\n`);
