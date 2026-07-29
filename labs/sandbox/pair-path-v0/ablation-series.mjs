/**
 * Ablation of Pair-Path V0 presets on baliza series8 ticks.
 *
 *   node labs/sandbox/pair-path-v0/ablation-series.mjs
 *   node labs/sandbox/pair-path-v0/ablation-series.mjs --series .tmp/poly-baliza/...
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventEngine, DEFAULT_PARAMS } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

const args = process.argv.slice(2);
function argVal(name, fb) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return fb;
}

const seriesDefault = path.join(
  ROOT,
  '.tmp/poly-baliza/2026-07-28T04-03-09-340Z-series8',
);
const seriesDir = path.resolve(argVal('series', seriesDefault));

/** Variants: name + param overrides on top of DEFAULT / v0 baseline */
const VARIANTS = [
  {
    name: 'v0-baseline',
    notes: 'contrato MACHINE-V0',
    params: {
      openShares: 10,
      openAskLo: 0.52,
      openAskHi: 0.62,
      openCapCents: 1,
      openTriggerCents: 55,
      avgSumMax: 0.995,
      hedgeAskMax: 0.48,
      eqAskMax: 0.05,
      eqAvgSumMax: 0.99,
      legChoice: 'chase',
      feeRate: 0.07,
      maxEventNotional: 25,
    },
  },
  {
    name: 'wider-open',
    notes: 'banda open 50–65 — mais entradas',
    params: {
      openShares: 10,
      openAskLo: 0.5,
      openAskHi: 0.65,
      openCapCents: 1,
      openTriggerCents: 55,
      avgSumMax: 0.995,
      hedgeAskMax: 0.48,
      legChoice: 'chase',
      feeRate: 0.07,
    },
  },
  {
    name: 'tight-avgSum',
    notes: 'só hedge se avgSum proj < 0.98',
    params: {
      openShares: 10,
      openAskLo: 0.52,
      openAskHi: 0.62,
      openCapCents: 1,
      openTriggerCents: 55,
      avgSumMax: 0.98,
      hedgeAskMax: 0.45,
      eqAvgSumMax: 0.98,
      legChoice: 'chase',
      feeRate: 0.07,
    },
  },
  {
    name: 'loose-hedge',
    notes: 'hedge até 52¢ se avgSum < 1.00',
    params: {
      openShares: 10,
      openAskLo: 0.52,
      openAskHi: 0.62,
      openCapCents: 1,
      openTriggerCents: 55,
      avgSumMax: 1.0,
      hedgeAskMax: 0.52,
      eqAvgSumMax: 0.995,
      legChoice: 'chase',
      feeRate: 0.07,
    },
  },
  {
    name: 'cap2-open',
    notes: 'taker_limit +2¢ no open (mais fills, pior preço)',
    params: {
      openShares: 10,
      openAskLo: 0.52,
      openAskHi: 0.62,
      openCapCents: 2,
      openTriggerCents: 55,
      avgSumMax: 0.995,
      hedgeAskMax: 0.48,
      legChoice: 'chase',
      feeRate: 0.07,
    },
  },
  {
    name: 'fade-underdog',
    notes: 'open no underdog 38–48¢',
    params: {
      openShares: 10,
      openAskLo: 0.38,
      openAskHi: 0.48,
      openCapCents: 1,
      openTriggerCents: 45,
      avgSumMax: 0.995,
      hedgeAskMax: 0.55,
      legChoice: 'fade',
      feeRate: 0.07,
    },
  },
  {
    name: 'size20-feeaware',
    notes: 'size 20 — fee relativa menor no par ~3¢',
    params: {
      openShares: 20,
      openAskLo: 0.52,
      openAskHi: 0.62,
      openCapCents: 1,
      openTriggerCents: 55,
      avgSumMax: 0.995,
      hedgeAskMax: 0.48,
      maxEventNotional: 40,
      legChoice: 'chase',
      feeRate: 0.07,
    },
  },
  {
    name: 'cheap-pair-only',
    notes: 'open só se ask+opp ≤ 1.00 e open 53–58',
    params: {
      openShares: 10,
      openAskLo: 0.53,
      openAskHi: 0.58,
      openCapCents: 1,
      openTriggerCents: 55,
      avgSumMax: 0.99,
      hedgeAskMax: 0.45,
      // engine uses fixed 0.95–1.05 book sum; cheap via tighter avgSum + band
      legChoice: 'chase',
      feeRate: 0.07,
    },
  },
];

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function listEvents(dir) {
  const eventsDir = path.join(dir, 'events');
  if (!fs.existsSync(eventsDir)) return [];
  return fs
    .readdirSync(eventsDir)
    .filter((n) => fs.existsSync(path.join(eventsDir, n, 'ticks.jsonl')))
    .sort();
}

