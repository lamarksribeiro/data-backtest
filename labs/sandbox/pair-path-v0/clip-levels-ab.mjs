/**
 * Clip-Path V1 lab — A/B V0 vs hedge multinível (Clip-2 / Clip-3 / escape).
 *
 * Usa os mesmos journals da baliza (14 evt) que os outros A/B do Pair-Path.
 *
 *   node labs/sandbox/pair-path-v0/clip-levels-ab.mjs
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

/** Base alinhada ao micro-live size25 / hedge-ready A/B. */
const BASE = {
  ...PRESET.params,
  openShares: 25,
  maxEventNotional: 50,
  avgSumMax: 0.95,
  eqAvgSumMax: 0.98,
  hedgeAskMax: 0.42,
  openCapCents: 2,
  maxHedgeAttempts: 6,
};

const SERIES = [
  '.tmp/poly-baliza/2026-07-28T04-03-09-340Z-series8',
  '.tmp/pair-path-v0-shadow/2026-07-28T04-59-33-426Z-tight-shadow',
  '.tmp/pair-path-v0-shadow/2026-07-28T05-20-20-839Z-calib-shadow',
].map((p) => path.join(ROOT, p));

const VARIANTS = [
  {
    name: 'v0-baseline',
    notes: '1 open + 1 hedge cheio @≤42 · avgSumMax 0.95',
    params: {
      hedgeLevels: null,
      tauHedgeEscape: null,
      maxHedgeAttempts: 2,
    },
  },
  {
    name: 'clip-2',
    notes: '50% @≤42 + 50% @≤38 (strict · pode stuck)',
    params: {
      hedgeLevels: [
        { askMax: 0.42, frac: 0.5 },
        { askMax: 0.38, frac: 0.5 },
      ],
      tauHedgeEscape: null,
    },
  },
  {
    name: 'clip-2-escape',
    notes: '50%@42 + 50%@38; se τ≤20 completa @≤42',
    params: {
      hedgeLevels: [
        { askMax: 0.42, frac: 0.5 },
        { askMax: 0.38, frac: 0.5 },
      ],
      tauHedgeEscape: 20,
      hedgeEscapeAskMax: 0.42,
    },
  },
  {
    name: 'clip-3',
    notes: '40%@42 + 30%@38 + 30%@34 (strict)',
    params: {
      hedgeLevels: [
        { askMax: 0.42, frac: 0.4 },
        { askMax: 0.38, frac: 0.3 },
        { askMax: 0.34, frac: 0.3 },
      ],
      tauHedgeEscape: null,
    },
  },
  {
    name: 'clip-3-escape',
    notes: 'clip-3 + escape τ≤20 @≤42',
    params: {
      hedgeLevels: [
        { askMax: 0.42, frac: 0.4 },
        { askMax: 0.38, frac: 0.3 },
        { askMax: 0.34, frac: 0.3 },
      ],
      tauHedgeEscape: 20,
      hedgeEscapeAskMax: 0.42,
    },
  },
  {
    name: 'clip-2-tight',
    notes: '50%@40 + 50%@36 · avgSumMax 0.95',
    params: {
      hedgeAskMax: 0.4,
      hedgeLevels: [
        { askMax: 0.4, frac: 0.5 },
        { askMax: 0.36, frac: 0.5 },
      ],
      tauHedgeEscape: 20,
      hedgeEscapeAskMax: 0.42,
    },
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
    let openedTau = null;
    let hedgedTau = null;
    for (const t of ticks) {
      const before = eng.state.mode;
      eng.onTick(t);
      const after = eng.state.mode;
      // hedged→done can happen in the same tick via tryEq
      if (
        before === 'idle' &&
        (after === 'opened' || after === 'hedged' || after === 'done') &&
        openedTau == null
      ) {
        openedTau = t.tau != null ? Number(t.tau) : null;
      }
      if (
        before === 'opened' &&
        (after === 'hedged' || after === 'done') &&
        hedgedTau == null
      ) {
        hedgedTau = t.tau != null ? Number(t.tau) : null;
      }
      last = t;
    }
    const r = eng.finish(last);
    const residualSh = r.residual?.shares || 0;
    const tauOpened =
      openedTau != null && hedgedTau != null ? Math.round((openedTau - hedgedTau) * 10) / 10 : null;
    rows.push({
      slug,
      mode: r.mode,
      fills: r.nFills,
      nHedgeClips: r.nHedgeClips || 0,
      avgSum: r.avgSum,
      pnl: r.pnl ?? 0,
      worst: r.worstPnl,
      invested: r.invested,
      residualSh,
      tauOpenedSec: tauOpened,
      hedgePlan: r.hedgePlan,
      blocks: r.blockCounts,
      fillKinds: r.fills.reduce((m, f) => {
        m[f.kind] = (m[f.kind] || 0) + 1;
        return m;
      }, {}),
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
  const hedgeRefuse = rows.reduce((a, r) => a + (r.blocks?.HEDGE_REFUSE_AVGSUM || 0), 0);
  const clipFills = rows.reduce((a, r) => a + (r.nHedgeClips || 0), 0);
  const escapeFills = rows.reduce((a, r) => a + (r.fillKinds?.hedge_escape || 0), 0);
  const taus = equalized.map((r) => r.tauOpenedSec).filter((x) => x != null);
  const tauMed = taus.length
    ? [...taus].sort((a, b) => a - b)[Math.floor(taus.length / 2)]
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
    hedgeRefuse,
    clipFills,
    escapeFills,
    tauOpenedMed: tauMed,
    score:
      Math.round(
        (pnl - 5 * stuck.length - Math.max(0, -Math.min(...rows.map((r) => r.worst)))) *
          1000,
      ) / 1000,
    events: rows,
  };
}

function gateCheck(base, r) {
  const pnlFloor = base.pnl - 0.5;
  const avgOk =
    r.avgSumMed == null || base.avgSumMed == null || r.avgSumMed <= base.avgSumMed + 1e-9;
  const go = r.stuck === 0 && r.worst >= 0 && r.pnl >= pnlFloor && avgOk;
  return {
    go,
    reasons: [
      r.stuck === 0 ? null : `stuck=${r.stuck}`,
      r.worst >= 0 ? null : `worst=${r.worst}`,
      r.pnl >= pnlFloor ? null : `pnl ${r.pnl} < V0−0.5 (${pnlFloor})`,
      avgOk ? null : `avgMed ${r.avgSumMed} > V0 ${base.avgSumMed}`,
    ].filter(Boolean),
  };
}

function main() {
  const dirs = listDirs();
  console.log('=== Clip-Path V1 · levels A/B ===');
  console.log(
    `events=${dirs.length} base=sh${BASE.openShares} cap+${BASE.openCapCents}` +
      ` avgSumMax${BASE.avgSumMax} hedgeAskMax${BASE.hedgeAskMax} notional≤${BASE.maxEventNotional}`,
  );
  console.log('');

  if (!dirs.length) {
    console.error('Nenhum journal encontrado. Esperado em .tmp/poly-baliza e .tmp/pair-path-v0-shadow');
    process.exit(1);
  }

  const results = VARIANTS.map((v) => runVariant(v, dirs));
  const base = results[0];

  for (const r of results) {
    const gate = r.name === 'v0-baseline' ? { go: true, reasons: [] } : gateCheck(base, r);
    const mark = r.name === 'v0-baseline' ? 'BASE' : gate.go ? 'GO  ' : 'NOGO';
    console.log(
      `[${mark}] ${r.name.padEnd(16)} traded=${r.traded}/${r.n} eq=${r.equalized}` +
        ` stuck=${r.stuck}` +
        ` pnl=${String(r.pnl).padStart(7)} roc=${r.roc}%` +
        ` avgMed=${r.avgSumMed} worst=${r.worst}` +
        ` clips=${r.clipFills} esc=${r.escapeFills}` +
        ` τmed=${r.tauOpenedMed ?? '-'}`,
    );
    console.log(`       ${r.notes}`);
    if (gate.reasons.length) console.log(`       fail: ${gate.reasons.join('; ')}`);
  }

  console.log('');
  console.log('--- vs v0-baseline ---');
  for (const r of results.slice(1)) {
    console.log(
      `→ ${r.name}: Δtraded=${r.traded - base.traded} Δeq=${r.equalized - base.equalized}` +
        ` Δstuck=${r.stuck - base.stuck}` +
        ` Δpnl=${Math.round((r.pnl - base.pnl) * 1000) / 1000}` +
        ` ΔavgMed=${
          r.avgSumMed != null && base.avgSumMed != null
            ? Math.round((r.avgSumMed - base.avgSumMed) * 1000) / 1000
            : '-'
        }`,
    );
  }

  console.log('');
  console.log('--- stuck / residual ---');
  let anyStuck = false;
  for (const r of results) {
    const bad = r.events.filter((e) => e.mode === 'opened' || (e.residualSh || 0) >= 1);
    if (!bad.length) continue;
    anyStuck = true;
    console.log(r.name + ':');
    for (const e of bad) {
      console.log(
        `  ${e.slug.slice(-12)} mode=${e.mode} fills=${e.fills} resid=${e.residualSh}` +
          ` pnl=${e.pnl} worst=${e.worst} avg=${e.avgSum ?? '-'} clips=${e.nHedgeClips}`,
      );
    }
  }
  if (!anyStuck) console.log('(nenhum)');

  const gated = results
    .slice(1)
    .map((r) => ({ r, gate: gateCheck(base, r) }))
    .filter((x) => x.gate.go);
  gated.sort((a, b) => b.r.score - a.r.score || b.r.pnl - a.r.pnl);
  const recommendation = gated[0]
    ? `prefer_${gated[0].r.name}`
    : 'keep_v0_baseline';

  const out = {
    generatedAt: new Date().toISOString(),
    lab: 'clip-path-v1',
    base: BASE,
    series: SERIES.map((s) => path.relative(ROOT, s)),
    gate: {
      stuck: 0,
      worstMin: 0,
      pnlFloorVsV0: -0.5,
      avgSumMedMaxVsV0: 0,
    },
    results: results.map(({ events, ...sum }) => ({
      ...sum,
      gate: sum.name === 'v0-baseline' ? { go: true, reasons: [] } : gateCheck(base, sum),
      events,
    })),
    recommendation,
  };

  const outDir = path.join(ROOT, '.tmp/clip-path-v1-ab');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'report.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

  console.log('');
  console.log('recommendation:', recommendation);
  console.log('saved', outFile);
}

main();
