#!/usr/bin/env node
import 'dotenv/config';

import path from 'node:path';

import {
  consolidateLabReports,
  findLabReportDirs,
  writeConsolidatedReport,
} from '../shared/labConsolidate.js';

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

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const root = flags.root || flags.r || 'reports/labs/edge-snipper';
  const output = flags.output || flags.o || path.join(root, '_consolidated');
  const top = Number(flags.top || 50);

  const reportDirs = findLabReportDirs(root);
  if (!reportDirs.length) {
    console.error(JSON.stringify({ error: 'NO_REPORTS', root: path.resolve(root) }, null, 2));
    process.exitCode = 2;
    return;
  }

  const consolidated = consolidateLabReports(reportDirs, { top });
  const outDir = writeConsolidatedReport(output, consolidated);
  console.log(JSON.stringify({
    ok: true,
    outputDir: outDir,
    reportCount: consolidated.reportCount,
    variantCount: consolidated.variantCount,
    top: consolidated.topResults.slice(0, 5).map((item) => ({
      rank: item.rank,
      id: item.id,
      totalPnl: item.summary?.totalPnl,
      sourceReport: item.sourceReport,
    })),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
