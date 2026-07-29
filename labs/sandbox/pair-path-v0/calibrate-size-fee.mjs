/**
 * Size / fee calibration for Pair-Path V0.
 * Locks entry/hedge mechanics from calibrated-v0; varies size, fee, mild asymmetry.
 *
 * Train: series8 baliza
 * Holdout: calib-shadow (3 events Giovanna)
 *
 *   node labs/sandbox/pair-path-v0/calibrate-size-fee.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventEngine, DEFAULT_PARAMS } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

const TRAIN_DIR = path.join(ROOT, '.tmp/poly-baliza/2026-07-28T04-03-09-340Z-series8');
const HOLDOUT_DIR = path.join(
  ROOT,
  '.tmp/pair-path-v0-shadow/2026-07-28T05-20-20-839Z-calib-shadow',
);

/** Mechanics frozen from calibrated-v0 */
const MECH = {
  openAskLo: 0.52,
  openAskHi: 0.62,
  openTriggerCents: 55,
  openCapCents: 1,
  avgSumMax: 0.97,
  eqAvgSumMax: 0.97,
  hedgeAskMax: 0.42,
  tauOpenMin: 40,
  tauOpenMax: 240,
  tauHedgeMin: 15,
  tauEqMin: 8,
  eqAskMax: 0.05,
  legChoice: 'chase',
  hedgeCapCents: 1,
  maxOpenAttempts: 3,
  maxHedgeAttempts: 2,
  makerTimeoutSec: 30,
};

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

/**
 * Run with optional hedgeSizeScale: hedge sh = openShares * scale (capped by residual need).
 * Engine equalizes fully today — we simulate scale by temporarily patching via
 * openShares on hedge path is not separate. For v0 engine, full equalize only.
 * Asymmetry variants use post-hoc note OR we extend engine.
 *
 * For this pass we support:
 *  - openShares
 *  - feeRate
 *  - maxEventNotional
 *  - minStructuralEdge: refuse open if projected fee drag too high (fee-aware gate)
 *  - hedgeSizeScale via engine extension params if present
 */
function runOnSeries(params, seriesDir) {
  const slugs = listEvents(seriesDir);
  const rows = [];
  for (const slug of slugs) {
    const ticks = readJsonl(path.join(seriesDir, 'events', slug, 'ticks.jsonl'));
    if (!ticks.length) continue;
    const eng = createEventEngine(
      {
        ...DEFAULT_PARAMS,
        ...MECH,
        ...params,
      },
      { slug },
    );
    // Optional fee-aware gate: skip opens by wrapping onTick — handled in engine if minEdge
    let last = null;
    for (const t of ticks) {
      eng.onTick(t);
      last = t;
    }
    rows.push({ slug, ...eng.finish(last) });
  }

  const traded = rows.filter((r) => r.nFills > 0);
  const done = rows.filter((r) => r.mode === 'done');
  const stuck = rows.filter((r) => r.mode === 'opened');
  const pnls = rows.map((r) => (r.pnl != null ? r.pnl : 0));
  const avgSums = traded.map((r) => r.avgSum).filter((x) => x != null);
  const worsts = rows.map((r) => r.worstPnl);
  let structural = 0;
  for (const r of done) {
    if (r.avgSum != null && r.inv?.UP?.shares) {
      // use min shares when equalized
      const sh = Math.min(r.inv.UP.shares, r.inv.DOWN.shares);
      structural += sh * (1 - r.avgSum);
    }
  }
  const fees = rows.reduce((a, r) => a + (r.fees || 0), 0);
  const invested = rows.reduce((a, r) => a + (r.invested || 0), 0);

  return {
    nEvents: rows.length,
    nTraded: traded.length,
    nDone: done.length,
    nStuck: stuck.length,
    totalPnl: Math.round(pnls.reduce((a, b) => a + b, 0) * 1000) / 1000,
    structuralEdge: Math.round(structural * 1000) / 1000,
    totalFees: Math.round(fees * 1000) / 1000,
    structuralNet: Math.round((structural - fees) * 1000) / 1000,
    totalInvested: Math.round(invested * 100) / 100,
    // return on capital deployed (when invested > 0)
    roc: invested > 0 ? Math.round((pnls.reduce((a, b) => a + b, 0) / invested) * 10000) / 10000 : null,
    worstMin: worsts.length ? Math.min(...worsts) : 0,
    avgSum: stats(avgSums),
    avgSumGt1: avgSums.filter((a) => a > 1).length,
    pnlPerEvent: Math.round((pnls.reduce((a, b) => a + b, 0) / Math.max(1, rows.length)) * 1000) / 1000,
  };
}