function stats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const pct = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  return {
    n: s.length,
    min: s[0],
    p50: pct(50),
    p90: pct(90),
    max: s[s.length - 1],
    mean: Math.round((sum / s.length) * 1000) / 1000,
    sum: Math.round(sum * 100) / 100,
  };
}

function runVariant(params, slugs) {
  const rows = [];
  for (const slug of slugs) {
    const ticks = readJsonl(path.join(seriesDir, 'events', slug, 'ticks.jsonl'));
    const eng = createEventEngine({ ...DEFAULT_PARAMS, ...params }, { slug });
    let last = null;
    for (const t of ticks) {
      eng.onTick(t);
      last = t;
    }
    rows.push({ slug, ...eng.finish(last) });
  }
  const traded = rows.filter((r) => r.nFills > 0);
  const pnls = traded.map((r) => r.pnl).filter((x) => x != null);
  const allPnl = rows.map((r) => (r.pnl != null ? r.pnl : 0));
  const worsts = rows.map((r) => r.worstPnl);
  const avgSums = traded.map((r) => r.avgSum).filter((x) => x != null);
  const invested = rows.map((r) => r.invested);
  const equalized = rows.filter((r) => r.mode === 'done' || (r.residual?.shares ?? 1) < 1e-6).length;

  // structural edge if equalized: shares * (1 - avgSum) before fee already in pnl
  const avgSumGt1 = avgSums.filter((a) => a > 1).length;

  return {
    nEvents: rows.length,
    nTraded: traded.length,
    nSkip: rows.length - traded.length,
    nEqualizedDone: rows.filter((r) => r.mode === 'done').length,
    nOpenedStuck: rows.filter((r) => r.mode === 'opened').length,
    pnlTraded: stats(pnls),
    pnlAll: stats(allPnl),
    worstPnl: stats(worsts),
    avgSum: stats(avgSums),
    avgSumGt1,
    invested: stats(invested),
    totalInvested: invested.reduce((a, b) => a + b, 0),
    totalPnl: allPnl.reduce((a, b) => a + b, 0),
    // score: prefer higher total pnl, then better worst, then fewer avgSum>1, then more selective quality
    events: rows.map((r) => ({
      slug: r.slug,
      mode: r.mode,
      sideOpen: r.sideOpen,
      fills: r.nFills,
      avgSum: r.avgSum,
      worstPnl: r.worstPnl,
      pnl: r.pnl,
      invested: r.invested,
    })),
  };
}

function score(r) {
  // multi-objective scalar for ranking (not expectancy claim)
  const pnl = r.totalPnl;
  const worst = r.worstPnl?.min ?? 0;
  const stuck = r.nOpenedStuck;
  const badAvg = r.avgSumGt1;
  const traded = r.nTraded;
  // reward pnl, penalize catastrophic worst, stuck residual, avgSum>1
  return pnl * 10 + worst * 5 - stuck * 2 - badAvg * 3 + (traded > 0 ? 0.1 : 0);
}

/** Hard gates for shadow candidate (risk-first). */
function passesRiskGate(r) {
  const worst = r.worstPnl?.min ?? 0;
  if (r.nOpenedStuck > 0) return false;
  if (worst < -1.0) return false; // no single-event blast
  if (r.avgSumGt1 > 0) return false;
  return true;
}

