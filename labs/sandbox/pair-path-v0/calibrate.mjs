/**
 * Calibrate Pair-Path V0 BEFORE size/fee sweeps.
 * Holds openShares=10 and feeRate=0.07 fixed; searches entry/hedge/window/cap.
 *
 * Train: baliza series8
 * Holdout: Giovanna shadow tight-shadow (3 events)
 *
 *   node labs/sandbox/pair-path-v0/calibrate.mjs
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
  '.tmp/pair-path-v0-shadow/2026-07-28T04-59-33-426Z-tight-shadow',
);

// Fixed — do not calibrate size/fee in this pass
const FIXED = {
  openShares: 10,
  feeRate: 0.07,
  maxEventNotional: 25,
  maxOpenAttempts: 3,
  maxHedgeAttempts: 2,
  makerTimeoutSec: 30,
  tauHedgeMin: 15,
  tauEqMin: 8,
  eqAskMax: 0.05,
  legChoice: 'chase',
  hedgeCapCents: 1,
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

function runOnSeries(params, seriesDir) {
  const slugs = listEvents(seriesDir);
  const rows = [];
  for (const slug of slugs) {
    const ticks = readJsonl(path.join(seriesDir, 'events', slug, 'ticks.jsonl'));
    if (!ticks.length) continue;
    const eng = createEventEngine({ ...DEFAULT_PARAMS, ...FIXED, ...params }, { slug });
    let last = null;
    for (const t of ticks) {
      eng.onTick(t);
      last = t;
    }
    rows.push({ slug, ...eng.finish(last) });
  }

  const traded = rows.filter((r) => r.nFills > 0);
  const equalized = rows.filter((r) => r.mode === 'done');
  const stuck = rows.filter((r) => r.mode === 'opened');
  const pnls = rows.map((r) => (r.pnl != null ? r.pnl : 0));
  const avgSums = traded.map((r) => r.avgSum).filter((x) => x != null);
  const worsts = rows.map((r) => r.worstPnl);

  // Structural edge when equalized (shares * (1-avgSum)) — independent of fee accounting quirks
  let structural = 0;
  for (const r of equalized) {
    if (r.avgSum != null && r.inv?.UP?.shares) {
      structural += r.inv.UP.shares * (1 - r.avgSum);
    }
  }
  // Fees total
  const fees = rows.reduce((a, r) => a + (r.fees || 0), 0);

  return {
    nEvents: rows.length,
    nTraded: traded.length,
    nDone: equalized.length,
    nStuck: stuck.length,
    nIdle: rows.filter((r) => r.mode === 'idle').length,
    totalPnl: pnls.reduce((a, b) => a + b, 0),
    structuralEdge: Math.round(structural * 1000) / 1000,
    totalFees: Math.round(fees * 1000) / 1000,
    // net structural after fee (approx)
    structuralNet: Math.round((structural - fees) * 1000) / 1000,
    worstMin: worsts.length ? Math.min(...worsts) : 0,
    avgSum: stats(avgSums),
    avgSumGt1: avgSums.filter((a) => a > 1).length,
    avgSumGt098: avgSums.filter((a) => a > 0.98).length,
    pnl: stats(pnls),
    missOpenRate: null, // filled below from blocks if needed
    rows: rows.map((r) => ({
      slug: r.slug,
      mode: r.mode,
      fills: r.nFills,
      avgSum: r.avgSum,
      pnl: r.pnl,
      worstPnl: r.worstPnl,
      openAttempts: r.openAttempts,
      blockCounts: r.blockCounts,
    })),
  };
}

function riskPass(r) {
  if (r.nStuck > 0) return false;
  if (r.worstMin < -1.0) return false;
  if (r.avgSumGt1 > 0) return false;
  return true;
}

function scoreTrain(r) {
  // Prefer structural net (edge - fee), then worst, then more selective quality trades
  // Penalize overtrading noise slightly if structural not improving
  return (
    r.structuralNet * 20 +
    r.totalPnl * 10 +
    r.worstMin * 8 -
    r.nStuck * 5 -
    r.avgSumGt1 * 10 -
    r.avgSumGt098 * 1 +
    (r.nDone > 0 ? 0.05 : 0)
  );
}

/** Grid — size/fee fixed */
function buildGrid() {
  const grid = [];
  const openBands = [
    { openAskLo: 0.52, openAskHi: 0.62, openTriggerCents: 55, tag: 'band_52_62' },
    { openAskLo: 0.53, openAskHi: 0.6, openTriggerCents: 55, tag: 'band_53_60' },
    { openAskLo: 0.54, openAskHi: 0.58, openTriggerCents: 55, tag: 'band_54_58' },
    { openAskLo: 0.5, openAskHi: 0.65, openTriggerCents: 55, tag: 'band_50_65' },
    { openAskLo: 0.52, openAskHi: 0.62, openTriggerCents: 58, tag: 'trig_58' },
  ];
  const caps = [1, 2];
  const avgSums = [0.97, 0.98, 0.99, 0.995];
  const hedges = [0.42, 0.45, 0.48];
  const tauMaxes = [200, 240];
  const tauMins = [40, 60];

  for (const band of openBands) {
    for (const openCapCents of caps) {
      for (const avgSumMax of avgSums) {
        for (const hedgeAskMax of hedges) {
          // skip nonsense: hedge should be able to complete pair under avgSum
          if (hedgeAskMax + band.openAskLo > avgSumMax + 0.08) continue;
          for (const tauOpenMax of tauMaxes) {
            for (const tauOpenMin of tauMins) {
              if (tauOpenMin >= tauOpenMax) continue;
              const id = [
                band.tag,
                `cap${openCapCents}`,
                `as${avgSumMax}`,
                `h${hedgeAskMax}`,
                `t${tauOpenMin}-${tauOpenMax}`,
              ].join('_');
              grid.push({
                id,
                params: {
                  ...band,
                  openCapCents,
                  avgSumMax,
                  eqAvgSumMax: Math.min(avgSumMax, 0.99),
                  hedgeAskMax,
                  tauOpenMin,
                  tauOpenMax,
                },
              });
            }
          }
        }
      }
    }
  }
  return grid;
}

