#!/usr/bin/env node
/**
 * Compara full-adapt-rescue-ds15 com minTau 20 (baseline) vs 45 vs 60.
 * Janela: 2026-05-01 → 2026-07-31 (mesma do GO ds15).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LAB = 'labs/sandbox/binance-lead-scalp/run-scalp-lab.mjs';
const OUT = 'labs/sandbox/binance-lead-scalp/reports';
const FROM = '2026-05-01';
const TO = '2026-07-31';

const BASE_ARGS = [
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
];

const RUNS = [
  { minTau: 20, tag: 'full-adapt-rescue-ds15', reuseBaseline: true },
  { minTau: 45, tag: 'full-adapt-rescue-ds15-tau45', reuseBaseline: false },
  { minTau: 60, tag: 'full-adapt-rescue-ds15-tau60', reuseBaseline: false },
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

function runOne({ minTau, tag, reuseBaseline }) {
  if (reuseBaseline) {
    const existing = findReport(tag);
    if (existing) {
      console.error(`>>> reuse baseline minTau=${minTau} ${path.basename(existing)}`);
      return JSON.parse(fs.readFileSync(existing, 'utf8')).summary;
    }
  }
  const args = [
    '--max-old-space-size=8192',
    LAB,
    '--from', FROM,
    '--to', TO,
    ...BASE_ARGS,
    '--min-tau', String(minTau),
    '--tag', tag,
  ];
  console.error(`\n>>> run minTau=${minTau} tag=${tag}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  console.error(`<<< done minTau=${minTau} in ${((Date.now() - t0) / 1000).toFixed(1)}s exit=${r.status}`);
  if (r.status !== 0) {
    console.error(r.stderr?.slice(-4000) || r.stdout?.slice(-4000));
    throw new Error(`fail minTau=${minTau} exit=${r.status}`);
  }
  const report = findReport(tag);
  if (!report) throw new Error(`report not found for ${tag}`);
  return JSON.parse(fs.readFileSync(report, 'utf8')).summary;
}

function pick(s) {
  return {
    trades: s.trades,
    winRate: +Number(s.winRate).toFixed(2),
    pnl: +s.totalPnl.toFixed(2),
    pf: +s.profitFactor.toFixed(3),
    avgPnl: +s.avgPnl.toFixed(4),
    maxDD: +s.maxDrawdown.toFixed(2),
    fees: +s.fees.toFixed(2),
    makerPct: s.makerExitSharePct,
    exitReasons: s.exitReasons,
    pnlByReason: Object.fromEntries(
      Object.entries(s.pnlByReason || {}).map(([k, v]) => [
        k,
        { n: v.n, sum: +v.sum.toFixed(2), avg: v.avg },
      ]),
    ),
    byMonth: Object.fromEntries(
      Object.entries(s.byMonth || {}).map(([k, v]) => [
        k,
        { trades: v.trades, pnl: +v.pnl.toFixed(2), wr: v.winRate },
      ]),
    ),
  };
}

const rows = [];
for (const run of RUNS) {
  const s = runOne(run);
  rows.push({ minTau: run.minTau, tag: run.tag, ...pick(s), configMinTau: s.config?.minTau });
}

const baseline = rows.find((r) => r.minTau === 20);
const comparePath = path.join(OUT, `mintau-compare-${FROM}_${TO}-${Date.now()}.json`);
const out = {
  generatedAt: new Date().toISOString(),
  from: FROM,
  to: TO,
  baselineTag: 'full-adapt-rescue-ds15',
  rows: rows.map((r) => {
    if (!baseline || r.minTau === 20) return r;
    return {
      ...r,
      deltaVsBaseline: {
        pnl: +(r.pnl - baseline.pnl).toFixed(2),
        pnlPct: +(((r.pnl - baseline.pnl) / baseline.pnl) * 100).toFixed(2),
        pf: +(r.pf - baseline.pf).toFixed(3),
        trades: r.trades - baseline.trades,
        tradesPct: +(((r.trades - baseline.trades) / baseline.trades) * 100).toFixed(2),
        maxDD: +(r.maxDD - baseline.maxDD).toFixed(2),
        winRatePp: +(r.winRate - baseline.winRate).toFixed(2),
        rescueStopN: (r.exitReasons?.rescue_stop ?? 0) - (baseline.exitReasons?.rescue_stop ?? 0),
        rescueStopPnl:
          +((r.pnlByReason?.rescue_stop?.sum ?? 0) - (baseline.pnlByReason?.rescue_stop?.sum ?? 0)).toFixed(2),
      },
    };
  }),
};
fs.writeFileSync(comparePath, JSON.stringify(out, null, 2));

console.log('\n=== minTau compare (ds15) ===');
console.log(
  'minTau'.padStart(6),
  'trades'.padStart(8),
  'WR%'.padStart(7),
  'PnL'.padStart(12),
  'PF'.padStart(7),
  'maxDD'.padStart(9),
  'ΔPnL'.padStart(12),
  'ΔPF'.padStart(7),
  'rStopN'.padStart(8),
);
for (const r of out.rows) {
  const d = r.deltaVsBaseline;
  console.log(
    String(r.minTau).padStart(6),
    String(r.trades).padStart(8),
    String(r.winRate).padStart(7),
    String(r.pnl).padStart(12),
    String(r.pf).padStart(7),
    String(r.maxDD).padStart(9),
    String(d?.pnl ?? 0).padStart(12),
    String(d?.pf ?? 0).padStart(7),
    String(d?.rescueStopN ?? 0).padStart(8),
  );
}
console.log(`\nWrote ${comparePath}`);
