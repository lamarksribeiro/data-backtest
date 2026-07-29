#!/usr/bin/env node
/**
 * Summarize live Pair-Path fills from runs/pair-path-micro (no secrets).
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'runs/pair-path-micro';
const files = fs
  .readdirSync(dir)
  .filter((f) => f.startsWith('btc-') && f.endsWith('.json'))
  .sort();

const rows = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (!j.live) continue;
  const fills = (j.fills || []).filter((x) => x && (x.dry === false || x.orderId));
  if (!fills.length) continue;
  rows.push({
    at: j.generatedAt,
    slug: (j.event && j.event.slug) || f,
    title: (j.event && j.event.title) || '',
    sh: j.params?.openShares,
    mode: j.mode,
    avgSum: j.avgSum,
    invested: j.invested,
    fees: j.fees,
    pnl: j.pnl,
    winner: j.winner,
    legs: fills.map((x) => `${x.kind}:${x.side}@${x.px}x${x.sh}`).join(' + '),
  });
}

rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
for (const r of rows) {
  console.log(
    `${r.at}  sh=${r.sh}  avgSum=${r.avgSum}  inv=${r.invested}  fees=${r.fees}  pnl=${r.pnl}  winner=${r.winner}`,
  );
  console.log(`  ${r.slug}`);
  console.log(`  ${r.legs}`);
}

const pnl = rows.reduce((a, r) => a + (r.pnl || 0), 0);
const inv = rows.reduce((a, r) => a + (r.invested || 0), 0);
const fees = rows.reduce((a, r) => a + (r.fees || 0), 0);
const edge = rows.reduce((a, r) => a + (r.sh || 0) * (1 - (r.avgSum || 1)), 0);
console.log('==== TOTAL ====');
console.log(
  JSON.stringify(
    {
      nTrades: rows.length,
      pnlSum: Math.round(pnl * 1000) / 1000,
      edgeGross: Math.round(edge * 1000) / 1000,
      feesSum: Math.round(fees * 1000) / 1000,
      investedSum: Math.round(inv * 100) / 100,
      rocPct: inv ? Math.round((pnl / inv) * 10000) / 100 : null,
    },
    null,
    2,
  ),
);
