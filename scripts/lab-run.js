#!/usr/bin/env node
import 'dotenv/config';

import { runLabExperiment } from '../labs/shared/labRunner.js';

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return flags;
}

function printTop(topResults) {
  const lines = [
    '',
    'rank  variant  pnl       entries  win%    pf      dd      ms',
    '----  -------  --------  -------  ------  ------  ------  ----',
  ];
  for (const item of topResults.slice(0, 10)) {
    const s = item.summary || {};
    lines.push([
      String(item.rank).padStart(4),
      String(item.id).padEnd(7),
      fmt(s.totalPnl).padStart(8),
      String(s.entries ?? 0).padStart(7),
      fmt(s.winRate).padStart(6),
      fmt(s.profitFactor).padStart(6),
      fmt(s.maxDrawdown).padStart(6),
      String(item.variantMs ?? '-').padStart(4),
    ].join('  '));
  }
  console.error(lines.join('\n'));
}

function fmt(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return String(Math.round(number * 10000) / 10000);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const experiment = flags.experiment || flags.e;
  if (!experiment) {
    throw new Error('Usage: npm run lab:run -- --experiment <path> [--max-variants N] [--workers N] [--variant-workers N] [--dry-run]');
  }

  const result = await runLabExperiment(experiment, {
    dryRun: Boolean(flags['dry-run'] || flags.dryRun),
    maxVariants: flags['max-variants'] || flags.maxVariants,
    workers: flags.workers,
    variantWorkers: flags['variant-workers'] || flags.variantWorkers,
    top: flags.top,
    onProgress: (progress) => {
      if (progress?.phase === 'sweep') {
        if (flags.quiet) return;
        const completed = progress.variantIndex + 1;
        const every = Math.max(Number(flags['progress-every'] || 0) || Math.ceil(progress.variantCount / 20), 1);
        if (completed === 1 || completed === progress.variantCount || completed % every === 0) {
          console.error(`sweep ${completed}/${progress.variantCount} ${progress.variantId}`);
        }
      }
    },
  });

  if (!result.ok) {
    console.error(JSON.stringify({ error: result.error, availability: result.availability }, null, 2));
    process.exitCode = result.error === 'DATA_NOT_READY' ? 2 : 1;
    return;
  }

  if (result.dryRun) {
    console.log(JSON.stringify({ dryRun: true, metadata: result.metadata, variants: result.variants.slice(0, 10) }, null, 2));
    return;
  }

  printTop(result.topResults);
  console.log(JSON.stringify({ reportDir: result.reportDir, metadata: result.metadata, topResults: result.topResults.slice(0, 5) }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
