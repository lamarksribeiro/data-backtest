/**
 * Residual-risk A/B: open only when hedge is already montável.
 *
 *   node labs/sandbox/pair-path-v0/open-hedge-ready-ab.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventEngine, DEFAULT_PARAMS } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

const PRESET = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'presets/size-fee-v0-cap2.json'), 'utf8'),
);

const BASE = {
  ...PRESET.params,
  openShares: 25,
  maxEventNotional: 32,
  avgSumMax: 0.95,
  eqAvgSumMax: 0.95,
};

const SERIES = [
  '.tmp/poly-baliza/2026-07-28T04-03-09-340Z-series8',
  '.tmp/pair-path-v0-shadow/2026-07-28T04-59-33-426Z-tight-shadow',
  '.tmp/pair-path-v0-shadow/2026-07-28T05-20-20-839Z-calib-shadow',
].map((p) => path.join(ROOT, p));

const VARIANTS = [
  {
    name: 'baseline-cap2',
    notes: 'size-fee-cap2 · avgSumMax0.95 · sem hedge-ready',
    params: { openRequireHedgeReady: false },
  },
  {
    name: 'hedge-ready-strict',
    notes: 'askO≤0.42 e sum≤0.95 no open',
    params: { openRequireHedgeReady: true, openHedgeSlackCents: 0, openPairSumMaxAtOpen: 0.95 },
  },
  {
    name: 'hedge-ready-slack3',
    notes: 'askO≤0.45 (+3¢) e sum≤0.98 no open',
    params: {
      openRequireHedgeReady: true,
      openHedgeSlackCents: 3,
      openPairSumMaxAtOpen: 0.98,
      openBookSumMin: 0.9,
    },
  },
  {
    name: 'hedge-ready-slack5',
    notes: 'askO≤0.47 (+5¢) e sum≤1.00 no open',
    params: {
      openRequireHedgeReady: true,
      openHedgeSlackCents: 5,
      openPairSumMaxAtOpen: 1.0,
      openBookSumMin: 0.9,
    },
  },
  {
    name: 'hedge-ready-slack8',
    notes: 'askO≤0.50 (+8¢) e sum≤1.02 no open',
    params: {
      openRequireHedgeReady: true,
      openHedgeSlackCents: 8,
      openPairSumMaxAtOpen: 1.02,
      openBookSumMin: 0.9,
    },
  },
  {
    name: 'book-sum-max-1.00',
    notes: 'sem hedge-ready; só open se book sum ≤1.00',
    params: { openRequireHedgeReady: false, openBookSumMax: 1.0 },
  },
  {
    name: 'book-sum-max-0.99',
    notes: 'sem hedge-ready; só open se book sum ≤0.99',
    params: { openRequireHedgeReady: false, openBookSumMax: 0.99 },
  },
  {
    name: 'book-sum-max-0.98',
    notes: 'sem hedge-ready; só open se book sum ≤0.98',
    params: { openRequireHedgeReady: false, openBookSumMax: 0.98 },
  },
];

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function listDirs() {
  const m = new Map();
  for (const s of SERIES) {
    const ed = path.join(s, 'events');
    if (!fs.existsSync(ed)) continue;
    for (const n of fs.readdirSync(ed)) {
      if (fs.existsSync(path.join(ed, n, 'ticks.jsonl'))) m.set(n, path.join(ed, n));
    }
  }
  return [...m.values()].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function runVariant(variant, dirs) {
  const params = { ...BASE, ...variant.params };
  const rows = [];
  for (const dir of dirs) {
    const slug = path.basename(dir);
    const ticks = readJsonl(path.join(dir, 'ticks.jsonl'));
    const eng = createEventEngine({ ...DEFAULT_PARAMS, ...params }, { slug });
    let last = null;
    for (const t of ticks) {
      eng.onTick(t);
      last = t;
    }
    const r = eng.finish(last);
    const residualSh = r.residual?.shares || 0;
    rows.push({
      slug,
      mode: r.mode,
      fills: r.nFills,
      avgSum: r.avgSum,
      pnl: r.pnl ?? 0,
      worst: r.worstPnl,
      invested: r.invested,
      residualSh,
      blocks: r.blockCounts,
    });
  }

  const traded = rows.filter((r) => r.fills > 0);
  const done = rows.filter((r) => r.mode === 'done' || r.mode === 'hedged');
  // engine may leave mode as hedged before settlement finish — treat equalized as done-like
  const equalized = rows.filter(
    (r) => r.fills >= 2 && (r.residualSh || 0) < 1e-6,
  );
  const stuck = rows.filter((r) => r.mode === 'opened' || (r.residualSh || 0) >= 1);
  const avgXs = equalized
    .map((r) => r.avgSum)
    .filter((x) => x != null)
    .sort((a, b) => a - b);
  const pnl = rows.reduce((a, r) => a + r.pnl, 0);
  const inv = rows.reduce((a, r) => a + (r.invested || 0), 0);
  const openNotReady = rows.reduce(
    (a, r) => a + (r.blocks?.OPEN_HEDGE_NOT_READY || 0) + (r.blocks?.OPEN_PAIR_NOT_CHEAP || 0),
    0,
  );
  const hedgeRefuse = rows.reduce((a, r) => a + (r.blocks?.HEDGE_REFUSE_AVGSUM || 0), 0);

  return {
    name: variant.name,
    notes: variant.notes,
    params,
    n: rows.length,
    traded: traded.length,
    equalized: equalized.length,
    stuck: stuck.length,
    pnl: Math.round(pnl * 1000) / 1000,
    pnlPerEqualized: equalized.length
      ? Math.round((pnl / equalized.length) * 1000) / 1000
      : null,
    roc: inv > 0 ? Math.round((pnl / inv) * 10000) / 100 : null,
    worst: Math.min(...rows.map((r) => r.worst)),
    residualMax: Math.max(...rows.map((r) => r.residualSh || 0)),
    avgSumMed: avgXs.length ? avgXs[Math.floor(avgXs.length / 2)] : null,
    avgSumMean: avgXs.length
      ? Math.round((avgXs.reduce((a, b) => a + b, 0) / avgXs.length) * 1000) / 1000
      : null,
    invested: Math.round(inv * 100) / 100,
    openNotReadyBlocks: openNotReady,
    hedgeRefuse,
    // risk score: prefer high pnl, zero stuck, better avgSum
    score:
      Math.round(
        (pnl - 5 * stuck.length - Math.max(0, -Math.min(...rows.map((r) => r.worst)))) *
          1000,
      ) / 1000,
    events: rows,
  };
}

function main() {
  const dirs = listDirs();
  console.log('=== Open hedge-ready A/B (residual risk) ===');
  console.log(
    `events=${dirs.length} base=sh${BASE.openShares} cap+${BASE.openCapCents} avgSumMax${BASE.avgSumMax}`,
  );
  console.log('');

  const results = VARIANTS.map((v) => runVariant(v, dirs));
  for (const r of results) {
    console.log(
      `${r.name.padEnd(28)} traded=${r.traded}/${r.n} eq=${r.equalized} stuck=${r.stuck}` +
        ` pnl=${String(r.pnl).padStart(7)} roc=${r.roc}%` +
        ` avgMed=${r.avgSumMed} worst=${r.worst} residMax=${r.residualMax}` +
        ` openGateBlocks=${r.openNotReadyBlocks} hedgeRefuse=${r.hedgeRefuse}` +
        ` score=${r.score}`,
    );
    console.log(`  ${r.notes}`);
  }

  const base = results[0];
  console.log('');
  console.log('--- vs baseline ---');
  for (const r of results.slice(1)) {
    console.log(
      `→ ${r.name}: Δtraded=${r.traded - base.traded} Δeq=${r.equalized - base.equalized}` +
        ` Δstuck=${r.stuck - base.stuck} Δpnl=${Math.round((r.pnl - base.pnl) * 1000) / 1000}` +
        ` Δworst=${Math.round((r.worst - base.worst) * 1000) / 1000}`,
    );
  }

  console.log('');
  console.log('--- stuck / residual events (if any) ---');
  for (const r of results) {
    const bad = r.events.filter((e) => e.mode === 'opened' || (e.residualSh || 0) >= 1);
    if (!bad.length) continue;
    console.log(r.name + ':');
    for (const e of bad) {
      console.log(
        `  ${e.slug.slice(-10)} mode=${e.mode} fills=${e.fills} resid=${e.residualSh}` +
          ` pnl=${e.pnl} worst=${e.worst} avg=${e.avgSum ?? '-'}`,
      );
    }
  }

  const safe = results.filter((r) => r.stuck === 0 && r.worst >= 0);
  safe.sort((a, b) => b.score - a.score || b.pnl - a.pnl);
  const recommendation = safe[0]
    ? `prefer_${safe[0].name}`
    : 'no_safe_variant_keep_baseline_plus_escape';

  const out = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    results: results.map(({ events, ...sum }) => ({ ...sum, events })),
    recommendation,
  };
  const outDir = path.join(ROOT, '.tmp/pair-path-v0-hedge-ready-ab');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(out, null, 2));
  console.log('');
  console.log('recommendation:', recommendation);
  console.log('saved', path.join(outDir, 'report.json'));
}

main();
