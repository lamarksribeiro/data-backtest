#!/usr/bin/env node
/**
 * A/B V2.3b — entrada/ladder/impulse sobre V2.2 (filtros mid-ask falharam).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LAB = 'labs/sandbox/binance-lead-scalp/run-scalp-lab.mjs';
const OUT = 'labs/sandbox/binance-lead-scalp/reports';
const FROM = '2026-05-01';
const TO = '2026-07-31';
const OOS_FROM = '2026-08-01';
const OOS_TO = '2026-08-04';

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
  { id: 'base-v22', tag: 'v22-mine', extra: [], reuse: true },
  { id: 'ladder-06-12', tag: 'v23b-l0612', extra: ['--ladder', '0.06,0.12'] },
  { id: 'ladder-10-16', tag: 'v23b-l1016', extra: ['--ladder', '0.10,0.16'] },
  { id: 'ladder-08-only', tag: 'v23b-l08', extra: ['--ladder', '0.08'] },
  { id: 'cap24', tag: 'v23b-cap24', extra: ['--impulse-cap', '24'] },
  { id: 'cap16', tag: 'v23b-cap16', extra: ['--impulse-cap', '16'] },
  { id: 'stale02', tag: 'v23b-stale02', extra: ['--stale-mid', '0.02'] },
  { id: 'stale04', tag: 'v23b-stale04', extra: ['--stale-mid', '0.04'] },
  { id: 'to18', tag: 'v23b-to18', extra: ['--timeout', '18'] },
  { id: 'stop04-cap45', tag: 'v23b-stop04', extra: ['--stop', '0.04'] },
  { id: 'depth1', tag: 'v23b-depth1', extra: ['--ask-size-mult', '1.0'] },
];

function findReport(from, to, tag) {
  const files = fs
    .readdirSync(OUT)
    .filter((f) => f.endsWith(`_${tag}.json`) && f.includes(`${from}_${to}`));
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(path.join(OUT, b)).mtimeMs - fs.statSync(path.join(OUT, a)).mtimeMs);
  return path.join(OUT, files[0]);
}

function pick(s) {
  const rs = s.pnlByReason?.rescue_stop;
  const lf = s.pnlByReason?.ladder_full;
  return {
    trades: s.trades,
    wr: s.winRate != null ? +Number(s.winRate).toFixed(1) : null,
    pnl: +s.totalPnl.toFixed(2),
    pf: s.profitFactor != null && Number.isFinite(s.profitFactor) ? +s.profitFactor.toFixed(3) : s.profitFactor,
    maxDD: +s.maxDrawdown.toFixed(2),
    rsN: rs?.n ?? 0,
    rsPnl: rs ? +rs.sum.toFixed(2) : 0,
    lfPnl: lf ? +lf.sum.toFixed(2) : 0,
  };
}

function promote(row, base) {
  const pnlOk = row.pnl >= base.pnl * 0.99;
  const ddOk = row.maxDD <= base.maxDD || (row.pnl >= base.pnl * 1.02 && row.maxDD <= base.maxDD * 1.15);
  const ladderOk = row.lfPnl >= base.lfPnl * 0.97;
  const pass = pnlOk && ddOk && ladderOk;
  const notes = [];
  if (!pnlOk) notes.push('PnL');
  if (!ddOk) notes.push('DD');
  if (!ladderOk) notes.push('LF');
  return pass ? 'PROMOTE' : notes.join('+') || 'fail';
}

function runOne(run, from, to) {
  if (run.reuse) {
    const existing = findReport(from, to, run.tag);
    if (existing) {
      console.error(`>>> reuse ${run.id}`);
      return JSON.parse(fs.readFileSync(existing, 'utf8')).summary;
    }
  }
  const existing = findReport(from, to, run.tag);
  if (existing && run.reuse !== false) {
    // always prefer fresh for non-base unless reuse true - for speed reuse if exists from this wave
  }
  if (existing && run.id !== 'base-v22') {
    // re-run always for this wave to avoid stale wrong tags - actually reuse if present
    console.error(`>>> reuse ${run.id} ${path.basename(existing)}`);
    return JSON.parse(fs.readFileSync(existing, 'utf8')).summary;
  }
  const args = ['--max-old-space-size=8192', LAB, '--from', from, '--to', to, ...V22, ...run.extra, '--tag', run.tag];
  console.error(`\n>>> run ${run.id}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  console.error(`<<< ${run.id} ${((Date.now() - t0) / 1000).toFixed(1)}s exit=${r.status}`);
  if (r.status !== 0) {
    console.error(r.stderr?.slice(-2000) || r.stdout?.slice(-2000));
    throw new Error(`fail ${run.id}`);
  }
  return JSON.parse(fs.readFileSync(findReport(from, to, run.tag), 'utf8')).summary;
}

const phase = process.argv.includes('--oos') ? 'oos' : 'is';
const from = phase === 'oos' ? OOS_FROM : FROM;
const to = phase === 'oos' ? OOS_TO : TO;
const onlyArg = process.argv.find((a, i, arr) => arr[i - 1] === '--only');
const only = onlyArg ? onlyArg.split(',') : null;
const runs = only ? RUNS.filter((r) => only.includes(r.id)) : RUNS;

const rows = [];
for (const run of runs) rows.push({ id: run.id, ...pick(runOne(run, from, to)) });
const base = rows.find((r) => r.id === 'base-v22');
for (const r of rows) {
  r.deltaPnl = +(r.pnl - base.pnl).toFixed(2);
  r.deltaDD = +(r.maxDD - base.maxDD).toFixed(2);
  r.verdict = promote(r, base);
}
const winners = rows.filter((r) => r.verdict === 'PROMOTE' && r.id !== 'base-v22').map((r) => r.id);
const out = { generatedAt: new Date().toISOString(), phase, from, to, rows, winners };
fs.writeFileSync(path.join(OUT, `improve-v23b-${phase}-${Date.now()}.json`), JSON.stringify(out, null, 2));

console.log(`\n=== V2.3b ${phase} ===`);
console.log('id'.padEnd(16), 'PnL'.padStart(10), 'Δ'.padStart(8), 'PF'.padStart(7), 'DD'.padStart(7), 'LF'.padStart(10), 'verdict'.padStart(10));
for (const r of rows) {
  console.log(r.id.padEnd(16), String(r.pnl).padStart(10), String(r.deltaPnl).padStart(8), String(r.pf).padStart(7), String(r.maxDD).padStart(7), String(r.lfPnl).padStart(10), String(r.verdict).padStart(10));
}
console.log(winners.length ? `PROMOTE: ${winners.join(', ')}` : 'No promote over V2.2');
