#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EXP = 'labs/strategies/terminal/tfc/experiments/v7-final-validate.json';
const WINDOWS = [
  { key: 'full', from: '2026-05-04', to: '2026-07-01' },
  { key: 'june', from: '2026-06-01', to: '2026-07-01' },
  { key: 'holdout', from: '2026-07-01', to: '2026-07-06' },
];

const base = JSON.parse(fs.readFileSync(EXP, 'utf8'));
const summary = {};

for (const win of WINDOWS) {
  const tmp = path.join('labs', 'sandbox', `v7-final-validate-${win.key}.json`);
  fs.writeFileSync(tmp, `${JSON.stringify({ ...base, name: `v7-final-validate-${win.key}`, from: win.from, to: win.to }, null, 2)}\n`);
  console.error(`\n=== ${win.key} ${win.from} → ${win.to} ===`);
  const proc = spawnSync(process.execPath, ['labs/cli/run.js', '--experiment', tmp, '--variant-workers', '5'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    console.error(proc.stderr || proc.stdout);
    process.exit(proc.status || 1);
  }
  const jsonStart = proc.stdout.indexOf('{');
  const payload = JSON.parse(proc.stdout.slice(jsonStart));
  summary[win.key] = {
    reportDir: payload.metadata?.reportDir,
    results: Object.fromEntries((payload.topResults || []).map((r) => [
      r.id,
      {
        pnl: r.summary?.totalPnl,
        entries: r.summary?.entries,
        winRate: r.summary?.winRate,
        profitFactor: r.summary?.profitFactor,
        maxDrawdown: r.summary?.maxDrawdown,
      },
    ])),
  };
  // merge all variants from results file if available
  const reportDir = payload.metadata?.reportDir;
  if (reportDir) {
    const resultsPath = path.join(reportDir, 'results.json');
    if (fs.existsSync(resultsPath)) {
      const full = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
      for (const v of full.variants || []) {
        summary[win.key].results[v.id] = {
          pnl: v.summary?.totalPnl,
          entries: v.summary?.entries,
          winRate: v.summary?.winRate,
          profitFactor: v.summary?.profitFactor,
          maxDrawdown: v.summary?.maxDrawdown,
        };
      }
    }
  }
}

const out = path.join('labs', 'sandbox', 'v7-final-validate-summary.json');
fs.writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
