#!/usr/bin/env node
/**
 * Protect + Arb V1 lab — lake Parquet + journal smoke.
 * Contrato: MACHINE-PROTECT-ARB-V1.md
 *
 *   node labs/sandbox/pair-path-v0/protect-arb-lab.mjs --from=2026-04-23 --to=2026-06-30 --tag=discovery
 *   node labs/sandbox/pair-path-v0/protect-arb-lab.mjs --journals --tag=journal-smoke
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

import {
  createProtectArbEngine,
  VARIANT_PRESETS,
} from './protect-arb-engine.mjs';
import {
  createPairGateEngine,
  DEFAULT_PARAMS as PG_DEFAULTS,
} from './pair-gate-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const LAKE = path.join(
  ROOT,
  'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25',
);
const OUTCOMES_CSV = path.join(ROOT, 'scratch/canonical-outcomes-v1.csv');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((v) => v.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const JOURNALS = process.argv.includes('--journals');
const FROM = arg('from', '2026-04-23');
const TO = arg('to', '2026-06-30');
const TAG = arg('tag', JOURNALS ? 'journal-smoke' : 'discovery');
const SHARES = Math.max(5, Number(arg('shares', '5')) || 5);
const OUT_DIR = path.join(ROOT, `.tmp/protect-arb-v1-${TAG}`);

const ENGINE_VARIANTS = [
  'v0-naked',
  'prot-sell',
  'prot-hedge',
  'prot-min',
  'prot-min-ready',
  'arb-atomic',
];

const JOURNAL_SERIES = [
  '.tmp/poly-baliza/2026-07-28T04-03-09-340Z-series8',
  '.tmp/pair-path-v0-shadow/2026-07-28T04-59-33-426Z-tight-shadow',
  '.tmp/pair-path-v0-shadow/2026-07-28T05-20-20-839Z-calib-shadow',
].map((p) => path.join(ROOT, p));

function round4(x) {
  return Number.isFinite(x) ? Math.round(Number(x) * 1e4) / 1e4 : null;
}

function listDays(from, to) {
  if (!fs.existsSync(LAKE)) return [];
  return fs
    .readdirSync(LAKE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('dt='))
    .map((e) => e.name.slice(3))
    .filter((d) => d >= from && d <= to)
    .sort();
}

function loadWinners() {
  const map = new Map();
  if (!fs.existsSync(OUTCOMES_CSV)) return map;
  const lines = fs.readFileSync(OUTCOMES_CSV, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(',');
  const iEpoch = header.indexOf('event_epoch');
  const iWinner = header.indexOf('winner');
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(',');
    const epoch = cols[iEpoch];
    const winner = cols[iWinner];
    if (epoch && (winner === 'UP' || winner === 'DOWN')) {
      map.set(String(epoch), winner);
    }
  }
  return map;
}

function proxyWinner(ticks) {
  const last = ticks[ticks.length - 1];
  if (!last) return null;
  if (Number.isFinite(last.underlyingPrice) && Number.isFinite(last.priceToBeat)) {
    if (last.underlyingPrice > last.priceToBeat) return 'UP';
    if (last.underlyingPrice < last.priceToBeat) return 'DOWN';
  }
  if (last.upAsk != null && last.downAsk != null) {
    if (last.upAsk > last.downAsk) return 'UP';
    if (last.downAsk > last.upAsk) return 'DOWN';
  }
  return null;
}

function baseParams() {
  return {
    openShares: SHARES,
    maxEventNotional: Math.max(8, SHARES * 1.2),
    feeRate: 0.07,
    openAskLo: 0.52,
    openAskHi: 0.62,
    openTrigger: 0.55,
    openCap: 0.02,
    hedgeAskMax: 0.42,
    avgSumMax: 0.96,
    tauOpenMin: 40,
    tauOpenMax: 240,
    tauHedgeMin: 15,
    maxHedgeAttempts: 8,
    tauForceProtect: 20,
    protectAvgSumMax: 1.0,
  };
}

function runEngineVariant(name, ticks, winner) {
  const eng = createProtectArbEngine(
    { ...baseParams(), ...VARIANT_PRESETS[name] },
    { variant: name },
  );
  for (const t of ticks) {
    eng.onTick({
      tau: t.tau,
      upAsk: t.upAsk,
      downAsk: t.downAsk,
      upBid: t.upBid,
      downBid: t.downBid,
      ts: t.tsEpoch,
    });
  }
  const result = eng.finish(winner);
  const opened = result.fills.some(
    (f) => f.kind === 'open' || f.kind === 'atomic_up' || f.kind === 'atomic_down',
  );
  return {
    variant: name,
    opened,
    equalized: Boolean(result.equalized && result.residual < 1e-6),
    residualEnd: result.residual,
    pnl: result.pnl,
    worst: result.worst,
    fees: result.fees,
    avgSum: result.avgSum,
    nProtectSell: result.nProtectSell,
    nProtectHedge: result.nProtectHedge,
    bidProxyUsed: result.bidProxyUsed,
    mode: result.mode,
    blockCounts: result.blockCounts,
    nFills: result.fills.length,
  };
}

function runPairGate(ticks, winner) {
  const eng = createPairGateEngine({
    ...PG_DEFAULTS,
    openShares: SHARES,
    maxEventNotional: SHARES * 1.15,
    hedgeAskMax: 0.42,
    epsCents: 2,
    bufferCents: 1,
    latencyTicks: 1,
    T_hedge_sec: 8,
    SL_usd: 0.4 * (SHARES / 5),
    abortPreferSell: true,
  });
  for (const t of ticks) {
    eng.onTick({
      tau: t.tau,
      upAsk: t.upAsk,
      downAsk: t.downAsk,
      upBid: t.upBid,
      downBid: t.downBid,
      ts: t.tsEpoch,
    });
  }
  const result = eng.finish(winner);
  const opened = result.fills.some((f) => f.kind === 'open');
  const aborted = result.mode === 'aborted' || result.fills.some((f) => f.kind === 'abort_sell');
  const paired = result.paired > 0;
  return {
    variant: 'arb-pair-gate',
    opened,
    equalized: paired,
    residualEnd: result.residual?.shares ?? 0,
    pnl: result.pnl,
    worst: paired ? result.pnl : Math.min(0, result.pnl),
    fees: result.fees,
    avgSum: result.avgSum,
    nProtectSell: result.fills.filter((f) => f.kind === 'abort_sell').length,
    nProtectHedge: 0,
    bidProxyUsed: false,
    mode: result.mode,
    aborted,
    blockCounts: result.blockCounts || {},
    nFills: result.fills.length,
  };
}

function runAllVariants(ticks, winner) {
  const rows = ENGINE_VARIANTS.map((name) => runEngineVariant(name, ticks, winner));
  rows.push(runPairGate(ticks, winner));
  return rows;
}

function summarizeVariant(rows) {
  const opened = rows.filter((r) => r.opened);
  const pnls = opened.map((r) => r.pnl).filter((x) => Number.isFinite(x));
  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const grossWin = pnls.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const grossLoss = pnls.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const pf =
    grossLoss < -1e-12
      ? grossWin / Math.abs(grossLoss)
      : grossWin > 0
        ? null
        : 0;
  const residualEnd = opened.filter((r) => r.residualEnd >= 1).length;
  const equalized = opened.filter((r) => r.equalized).length;
  const avgSums = opened.map((r) => r.avgSum).filter((x) => x != null);
  avgSums.sort((a, b) => a - b);
  const avgSumMed = avgSums.length
    ? avgSums[Math.floor(avgSums.length / 2)]
    : null;

  return {
    events: rows.length,
    nOpen: opened.length,
    nEqualized: equalized,
    nResidualEnd: residualEnd,
    residualRatePct: opened.length
      ? round4((100 * residualEnd) / opened.length)
      : 0,
    nProtectSell: opened.reduce((a, r) => a + (r.nProtectSell || 0), 0),
    nProtectHedge: opened.reduce((a, r) => a + (r.nProtectHedge || 0), 0),
    pnl: round4(totalPnl),
    worst: opened.length
      ? round4(Math.min(...opened.map((r) => r.pnl)))
      : null,
    best: opened.length
      ? round4(Math.max(...opened.map((r) => r.pnl)))
      : null,
    PF: pf == null ? null : round4(pf),
    avgSumMed: avgSumMed != null ? round4(avgSumMed) : null,
    feeTotal: round4(opened.reduce((a, r) => a + (r.fees || 0), 0)),
    abortDrag: round4(
      opened
        .filter((r) => r.aborted)
        .reduce((a, r) => a + Math.min(0, r.pnl), 0),
    ),
  };
}

function evaluateProtectGates(summaries) {
  const naked = summaries['v0-naked'];
  const candidates = ['prot-min', 'prot-min-ready'];
  const openNotional = SHARES * 0.62;
  const results = {};

  for (const id of candidates) {
    const s = summaries[id];
    const reasons = [];
    let pass = true;
    if (!s || s.nOpen < 1) {
      results[id] = { pass: false, reasons: ['no opens'] };
      continue;
    }
    if (s.nOpen >= 10 && s.residualRatePct > 5) {
      pass = false;
      reasons.push(`residualRate ${s.residualRatePct}% > 5%`);
    }
    if (s.worst != null && s.worst < -openNotional - 1e-9) {
      pass = false;
      reasons.push(`worst ${s.worst} < -openNotional ${-openNotional}`);
    }
    if (naked && naked.pnl != null && Math.abs(naked.pnl) > 1e-9) {
      const floor = naked.pnl - 0.5 * Math.abs(naked.pnl);
      if (s.pnl < floor - 1e-9) {
        pass = false;
        reasons.push(`pnl ${s.pnl} worse than floor ${round4(floor)} vs v0-naked`);
      }
    }
    if (pass) reasons.push('gates ok');
    results[id] = { pass, reasons };
  }
  return results;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadJournalEvents() {
  const events = [];
  for (const series of JOURNAL_SERIES) {
    const ed = path.join(series, 'events');
    if (!fs.existsSync(ed)) continue;
    for (const name of fs.readdirSync(ed)) {
      const ticksPath = path.join(ed, name, 'ticks.jsonl');
      if (!fs.existsSync(ticksPath)) continue;
      const raw = readJsonl(ticksPath);
      const ticks = raw
        .map((t) => ({
          tau: t.tau ?? t.tauSec ?? null,
          upAsk: t.upAsk ?? t.askUp ?? null,
          downAsk: t.downAsk ?? t.askDown ?? null,
          upBid: t.upBid ?? t.bidUp ?? null,
          downBid: t.downBid ?? t.bidDown ?? null,
          tsEpoch: t.ts ?? t.tsEpoch ?? null,
          underlyingPrice: t.btc ?? t.underlyingPrice ?? null,
          priceToBeat: t.ptb ?? t.priceToBeat ?? null,
        }))
        .filter((t) => t.tau != null && t.upAsk != null && t.downAsk != null);
      if (ticks.length < 10) continue;
      events.push({ id: name, day: 'journal', ticks });
    }
  }
  return events;
}

async function runLake() {
  const days = listDays(FROM, TO);
  const winners = loadWinners();
  console.log(`Protect+Arb lab lake ${FROM}→${TO} days=${days.length} tag=${TAG}`);
  console.log(`winners=${winners.size}`);

  const db = await DuckDBInstance.create(':memory:');
  const connection = await db.connect();
  await connection.run('SET threads TO 6');

  /** @type {Map<string, object[]>} */
  const byVariant = new Map([
    ...ENGINE_VARIANTS.map((v) => [v, []]),
    ['arb-pair-gate', []],
  ]);

  let eligibleEvents = 0;
  let skippedCoverage = 0;

  for (let di = 0; di < days.length; di += 1) {
    const day = days[di];
    const dayDir = path.join(LAKE, `dt=${day}`);
    const files = fs
      .readdirSync(dayDir)
      .filter((n) => n.endsWith('.parquet'))
      .map((n) => path.join(dayDir, n));
    if (!files.length) continue;
    const parquet = `[${files.map((f) => quotedString(f)).join(',')}]`;
    const query = `
      SELECT
        epoch(try_cast(event_start AS TIMESTAMPTZ))::BIGINT AS event_epoch,
        epoch(try_cast(ts AS TIMESTAMPTZ))::DOUBLE AS ts_epoch,
        extract(epoch FROM (
          try_cast(event_end AS TIMESTAMPTZ) - try_cast(ts AS TIMESTAMPTZ)
        ))::DOUBLE AS tau,
        up_best_ask, down_best_ask,
        up_best_bid, down_best_bid,
        underlying_price, price_to_beat
      FROM read_parquet(${parquet})
      WHERE coverage >= 0.99
        AND coalesce(degraded, false) = false
        AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
      QUALIFY row_number() OVER (
        PARTITION BY event_start, ts ORDER BY coverage DESC
      ) = 1
      ORDER BY event_start, ts
    `;
    const rows = (await connection.runAndReadAll(query)).getRowObjectsJS();

    let eventKey = null;
    let buffer = [];
    const flush = () => {
      if (!buffer.length) return;
      const maxTau = Math.max(...buffer.map((t) => t.tau));
      const minTau = Math.min(...buffer.map((t) => t.tau));
      if (maxTau < 240 || minTau > 15) {
        skippedCoverage += 1;
        return;
      }
      eligibleEvents += 1;
      const winner =
        winners.get(String(eventKey)) ?? proxyWinner(buffer);
      const results = runAllVariants(buffer, winner);
      for (const r of results) {
        byVariant.get(r.variant).push({ day, eventEpoch: eventKey, winner, ...r });
      }
    };

    for (const row of rows) {
      const key = String(row.event_epoch);
      if (eventKey != null && key !== eventKey) {
        flush();
        buffer = [];
      }
      eventKey = key;
      buffer.push({
        tau: Number(row.tau),
        tsEpoch: Number(row.ts_epoch),
        upAsk: Number(row.up_best_ask),
        downAsk: Number(row.down_best_ask),
        upBid: row.up_best_bid != null ? Number(row.up_best_bid) : null,
        downBid: row.down_best_bid != null ? Number(row.down_best_bid) : null,
        underlyingPrice:
          row.underlying_price != null ? Number(row.underlying_price) : null,
        priceToBeat:
          row.price_to_beat != null ? Number(row.price_to_beat) : null,
      });
    }
    flush();

    if (di === 0 || di === days.length - 1 || (di + 1) % 10 === 0) {
      const opens = byVariant.get('v0-naked').filter((r) => r.opened).length;
      console.log(
        `[${di + 1}/${days.length}] ${day} eligible=${eligibleEvents} v0opens=${opens}`,
      );
    }
  }

  return { byVariant, eligibleEvents, skippedCoverage, days: days.length, winners: winners.size };
}

