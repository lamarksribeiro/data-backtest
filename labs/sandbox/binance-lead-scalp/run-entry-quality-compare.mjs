#!/usr/bin/env node
/**
 * A/B qualidade de entrada (ds15 oficial):
 *   baseline          — askSizeMult 0.75, sizing none
 *   depth1.0          — exige askSz >= 100% do size
 *   liqCap            — size = min(budget/ask, askSz*0.9)
 *   depth1.0+liqCap   — os dois
 *
 * Nota: entry-retries é só live (lake fill instantâneo) — não entra neste A/B.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LAB = 'labs/sandbox/binance-lead-scalp/run-scalp-lab.mjs';
const OUT = 'labs/sandbox/binance-lead-scalp/reports';
const FROM = '2026-05-01';
const TO = '2026-07-31';

const DS15 = [
  '--impulse-vol-mult', '2.5',
  '--impulse-floor', '5',
  '--impulse-cap', '12',
  '--impulse-usd', '8',
  '--stale-mid', '0.03',
  '--stop', '0.05',
  '--timeout', '20',
  '--exit-mode', 'maker-ladder',
  '--ladder', '0.08,0.14',
  '--rescue',
  '--rescue-offset', '0.01',
  '--rescue-stop', '0.15',
  '--budget', '10',
  '--min-shares', '5',
];

const RUNS = [
  {
    id: 'baseline',
    tag: 'full-adapt-rescue-ds15',
    extra: ['--sizing', 'none', '--ask-size-mult', '0.75'],
    reuse: true,
  },
  {
    id: 'depth1.0',
    tag: 'full-adapt-rescue-ds15-depth1',
    extra: ['--sizing', 'none', '--ask-size-mult', '1.0'],
    reuse: false,
  },
  {
    id: 'liqCap',
    tag: 'full-adapt-rescue-ds15-liqcap',
    extra: ['--sizing', 'liqCap', '--liq-cap-mult', '0.9', '--ask-size-mult', '0.75'],
    reuse: false,
  },
  {
    id: 'depth1.0+liqCap',
    tag: 'full-adapt-rescue-ds15-depth1-liqcap',
    extra: ['--sizing', 'liqCap', '--liq-cap-mult', '0.9', '--ask-size-mult', '1.0'],
    reuse: false,
  },
];

function findReport(tag) {
  const files = fs
    .readdirSync(OUT)
    .filter((f) => f.endsWith(`_${tag}.json`) && f.includes(`${FROM}_${TO}`));
  if (!files.length) return null;
  files.sort(
    (a, b) => fs.statSync(path.join(OUT, b)).mtimeMs - fs.statSync(path.join(OUT, a)).mtimeMs,
  );
  return path.join(OUT, files[0]);
}

function runOne(run) {
  if (run.reuse) {
    const existing = findReport(run.tag);
    if (existing) {
      console.error(`>>> reuse ${run.id} ${path.basename(existing)}`);
      return JSON.parse(fs.readFileSync(existing, 'utf8')).summary;
    }
  }
  const args = [
    '--max-old-space-size=8192',
    LAB,
    '--from', FROM,
    '--to', TO,
    ...DS15,
    ...run.extra,
    '--tag', run.tag,
  ];
  console.error(`\n>>> run ${run.id}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  console.error(`<<< done ${run.id} in ${((Date.now() - t0) / 1000).toFixed(1)}s exit=${r.status}`);
  if (r.status !== 0) {
    console.error(r.stderr?.slice(-4000) || r.stdout?.slice(-4000));
    throw new Error(`fail ${run.id}`);
  }
  const report = findReport(run.tag);
  if (!report) throw new Error(`missing ${run.tag}`);
  return JSON.parse(fs.readFileSync(report, 'utf8')).summary;
}

function pick(s) {
  const rs = s.pnlByReason?.rescue_stop;
  return {
    trades: s.trades,
    winRate: +Number(s.winRate).toFixed(2),
    pnl: +s.totalPnl.toFixed(2),
    pf: +s.profitFactor.toFixed(3),
    avgPnl: +s.avgPnl.toFixed(4),
    maxDD: +s.maxDrawdown.toFixed(2),
    fees: +s.fees.toFixed(2),
    exitReasons: s.exitReasons,
    rescueStopN: rs?.n ?? 0,
    rescueStopPnl: rs ? +rs.sum.toFixed(2) : 0,
    ladderFullPnl: s.pnlByReason?.ladder_full ? +s.pnlByReason.ladder_full.sum.toFixed(2) : 0,
    rescueFullPnl: s.pnlByReason?.rescue_full ? +s.pnlByReason.rescue_full.sum.toFixed(2) : 0,
    config: {
      sizingMode: s.config?.sizingMode ?? 'none',
      askSizeMult: s.config?.askSizeMult ?? 0.75,
      liqCapMult: s.config?.liqCapMult,
    },
  };
}

const rows = [];
for (const run of RUNS) {
  rows.push({ id: run.id, tag: run.tag, ...pick(runOne(run)) });
}

const baseline = rows[0];
const out = {
  generatedAt: new Date().toISOString(),
  from: FROM,
  to: TO,
  strategy: 'full-adapt-rescue-ds15',
  note:
    'Lake A/B for entry quality. Retry is live-only and not simulated here. Baseline reused from GO report.',
  rows: rows.map((r) => ({
    ...r,
    deltaVsBaseline:
      r.id === baseline.id
        ? null
        : {
            pnl: +(r.pnl - baseline.pnl).toFixed(2),
            pnlPct: +(((r.pnl - baseline.pnl) / baseline.pnl) * 100).toFixed(2),
            pf: +(r.pf - baseline.pf).toFixed(3),
            trades: r.trades - baseline.trades,
            tradesPct: +(((r.trades - baseline.trades) / baseline.trades) * 100).toFixed(2),
            maxDD: +(r.maxDD - baseline.maxDD).toFixed(2),
            winRatePp: +(r.winRate - baseline.winRate).toFixed(2),
            rescueStopPnl: +(r.rescueStopPnl - baseline.rescueStopPnl).toFixed(2),
          },
  })),
  verdict: null,
};

const alts = out.rows.filter((r) => r.id !== 'baseline');
const best = alts.reduce((a, b) => (b.pnl >= a.pnl ? b : a), alts[0]);
if (!best || best.pnl < baseline.pnl * 0.99) {
  out.verdict =
    'KEEP baseline. Depth/liqCap não melhoram PnL no lake (≥1% abaixo ou iguais). Retry só faz sentido como teste live.';
} else if (best.pnl >= baseline.pnl) {
  out.verdict = `CONSIDER ${best.id}: PnL ≥ baseline (Δ ${best.deltaVsBaseline.pnl}). Avaliar trades/maxDD antes de live.`;
} else {
  out.verdict = `WEAK ${best.id}: próximo mas abaixo — manter baseline.`;
}

const outPath = path.join(OUT, `entry-quality-compare-${FROM}_${TO}-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log('\n=== entry quality A/B (ds15) ===');
console.log(
  'mode'.padEnd(18),
  'trades'.padStart(8),
  'WR%'.padStart(7),
  'PnL'.padStart(12),
  'PF'.padStart(7),
  'maxDD'.padStart(9),
  'ΔPnL'.padStart(10),
  'Δtrades%'.padStart(10),
);
for (const r of out.rows) {
  const d = r.deltaVsBaseline;
  console.log(
    r.id.padEnd(18),
    String(r.trades).padStart(8),
    String(r.winRate).padStart(7),
    String(r.pnl).padStart(12),
    String(r.pf).padStart(7),
    String(r.maxDD).padStart(9),
    String(d?.pnl ?? 0).padStart(10),
    String(d?.tradesPct ?? 0).padStart(10),
  );
}
console.log('\nVERDICT:', out.verdict);
console.log('Wrote', outPath);
