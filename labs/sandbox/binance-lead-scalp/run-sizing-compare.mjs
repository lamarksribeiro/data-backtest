#!/usr/bin/env node
/**
 * A/B sizing no lab oficial ds15 (mai–jul):
 *   1) baseline none (reuse report se existir)
 *   2) sharesCap @ 0.50
 *   3) dynamicBudget @ 0.50
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
];

const RUNS = [
  { id: 'baseline', tag: 'full-adapt-rescue-ds15', sizing: 'none', reuse: true },
  { id: 'sharesCap@0.50', tag: 'full-adapt-rescue-ds15-cap50', sizing: 'sharesCap', reuse: false },
  { id: 'dynamicBudget@0.50', tag: 'full-adapt-rescue-ds15-dyn50', sizing: 'dynamicBudget', reuse: false },
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
    '--sizing', run.sizing,
    '--shares-cap-ask', '0.50',
    '--tag', run.tag,
  ];
  console.error(`\n>>> run ${run.id} sizing=${run.sizing}`);
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
  if (!report) throw new Error(`report missing ${run.tag}`);
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
    avgWin: +s.avgWin.toFixed(4),
    avgLoss: +s.avgLoss.toFixed(4),
    maxDD: +s.maxDrawdown.toFixed(2),
    fees: +s.fees.toFixed(2),
    exitReasons: s.exitReasons,
    rescueStopN: rs?.n ?? 0,
    rescueStopPnl: rs ? +rs.sum.toFixed(2) : 0,
    rescueStopAvg: rs?.avg ?? null,
    ladderFullPnl: s.pnlByReason?.ladder_full ? +s.pnlByReason.ladder_full.sum.toFixed(2) : 0,
    rescueFullPnl: s.pnlByReason?.rescue_full ? +s.pnlByReason.rescue_full.sum.toFixed(2) : 0,
    byMonth: s.byMonth,
    sizingMode: s.config?.sizingMode ?? 'none',
    sharesCapAsk: s.config?.sharesCapAsk,
  };
}

const rows = [];
for (const run of RUNS) {
  const s = runOne(run);
  rows.push({ id: run.id, tag: run.tag, ...pick(s) });
}

const baseline = rows[0];
const out = {
  generatedAt: new Date().toISOString(),
  from: FROM,
  to: TO,
  strategy: 'full-adapt-rescue-ds15',
  note: 'Official run-scalp-lab.mjs; timeout 20s; stale 0.03; budget $10; sharesCapAsk 0.50',
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
            maxDD: +(r.maxDD - baseline.maxDD).toFixed(2),
            winRatePp: +(r.winRate - baseline.winRate).toFixed(2),
            rescueStopN: r.rescueStopN - baseline.rescueStopN,
            rescueStopPnl: +(r.rescueStopPnl - baseline.rescueStopPnl).toFixed(2),
            rescueStopPnlPct:
              baseline.rescueStopPnl !== 0
                ? +(((r.rescueStopPnl - baseline.rescueStopPnl) / Math.abs(baseline.rescueStopPnl)) * 100).toFixed(2)
                : null,
          },
  })),
  verdict: null,
};

// Simple verdict
const cap = out.rows.find((r) => r.id.startsWith('sharesCap'));
const dyn = out.rows.find((r) => r.id.startsWith('dynamicBudget'));
const candidates = [cap, dyn].filter(Boolean);
const best = candidates.reduce((a, b) => (b.pnl > a.pnl ? b : a), candidates[0]);
if (!best || best.pnl < baseline.pnl * 0.98) {
  out.verdict =
    'KEEP baseline (none). Nenhum sizing supera/empata (~≤2% PnL) o GO ds15 — não promover ao live.';
} else if (best.pnl >= baseline.pnl && (best.deltaVsBaseline?.rescueStopPnl ?? 0) > 0) {
  out.verdict = `CONSIDER ${best.id}: PnL ≥ baseline e rescue_stop menos negativo. Validar live micro antes de default.`;
} else if (best.pnl > baseline.pnl) {
  out.verdict = `CONSIDER ${best.id}: PnL acima do baseline. Checar maxDD e rescue_stop.`;
} else {
  out.verdict = `WEAK ${best.id}: próximo do baseline mas sem ganhos claros — preferir manter none.`;
}

const outPath = path.join(OUT, `sizing-compare-${FROM}_${TO}-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log('\n=== sizing A/B (ds15 mai–jul) ===');
console.log(
  'mode'.padEnd(22),
  'trades'.padStart(8),
  'WR%'.padStart(7),
  'PnL'.padStart(12),
  'PF'.padStart(7),
  'maxDD'.padStart(9),
  'rStop$'.padStart(12),
  'ΔPnL'.padStart(10),
  'ΔrStop%'.padStart(9),
);
for (const r of out.rows) {
  const d = r.deltaVsBaseline;
  console.log(
    r.id.padEnd(22),
    String(r.trades).padStart(8),
    String(r.winRate).padStart(7),
    String(r.pnl).padStart(12),
    String(r.pf).padStart(7),
    String(r.maxDD).padStart(9),
    String(r.rescueStopPnl).padStart(12),
    String(d?.pnl ?? 0).padStart(10),
    String(d?.rescueStopPnlPct ?? 0).padStart(9),
  );
}
console.log('\nVERDICT:', out.verdict);
console.log('Wrote', outPath);
