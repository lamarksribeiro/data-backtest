/**
 * Pair-Gate V1 — lake replay (Etapa A+B).
 * Contrato: MACHINE-PAIR-GATE-V1.md
 *
 *   node labs/sandbox/pair-path-v0/pair-gate-replay.mjs
 *   node labs/sandbox/pair-path-v0/pair-gate-replay.mjs --from=2026-05-01 --to=2026-06-30
 *   node labs/sandbox/pair-path-v0/pair-gate-replay.mjs --from=2026-07-20 --to=2026-07-22 --shares=5
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

import {
  createPairGateEngine,
  DEFAULT_PARAMS,
  projectPairCost,
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

const FROM = arg('from', '2026-05-01');
const TO = arg('to', '2026-06-30');
const SHARES = Math.max(5, Number(arg('shares', '5')) || 5);
const EPS = Number(arg('epsCents', String(DEFAULT_PARAMS.epsCents)));
const BUFFER = Number(arg('bufferCents', String(DEFAULT_PARAMS.bufferCents)));
const HEDGE_MAX = Number(arg('hedgeAskMax', String(DEFAULT_PARAMS.hedgeAskMax)));
const LATENCY = Math.max(1, Number(arg('latencyTicks', '1')) || 1);
const T_HEDGE = Number(arg('T_hedge_sec', String(DEFAULT_PARAMS.T_hedge_sec)));
const SL = Number(arg('SL_usd', String(DEFAULT_PARAMS.SL_usd * (SHARES / 5))));
const TAG = arg('tag', 'clean');

const OUT_DIR = path.join(ROOT, `.tmp/pair-gate-replay-${TAG}`);

function listDays(from, to) {
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
  const text = fs.readFileSync(OUTCOMES_CSV, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(',');
  const iEpoch = header.indexOf('event_epoch');
  const iWinner = header.indexOf('winner');
  for (let i = 1; i < lines.length; i += 1) {
    // CSV may have quoted fields; winners/epochs are simple
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
  if (
    Number.isFinite(last.underlyingPrice) &&
    Number.isFinite(last.priceToBeat)
  ) {
    if (last.underlyingPrice > last.priceToBeat) return 'UP';
    if (last.underlyingPrice < last.priceToBeat) return 'DOWN';
  }
  if (last.upAsk != null && last.downAsk != null) {
    if (last.upAsk > last.downAsk) return 'UP';
    if (last.downAsk > last.upAsk) return 'DOWN';
  }
  return null;
}

function engineParams() {
  return {
    openShares: SHARES,
    epsCents: EPS,
    bufferCents: BUFFER,
    hedgeAskMax: HEDGE_MAX,
    latencyTicks: LATENCY,
    T_hedge_sec: T_HEDGE,
    SL_usd: SL,
    maxEventNotional: SHARES * 1.15,
    feeRate: 0.07,
    openAskLo: 0.52,
    openAskHi: 0.62,
    openTriggerCents: 55,
    openCapCents: 2,
    hedgeCapCents: 2,
    esperaLimiteC: 70,
    esperaGatilhoC: 55,
    tauOpenMin: 40,
    tauOpenMax: 240,
    abortPreferSell: true,
    holdOnlyIfDust: true,
  };
}

function runEvent(ticks, winners, eventEpoch) {
  const eng = createPairGateEngine(engineParams(), { eventEpoch });
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
  const winner = winners.get(String(eventEpoch)) ?? proxyWinner(ticks);
  const result = eng.finish(winner);
  const paired = result.paired > 0;
  const opened = result.fills.some((f) => f.kind === 'open');
  const hedged = result.fills.some((f) => f.kind === 'hedge');
  const aborted = result.mode === 'aborted' || result.fills.some((f) => f.kind === 'abort_sell');
  const residual = result.residual.shares > 1e-9;

  // decomposição Etapa B
  const pairPremium =
    paired && result.avgSum != null
      ? result.paired * (1 - result.avgSum)
      : 0;
  const abortCost = result.fills
    .filter((f) => f.kind === 'abort_sell')
    .reduce((s, f) => s + Math.max(0, -(f.realized || 0)), 0);
  // residual loss approx: if residual settled against us
  const residualLoss = residual && !paired
    ? Math.max(0, -Math.min(0, result.pnl + result.fees)) // crude
    : residual
      ? Math.max(0, result.residual.shares * (result.avgSum ? result.avgSum / 2 : 0.5) - (winner === result.residual.side ? result.residual.shares : 0))
      : 0;

  return {
    eventEpoch: String(eventEpoch),
    winner,
    winnerSource: winners.has(String(eventEpoch)) ? 'canonical' : 'proxy',
    mode: result.mode,
    opened,
    hedged,
    paired,
    aborted,
    residual,
    residualShares: result.residual.shares,
    pnl: result.pnl,
    fees: result.fees,
    invested: result.invested,
    avgSum: result.avgSum,
    projAtOpen: result.projAtOpen,
    pairPremium,
    abortProceeds: result.abortProceeds,
    abortCost,
    skipCounts: result.skipCounts,
    blockCounts: result.blockCounts,
    openAttempts: result.openAttempts,
    nFills: result.fills.length,
    nEvents: result.events.length,
  };
}

function summarize(rows) {
  const events = rows.length;
  const opened = rows.filter((r) => r.opened);
  const paired = rows.filter((r) => r.paired);
  const aborted = rows.filter((r) => r.aborted && r.opened);
  const residual = rows.filter((r) => r.residual && r.opened);
  const pnls = opened.map((r) => r.pnl);
  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const grossWin = pnls.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const grossLoss = pnls.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const pf = grossLoss < 0 ? grossWin / Math.abs(grossLoss) : grossWin > 0 ? Infinity : 0;
  const fees = opened.reduce((a, r) => a + r.fees, 0);
  const pairPremium = paired.reduce((a, r) => a + r.pairPremium, 0);
  const abortCost = aborted.reduce((a, r) => a + Math.max(0, r.abortCost), 0);

  // skip funnel
  const skipFunnel = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.skipCounts || {})) {
      skipFunnel[k] = (skipFunnel[k] || 0) + v;
    }
  }

  const byDay = new Map();
  for (const r of rows) {
    if (!r.opened) continue;
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(r.pnl);
  }
  const dayPnls = [...byDay.entries()].map(([day, xs]) => ({
    day,
    n: xs.length,
    pnl: xs.reduce((a, b) => a + b, 0),
    ev: xs.reduce((a, b) => a + b, 0) / xs.length,
  }));

  const evPerEvent = opened.length
    ? totalPnl / opened.length
    : 0;

  return {
    events,
    opened: opened.length,
    paired: paired.length,
    aborted: aborted.length,
    residualOpened: residual.length,
    residualRatePct: opened.length
      ? Math.round((1000 * residual.length) / opened.length) / 10
      : 0,
    openRatePct: events
      ? Math.round((1000 * opened.length) / events) / 10
      : 0,
    totalPnl: round4(totalPnl),
    evPerOpen: round4(evPerEvent),
    profitFactor: pf === Infinity ? null : round4(pf),
    profitFactorInf: pf === Infinity,
    fees: round4(fees),
    pairPremium: round4(pairPremium),
    abortCost: round4(abortCost),
    // I2 check: fees + abort + residual contribution vs premium
    i2: {
      premium: round4(pairPremium),
      fees: round4(fees),
      abortCost: round4(abortCost),
      // residual contribution ≈ opened residuals' negative pnl share
      residualDrag: round4(
        residual.reduce((a, r) => a + Math.min(0, r.pnl), 0),
      ),
    },
    worstOpen: opened.length
      ? round4(Math.min(...opened.map((r) => r.pnl)))
      : null,
    bestOpen: opened.length
      ? round4(Math.max(...opened.map((r) => r.pnl)))
      : null,
    daysWithOpens: dayPnls.length,
    skipFunnelTop: Object.entries(skipFunnel)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12),
    dayPnls,
  };
}

function clusterBootstrap(dayPnls, draws = 2000) {
  if (!dayPnls.length) return { lo: null, hi: null, mean: null };
  const seedRng = mulberry32(0x50475231);
  const evs = dayPnls.map((d) => d.ev);
  const means = [];
  for (let i = 0; i < draws; i += 1) {
    let s = 0;
    for (let j = 0; j < evs.length; j += 1) {
      s += evs[Math.floor(seedRng() * evs.length)];
    }
    means.push(s / evs.length);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(0.025 * means.length)];
  const hi = means[Math.floor(0.975 * means.length)];
  const mean = means.reduce((a, b) => a + b, 0) / means.length;
  return { lo: round4(lo), hi: round4(hi), mean: round4(mean) };
}

function mulberry32(a) {
  return function rng() {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

function evaluateGates(summary, bootstrap) {
  const reasons = [];
  let pass = true;

  if (summary.opened < 30) {
    pass = false;
    reasons.push(`NO-GO amostra: opens=${summary.opened} < 30`);
  }
  if (!(summary.totalPnl > 0)) {
    pass = false;
    reasons.push(`PnL=${summary.totalPnl} ≤ 0`);
  }
  const pf = summary.profitFactorInf ? Infinity : summary.profitFactor;
  if (!(pf >= 1.2)) {
    pass = false;
    reasons.push(`PF=${pf} < 1.20`);
  }
  if (bootstrap.lo == null || !(bootstrap.lo > 0)) {
    pass = false;
    reasons.push(`IC95 lo=${bootstrap.lo} ≤ 0`);
  }
  if (!(summary.residualRatePct <= 15)) {
    pass = false;
    reasons.push(`residualRate=${summary.residualRatePct}% > 15%`);
  }
  const drag =
    summary.i2.fees +
    summary.i2.abortCost +
    Math.abs(Math.min(0, summary.i2.residualDrag));
  if (summary.i2.premium > 0 && drag >= 0.5 * summary.i2.premium) {
    pass = false;
    reasons.push(
      `I2: fees+abort+|residualDrag|=${round4(drag)} ≥ 50% premium=${summary.i2.premium}`,
    );
  }
  if (summary.opened === 0) {
    pass = false;
    reasons.push('I1: zero opens — complete-set sem oferta sob este gate');
  }

  return { pass, reasons, pf };
}

async function main() {
  const days = listDays(FROM, TO);
  if (!days.length) throw new Error(`no lake days in ${FROM}..${TO}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const winners = loadWinners();
  console.log('=== Pair-Gate V1 lake replay (Etapa A+B) ===');
  console.log(
    `window=${FROM}..${TO} days=${days.length} shares=${SHARES}` +
      ` eps=${EPS}c buffer=${BUFFER}c hedgeMax=${HEDGE_MAX}` +
      ` lat=${LATENCY} T_hedge=${T_HEDGE}s SL=$${SL}`,
  );
  console.log(`winners loaded=${winners.size} from ${path.basename(OUTCOMES_CSV)}`);
  console.log(
    `proj smoke 55+42 =>`,
    projectPairCost(0.55, 0.42, { epsCents: EPS, bufferCents: BUFFER }),
  );

  const db = await DuckDBInstance.create(':memory:');
  const connection = await db.connect();
  await connection.run('SET threads TO 6');

  /** @type {Array<object>} */
  const allRows = [];
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
      const result = runEvent(buffer, winners, eventKey);
      allRows.push({ day, ...result });
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
      console.log(
        `[${di + 1}/${days.length}] ${day} eligible=${eligibleEvents} opens=${allRows.filter((r) => r.opened).length}`,
      );
    }
  }

  const summary = summarize(allRows);
  const bootstrap = clusterBootstrap(summary.dayPnls);
  const gates = evaluateGates(summary, bootstrap);

  const report = {
    generatedAt: new Date().toISOString(),
    contract: 'MACHINE-PAIR-GATE-V1',
    stage: 'A+B',
    window: { from: FROM, to: TO, days: days.length },
    dataset: 'backtest_ticks BTC 5m depth25',
    executionModel: {
      book: 'L1 best ask/bid',
      liquidity: 'taker_limit @ L1',
      latencyTicks: LATENCY,
      maker: false,
      note: 'L1 only — depth-25 walk fica para V1.1 se A passar',
    },
    params: engineParams(),
    eligibleEvents,
    skippedCoverage,
    summary,
    bootstrapIC95_evPerOpenDayCluster: bootstrap,
    gates,
    sampleOpens: allRows
      .filter((r) => r.opened)
      .sort((a, b) => a.pnl - b.pnl)
      .slice(0, 15)
      .map((r) => ({
        day: r.day,
        eventEpoch: r.eventEpoch,
        mode: r.mode,
        pnl: round4(r.pnl),
        avgSum: r.avgSum != null ? round4(r.avgSum) : null,
        projAtOpen: r.projAtOpen != null ? round4(r.projAtOpen) : null,
        residual: r.residualShares,
        winner: r.winner,
      })),
  };

  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify(report, null, 2),
  );

  const md = [
    `# Pair-Gate V1 — replay ${FROM} → ${TO}`,
    '',
    `**Gate Etapa A+B:** ${gates.pass ? 'PASS' : 'FAIL / HOLD'}`,
    '',
    '## Motivos',
    ...gates.reasons.map((r) => `- ${r}`),
    '',
    '## Resumo',
    '',
    `| Métrica | Valor |`,
    `|---------|------:|`,
    `| Eventos elegíveis | ${eligibleEvents} |`,
    `| Opens | ${summary.opened} (${summary.openRatePct}%) |`,
    `| Paired | ${summary.paired} |`,
    `| Aborted | ${summary.aborted} |`,
    `| Residual rate | ${summary.residualRatePct}% |`,
    `| PnL | ${summary.totalPnl} |`,
    `| EV/open | ${summary.evPerOpen} |`,
    `| PF | ${summary.profitFactorInf ? '∞' : summary.profitFactor} |`,
    `| Fees | ${summary.fees} |`,
    `| Pair premium | ${summary.pairPremium} |`,
    `| IC95 EV (dia) | [${bootstrap.lo}; ${bootstrap.hi}] |`,
    `| Worst open | ${summary.worstOpen} |`,
    '',
    '## Funil SKIP (top)',
    '',
    ...summary.skipFunnelTop.map(([k, v]) => `- \`${k}\`: ${v}`),
    '',
    `Relatório: \`${path.join(OUT_DIR, 'report.json')}\``,
    '',
  ].join('\n');

  fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), md);

  console.log('');
  console.log(md);
  console.log('saved', path.join(OUT_DIR, 'report.json'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
