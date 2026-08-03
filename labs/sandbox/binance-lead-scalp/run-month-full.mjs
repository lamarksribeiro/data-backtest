#!/usr/bin/env node
/**
 * Roda variantes do scalp em meses CHEIOS (2026-05-01 → 2026-07-31) e imprime PnL/mês.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LAB = 'labs/sandbox/binance-lead-scalp/run-scalp-lab.mjs';
const OUT = 'labs/sandbox/binance-lead-scalp/reports';
const FROM = '2026-05-01';
const TO = '2026-07-31';

const RUNS = [
  {
    id: 'A · taker +3¢/8s · $12/0.02 (original)',
    args: [
      '--impulse-usd', '12', '--stale-mid', '0.02', '--tp', '0.03', '--stop', '0.05',
      '--timeout', '8', '--exit-mode', 'taker', '--tag', 'full-A',
    ],
  },
  {
    id: 'B · maker +1/+2/+3 · 8s · $12/0.02',
    args: [
      '--impulse-usd', '12', '--stale-mid', '0.02', '--stop', '0.05', '--timeout', '8',
      '--exit-mode', 'maker-ladder', '--ladder', '0.01,0.02,0.03', '--tag', 'full-B',
    ],
  },
  {
    id: 'C · maker +3¢ · 8s · $12/0.02',
    args: [
      '--impulse-usd', '12', '--stale-mid', '0.02', '--stop', '0.05', '--timeout', '8',
      '--exit-mode', 'maker-ladder', '--ladder', '0.03', '--tag', 'full-C',
    ],
  },
  {
    id: 'D · maker +2/+3 · 8s · $12/0.02',
    args: [
      '--impulse-usd', '12', '--stale-mid', '0.02', '--stop', '0.05', '--timeout', '8',
      '--exit-mode', 'maker-ladder', '--ladder', '0.02,0.03', '--tag', 'full-D',
    ],
  },
  {
    id: 'E · ladder +8/+14 · 20s · $12/0.02',
    args: [
      '--impulse-usd', '12', '--stale-mid', '0.02', '--stop', '0.05', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14', '--tag', 'full-E',
    ],
  },
  {
    id: 'F · brief $20 · stop−15% · +8/+14',
    args: [
      '--impulse-usd', '20', '--stale-mid', '0.02', '--stop-pct', '0.15', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14', '--tag', 'full-F',
    ],
  },
  {
    id: 'E-freq · $8/0.03 · +8/+14',
    args: [
      '--impulse-usd', '8', '--stale-mid', '0.03', '--stop', '0.05', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14', '--tag', 'full-Efreq',
    ],
  },
  {
    id: 'i6-s04 · $6/0.04 · +8/+14',
    args: [
      '--impulse-usd', '6', '--stale-mid', '0.04', '--stop', '0.05', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14', '--tag', 'full-i6s04',
    ],
  },
  {
    id: 'i6-s03 · $6/0.03 · +8/+14',
    args: [
      '--impulse-usd', '6', '--stale-mid', '0.03', '--stop', '0.05', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14', '--tag', 'full-i6s03',
    ],
  },
  {
    id: 'Adapt · 2.5σ ∈$5–12 · 0.03',
    args: [
      '--impulse-vol-mult', '2.5', '--impulse-floor', '5', '--impulse-cap', '12',
      '--impulse-usd', '8', '--stale-mid', '0.03', '--stop', '0.05', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14', '--tag', 'full-adapt',
    ],
  },
  {
    id: 'Adapt+rescue hold · +1¢ até EOD',
    args: [
      '--impulse-vol-mult', '2.5', '--impulse-floor', '5', '--impulse-cap', '12',
      '--impulse-usd', '8', '--stale-mid', '0.03', '--stop', '0.05', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14',
      '--rescue', '--rescue-offset', '0.01', '--rescue-stop', '0',
      '--tag', 'full-adapt-rescue',
    ],
  },
  {
    id: 'Adapt+rescue ds15 · stop−15¢',
    args: [
      '--impulse-vol-mult', '2.5', '--impulse-floor', '5', '--impulse-cap', '12',
      '--impulse-usd', '8', '--stale-mid', '0.03', '--stop', '0.05', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14',
      '--rescue', '--rescue-offset', '0.01', '--rescue-stop', '0.15',
      '--tag', 'full-adapt-rescue-ds15',
    ],
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
  const args = ['--max-old-space-size=8192', LAB, '--from', FROM, '--to', TO, ...run.args];
  console.error(`\n>>> ${run.id}`);
  const r = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(r.stderr?.slice(-3000) || r.stdout?.slice(-3000));
    throw new Error(`fail ${run.id} exit=${r.status}`);
  }
  const tag = run.args[run.args.indexOf('--tag') + 1];
  const report = findReport(tag);
  if (!report) throw new Error(`report not found for ${tag}`);
  return JSON.parse(fs.readFileSync(report, 'utf8')).summary;
}

const rows = [];
for (const run of RUNS) {
  const s = runOne(run);
  rows.push({
    id: run.id,
    totalPnl: s.totalPnl,
    trades: s.trades,
    winRate: s.winRate,
    pf: s.profitFactor,
    feeDrag: s.feeDrag,
    maxDd: s.maxDrawdown,
    eventsSeen: s.eventsSeen,
    daysOk: s.meta?.daysOk,
    byMonth: s.byMonth || {},
  });
}

const outPath = path.join(OUT, `month-full-${FROM}_${TO}-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify({ from: FROM, to: TO, rows }, null, 2));

const months = ['2026-05', '2026-06', '2026-07'];
console.log(`\n========== PnL MESES CHEIOS (${FROM} → ${TO}) ==========\n`);
console.log(
  ['Formato', ...months.map((m) => m.slice(5)), 'Total', 'PF', 'DD', 'Trades'].join('\t'),
);
for (const r of rows) {
  const cells = months.map((m) => {
    const x = r.byMonth[m];
    return x ? `$${Math.round(x.pnl)}/${x.trades}t` : '—';
  });
  console.log(
    [
      r.id,
      ...cells,
      `$${Math.round(r.totalPnl)}`,
      Number(r.pf).toFixed(2),
      `$${Math.round(r.maxDd)}`,
      r.trades,
    ].join('\t'),
  );
}

console.log(`\nwrote ${outPath}`);
