#!/usr/bin/env node
/**
 * Roda as variantes históricas do scalp e imprime PnL mês a mês.
 * Janela principal: 2026-05-04 → 2026-06-14 (+ julho para as mais novas).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LAB = 'labs/sandbox/binance-lead-scalp/run-scalp-lab.mjs';
const OUT = 'labs/sandbox/binance-lead-scalp/reports';

const RUNS = [
  {
    id: 'A · taker +3¢/8s · $12/0.02',
    from: '2026-05-04',
    to: '2026-06-14',
    args: [
      '--impulse-usd', '12', '--stale-mid', '0.02', '--tp', '0.03', '--stop', '0.05',
      '--timeout', '8', '--exit-mode', 'taker', '--tag', 'month-A',
    ],
  },
  {
    id: 'B · maker +1/+2/+3 · 8s · $12/0.02',
    from: '2026-05-04',
    to: '2026-06-14',
    args: [
      '--impulse-usd', '12', '--stale-mid', '0.02', '--stop', '0.05', '--timeout', '8',
      '--exit-mode', 'maker-ladder', '--ladder', '0.01,0.02,0.03', '--tag', 'month-B',
    ],
  },
  {
    id: 'C · maker +3¢ · 8s · $12/0.02',
    from: '2026-05-04',
    to: '2026-06-14',
    args: [
      '--impulse-usd', '12', '--stale-mid', '0.02', '--stop', '0.05', '--timeout', '8',
      '--exit-mode', 'maker-ladder', '--ladder', '0.03', '--tag', 'month-C',
    ],
  },
  {
    id: 'D · maker +2/+3 · 8s · $12/0.02',
    from: '2026-05-04',
    to: '2026-06-14',
    args: [
      '--impulse-usd', '12', '--stale-mid', '0.02', '--stop', '0.05', '--timeout', '8',
      '--exit-mode', 'maker-ladder', '--ladder', '0.02,0.03', '--tag', 'month-D',
    ],
  },
  {
    id: 'E · ladder +8/+14 · 20s · $12/0.02',
    from: '2026-05-04',
    to: '2026-06-14',
    args: [
      '--impulse-usd', '12', '--stale-mid', '0.02', '--stop', '0.05', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14', '--tag', 'month-E',
    ],
  },
  {
    id: 'F · brief $20 · stop−15% · +8/+14',
    from: '2026-05-04',
    to: '2026-06-14',
    args: [
      '--impulse-usd', '20', '--stale-mid', '0.02', '--stop-pct', '0.15', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14', '--tag', 'month-F',
    ],
  },
  {
    id: 'E-freq · $8/0.03 · +8/+14',
    from: '2026-05-04',
    to: '2026-06-14',
    args: [
      '--impulse-usd', '8', '--stale-mid', '0.03', '--stop', '0.05', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14', '--tag', 'month-Efreq',
    ],
  },
  {
    id: 'i6-s04 · $6/0.04 · +8/+14',
    from: '2026-05-04',
    to: '2026-06-14',
    args: [
      '--impulse-usd', '6', '--stale-mid', '0.04', '--stop', '0.05', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14', '--tag', 'month-i6s04',
    ],
  },
  {
    id: 'i6-s03 · $6/0.03 · +8/+14',
    from: '2026-05-04',
    to: '2026-06-14',
    args: [
      '--impulse-usd', '6', '--stale-mid', '0.03', '--stop', '0.05', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14', '--tag', 'month-i6s03',
    ],
  },
  {
    id: 'Adapt · 2.5σ ∈$5–12 · 0.03',
    from: '2026-05-04',
    to: '2026-06-14',
    args: [
      '--impulse-vol-mult', '2.5', '--impulse-floor', '5', '--impulse-cap', '12',
      '--impulse-usd', '8', '--stale-mid', '0.03', '--stop', '0.05', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14', '--tag', 'month-adapt',
    ],
  },
  {
    id: 'Adapt+rescue hold · +1¢ até EOD',
    from: '2026-05-04',
    to: '2026-06-14',
    args: [
      '--impulse-vol-mult', '2.5', '--impulse-floor', '5', '--impulse-cap', '12',
      '--impulse-usd', '8', '--stale-mid', '0.03', '--stop', '0.05', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14',
      '--rescue', '--rescue-offset', '0.01', '--rescue-stop', '0',
      '--tag', 'month-adapt-rescue',
    ],
  },
  {
    id: 'Adapt+rescue ds15 · stop−15¢',
    from: '2026-05-04',
    to: '2026-06-14',
    args: [
      '--impulse-vol-mult', '2.5', '--impulse-floor', '5', '--impulse-cap', '12',
      '--impulse-usd', '8', '--stale-mid', '0.03', '--stop', '0.05', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14',
      '--rescue', '--rescue-offset', '0.01', '--rescue-stop', '0.15',
      '--tag', 'month-adapt-rescue-ds15',
    ],
  },
  // Julho (regime mais recente / quieto) — variantes chave
  {
    id: '[jul] E-freq · $8/0.03',
    from: '2026-07-17',
    to: '2026-07-31',
    args: [
      '--impulse-usd', '8', '--stale-mid', '0.03', '--stop', '0.05', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14', '--tag', 'month-jul-Efreq',
    ],
  },
  {
    id: '[jul] Adapt · 2.5σ',
    from: '2026-07-17',
    to: '2026-07-31',
    args: [
      '--impulse-vol-mult', '2.5', '--impulse-floor', '5', '--impulse-cap', '12',
      '--impulse-usd', '8', '--stale-mid', '0.03', '--stop', '0.05', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14', '--tag', 'month-jul-adapt',
    ],
  },
  {
    id: '[jul] Adapt+rescue hold',
    from: '2026-07-17',
    to: '2026-07-31',
    args: [
      '--impulse-vol-mult', '2.5', '--impulse-floor', '5', '--impulse-cap', '12',
      '--impulse-usd', '8', '--stale-mid', '0.03', '--stop', '0.05', '--timeout', '20',
      '--exit-mode', 'maker-ladder', '--ladder', '0.08,0.14',
      '--rescue', '--rescue-offset', '0.01', '--rescue-stop', '0',
      '--tag', 'month-jul-adapt-rescue',
    ],
  },
];

function findReport(from, to, tag) {
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith(`_${tag}.json`) && f.includes(`${from}_${to}`));
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(path.join(OUT, b)).mtimeMs - fs.statSync(path.join(OUT, a)).mtimeMs);
  return path.join(OUT, files[0]);
}

function runOne(run) {
  const args = [
    '--max-old-space-size=8192',
    LAB,
    '--from', run.from,
    '--to', run.to,
    ...run.args,
  ];
  console.error(`\n>>> ${run.id}`);
  const r = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(r.stderr?.slice(-2000) || r.stdout?.slice(-2000));
    throw new Error(`fail ${run.id} exit=${r.status}`);
  }
  const tag = run.args[run.args.indexOf('--tag') + 1];
  const report = findReport(run.from, run.to, tag);
  if (!report) throw new Error(`report not found for ${tag}`);
  const j = JSON.parse(fs.readFileSync(report, 'utf8'));
  return j.summary || j;
}

const rows = [];
for (const run of RUNS) {
  const s = runOne(run);
  rows.push({
    id: run.id,
    from: run.from,
    to: run.to,
    totalPnl: s.totalPnl,
    trades: s.trades,
    winRate: s.winRate,
    pf: s.profitFactor,
    feeDrag: s.feeDrag,
    maxDd: s.maxDrawdown,
    byMonth: s.byMonth || {},
  });
}

const outPath = path.join(OUT, `month-comparison-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));

console.log('\n========== PnL POR MÊS ==========\n');
for (const r of rows) {
  const months = Object.keys(r.byMonth).sort();
  const parts = months.map((m) => {
    const x = r.byMonth[m];
    return `${m}: $${x.pnl.toFixed(0)} (${x.trades}t WR${x.winRate}%)`;
  });
  console.log(`${r.id}`);
  console.log(`  total=$${r.totalPnl}  PF=${Number(r.pf).toFixed?.(2) ?? r.pf}  DD=$${r.maxDd}`);
  console.log(`  ${parts.join(' · ') || '(sem byMonth)'}`);
  console.log('');
}

console.log(`wrote ${outPath}`);