function riskPass(r) {
  if (r.nStuck > 0) return false;
  if (r.avgSumGt1 > 0) return false;
  // scale worst with size: allow ~1.5c per share * size roughly; use absolute for now
  if (r.worstMin < -2.5) return false;
  return true;
}

function score(r) {
  // Prefer total pnl, then ROC, then worst, penalize fee waste
  const roc = r.roc != null ? r.roc : 0;
  return r.totalPnl * 15 + roc * 50 + r.worstMin * 5 + r.structuralNet * 5 - (r.totalFees > r.structuralEdge ? 2 : 0);
}

function buildGrid() {
  const grid = [];
  const sizes = [5, 10, 15, 20, 30];
  const fees = [0, 0.035, 0.07]; // 0 = maker-like / rebate extreme; 0.035 half; 0.07 full crypto taker both legs
  for (const openShares of sizes) {
    for (const feeRate of fees) {
      const maxEventNotional = Math.ceil(openShares * 1.2); // room for both legs ~ open*avg*2
      // more accurate notional cap: 2 * openShares * 0.62
      const cap = Math.ceil(openShares * 0.62 * 2 + 2);
      grid.push({
        id: `sh${openShares}_fee${feeRate}`,
        params: {
          openShares,
          feeRate,
          maxEventNotional: cap,
        },
      });
    }
  }
  // Fee-aware: only trade if structural edge buffer — simulated via tighter avgSumMax at same size
  // (true dynamic fee gate needs engine change; we test tighter avgSum as proxy)
  for (const openShares of [10, 20]) {
    grid.push({
      id: `sh${openShares}_fee0.07_as0.96`,
      params: {
        openShares,
        feeRate: 0.07,
        maxEventNotional: Math.ceil(openShares * 0.62 * 2 + 2),
        avgSumMax: 0.96,
        eqAvgSumMax: 0.96,
      },
    });
  }
  // Asymmetry proxy: higher open band cheaper pairs only (not size tilt yet)
  grid.push({
    id: 'sh10_fee0.07_cheap_pair_as0.95',
    params: {
      openShares: 10,
      feeRate: 0.07,
      maxEventNotional: 15,
      avgSumMax: 0.95,
      eqAvgSumMax: 0.95,
      hedgeAskMax: 0.4,
    },
  });
  return grid;
}

function lite(r) {
  return {
    nTraded: r.nTraded,
    nDone: r.nDone,
    nStuck: r.nStuck,
    totalPnl: r.totalPnl,
    structuralEdge: r.structuralEdge,
    structuralNet: r.structuralNet,
    totalFees: r.totalFees,
    totalInvested: r.totalInvested,
    roc: r.roc,
    worstMin: r.worstMin,
    avgSumMed: r.avgSum?.p50 ?? null,
    pnlPerEvent: r.pnlPerEvent,
  };
}