function main() {
  const slugs = listEvents(seriesDir);
  if (!slugs.length) {
    console.error(`no events in ${seriesDir}`);
    process.exit(1);
  }

  console.log('=== Pair-Path V0 ablation ===');
  console.log(`series=${seriesDir} events=${slugs.length} variants=${VARIANTS.length}`);
  console.log('');

  const results = [];
  for (const v of VARIANTS) {
    const r = runVariant(v.params, slugs);
    const sc = score(r);
    results.push({ name: v.name, notes: v.notes, params: v.params, score: sc, ...r });
    console.log(
      `${v.name.padEnd(18)} traded=${r.nTraded}/${r.nEvents} done=${r.nEqualizedDone} stuck=${r.nOpenedStuck}` +
        ` pnlSum=${r.totalPnl.toFixed(2)} worstMin=${r.worstPnl?.min}` +
        ` avgSum med=${r.avgSum?.p50 ?? '-'} gt1=${r.avgSumGt1}` +
        ` score=${sc.toFixed(2)}  | ${v.notes}`,
    );
  }

  results.sort((a, b) => b.score - a.score);
  const riskOk = results.filter(passesRiskGate);
  const best = riskOk.length ? riskOk[0] : null;
  const bestRaw = results[0];

  console.log('');
  console.log('========== RANKING (raw score) ==========');
  results.forEach((r, i) => {
    const gate = passesRiskGate(r) ? 'PASS' : 'FAIL';
    console.log(
      `${i + 1}. ${r.name}  [${gate}] score=${r.score.toFixed(2)}  pnl=${r.totalPnl.toFixed(2)}  worst=${r.worstPnl?.min}` +
        `  traded=${r.nTraded}  avgSumMed=${r.avgSum?.p50 ?? '-'}  stuck=${r.nOpenedStuck}`,
    );
  });

  if (!best) {
    console.error('no variant passed risk gate');
    process.exit(2);
  }

  console.log('');
  console.log(`raw leader: ${bestRaw.name} (may fail risk gate)`);
  console.log(`shadow candidate: ${best.name} (best score among risk PASS)`);

  const candidate = {
    selectedAt: new Date().toISOString(),
    seriesDir,
    criterion:
      'Among risk PASS (stuck=0, worstMin>=-1, avgSumGt1=0), max score=10*pnl+5*worst-2*stuck-3*avgSumGt1; n=8 replay only',
    riskGate: {
      maxOpenedStuck: 0,
      minWorstPnl: -1.0,
      maxAvgSumGt1: 0,
    },
    name: best.name,
    notes: best.notes,
    params: best.params,
    metrics: {
      totalPnl: best.totalPnl,
      worstMin: best.worstPnl?.min,
      nTraded: best.nTraded,
      nEqualizedDone: best.nEqualizedDone,
      nOpenedStuck: best.nOpenedStuck,
      avgSumMed: best.avgSum?.p50 ?? null,
      avgSumGt1: best.avgSumGt1,
      score: best.score,
    },
    rejectedRawLeader:
      bestRaw.name !== best.name
        ? {
            name: bestRaw.name,
            reason: 'failed risk gate or lower priority',
            worstMin: bestRaw.worstPnl?.min,
            stuck: bestRaw.nOpenedStuck,
            totalPnl: bestRaw.totalPnl,
          }
        : null,
    ranking: results.map((r) => ({
      name: r.name,
      riskPass: passesRiskGate(r),
      score: r.score,
      totalPnl: r.totalPnl,
      worstMin: r.worstPnl?.min,
      nTraded: r.nTraded,
      avgSumMed: r.avgSum?.p50 ?? null,
      stuck: r.nOpenedStuck,
      avgSumGt1: r.avgSumGt1,
    })),
  };

  const outDir = path.join(seriesDir, 'pair-path-v0-ablation');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'ablation.json'), JSON.stringify({ results, candidate }, null, 2));
  fs.writeFileSync(path.join(outDir, 'candidate.json'), JSON.stringify(candidate, null, 2));

  // also write preset file for shadow
  const presetOut = {
    id: `pair-path-${best.name}`,
    name: `Pair-Path candidate · ${best.name}`,
    role: 'shadow-candidate',
    source: 'ablation series8',
    notes: best.notes,
    params: best.params,
  };
  fs.writeFileSync(
    path.join(__dirname, 'presets/candidate-shadow.json'),
    JSON.stringify(presetOut, null, 2),
  );

  console.log('');
  console.log('========== CANDIDATE ==========');
  console.log(`selected: ${best.name}`);
  console.log(`notes: ${best.notes}`);
  console.log(`params: ${JSON.stringify(best.params)}`);
  console.log(`metrics: ${JSON.stringify(candidate.metrics)}`);
  console.log(`saved: ${outDir}`);
  console.log(`preset: labs/sandbox/pair-path-v0/presets/candidate-shadow.json`);
  console.log('===============================');
}

main();
