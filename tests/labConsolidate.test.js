import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  consolidateLabReports,
  findLabReportDirs,
  writeConsolidatedReport,
} from '../labs/shared/labConsolidate.js';

function writeReport(root, name, topResults, metadata = {}) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'top-results.json'), `${JSON.stringify(topResults, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(dir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return dir;
}

test('consolidateLabReports keeps best variant across reports', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lab-consolidate-'));
  try {
    writeReport(root, 'run-a', [
      { id: 'v1', summary: { totalPnl: 10, entries: 5, winRate: 50, profitFactor: 2, maxDrawdown: 1 } },
      { id: 'v2', summary: { totalPnl: 1, entries: 5, winRate: 50, profitFactor: 1, maxDrawdown: 1 } },
    ], { experimentName: 'run-a', generatedAt: '2026-06-13T10:00:00.000Z' });
    writeReport(root, 'run-b', [
      { id: 'v1', summary: { totalPnl: 3, entries: 5, winRate: 50, profitFactor: 1.2, maxDrawdown: 1 } },
      { id: 'v3', summary: { totalPnl: 20, entries: 5, winRate: 50, profitFactor: 3, maxDrawdown: 1 } },
    ], { experimentName: 'run-b', generatedAt: '2026-06-13T11:00:00.000Z' });

    const dirs = findLabReportDirs(root);
    assert.equal(dirs.length, 2);

    const consolidated = consolidateLabReports(dirs, { top: 10 });
    assert.equal(consolidated.variantCount, 3);
    assert.equal(consolidated.topResults[0].id, 'v3');
    assert.equal(consolidated.topResults.find((item) => item.id === 'v1').sourceReport, 'run-a');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeConsolidatedReport writes json and markdown', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lab-consolidate-out-'));
  try {
    const consolidated = {
      reportCount: 1,
      variantCount: 1,
      sources: ['run-a'],
      topResults: [{
        rank: 1,
        id: 'v1',
        sourceReport: 'run-a',
        summary: { totalPnl: 10, entries: 1, winRate: 100, profitFactor: 9, maxDrawdown: 0 },
      }],
    };
    const outDir = writeConsolidatedReport(path.join(root, 'out'), consolidated);
    assert.match(outDir, /out$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
