import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { rankSweepResults } from './labRunner.js';

function pickBetterVariant(left, right) {
  const [winner] = rankSweepResults([left, right]);
  return winner.id === left.id ? left : right;
}

export function findLabReportDirs(root) {
  const absoluteRoot = path.resolve(root);
  const entries = readdirSync(absoluteRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(absoluteRoot, entry.name))
    .filter((dir) => {
      try {
        readFileSync(path.join(dir, 'top-results.json'));
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

export function loadLabReport(dir) {
  const topResults = JSON.parse(readFileSync(path.join(dir, 'top-results.json'), 'utf8'));
  let metadata = null;
  let experiment = null;
  try {
    metadata = JSON.parse(readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
  } catch {
    metadata = null;
  }
  try {
    experiment = JSON.parse(readFileSync(path.join(dir, 'experiment.json'), 'utf8'));
  } catch {
    experiment = null;
  }
  return { dir, topResults, metadata, experiment };
}

export function consolidateLabReports(reportDirs, { top = 50 } = {}) {
  const byVariant = new Map();

  for (const dir of reportDirs) {
    const report = loadLabReport(dir);
    for (const item of report.topResults || []) {
      const key = item.id;
      const candidate = {
        ...item,
        sourceReport: path.basename(report.dir),
        sourceExperiment: report.metadata?.experimentName || report.experiment?.name || null,
        generatedAt: report.metadata?.generatedAt || null,
        sweepMode: report.metadata?.sweepMode || null,
      };
      const current = byVariant.get(key);
      if (!current) {
        byVariant.set(key, candidate);
      } else {
        byVariant.set(key, pickBetterVariant(current, candidate));
      }
    }
  }

  const merged = rankSweepResults([...byVariant.values()].map(({ rank, score, ...rest }) => rest));
  return {
    reportCount: reportDirs.length,
    variantCount: merged.length,
    topResults: merged.slice(0, Math.max(Number(top) || 50, 1)),
    sources: reportDirs.map((dir) => path.basename(dir)),
  };
}

export function writeConsolidatedReport(outputDir, consolidated) {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, 'consolidated-top-results.json'), `${JSON.stringify(consolidated, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(outputDir, 'consolidated-summary.md'), renderConsolidatedMarkdown(consolidated), 'utf8');
  return outputDir;
}

function renderConsolidatedMarkdown(consolidated) {
  const lines = [
    '# Lab Consolidated Ranking',
    '',
    `- Reports merged: ${consolidated.reportCount}`,
    `- Unique variants: ${consolidated.variantCount}`,
    '',
    '## Top Results',
    '',
    '| Rank | Variant | PnL | Entries | Win % | PF | Max DD | Pos Days | Source |',
    '|---:|---|---:|---:|---:|---:|---:|---:|---|',
  ];

  for (const item of consolidated.topResults) {
    const daily = item.summary?.daily;
    lines.push([
      `| ${item.rank}`,
      `\`${item.id}\``,
      formatNumber(item.summary?.totalPnl),
      item.summary?.entries ?? 0,
      formatNumber(item.summary?.winRate),
      formatNumber(item.summary?.profitFactor),
      formatNumber(item.summary?.maxDrawdown),
      daily ? `${daily.profitableDays}/${daily.days}` : 'n/a',
      `\`${item.sourceReport}\``,
      '|',
    ].join(' | '));
  }

  lines.push('', '## Sources', '', ...consolidated.sources.map((source) => `- \`${source}\``));
  return `${lines.join('\n')}\n`;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return String(Math.round(number * 10000) / 10000);
}