function runJournals() {
  const events = loadJournalEvents();
  console.log(`Protect+Arb journal smoke events=${events.length}`);
  const byVariant = new Map([
    ...ENGINE_VARIANTS.map((v) => [v, []]),
    ['arb-pair-gate', []],
  ]);
  for (const ev of events) {
    const winner = proxyWinner(ev.ticks);
    const results = runAllVariants(ev.ticks, winner);
    for (const r of results) {
      byVariant.get(r.variant).push({
        day: 'journal',
        eventEpoch: ev.id,
        winner,
        ...r,
      });
    }
  }
  return {
    byVariant,
    eligibleEvents: events.length,
    skippedCoverage: 0,
    days: 0,
    winners: 0,
  };
}

function writeReport(bundle) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const summaries = {};
  for (const [name, rows] of bundle.byVariant) {
    summaries[name] = summarizeVariant(rows);
  }
  const protectGates = evaluateProtectGates(summaries);
  const report = {
    generatedAt: new Date().toISOString(),
    contract: 'MACHINE-PROTECT-ARB-V1',
    tag: TAG,
    source: JOURNALS ? 'journals' : 'lake',
    window: JOURNALS
      ? { journals: JOURNAL_SERIES.map((p) => path.basename(p)) }
      : { from: FROM, to: TO, days: bundle.days },
    shares: SHARES,
    eligibleEvents: bundle.eligibleEvents,
    skippedCoverage: bundle.skippedCoverage,
    winnersLoaded: bundle.winners,
    variants: summaries,
    protectGates,
    sampleWorst: Object.fromEntries(
      [...bundle.byVariant.entries()].map(([name, rows]) => [
        name,
        rows
          .filter((r) => r.opened)
          .sort((a, b) => a.pnl - b.pnl)
          .slice(0, 5)
          .map((r) => ({
            day: r.day,
            eventEpoch: r.eventEpoch,
            pnl: round4(r.pnl),
            residual: r.residualEnd,
            mode: r.mode,
            protectSell: r.nProtectSell,
            protectHedge: r.nProtectHedge,
          })),
      ]),
    ),
  };

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

  const lines = [
    `# Protect + Arb V1 — ${TAG}`,
    '',
    `Source: **${report.source}** · events=${bundle.eligibleEvents}`,
    '',
    '| Variant | Opens | Eq | Resid% | PnL | Worst | PF | ProtS/H |',
    '|---------|------:|---:|-------:|----:|------:|---:|--------:|',
  ];
  for (const [name, s] of Object.entries(summaries)) {
    lines.push(
      `| ${name} | ${s.nOpen} | ${s.nEqualized} | ${s.residualRatePct} | ${s.pnl} | ${s.worst} | ${s.PF ?? 'inf'} | ${s.nProtectSell}/${s.nProtectHedge} |`,
    );
  }
  lines.push('', '## Protect gates', '');
  for (const [id, g] of Object.entries(protectGates)) {
    lines.push(`- **${id}**: ${g.pass ? 'PASS' : 'FAIL'} — ${g.reasons.join('; ')}`);
  }
  lines.push('', `Report: \`.tmp/protect-arb-v1-${TAG}/report.json\``, '');
  fs.writeFileSync(path.join(OUT_DIR, 'SUMMARY.md'), lines.join('\n'));
  console.log(lines.join('\n'));
  return report;
}

const bundle = JOURNALS ? runJournals() : await runLake();
writeReport(bundle);