function main() {
  const trainN = listEvents(TRAIN_DIR).length;
  const holdN = listEvents(HOLDOUT_DIR).length;
  if (!trainN) {
    console.error('missing train', TRAIN_DIR);
    process.exit(1);
  }

  const grid = buildGrid();
  console.log('=== Size/Fee calibration ===');
  console.log(`mech frozen: avgSumMax=${MECH.avgSumMax} hedge<=${MECH.hedgeAskMax} band 52-62 cap1`);
  console.log(`train events=${trainN} holdout=${holdN} grid=${grid.length}`);
  console.log('');

  const results = [];
  for (const g of grid) {
    const train = runOnSeries(g.params, TRAIN_DIR);
    const hold = holdN ? runOnSeries(g.params, HOLDOUT_DIR) : null;
    const pass = riskPass(train) && (!hold || riskPass(hold));
    const sc = score(train);
    results.push({
      id: g.id,
      params: { ...MECH, ...g.params },
      riskPass: pass,
      score: sc,
      train,
      hold,
    });
    const h = hold
      ? ` holdPnl=${hold.totalPnl} holdRoc=${hold.roc} holdWorst=${hold.worstMin}`
      : '';
    console.log(
      `${g.id.padEnd(28)} PASS=${pass} pnl=${train.totalPnl} roc=${train.roc} worst=${train.worstMin}` +
        ` fees=${train.totalFees} struct=${train.structuralEdge} done=${train.nDone}/${train.nEvents}${h}`,
    );
  }

  const passers = results.filter((r) => r.riskPass).sort((a, b) => b.score - a.score);
  // Live candidate: must use realistic taker fee 0.07 (fee=0 is maker-utopia bound only)
  const livePassers = passers.filter((r) => Number(r.params.feeRate) === 0.07);
  let chosen = null;
  const holdOk = livePassers.filter((r) => r.hold && r.hold.totalPnl >= 0 && r.hold.worstMin >= -1);
  if (holdOk.length) {
    holdOk.sort((a, b) => {
      const d = b.hold.totalPnl - a.hold.totalPnl;
      if (Math.abs(d) > 1e-9) return d;
      return (b.hold.roc || 0) - (a.hold.roc || 0);
    });
    chosen = holdOk[0];
  } else if (livePassers.length) {
    chosen = livePassers[0];
  } else if (passers.length) {
    chosen = passers[0]; // fallback
  }

  console.log('');
  console.log('========== TOP (risk PASS both) ==========');
  passers.slice(0, 12).forEach((r, i) => {
    console.log(
      `${i + 1}. ${r.id} score=${r.score.toFixed(2)} trainPnl=${r.train.totalPnl} holdPnl=${r.hold?.totalPnl}` +
        ` trainRoc=${r.train.roc} holdRoc=${r.hold?.roc}`,
    );
  });

  if (!chosen) {
    console.error('no candidate');
    process.exit(2);
  }

  // Baseline size10 fee0.07
  const baseline = results.find((r) => r.id === 'sh10_fee0.07');

  const out = {
    generatedAt: new Date().toISOString(),
    notes: {
      asymmetry:
        'Full equalize is symmetric payoff. Asymmetry (residual tilt / unequal size) is a SEPARATE mechanic — not size sweep. Fee-aware = only trade when (1-avgSum)*sh > fees.',
      shotandgo:
        'Shotandgo = dual ladder + rearm + MULT path inventory. We only kept complete-set + taker_limit + freios. Dynamic size-by-event is next after this grid.',
    },
    mech: MECH,
    chosen: {
      id: chosen.id,
      params: chosen.params,
      train: lite(chosen.train),
      hold: chosen.hold ? lite(chosen.hold) : null,
      score: chosen.score,
    },
    baseline_sh10_fee007: baseline
      ? { train: lite(baseline.train), hold: baseline.hold ? lite(baseline.hold) : null }
      : null,
    leaderboard: passers.slice(0, 20).map((r) => ({
      id: r.id,
      score: r.score,
      openShares: r.params.openShares,
      feeRate: r.params.feeRate,
      train: lite(r.train),
      hold: r.hold ? lite(r.hold) : null,
    })),
    all: results.map((r) => ({
      id: r.id,
      riskPass: r.riskPass,
      score: r.score,
      params: { openShares: r.params.openShares, feeRate: r.params.feeRate, avgSumMax: r.params.avgSumMax },
      train: lite(r.train),
      hold: r.hold ? lite(r.hold) : null,
    })),
  };

  const outDir = path.join(ROOT, '.tmp/pair-path-v0-calib-size-fee');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'size-fee.json'), JSON.stringify(out, null, 2));

  const preset = {
    id: 'pair-path-size-fee-v0',
    name: `Pair-Path size/fee · ${chosen.id}`,
    role: 'size-fee-calibrated',
    source: 'calibrate-size-fee.mjs',
    notes: chosen.id,
    params: chosen.params,
  };
  fs.writeFileSync(
    path.join(__dirname, 'presets/size-fee-v0.json'),
    JSON.stringify(preset, null, 2),
  );

  console.log('');
  console.log('========== CHOSEN ==========');
  console.log(JSON.stringify(out.chosen, null, 2));
  console.log('baseline sh10 fee0.07:', JSON.stringify(out.baseline_sh10_fee007, null, 2));
  console.log(`saved ${outDir}`);
  console.log('preset presets/size-fee-v0.json');
}

main();
