/**
 * Seção D — upside de sizing proporcional à expectância.
 *
 * Uso: node labs/sandbox/tfc-v7-diag-sizing.mjs
 * Pré-requisito: loss-pockets.json
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CACHE_DIR, loadJson, writeJson, stats, fmtUsd, maxDrawdownFromDaily, dailySeries,
} from './tfc-v7-diag-lib.mjs';

const SCHEMES = {
  fixed10: (r) => 10,
  prop_v1: (r) => {
    const ask = Number(r.ask_fav ?? r.entry?.price ?? 0.65);
    const dv = Number(r.dist_vol ?? 2);
    if (ask >= 0.7 && dv <= 1.5) return 15;
    if (ask >= 0.65) return 10;
    if (ask >= 0.6) return 5;
    return 0;
  },
  prop_v2: (r) => {
    const ask = Number(r.ask_fav ?? r.entry?.price ?? 0.65);
    if (ask >= 0.75) return 15;
    if (ask >= 0.7) return 12;
    if (ask >= 0.65) return 10;
    if (ask >= 0.6) return 5;
    return 0;
  },
  prop_gate: (r) => {
    const ask = Number(r.ask_fav ?? r.entry?.price ?? 0.65);
    const dv = Number(r.dist_vol ?? 2);
    if (ask < 0.65 || dv > 1.5) return 0;
    if (ask >= 0.7) return 15;
    return 10;
  },
};

function simulateScheme(events, budgetFn) {
  const scaled = [];
  for (const e of events) {
    const baseBudget = 10;
    const budget = budgetFn(e);
    if (budget <= 0) continue;
    const scale = budget / baseBudget;
    scaled.push({
      ...e,
      scaledPnl: Number(e.finalPnl || 0) * scale,
      budget,
    });
  }
  return scaled;
}

function summarize(events, pnlKey = 'scaledPnl') {
  const st = stats(events, pnlKey);
  const daily = dailySeries(events.map((e) => ({ eventStart: e.eventStart, finalPnl: e[pnlKey] })));
  return {
    ...st,
    maxDrawdown: maxDrawdownFromDaily(daily),
    skipped: null,
  };
}

function main() {
  const enrichedPath = path.join(CACHE_DIR, 'enriched-events.json');
  const joined = fs.existsSync(enrichedPath)
    ? loadJson(enrichedPath)
    : (loadJson(path.join(CACHE_DIR, 'events-v5-practical.json')).events || []).filter((e) => e.entry);

  const results = {};
  for (const [name, fn] of Object.entries(SCHEMES)) {
    const all = simulateScheme(joined, fn);
    results[name] = {
      all: summarize(all),
      train: summarize(all.filter((e) => e.split === 'train')),
      june: summarize(all.filter((e) => e.split === 'june')),
      skipped: joined.length - all.length,
    };
  }

  const loss = loadJson(path.join(CACHE_DIR, 'loss-pockets.json'));
  writeJson(path.join(CACHE_DIR, 'sizing.json'), { results, baseline: loss.baseline });

  console.log('=== D. Sizing schemes vs fixed $10 ===');
  for (const [name, r] of Object.entries(results)) {
    console.log(`\n${name}:`);
    for (const split of ['train', 'june', 'all']) {
      const s = r[split];
      console.log(`  ${split}: n=${s.n} sum=${fmtUsd(s.sum)} exp=${fmtUsd(s.exp)} DD≈${fmtUsd(s.maxDrawdown)} skipped=${r.skipped}`);
    }
  }
  console.error('\nSalvo em labs/sandbox/cache/sizing.json');
}

main();
