/**
 * Correlação de perdas MIDAS Gold entre BTC/ETH/SOL/XRP no mesmo event_start.
 *
 * Uso:
 *   node --max-old-space-size=12288 labs/sandbox/midas-cross-asset-loss-corr.mjs
 *   node labs/sandbox/midas-cross-asset-loss-corr.mjs --from 2026-07-01 --to 2026-07-25
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../../src/state/sqlite.js';
import { parse } from '../../src/backtestStudio/gls/parser.js';
import { createGlsBacktestRunner } from '../../src/backtestStudio/gls/runtime.js';
import { runSequentialSoA } from '../../src/backtest/engine.js';
import { loadBacktestColumnSet } from '../../src/query/columnChunkReader.js';
import { applyPolymarketFeesToBacktestResult } from '../../src/backtest/fees.js';
import { loadPreset } from '../shared/presets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const STRATEGY_ROOT = path.join(ROOT, 'labs/strategies/terminal/midas-carry-v1');
const OUT_JSON = path.join(ROOT, 'labs/sandbox/midas-cross-asset-loss-corr.json');

const PRESETS = [
  { asset: 'BTC', presetId: 'btc-gold-v1' },
  { asset: 'ETH', presetId: 'eth-gold-v1' },
  { asset: 'SOL', presetId: 'sol-gold-v1' },
  { asset: 'XRP', presetId: 'xrp-gold-v1' },
];

function parseArgs(argv) {
  const flags = { from: '2026-07-01', to: '2026-07-25' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return flags;
}

function pct(n, d) {
  if (!d) return null;
  return Math.round((1000 * n) / d) / 10;
}

function normSlot(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  const s = String(v);
  const ms = Date.parse(s);
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  return s;
}

function pairs(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    for (let j = i + 1; j < arr.length; j += 1) out.push([arr[i], arr[j]]);
  }
  return out;
}

async function runAsset(db, glsAst, asset, presetId, from, to) {
  const { params } = loadPreset(presetId, {
    strategyFamily: 'terminal',
    strategyId: 'midas-carry-v1',
  });
  console.error(`[${asset}] loading ticks + running ${presetId}...`);
  const t0 = Date.now();
  const columnSet = await loadBacktestColumnSet(db, {
    from: new Date(`${from}T00:00:00.000Z`).toISOString(),
    to: new Date(`${to}T00:00:00.000Z`).toISOString(),
    underlying: asset,
    interval: '5m',
    bookDepth: 25,
    selectBookDepth: 25,
    dataset: 'backtest_ticks',
    includeBook: true,
    validBacktestRows: true,
  });
  console.error(`[${asset}] ticks=${columnSet.length} events=${columnSet.events?.length ?? 0}`);

  const runner = createGlsBacktestRunner(glsAst, params, {
    executionMode: 'compiled-soa',
    fastRun: true,
    bookDepth: 25,
  });
  runner.bindColumnSet(columnSet);
  await runSequentialSoA(runner, columnSet, true);
  const outcome = runner.finish();
  applyPolymarketFeesToBacktestResult(outcome, { category: 'crypto' });

  const trades = [];
  for (const ev of outcome.events || []) {
    if (ev.reason === 'no_entry') continue;
    const pnl = Number(ev.finalPnl ?? 0);
    const slot = normSlot(ev.eventStart);
    if (!slot) continue;
    trades.push({
      asset,
      slot,
      pnl,
      side: ev.positionType || null,
      ask: ev.avgEntryPrice != null ? Number(ev.avgEntryPrice) : null,
      loss: pnl < -0.01,
      win: pnl > 0.01,
    });
  }

  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const losses = trades.filter((t) => t.loss);
  console.error(
    `[${asset}] trades=${trades.length} pnl=${pnl.toFixed(2)} losses=${losses.length} ` +
      `${Date.now() - t0}ms`,
  );
  return { asset, presetId, trades, pnl, losses: losses.length };
}

function analyze(byAsset) {
  const assets = PRESETS.map((p) => p.asset);
  const bySlot = new Map();

  for (const asset of assets) {
    for (const t of byAsset[asset].trades) {
      if (!bySlot.has(t.slot)) bySlot.set(t.slot, {});
      bySlot.get(t.slot)[asset] = t;
    }
  }

  // Pairwise: given A loses, P(B also loses | both traded)
  const pairCond = {};
  for (const [a, b] of pairs(assets)) {
    let bothTraded = 0;
    let aLoss = 0;
    let bothLoss = 0;
    let aLossBWin = 0;
    let bothWin = 0;
    let sameSideBothLoss = 0;
    let oppSideBothLoss = 0;
    let sumJointLossPnl = 0;
    for (const row of bySlot.values()) {
      const ta = row[a];
      const tb = row[b];
      if (!ta || !tb) continue;
      bothTraded += 1;
      if (ta.win && tb.win) bothWin += 1;
      if (ta.loss) {
        aLoss += 1;
        if (tb.loss) {
          bothLoss += 1;
          sumJointLossPnl += ta.pnl + tb.pnl;
          if (ta.side && tb.side && ta.side === tb.side) sameSideBothLoss += 1;
          else if (ta.side && tb.side) oppSideBothLoss += 1;
        } else if (tb.win) aLossBWin += 1;
      }
    }
    pairCond[`${a}_${b}`] = {
      bothTraded,
      aLossGivenBoth: aLoss,
      bothLoss,
      pBLossGivenALoss: pct(bothLoss, aLoss),
      unconditionalLossRateA: null,
      bothWin,
      aLossBWin,
      sameSideBothLoss,
      oppSideBothLoss,
      avgJointLossPnl: bothLoss ? Number((sumJointLossPnl / bothLoss).toFixed(2)) : null,
    };
  }

  // Unconditional loss rate per asset among its trades
  const lossRate = {};
  for (const asset of assets) {
    const n = byAsset[asset].trades.length;
    lossRate[asset] = pct(byAsset[asset].losses, n);
  }
  for (const [a, b] of pairs(assets)) {
    pairCond[`${a}_${b}`].unconditionalLossRateB = lossRate[b];
    pairCond[`${a}_${b}`].liftVsIndep = pairCond[`${a}_${b}`].pBLossGivenALoss != null && lossRate[b]
      ? Number((pairCond[`${a}_${b}`].pBLossGivenALoss / lossRate[b]).toFixed(2))
      : null;
  }

  // Portfolio: slots where k assets lose simultaneously (among those that traded)
  const multiLoss = { '1': 0, '2': 0, '3': 0, '4': 0 };
  const multiTrade = { '1': 0, '2': 0, '3': 0, '4': 0 };
  let slotsWithAnyTrade = 0;
  let slotsWithAnyLoss = 0;
  let worstSlot = null;
  const dailyJoint = new Map(); // day -> max concurrent loss pnl

  for (const [slot, row] of bySlot.entries()) {
    const traded = assets.filter((a) => row[a]);
    if (!traded.length) continue;
    slotsWithAnyTrade += 1;
    const kTrade = String(Math.min(traded.length, 4));
    multiTrade[kTrade] = (multiTrade[kTrade] || 0) + 1;

    const losers = traded.filter((a) => row[a].loss);
    if (losers.length) {
      slotsWithAnyLoss += 1;
      const k = String(Math.min(losers.length, 4));
      multiLoss[k] = (multiLoss[k] || 0) + 1;
      const jointPnl = losers.reduce((s, a) => s + row[a].pnl, 0);
      const sides = losers.map((a) => row[a].side);
      if (!worstSlot || jointPnl < worstSlot.jointPnl) {
        worstSlot = {
          slot,
          jointPnl: Number(jointPnl.toFixed(2)),
          losers,
          sides,
          details: Object.fromEntries(
            losers.map((a) => [a, { pnl: Number(row[a].pnl.toFixed(2)), side: row[a].side }]),
          ),
        };
      }
      const day = slot.slice(0, 10);
      const prev = dailyJoint.get(day) || { worstJoint: 0, multiLossSlots: 0, lossSlots: 0 };
      prev.lossSlots += 1;
      if (losers.length >= 2) prev.multiLossSlots += 1;
      if (jointPnl < prev.worstJoint) prev.worstJoint = Number(jointPnl.toFixed(2));
      dailyJoint.set(day, prev);
    }
  }

  // Given BTC loss, how many other assets also lose (when they traded)
  const givenBtcLoss = { n: 0, with1plus: 0, with2plus: 0, with3: 0, avgOthersLosing: 0 };
  let othersSum = 0;
  for (const row of bySlot.values()) {
    if (!row.BTC?.loss) continue;
    givenBtcLoss.n += 1;
    const others = ['ETH', 'SOL', 'XRP'].filter((a) => row[a]?.loss);
    othersSum += others.length;
    if (others.length >= 1) givenBtcLoss.with1plus += 1;
    if (others.length >= 2) givenBtcLoss.with2plus += 1;
    if (others.length >= 3) givenBtcLoss.with3 += 1;
  }
  givenBtcLoss.avgOthersLosing = givenBtcLoss.n
    ? Number((othersSum / givenBtcLoss.n).toFixed(2))
    : 0;
  givenBtcLoss.pctWith1plus = pct(givenBtcLoss.with1plus, givenBtcLoss.n);
  givenBtcLoss.pctWith2plus = pct(givenBtcLoss.with2plus, givenBtcLoss.n);

  // Independence baseline for multi-loss among 4-traded slots
  let fourTraded = 0;
  let fourAllLoss = 0;
  let fourGe2Loss = 0;
  let fourGe3Loss = 0;
  for (const row of bySlot.values()) {
    if (!assets.every((a) => row[a])) continue;
    fourTraded += 1;
    const nLoss = assets.filter((a) => row[a].loss).length;
    if (nLoss >= 2) fourGe2Loss += 1;
    if (nLoss >= 3) fourGe3Loss += 1;
    if (nLoss === 4) fourAllLoss += 1;
  }

  // Simulated independent: product of loss rates (approx) for P(all 4 lose)
  const pIndepAll4 = assets.reduce((p, a) => p * ((lossRate[a] || 0) / 100), 1);
  const expectedAll4Indep = fourTraded * pIndepAll4;

  // Equity path: sum PnL per slot across assets that traded
  const slotPnls = [...bySlot.entries()]
    .map(([slot, row]) => ({
      slot,
      pnl: assets.reduce((s, a) => s + (row[a]?.pnl || 0), 0),
      nLoss: assets.filter((a) => row[a]?.loss).length,
      nTrade: assets.filter((a) => row[a]).length,
    }))
    .sort((a, b) => a.slot.localeCompare(b.slot));

  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let worstDayPnl = 0;
  const dayPnl = new Map();
  for (const s of slotPnls) {
    equity += s.pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    const day = s.slot.slice(0, 10);
    dayPnl.set(day, (dayPnl.get(day) || 0) + s.pnl);
  }
  for (const v of dayPnl.values()) worstDayPnl = Math.min(worstDayPnl, v);

  // Single-asset DDs for comparison
  const singleDd = {};
  for (const asset of assets) {
    const sorted = [...byAsset[asset].trades].sort((a, b) => a.slot.localeCompare(b.slot));
    let eq = 0;
    let pk = 0;
    let dd = 0;
    for (const t of sorted) {
      eq += t.pnl;
      pk = Math.max(pk, eq);
      dd = Math.max(dd, pk - eq);
    }
    singleDd[asset] = Number(dd.toFixed(2));
  }

  // Sum of individual max DDs vs portfolio (diversification ratio proxy)
  const sumSingleDd = assets.reduce((s, a) => s + singleDd[a], 0);

  return {
    lossRate,
    pairCond,
    multiLoss,
    multiTrade,
    slotsWithAnyTrade,
    slotsWithAnyLoss,
    multiLossShareOfLossSlots: pct(
      (multiLoss['2'] || 0) + (multiLoss['3'] || 0) + (multiLoss['4'] || 0),
      slotsWithAnyLoss,
    ),
    fourTraded,
    fourGe2Loss,
    fourGe3Loss,
    fourAllLoss,
    fourGe2Pct: pct(fourGe2Loss, fourTraded),
    fourGe3Pct: pct(fourGe3Loss, fourTraded),
    fourAllPct: pct(fourAllLoss, fourTraded),
    expectedAll4Indep: Number(expectedAll4Indep.toFixed(2)),
    givenBtcLoss,
    worstSlot,
    portfolio: {
      totalPnl: Number(slotPnls.reduce((s, x) => s + x.pnl, 0).toFixed(2)),
      maxDrawdown: Number(maxDd.toFixed(2)),
      worstDay: Number(worstDayPnl.toFixed(2)),
      singleDd,
      sumSingleDd: Number(sumSingleDd.toFixed(2)),
      ddVsSumSinglePct: pct(maxDd, sumSingleDd),
    },
    dailyJoint: [...dailyJoint.entries()]
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => a.worstJoint - b.worstJoint)
      .slice(0, 10),
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath, { readOnly: true });
  const glsSource = fs.readFileSync(path.join(STRATEGY_ROOT, 'strategy.gls'), 'utf8');
  const glsAst = parse(glsSource);

  const byAsset = {};
  for (const { asset, presetId } of PRESETS) {
    byAsset[asset] = await runAsset(db, glsAst, asset, presetId, flags.from, flags.to);
  }
  closeStateDatabase(db);

  const analysis = analyze(byAsset);
  const summary = {
    meta: {
      from: flags.from,
      to: flags.to,
      presets: Object.fromEntries(PRESETS.map((p) => [p.asset, p.presetId])),
      generatedAt: new Date().toISOString(),
    },
    perAsset: Object.fromEntries(
      PRESETS.map(({ asset }) => [
        asset,
        {
          trades: byAsset[asset].trades.length,
          pnl: Number(byAsset[asset].pnl.toFixed(2)),
          losses: byAsset[asset].losses,
          lossRate: analysis.lossRate[asset],
        },
      ]),
    ),
    analysis,
  };

  fs.writeFileSync(OUT_JSON, `${JSON.stringify(summary, null, 2)}\n`);
  console.log('\n=== MIDAS CROSS-ASSET LOSS CORRELATION ===');
  console.log(JSON.stringify({
    perAsset: summary.perAsset,
    lossRate: analysis.lossRate,
    givenBtcLoss: analysis.givenBtcLoss,
    multiLoss: analysis.multiLoss,
    multiLossShareOfLossSlots: analysis.multiLossShareOfLossSlots,
    fourTraded: analysis.fourTraded,
    fourGe2Pct: analysis.fourGe2Pct,
    fourGe3Pct: analysis.fourGe3Pct,
    fourAllLoss: analysis.fourAllLoss,
    expectedAll4Indep: analysis.expectedAll4Indep,
    pairCond: Object.fromEntries(
      Object.entries(analysis.pairCond).map(([k, v]) => [
        k,
        {
          pBLossGivenALoss: v.pBLossGivenALoss,
          unconditionalLossRateB: v.unconditionalLossRateB,
          liftVsIndep: v.liftVsIndep,
          bothLoss: v.bothLoss,
          bothTraded: v.bothTraded,
        },
      ]),
    ),
    portfolio: analysis.portfolio,
    worstSlot: analysis.worstSlot,
    worstDays: analysis.dailyJoint.slice(0, 5),
  }, null, 2));
  console.error(`\nWrote ${OUT_JSON}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
