#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EXPS = [
  'v7-m1-maker-train', 'v7-m1-maker-june',
  'v7-m1b-late-entry-train', 'v7-m1b-late-entry-june',
  'v7-m2-reverse-train', 'v7-m2-reverse-june',
  'v7-m3-danger-train', 'v7-m3-danger-june',
  'v7-m4-sizing-train', 'v7-m4-sizing-june',
];

const summary = [];
for (const name of EXPS) {
  const expPath = path.join('labs', 'strategies', 'terminal', 'tfc', 'experiments', `${name}.json`);
  console.error(`\n=== RUN ${name} ===`);
  const started = Date.now();
  const proc = spawnSync(process.execPath, ['labs/cli/run.js', '--experiment', expPath, '--variant-workers', '4'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    console.error(proc.stderr || proc.stdout);
    summary.push({ name, ok: false, error: proc.stderr?.slice(0, 500) });
    continue;
  }
  const jsonStart = proc.stdout.indexOf('{');
  const payload = JSON.parse(proc.stdout.slice(jsonStart));
  summary.push({
    name,
    ok: true,
    elapsedMs: Date.now() - started,
    reportDir: payload.metadata?.reportDir,
    results: (payload.topResults || []).map((r) => ({
      id: r.id,
      pnl: r.summary?.totalPnl,
      entries: r.summary?.entries,
      winRate: r.summary?.winRate,
      profitFactor: r.summary?.profitFactor,
      maxDrawdown: r.summary?.maxDrawdown,
    })),
  });
}

const out = path.join('labs', 'sandbox', 'v7-sweep-summary.json');
fs.writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
