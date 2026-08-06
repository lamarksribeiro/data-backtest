#!/usr/bin/env node
/**
 * A/B V2.3 — fechar buraco mid-ask / dead soft-stop sobre V2.2 (cap45+nra60).
 *   node labs/sandbox/binance-lead-scalp/run-improve-v23.mjs --phase is
 *   node labs/sandbox/binance-lead-scalp/run-improve-v23.mjs --phase oos --only base-v22,nra55-cap45,nofill-nra60
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LAB = 'labs/sandbox/binance-lead-scalp/run-scalp-lab.mjs';
const OUT = 'labs/sandbox/binance-lead-scalp/reports';

const RANGES = {
  is: { from: '2026-05-01', to: '2026-07-31' },
  oos: { from: '2026-08-01', to: '2026-08-04' },
};

const V22 = [
  '--impulse-vol-mult', '2.5',
  '--impulse-floor', '5',
  '--impulse-cap', '20',
  '--impulse-usd', '8',
  '--stale-mid', '0.03',
  '--stop', '0.05',
  '--timeout', '20',
  '--rescue',
  '--rescue-offset', '0.01',
  '--rescue-stop', '0.25',
  '--exit-mode', 'maker-ladder',
  '--ladder', '0.08,0.14',
  '--budget', '5',
  '--sizing', 'sharesCap',
  '--shares-cap-ask', '0.45',
  '--no-rescue-above-ask', '0.60',
];

const RUNS = [
  { id: 'base-v22', tag: 'v23-base-v22', extra: [], reuseTags: ['v22-mine', 'improve-cap45', 'v23-base-v22'] },
  { id: 'nra55-cap45', tag: 'v23-nra55', extra: ['--no-rescue-above-ask', '0.55'] },
  { id: 'nra50-cap45', tag: 'v23-nra50', extra: ['--no-rescue-above-ask', '0.50'] },
  { id: 'nofill-nra60', tag: 'v23-nofill', extra: ['--no-rescue-if-no-fill'] },
  { id: 'nofill-nra55', tag: 'v23-nofill-nra55', extra: ['--no-rescue-if-no-fill', '--no-rescue-above-ask', '0.55'] },
  { id: 'rhold30-nra60', tag: 'v23-rhold30', extra: ['--rescue-max-hold', '30'] },
  { id: 'rhold45-nra60', tag: 'v23-rhold45', extra: ['--rescue-max-hold', '45'] },
  { id: 'ds20-nra55', tag: 'v23-ds20-nra55', extra: ['--rescue-stop', '0.20', '--no-rescue-above-ask', '0.55'] },
  { id: 'nofill-rhold45', tag: 'v23-nofill-rhold45', extra: ['--no-rescue-if-no-fill', '--rescue-max-hold', '45'] },
];

function parseCli() {
  const argv = process.argv.slice(2);
  let phase = 'is';
  let only = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--phase') phase = argv[++i];
    else if (argv[i] === '--only') only = String(argv[++i]).split(',').map((s) => s.trim());
  }
  if (!RANGES[phase]) throw new Error(`unknown phase ${phase}`);
  return { phase, range: RANGES[phase], only };
}

function findReport(from, to, tags) {
  const list = Array.isArray(tags) ? tags : [tags];
  for (const tag of list) {
    const files = fs
      .readdirSync(OUT)
      .filter((f) => f.endsWith(`_${tag}.json`) && f.includes(`${from}_${to}`));
    if (!files.length) continue;
    files.sort((a, b) => fs.statSync(path.join(OUT, b)).mtimeMs - fs.statSync(path.join(OUT, a)).mtimeMs);
    return path.join(OUT, files[0]);
  }
  return null;
}

function pick(s) {
  const rs = s.pnlByReason?.rescue_stop;
  const ls = s.pnlByReason?.ladder_stop;
  const lf = s.pnlByReason?.ladder_full;
  const rf = s.pnlByReason?.rescue_full;
  const rt = s.pnlByReason?.rescue_timeout;
  return {
    trades: s.trades,
    winRate: s.winRate != null ? +Number(s.winRate).toFixed(1) : null,
    pnl: +s.totalPnl.toFixed(2),
    pf: s.profitFactor != null && Number.isFinite(s.profitFactor) ? +s.profitFactor.toFixed(3) : s.profitFactor,
    maxDD: +s.maxDrawdown.toFixed(2),
    fees: +s.fees.toFixed(2),
    rescueStopN: rs?.n ?? 0,
    rescueStopPnl: rs ? +rs.sum.toFixed(2) : 0,
    ladderStopN: ls?.n ?? 0,
    ladderStopPnl: ls ? +ls.sum.toFixed(2) : 0,
    ladderFullPnl: lf ? +lf.sum.toFixed(2) : 0,
    rescueFullPnl: rf ? +rf.sum.toFixed(2) : 0,
    rescueTimeoutN: rt?.n ?? 0,
    rescueTimeoutPnl: rt ? +rt.sum.toFixed(2) : 0,
  };
}

function promote(row, base) {
  if (!base) return { pass: false, note: 'no baseline' };
  const pnlOk = row.pnl >= base.pnl * 0.99;
  const ddOk = row.maxDD <= base.maxDD || (row.pnl >= base.pnl * 1.02 && row.maxDD <= base.maxDD * 1.15);
  const ladderOk = row.ladderFullPnl >= base.ladderFullPnl * 0.97;
  const rsBetter = row.rescueStopPnl >= base.rescueStopPnl; // menos negativo
  const pass = pnlOk && ddOk && ladderOk;
  const notes = [];
  if (!pnlOk) notes.push('PnL');
  if (!ddOk) notes.push('maxDD');
  if (!ladderOk) notes.push('ladder');
  if (pass && rsBetter) notes.push('rs↓');
  return { pass, note: pass ? (notes.includes('rs↓') ? 'PROMOTE+rs' : 'PROMOTE') : notes.join('+') || 'fail' };
}

function runOne(run, from, to) {
  const existing = findReport(from, to, run.reuseTags || run.tag);
  if (existing) {
    console.error(`>>> reuse ${run.id} ${path.basename(existing)}`);
    return JSON.parse(fs.readFileSync(existing, 'utf8')).summary;
  }
  const args = [
    '--max-old-space-size=8192',
    LAB,
    '--from', from,
    '--to', to,
    ...V22,
    ...run.extra,
    '--tag', run.tag,
  ];
  console.error(`\n>>> run ${run.id} (${from}→${to})`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  console.error(`<<< done ${run.id} in ${((Date.now() - t0) / 1000).toFixed(1)}s exit=${r.status}`);
  if (r.status !== 0) {
    console.error(r.stderr?.slice(-3000) || r.stdout?.slice(-3000));
    throw new Error(`fail ${run.id}`);
  }
  const report = findReport(from, to, run.tag);
  if (!report) throw new Error(`missing report ${run.tag}`);
  return JSON.parse(fs.readFileSync(report, 'utf8')).summary;
}

const { phase, range, only } = parseCli();
const runs = only ? RUNS.filter((r) => only.includes(r.id)) : RUNS;
const rows = [];
for (const run of runs) {
  rows.push({ id: run.id, tag: run.tag, ...pick(runOne(run, range.from, range.to)) });
}
const baseline = rows.find((r) => r.id === 'base-v22') || rows[0];
const out = {
  generatedAt: new Date().toISOString(),
  phase,
  from: range.from,
  to: range.to,
  baselineId: baseline.id,
  note: 'V2.3 over V2.2 (cap45+nra60). Focus: mid-ask hole + dead soft-stop.',
  rows: rows.map((r) => ({
    ...r,
    delta: {
      pnl: +(r.pnl - baseline.pnl).toFixed(2),
      pnlPct: baseline.pnl ? +(((r.pnl - baseline.pnl) / baseline.pnl) * 100).toFixed(2) : null,
      maxDD: +(r.maxDD - baseline.maxDD).toFixed(2),
      rescueStopPnl: +(r.rescueStopPnl - baseline.rescueStopPnl).toFixed(2),
      ladderFullPnl: +(r.ladderFullPnl - baseline.ladderFullPnl).toFixed(2),
    },
    promote: promote(r, baseline),
  })),
  winners: [],
  verdict: null,
};
out.winners = out.rows.filter((r) => r.promote.pass && r.id !== baseline.id).map((r) => r.id);
out.verdict = out.winners.length
  ? `PROMOTE (${phase}): ${out.winners.join(', ')}`
  : `No V2.3 beat over V2.2 on ${phase}. Keep V2.2; dry residual is sample noise / live risk.`;

const outPath = path.join(OUT, `improve-v23-${phase}-${range.from}_${range.to}-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log(`\n=== V2.3 A/B ${phase} ${range.from}→${range.to} ===`);
console.log(
  'id'.padEnd(16),
  'PnL'.padStart(10),
  'ΔPnL'.padStart(8),
  'PF'.padStart(7),
  'maxDD'.padStart(7),
  'rsPnL'.padStart(9),
  'Δrs'.padStart(8),
  'lfPnL'.padStart(10),
  'verdict'.padStart(12),
);
for (const r of out.rows) {
  console.log(
    r.id.padEnd(16),
    String(r.pnl).padStart(10),
    String(r.delta.pnl).padStart(8),
    String(r.pf ?? '-').padStart(7),
    String(r.maxDD).padStart(7),
    String(r.rescueStopPnl).padStart(9),
    String(r.delta.rescueStopPnl).padStart(8),
    String(r.ladderFullPnl).padStart(10),
    String(r.promote.note).padStart(12),
  );
}
console.log(`\n${out.verdict}`);
console.log(`wrote ${outPath}`);