function main() {
  const trainEvents = listEvents(TRAIN_DIR);
  const holdEvents = listEvents(HOLDOUT_DIR);
  if (!trainEvents.length) {
    console.error('missing train series', TRAIN_DIR);
    process.exit(1);
  }

  const grid = buildGrid();
  console.log('=== Pair-Path V0 calibration (pre size/fee) ===');
  console.log(`train=${TRAIN_DIR} events=${trainEvents.length}`);
  console.log(`holdout=${HOLDOUT_DIR} events=${holdEvents.length || 0}`);
  console.log(`grid size=${grid.length}`);
  console.log(`FIXED size=${FIXED.openShares} fee=${FIXED.feeRate}`);
  console.log('');

  const results = [];
  let i = 0;
  for (const g of grid) {
    i += 1;
    const train = runOnSeries(g.params, TRAIN_DIR);
    const hold = holdEvents.length ? runOnSeries(g.params, HOLDOUT_DIR) : null;
    const pass = riskPass(train);
    const sc = scoreTrain(train);
    results.push({
      id: g.id,
      params: g.params,
      riskPass: pass,
      score: sc,
      train,
      hold,
    });
    if (i % 80 === 0 || i === grid.length) {
      process.stdout.write(`  … evaluated ${i}/${grid.length}\r`);
    }
  }
  console.log('');

  const passers = results.filter((r) => r.riskPass).sort((a, b) => b.score - a.score);
  const allSorted = [...results].sort((a, b) => b.score - a.score);

  console.log(`risk PASS on train: ${passers.length}/${results.length}`);
  console.log('');
  console.log('========== TOP 10 (risk PASS, train score) ==========');
  const top = passers.slice(0, 10);
  for (const [idx, r] of top.entries()) {
    const t = r.train;
    const h = r.hold;
    console.log(
      `${idx + 1}. ${r.id}\n` +
        `   train: pnl=${t.totalPnl.toFixed(2)} structNet=${t.structuralNet} worst=${t.worstMin}` +
        ` done=${t.nDone}/${t.nEvents} avgSumMed=${t.avgSum?.p50 ?? '-'} score=${r.score.toFixed(2)}\n` +
        (h
          ? `   hold:  pnl=${h.totalPnl.toFixed(2)} structNet=${h.structuralNet} worst=${h.worstMin}` +
            ` done=${h.nDone}/${h.nEvents} stuck=${h.nStuck} avgSumMed=${h.avgSum?.p50 ?? '-'}\n`
          : ''),
    );
  }

  // Prefer passers that also pass risk on holdout (if hold exists)
  let chosen = null;
  for (const r of passers) {
    if (!r.hold) {
      chosen = r;
      break;
    }
    if (riskPass(r.hold)) {
      chosen = r;
      break;
    }
  }
  // fallback: best train passer even if hold fails
  if (!chosen && passers.length) chosen = passers[0];

  if (!chosen) {
    console.error('no config passed risk gate on train');
    process.exit(2);
  }

  // Among top 15 passers, pick best holdout structuralNet if available
  const top15 = passers.slice(0, 15);
  if (holdEvents.length && top15.some((r) => r.hold && riskPass(r.hold))) {
    const holdRanked = top15
      .filter((r) => r.hold && riskPass(r.hold))
      .sort((a, b) => {
        const dh = b.hold.structuralNet - a.hold.structuralNet;
        if (Math.abs(dh) > 1e-9) return dh;
        return b.hold.totalPnl - a.hold.totalPnl;
      });
    if (holdRanked.length) chosen = holdRanked[0];
  }

  const calibration = {
    generatedAt: new Date().toISOString(),
    fixed: FIXED,
    trainDir: TRAIN_DIR,
    holdoutDir: HOLDOUT_DIR,
    gridSize: grid.length,
    riskGate: { nStuck: 0, worstMin: -1, avgSumGt1: 0 },
    scoreNote:
      'score=20*structuralNet + 10*pnl + 8*worstMin - penalties; size/fee FIXED',
    chosen: {
      id: chosen.id,
      params: { ...FIXED, ...chosen.params },
      train: summarizeLite(chosen.train),
      hold: chosen.hold ? summarizeLite(chosen.hold) : null,
      score: chosen.score,
    },
    top10: top.map((r) => ({
      id: r.id,
      score: r.score,
      params: r.params,
      train: summarizeLite(r.train),
      hold: r.hold ? summarizeLite(r.hold) : null,
    })),
    baselines: {
      tightAvgSum: evaluateNamed(
        {
          openAskLo: 0.52,
          openAskHi: 0.62,
          openTriggerCents: 55,
          openCapCents: 1,
          avgSumMax: 0.98,
          eqAvgSumMax: 0.98,
          hedgeAskMax: 0.45,
          tauOpenMin: 40,
          tauOpenMax: 240,
        },
        'tight-avgSum (pre-calib)',
      ),
    },
  };

  function evaluateNamed(params, name) {
    const train = runOnSeries(params, TRAIN_DIR);
    const hold = holdEvents.length ? runOnSeries(params, HOLDOUT_DIR) : null;
    return {
      name,
      params: { ...FIXED, ...params },
      riskPassTrain: riskPass(train),
      train: summarizeLite(train),
      hold: hold ? summarizeLite(hold) : null,
    };
  }

  function summarizeLite(r) {
    return {
      nEvents: r.nEvents,
      nTraded: r.nTraded,
      nDone: r.nDone,
      nStuck: r.nStuck,
      totalPnl: Math.round(r.totalPnl * 1000) / 1000,
      structuralEdge: r.structuralEdge,
      structuralNet: r.structuralNet,
      totalFees: r.totalFees,
      worstMin: r.worstMin,
      avgSumMed: r.avgSum?.p50 ?? null,
      avgSumGt1: r.avgSumGt1,
    };
  }

  const outDir = path.join(ROOT, '.tmp/pair-path-v0-calib');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'calibration.json'), JSON.stringify(calibration, null, 2));

  // compact leaderboard of all passers
  fs.writeFileSync(
    path.join(outDir, 'leaderboard-pass.json'),
    JSON.stringify(
      passers.slice(0, 40).map((r) => ({
        id: r.id,
        score: r.score,
        params: r.params,
        train: summarizeLite(r.train),
        hold: r.hold ? summarizeLite(r.hold) : null,
      })),
      null,
      2,
    ),
  );

  const preset = {
    id: `pair-path-calibrated-v0`,
    name: 'Pair-Path V0 calibrated (pre size/fee)',
    role: 'calibrated',
    source: 'calibrate.mjs train=series8 hold=shadow3',
    notes: chosen.id,
    params: { ...FIXED, ...chosen.params },
  };
  fs.writeFileSync(
    path.join(__dirname, 'presets/calibrated-v0.json'),
    JSON.stringify(preset, null, 2),
  );

  console.log('========== CHOSEN ==========');
  console.log(JSON.stringify(calibration.chosen, null, 2));
  console.log('');
  console.log('baseline tight-avgSum:');
  console.log(JSON.stringify(calibration.baselines.tightAvgSum, null, 2));
  console.log('');
  console.log(`saved ${outDir}`);
  console.log(`preset labs/sandbox/pair-path-v0/presets/calibrated-v0.json`);
}

main();
