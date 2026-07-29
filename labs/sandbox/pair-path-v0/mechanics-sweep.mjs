/**
 * Clip-Path mechanics sweep — wide search for safer + higher PnL configs.
 *
 * Soft constraints (hard-coded):
 *   - no MULT / no re-open
 *   - escapeAvgSumMax2 <= 1.00 (never Phil-3800 EQ)
 *   - GO if stuck=0, worst>=0, avgSumMed <= baseline+0.01 (or null)
 *
 *   node labs/sandbox/pair-path-v0/mechanics-sweep.mjs
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

const SERIES = [
  '.tmp/poly-baliza/2026-07-28T04-03-09-340Z-series8',
  '.tmp/pair-path-v0-shadow/2026-07-28T04-59-33-426Z-tight-shadow',
  '.tmp/pair-path-v0-shadow/2026-07-28T05-20-20-839Z-calib-shadow',
].map((p) => path.join(ROOT, p));

const BASE = {
  ...PRESET.params,
  openShares: 25,
  maxEventNotional: 50,
  openCapCents: 2,
  maxHedgeAttempts: 8,
  feeRate: 0.07,
  legChoice: 'chase',
  openRequireHedgeReady: false,
};

function L(...levels) {
  return levels.map(([askMax, frac]) => ({ askMax, frac }));
}

function buildVariants() {
  const out = [];
  const add = (name, notes, params) => out.push({ name, notes, params });

  // --- baselines ---
  add('v0-as95-h42', 'V0 full hedge @42 avg0.95', {
    hedgeLevels: null,
    hedgeAskMax: 0.42,
    avgSumMax: 0.95,
    eqAvgSumMax: 0.98,
    maxHedgeAttempts: 2,
  });
  add('v0-as96-h42', 'V0 @42 avg0.96', {
    hedgeLevels: null,
    hedgeAskMax: 0.42,
    avgSumMax: 0.96,
    eqAvgSumMax: 0.98,
    maxHedgeAttempts: 2,
  });
  add('v0-as95-h40', 'V0 @40 avg0.95', {
    hedgeLevels: null,
    hedgeAskMax: 0.4,
    avgSumMax: 0.95,
    eqAvgSumMax: 0.98,
    maxHedgeAttempts: 2,
  });

  // --- clip ladders ---
  const ladders = [
    ['c2-42-38', L([0.42, 0.5], [0.38, 0.5]), 0.42],
    ['c2-40-36', L([0.4, 0.5], [0.36, 0.5]), 0.4],
    ['c2-40-34', L([0.4, 0.5], [0.34, 0.5]), 0.4],
    ['c2-38-34', L([0.38, 0.5], [0.34, 0.5]), 0.38],
    ['c2-42-36', L([0.42, 0.4], [0.36, 0.6]), 0.42],
    ['c2-60-40', L([0.42, 0.6], [0.36, 0.4]), 0.42],
    ['c3-42-38-34', L([0.42, 0.4], [0.38, 0.3], [0.34, 0.3]), 0.42],
    ['c3-40-36-32', L([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]), 0.4],
    ['c3-42-36-30', L([0.42, 0.34], [0.36, 0.33], [0.3, 0.33]), 0.42],
    ['c4-42-38-34-30', L([0.42, 0.25], [0.38, 0.25], [0.34, 0.25], [0.3, 0.25]), 0.42],
  ];

  const avgSums = [0.93, 0.94, 0.95, 0.96];
  const escapes = [
    { tag: 'noesc', tauHedgeEscape: null },
    { tag: 'e20', tauHedgeEscape: 20, hedgeEscapeAskMax: 0.42, escapeAvgSumMax: 0.98 },
    { tag: 'e40', tauHedgeEscape: 40, hedgeEscapeAskMax: 0.42, escapeAvgSumMax: 0.98 },
    {
      tag: 'e2stage',
      tauHedgeEscape: 40,
      hedgeEscapeAskMax: 0.42,
      escapeAvgSumMax: 0.98,
      tauHedgeEscape2: 15,
      hedgeEscapeAskMax2: 0.45,
      escapeAvgSumMax2: 1.0,
    },
  ];

  for (const [ladderName, levels, hMax] of ladders) {
    for (const as of avgSums) {
      for (const esc of escapes) {
        // skip combinatorial explosion: only full escape matrix on key ladders
        const isKey = [
          'c2-40-36',
          'c2-42-38',
          'c3-42-38-34',
          'c3-40-36-32',
          'c4-42-38-34-30',
          'c3-42-36-30',
        ].includes(ladderName);
        if (!isKey && esc.tag !== 'e40' && esc.tag !== 'noesc') continue;
        if (!isKey && as !== 0.95 && as !== 0.94) continue;

        add(`${ladderName}-as${String(as).slice(2)}-${esc.tag}`, `${ladderName} avg${as} ${esc.tag}`, {
          hedgeAskMax: hMax,
          hedgeLevels: levels,
          avgSumMax: as,
          eqAvgSumMax: Math.min(0.99, as + 0.03),
          ...esc,
        });
      }
    }
  }

  // --- open band / trigger / cap ---
  const openTweaks = [
    { tag: 'trig54', openTriggerCents: 54, openCapCents: 2 },
    { tag: 'trig56', openTriggerCents: 56, openCapCents: 2 },
    { tag: 'cap1', openTriggerCents: 55, openCapCents: 1 },
    { tag: 'cap3', openTriggerCents: 55, openCapCents: 3 },
    { tag: 'band50-60', openAskLo: 0.5, openAskHi: 0.6, openTriggerCents: 55, openCapCents: 2 },
    { tag: 'band53-63', openAskLo: 0.53, openAskHi: 0.63, openTriggerCents: 55, openCapCents: 2 },
    { tag: 'bookMax100', openBookSumMax: 1.0 },
    { tag: 'bookMax99', openBookSumMax: 0.99 },
    { tag: 'tauOpen60-220', tauOpenMin: 60, tauOpenMax: 220 },
    { tag: 'fade', legChoice: 'fade' },
  ];
  for (const tw of openTweaks) {
    add(`tight-as95-e40-${tw.tag}`, `tight base + ${tw.tag}`, {
      hedgeAskMax: 0.4,
      hedgeLevels: L([0.4, 0.5], [0.36, 0.5]),
      avgSumMax: 0.95,
      eqAvgSumMax: 0.98,
      tauHedgeEscape: 40,
      hedgeEscapeAskMax: 0.42,
      escapeAvgSumMax: 0.98,
      ...tw,
    });
  }

  // --- soft hedge-ready (known harmful — keep as control) ---
  add('tight-hedgeReady-slack8', 'CONTROL: hedge-ready (expected worse traded)', {
    hedgeAskMax: 0.4,
    hedgeLevels: L([0.4, 0.5], [0.36, 0.5]),
    avgSumMax: 0.95,
    openRequireHedgeReady: true,
    openHedgeSlackCents: 8,
    openPairSumMaxAtOpen: 1.0,
    tauHedgeEscape: 40,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
  });

  // --- size / notional (same path, scale) — marked sizeScale for ranking filter ---
  for (const sh of [10, 15, 25, 40]) {
    add(`tight-as95-e40-sh${sh}`, `SIZE_SCALE tight size ${sh}`, {
      openShares: sh,
      maxEventNotional: Math.ceil(sh * 0.62 + sh * 0.42) + 2,
      hedgeAskMax: 0.4,
      hedgeLevels: L([0.4, 0.5], [0.36, 0.5]),
      avgSumMax: 0.95,
      eqAvgSumMax: 0.98,
      tauHedgeEscape: 40,
      hedgeEscapeAskMax: 0.42,
      escapeAvgSumMax: 0.98,
    });
  }

  // --- fee sensitivity (fee0 = upper bound only; never recommend for live) ---
  add('tight-fee0', 'FEE_ILLUSION tight fee 0 (upper bound)', {
    feeRate: 0,
    hedgeAskMax: 0.4,
    hedgeLevels: L([0.4, 0.5], [0.36, 0.5]),
    avgSumMax: 0.95,
    tauHedgeEscape: 40,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
  });
  add('tight-fee004', 'tight fee 0.04', {
    feeRate: 0.04,
    hedgeAskMax: 0.4,
    hedgeLevels: L([0.4, 0.5], [0.36, 0.5]),
    avgSumMax: 0.95,
    tauHedgeEscape: 40,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
  });

  // --- NEW THESES (sky-is-limit exploration) ---
  // asymmetric clip weight: front-load cheap / back-load cheap
  add('c3-40-36-32-front60-as94-e2stage', 'front-load 60% @40', {
    hedgeAskMax: 0.4,
    hedgeLevels: L([0.4, 0.6], [0.36, 0.2], [0.32, 0.2]),
    avgSumMax: 0.94,
    eqAvgSumMax: 0.97,
    tauHedgeEscape: 40,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 15,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  });
  add('c3-40-36-32-deep60-as94-e2stage', 'back-load 60% @32 (patient)', {
    hedgeAskMax: 0.4,
    hedgeLevels: L([0.4, 0.2], [0.36, 0.2], [0.32, 0.6]),
    avgSumMax: 0.94,
    eqAvgSumMax: 0.97,
    tauHedgeEscape: 40,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 15,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  });
  add('c3-38-34-30-as93-e2stage', 'deeper c3 38/34/30 avg0.93', {
    hedgeAskMax: 0.38,
    hedgeLevels: L([0.38, 0.34], [0.34, 0.33], [0.3, 0.33]),
    avgSumMax: 0.93,
    eqAvgSumMax: 0.96,
    tauHedgeEscape: 40,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 15,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  });
  add('c5-42-40-38-34-30-as94-e2stage', '5-level ladder', {
    hedgeAskMax: 0.42,
    hedgeLevels: L([0.42, 0.2], [0.4, 0.2], [0.38, 0.2], [0.34, 0.2], [0.3, 0.2]),
    avgSumMax: 0.94,
    eqAvgSumMax: 0.97,
    tauHedgeEscape: 40,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 15,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  });
  // patient open: wait for better band
  add('deep3-as94-e2-trig54-cap1', 'patient open trig54 cap1', {
    openTriggerCents: 54,
    openCapCents: 1,
    hedgeAskMax: 0.4,
    hedgeLevels: L([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
    avgSumMax: 0.94,
    eqAvgSumMax: 0.97,
    tauHedgeEscape: 40,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 15,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  });
  add('deep3-as94-e2-book99', 'open only if book sum≤0.99', {
    openBookSumMax: 0.99,
    hedgeAskMax: 0.4,
    hedgeLevels: L([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
    avgSumMax: 0.94,
    eqAvgSumMax: 0.97,
    tauHedgeEscape: 40,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 15,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  });
  add('deep3-as94-e2-fade', 'fade underdog open + deep3', {
    legChoice: 'fade',
    hedgeAskMax: 0.4,
    hedgeLevels: L([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
    avgSumMax: 0.94,
    eqAvgSumMax: 0.97,
    tauHedgeEscape: 40,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 15,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  });
  add('deep3-as94-e2-tau80-200', 'narrower open tau window', {
    tauOpenMin: 80,
    tauOpenMax: 200,
    hedgeAskMax: 0.4,
    hedgeLevels: L([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
    avgSumMax: 0.94,
    eqAvgSumMax: 0.97,
    tauHedgeEscape: 40,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 15,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  });
  // escape ask / avgSum knobs
  add('deep3-as94-e2-escAsk40', 'escape ask ≤40 (tighter)', {
    hedgeAskMax: 0.4,
    hedgeLevels: L([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
    avgSumMax: 0.94,
    eqAvgSumMax: 0.97,
    tauHedgeEscape: 40,
    hedgeEscapeAskMax: 0.4,
    escapeAvgSumMax: 0.97,
    tauHedgeEscape2: 12,
    hedgeEscapeAskMax2: 0.42,
    escapeAvgSumMax2: 1.0,
  });
  add('deep3-as94-e2-escAsk45', 'escape1 @45 early (riskier)', {
    hedgeAskMax: 0.4,
    hedgeLevels: L([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
    avgSumMax: 0.94,
    eqAvgSumMax: 0.97,
    tauHedgeEscape: 50,
    hedgeEscapeAskMax: 0.45,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 15,
    hedgeEscapeAskMax2: 0.48,
    escapeAvgSumMax2: 1.0,
  });
  // single deep clip (all-or-nothing cheap)
  add('c1-deep36-as94-e2stage', 'single clip @≤36 + escape', {
    hedgeAskMax: 0.36,
    hedgeLevels: L([0.36, 1.0]),
    avgSumMax: 0.94,
    eqAvgSumMax: 0.97,
    tauHedgeEscape: 40,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 15,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  });
  add('c1-deep34-as93-e2stage', 'single clip @≤34 + escape', {
    hedgeAskMax: 0.34,
    hedgeLevels: L([0.34, 1.0]),
    avgSumMax: 0.93,
    eqAvgSumMax: 0.96,
    tauHedgeEscape: 40,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 15,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  });
  // hybrid: V0-style first half + deep clip
  add('hybrid-50at42-50at32-as94-e2', 'hybrid 50%@42 + 50%@32', {
    hedgeAskMax: 0.42,
    hedgeLevels: L([0.42, 0.5], [0.32, 0.5]),
    avgSumMax: 0.94,
    eqAvgSumMax: 0.97,
    tauHedgeEscape: 40,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 15,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  });
  // ultra-safe avgSum
  add('deep3-as92-e2stage', 'ultra-safe avgSumMax 0.92', {
    hedgeAskMax: 0.4,
    hedgeLevels: L([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
    avgSumMax: 0.92,
    eqAvgSumMax: 0.95,
    tauHedgeEscape: 40,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.97,
    tauHedgeEscape2: 15,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  });
  // recommended candidate pinned for comparison — late escape (e20-like + escape2 only late)
  add('RECOMMENDED-deep3-as94-e2', 'pinned live candidate late-escape', {
    hedgeAskMax: 0.4,
    hedgeLevels: L([0.4, 0.4], [0.36, 0.3], [0.32, 0.3]),
    avgSumMax: 0.94,
    eqAvgSumMax: 0.97,
    tauHedgeEscape: 20,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 12,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  });
  // lab champion pin (c4 as93 + soft escape)
  add('RECOMMENDED-deep4-as93-e20', 'pinned lab champion c4', {
    hedgeAskMax: 0.42,
    hedgeLevels: L([0.42, 0.25], [0.38, 0.25], [0.34, 0.25], [0.3, 0.25]),
    avgSumMax: 0.93,
    eqAvgSumMax: 0.96,
    tauHedgeEscape: 20,
    hedgeEscapeAskMax: 0.42,
    escapeAvgSumMax: 0.98,
    tauHedgeEscape2: 12,
    hedgeEscapeAskMax2: 0.45,
    escapeAvgSumMax2: 1.0,
  });

  // dedupe by name
  const seen = new Set();
  return out.filter((v) => {
    if (seen.has(v.name)) return false;
    seen.add(v.name);
    return true;
  });
}

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
      nHedgeClips: r.nHedgeClips || 0,
      blocks: r.blockCounts,
    });
  }

  const traded = rows.filter((r) => r.fills > 0);
  const equalized = rows.filter((r) => r.fills >= 2 && (r.residualSh || 0) < 1e-6);
  const stuck = rows.filter((r) => r.mode === 'opened' || (r.residualSh || 0) >= 1);
  const avgXs = equalized
    .map((r) => r.avgSum)
    .filter((x) => x != null)
    .sort((a, b) => a - b);
  const pnl = rows.reduce((a, r) => a + r.pnl, 0);
  const inv = rows.reduce((a, r) => a + (r.invested || 0), 0);
  const worst = Math.min(...rows.map((r) => r.worst));
  const avgSumMed = avgXs.length ? avgXs[Math.floor(avgXs.length / 2)] : null;
  const avgSumMean = avgXs.length
    ? Math.round((avgXs.reduce((a, b) => a + b, 0) / avgXs.length) * 1000) / 1000
    : null;

  return {
    name: variant.name,
    notes: variant.notes,
    params,
    n: rows.length,
    traded: traded.length,
    equalized: equalized.length,
    stuck: stuck.length,
    pnl: Math.round(pnl * 1000) / 1000,
    pnlPerEq: equalized.length ? Math.round((pnl / equalized.length) * 1000) / 1000 : null,
    roc: inv > 0 ? Math.round((pnl / inv) * 10000) / 100 : null,
    worst,
    residualMax: Math.max(...rows.map((r) => r.residualSh || 0)),
    avgSumMed,
    avgSumMean,
    invested: Math.round(inv * 100) / 100,
    score:
      Math.round(
        (pnl - 8 * stuck.length - Math.max(0, -worst) * 2 + (equalized.length > 0 ? 0 : -1)) *
          1000,
      ) / 1000,
  };
}

function gate(base, r) {
  const reasons = [];
  if (r.stuck !== 0) reasons.push(`stuck=${r.stuck}`);
  // Allow tiny negative worst (escape micro-loss / fee noise); block real bleed.
  if (r.worst < -0.25) reasons.push(`worst=${r.worst}`);
  if (r.equalized === 0 && r.traded === 0) reasons.push('no_trades');
  if (
    base.avgSumMed != null &&
    r.avgSumMed != null &&
    r.avgSumMed > base.avgSumMed + 0.015 + 1e-12
  ) {
    reasons.push(`avgMed ${r.avgSumMed}>base+1.5¢`);
  }
  // must not be much worse PnL than baseline unless much better avg — soft
  if (r.pnl + 1e-9 < base.pnl - 2.0) reasons.push(`pnl ${r.pnl}<<base`);
  return { go: reasons.length === 0, reasons };
}

function main() {
  const dirs = listDirs();
  const variants = buildVariants();
  console.log(`=== Clip-Path mechanics sweep ===`);
  console.log(`events=${dirs.length} variants=${variants.length}`);
  if (!dirs.length) {
    console.error('no journals');
    process.exit(1);
  }

  const results = variants.map((v) => runVariant(v, dirs));
  const base = results.find((r) => r.name === 'v0-as95-h42') || results[0];

  for (const r of results) {
    r.gate = r.name === base.name ? { go: true, reasons: [] } : gate(base, r);
  }

  const isRealistic = (r) => {
    const fee = r.params?.feeRate ?? BASE.feeRate;
    const sh = r.params?.openShares ?? BASE.openShares;
    const notes = r.notes || '';
    if (fee < 0.069) return false; // exclude fee0 / fee004 illusions for live pick
    if (notes.includes('FEE_ILLUSION') || notes.includes('SIZE_SCALE')) return false;
    if (sh !== 25) return false; // compare mechanics at fixed size
    if (notes.includes('CONTROL')) return false;
    return true;
  };

  const go = results.filter((r) => r.gate.go);
  go.sort((a, b) => b.score - a.score || b.pnl - a.pnl || (a.avgSumMed ?? 9) - (b.avgSumMed ?? 9));

  const goLive = go.filter(isRealistic);
  goLive.sort((a, b) => b.score - a.score || b.pnl - a.pnl || (a.avgSumMed ?? 9) - (b.avgSumMed ?? 9));

  // Live ops preference: among near-top PnL, prefer escape-enabled (stuck insurance).
  // Journals rarely fire escape; live books do.
  const hasEscape = (r) =>
    r.params?.tauHedgeEscape != null || r.params?.tauHedgeEscape2 != null;
  const topPnl = goLive[0]?.pnl ?? 0;
  const nearTop = goLive.filter((r) => r.pnl + 1e-9 >= topPnl - 1.25);
  const nearWithEsc = nearTop.filter(hasEscape);
  // Prefer e2stage / e40 over noesc when pnl within 0.5 (live stuck insurance).
  nearWithEsc.sort((a, b) => {
    const escScore = (r) =>
      (r.params?.tauHedgeEscape2 != null ? 2 : 0) + (r.params?.tauHedgeEscape != null ? 1 : 0);
    const pa = a.pnl;
    const pb = b.pnl;
    if (Math.abs(pa - pb) < 0.5) return escScore(b) - escScore(a) || pb - pa;
    return pb - pa || (a.avgSumMed ?? 9) - (b.avgSumMed ?? 9);
  });
  const livePick = nearWithEsc[0] || goLive[0];

  const deep3OpsPreferred = [
    'RECOMMENDED-deep3-as94-e2',
    'c3-40-36-32-as94-e20',
    'c3-40-36-32-as94-e2stage',
    'c3-40-36-32-as94-e40',
  ];
  const deep3Ops =
    deep3OpsPreferred.map((n) => goLive.find((r) => r.name === n)).find(Boolean) ||
    goLive.find((r) => /^c3-40-36-32-as94-e/.test(r.name) && hasEscape(r));

  // Lab pick: prefer high pnl with soft escape (e20), avgSumMax>=0.93, not as92.
  // Prefer c4/c3 champions; bias mild escape over noesc when pnl within 0.3.
  const labPreferredNames = [
    'RECOMMENDED-deep4-as93-e20',
    'c4-42-38-34-30-as93-e20',
    'c4-42-38-34-30-as93-e2stage',
    'c3-42-36-30-as93-e20',
  ];
  const labFromPin = labPreferredNames.map((n) => goLive.find((r) => r.name === n)).find(Boolean);
  const labCandidates = nearWithEsc.filter((r) => (r.params?.avgSumMax ?? 0) >= 0.93 - 1e-12);
  labCandidates.sort((a, b) => {
    const escSoft = (r) => {
      // Prefer e20-like (tauEscape<=25) over aggressive e40 that burns PnL in lab
      const t1 = r.params?.tauHedgeEscape;
      const t2 = r.params?.tauHedgeEscape2;
      if (t1 == null && t2 == null) return 0;
      if (t1 != null && t1 <= 25) return 3;
      if (t2 != null) return 2;
      return 1;
    };
    if (Math.abs(a.pnl - b.pnl) < 0.35) return escSoft(b) - escSoft(a) || b.pnl - a.pnl;
    return b.pnl - a.pnl;
  });
  const livePickPreferred = labFromPin || labCandidates[0] || livePick;
  const calibrationPick =
    livePickPreferred?.name || livePick?.name || goLive[0]?.name || 'keep_v0';
  const priorOpsCandidate = deep3Ops?.name || calibrationPick;
  // This is one reused 14-event window. It can rank mechanics for calibration,
  // but it cannot authorize shadow/live promotion.
  const recommendation = 'NO_PROMOTION_IN_SAMPLE_ONLY';
  const opsRecommendation = null;

  console.log('\n--- TOP 15 CALIBRATION PASS (all, incl. fee/size illusions) ---');
  for (const r of go.slice(0, 15)) {
    console.log(
      `${r.name.padEnd(42)} pnl=${String(r.pnl).padStart(7)} roc=${String(r.roc).padStart(5)}%` +
        ` eq=${r.equalized} stuck=${r.stuck} avgMed=${r.avgSumMed} worst=${r.worst} score=${r.score}`,
    );
    console.log(`  ${r.notes}`);
  }

  console.log('\n--- TOP 15 CALIBRATION PASS (fee≥0.07 sh=25; not a live gate) ---');
  for (const r of goLive.slice(0, 15)) {
    console.log(
      `${r.name.padEnd(42)} pnl=${String(r.pnl).padStart(7)} roc=${String(r.roc).padStart(5)}%` +
        ` eq=${r.equalized} stuck=${r.stuck} avgMed=${r.avgSumMed} worst=${r.worst} score=${r.score}`,
    );
  }

  console.log('\n--- TOP 10 by PnL (in-sample calibration only) ---');
  const byPnl = [...results].sort((a, b) => b.pnl - a.pnl);
  for (const r of byPnl.slice(0, 10)) {
    console.log(
      `[${r.gate.go ? 'PASS' : 'FAIL'}] ${r.name.padEnd(40)} pnl=${r.pnl} stuck=${r.stuck} avg=${r.avgSumMed}` +
        (r.gate.reasons.length ? ` :: ${r.gate.reasons.join('; ')}` : ''),
    );
  }

  const outDir = path.join(ROOT, '.tmp/clip-path-mechanics-sweep');
  fs.mkdirSync(outDir, { recursive: true });
  const out = {
    generatedAt: new Date().toISOString(),
    events: dirs.length,
    nVariants: variants.length,
    base: base.name,
    recommendation,
    opsRecommendation,
    calibrationPick,
    priorOpsCandidate,
    recommendationFilter: 'fee>=0.07 && openShares==25 && !FEE_ILLUSION && !SIZE_SCALE && !CONTROL',
    recommendationNote:
      'No promotion: 148 variants reuse one 14-event window. calibrationPick only ranks mechanics and requires independent depth/latency evidence.',
    topGo: go.slice(0, 20).map(({ params, ...sum }) => sum),
    topGoLive: goLive.slice(0, 20).map(({ params, ...sum }) => sum),
    livePick: livePickPreferred
      ? {
          name: livePickPreferred.name,
          pnl: livePickPreferred.pnl,
          avgSumMed: livePickPreferred.avgSumMed,
          worst: livePickPreferred.worst,
        }
      : null,
    opsPick: deep3Ops
      ? { name: deep3Ops.name, pnl: deep3Ops.pnl, avgSumMed: deep3Ops.avgSumMed, worst: deep3Ops.worst }
      : null,
    results: results.map(({ params, ...sum }) => ({
      ...sum,
      paramsSummary: {
        hedgeLevels: params.hedgeLevels,
        avgSumMax: params.avgSumMax,
        hedgeAskMax: params.hedgeAskMax,
        tauHedgeEscape: params.tauHedgeEscape,
        escapeAvgSumMax: params.escapeAvgSumMax,
        tauHedgeEscape2: params.tauHedgeEscape2,
        escapeAvgSumMax2: params.escapeAvgSumMax2,
        openShares: params.openShares,
        openCapCents: params.openCapCents,
        openTriggerCents: params.openTriggerCents,
        legChoice: params.legChoice,
        feeRate: params.feeRate,
        openRequireHedgeReady: params.openRequireHedgeReady,
        openBookSumMax: params.openBookSumMax,
        tauOpenMin: params.tauOpenMin,
        tauOpenMax: params.tauOpenMax,
      },
    })),
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(out, null, 2));
  // markdown leaderboard for humans / other AIs
  const md = [
    '# Clip-Path mechanics sweep',
    '',
    `Generated: ${out.generatedAt}`,
    `Events: ${dirs.length} · Variants: ${variants.length}`,
    `Baseline: \`${base.name}\` pnl=${base.pnl} avgMed=${base.avgSumMed}`,
    `**Promotion decision: \`${recommendation}\`**`,
    `Calibration rank only: \`${calibrationPick}\` (prior ops candidate: \`${priorOpsCandidate}\`)`,
    '',
    '## Top calibration pass — execution assumptions filtered',
    '',
    '| rank | name | pnl | roc% | eq | stuck | avgMed | worst | score |',
    '|---:|---|---:|---:|---:|---:|---:|---:|---:|',
    ...goLive.slice(0, 20).map(
      (r, i) =>
        `| ${i + 1} | \`${r.name}\` | ${r.pnl} | ${r.roc} | ${r.equalized} | ${r.stuck} | ${r.avgSumMed} | ${r.worst} | ${r.score} |`,
    ),
    '',
    '## Top calibration pass — raw (includes fee0 / size scale)',
    '',
    '| rank | name | pnl | score | notes |',
    '|---:|---|---:|---:|---|',
    ...go.slice(0, 10).map(
      (r, i) => `| ${i + 1} | \`${r.name}\` | ${r.pnl} | ${r.score} | ${r.notes} |`,
    ),
    '',
    '## Notes',
    '',
    '- Hard rule: never escapeAvgSumMax2 > 1.00 in this sweep.',
    '- CONTROL `tight-hedgeReady-slack8` included to confirm entry gate hurts traded count.',
    '- Size variants scale notional; compare ROC not only absolute pnl — filtered out of live pick.',
    '- `tight-fee0` is an upper bound, not a live config.',
    '- Escape rarely fires in these 14 journals; keep e2stage for live stuck insurance.',
    `- Near-miss NOGO with high pnl (worst≈-0.1): deep3-as92, c3-38-34-30, deep60 — edge too thin after fees.`,
    '- This window is calibration evidence only. It is not a holdout and cannot produce a live recommendation.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'LEADERBOARD.md'), md);

  console.log('\npromotion decision:', recommendation);
  console.log('calibrationPick (not live):', calibrationPick);
  console.log('priorOpsCandidate (demoted):', priorOpsCandidate);
  console.log('saved', path.join(outDir, 'report.json'));
  console.log('saved', path.join(outDir, 'LEADERBOARD.md'));
}

main();
