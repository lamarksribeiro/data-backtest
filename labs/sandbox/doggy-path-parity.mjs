/**
 * Etapa 7: path fino Doggy vs lab nos eventos both (24–25).
 * Compara clip/cadence/residual/vacuum e testa ablações de params no lab.
 *
 * Usage:
 *   node labs/sandbox/doggy-path-parity.mjs [--days=2026-07-24,2026-07-25]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';
import { applyPolymarketFeesToBacktestResult } from '../../src/backtest/fees.js';

const OUT = path.resolve('.tmp/pair-ladder-re');
const args = new Set(process.argv.slice(2));
const daysArg = [...args].find((a) => a.startsWith('--days='));
const days = daysArg
  ? daysArg.slice('--days='.length).split(',').map((s) => s.trim()).filter(Boolean)
  : ['2026-07-24', '2026-07-25'];

fs.mkdirSync(OUT, { recursive: true });

function q(arr, p) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.floor((a.length - 1) * p)))];
}
function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}
function distStats(arr) {
  if (!arr.length) return null;
  return {
    n: arr.length,
    mean: mean(arr),
    med: q(arr, 0.5),
    p25: q(arr, 0.25),
    p75: q(arr, 0.75),
    p10: q(arr, 0.1),
    p90: q(arr, 0.9),
  };
}
function eventStartFromSlug(slug) {
  const m = String(slug || '').match(/btc-updown-5m-(\d+)/i);
  return m ? Number(m[1]) : null;
}
function utcDay(ts) {
  return new Date(Number(ts) * 1000).toISOString().slice(0, 10);
}
function toIso(v) {
  return v instanceof Date ? v.toISOString() : String(v);
}
function round1(x) {
  return x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10;
}
function round3(x) {
  return x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000;
}

const code = fs.readFileSync('labs/legacy/strategy-runners/portable/pair-ladder-complete-set-runner.js', 'utf8');
const exp = new Function(`${code}\nreturn __pairLadderCompleteSetExports;`)();

const BASE_LAB = {
  fillMode: 'taker',
  spreadCents: 0,
  slippageCents: -1,
  seedHedgeSameTick: false,
  forbidOverweight: true,
  softLockAllowVacuum: true,
  softLockAllowBuild: true,
  hedgePreferAsk: 0.5,
  minSecToHedge: 5,
  hedgeTargetAvgSum: 0.99,
  maxResidualShares: 150,
  maxEventNotional: 350,
  maxFillsPerEvent: 12,
  maxSharesPerSide: 500,
  refuseAvgSum: 1.0,
  stopAvgSum: 0.95,
  stopMinBalance: 0.9,
  openMinAsk: 0.45,
  openMaxAsk: 0.58,
  maxSecToOpen: 30,
  openShares: 50,
  hedgeShares: 100,
  clipShares: 100,
  lateClipShares: 50,
  lateStartSec: 180,
  lateMaxAsk: 0.15,
};

function buildDoggyPath(rows) {
  const trades = rows.filter((r) => r.type === 'TRADE' && r.side === 'BUY' && /btc-updown-5m/i.test(r.slug || ''));
  const redeems = rows.filter((r) => r.type === 'REDEEM' && /btc-updown-5m/i.test(r.slug || ''));
  const redeemBy = new Map();
  for (const r of redeems) {
    if (!redeemBy.has(r.slug)) redeemBy.set(r.slug, { usdc: 0, outcome: r.outcome });
    const x = redeemBy.get(r.slug);
    x.usdc += r.usdcSize || 0;
    x.outcome = r.outcome || x.outcome;
  }
  const bySlug = new Map();
  for (const t of trades) {
    const d = utcDay(t.timestamp);
    if (!days.includes(d)) continue;
    if (!bySlug.has(t.slug)) bySlug.set(t.slug, []);
    bySlug.get(t.slug).push({
      ts: t.timestamp,
      price: t.price,
      size: t.size,
      outcome: String(t.outcome || '').toLowerCase().includes('up') ? 'Up' : 'Down',
      usdc: t.usdcSize,
    });
  }
  const events = new Map();
  for (const [slug, fills] of bySlug) {
    fills.sort((a, b) => a.ts - b.ts || a.price - b.price);
    const start = eventStartFromSlug(slug);
    let upS = 0;
    let downS = 0;
    let upC = 0;
    let downC = 0;
    let dualSec = null;
    let firstUnderSec = null;
    let lateCheapShares = 0;
    let lateCheapFills = 0;
    let expensiveFills = 0;
    const gaps = [];
    for (let i = 0; i < fills.length; i += 1) {
      const f = fills[i];
      if (i > 0) gaps.push(f.ts - fills[i - 1].ts);
      if (f.outcome === 'Up') {
        upS += f.size;
        upC += f.price * f.size;
      } else {
        downS += f.size;
        downC += f.price * f.size;
      }
      if (dualSec == null && upS > 0 && downS > 0 && start != null) dualSec = f.ts - start;
      const sec = start != null ? f.ts - start : null;
      if (sec != null && sec >= 180 && f.price <= 0.15) {
        lateCheapShares += f.size;
        lateCheapFills += 1;
      }
      if (f.price >= 0.70) expensiveFills += 1;
      // first post-dual underweight buy (size toward residual)
      if (dualSec != null && firstUnderSec == null && i > 0) {
        const heavy = upS >= downS ? 'Up' : 'Down';
        if (f.outcome !== heavy) firstUnderSec = sec;
      }
    }
    const bal = Math.min(upS, downS);
    const avgUp = upS > 0 ? upC / upS : null;
    const avgDown = downS > 0 ? downC / downS : null;
    const redeem = redeemBy.get(slug);
    const buyUsdc = fills.reduce((s, f) => s + (f.usdc || f.price * f.size), 0);
    const sizes = fills.map((f) => f.size);
    events.set(slug, {
      slug,
      start,
      day: start != null ? utcDay(start) : null,
      nFills: fills.length,
      firstSize: fills[0]?.size ?? null,
      firstPx: fills[0]?.price ?? null,
      medClip: q(sizes.slice(1), 0.5) ?? q(sizes, 0.5),
      totalShares: upS + downS,
      upShares: upS,
      downShares: downS,
      buyUsdc,
      avgSum: avgUp != null && avgDown != null ? avgUp + avgDown : null,
      balance: Math.max(upS, downS) > 0 ? bal / Math.max(upS, downS) : 0,
      residual: Math.abs(upS - downS),
      residualSide: upS > downS ? 'Up' : downS > upS ? 'Down' : null,
      dualSec,
      secFirst: start != null && fills[0] ? fills[0].ts - start : null,
      secLast: start != null && fills.length ? fills[fills.length - 1].ts - start : null,
      spanSec: fills.length >= 2 ? fills[fills.length - 1].ts - fills[0].ts : 0,
      medGap: q(gaps, 0.5),
      lateCheapShares,
      lateCheapFills,
      expensiveFills,
      pnl: redeem ? redeem.usdc - buyUsdc : null,
      winner: redeem?.outcome || null,
      residualOnWinner: (() => {
        if (!redeem?.outcome || upS === downS) return null;
        const w = String(redeem.outcome).toLowerCase().includes('up') ? 'Up' : 'Down';
        const heavy = upS > downS ? 'Up' : 'Down';
        return heavy === w;
      })(),
    });
  }
  return events;
}

function summarizeLabEvent(e) {
  const start = e.eventStart ? Math.floor(Date.parse(e.eventStart) / 1000) : null;
  if (start == null) return null;
  const slug = `btc-updown-5m-${start}`;
  const fills = Array.isArray(e.fills) ? [...e.fills].sort((a, b) => String(a.time).localeCompare(String(b.time))) : [];
  const startMs = start * 1000;
  let dualSec = null;
  let upS = 0;
  let downS = 0;
  let lateCheapShares = 0;
  let lateCheapFills = 0;
  let expensiveFills = 0;
  const gaps = [];
  const sizes = [];
  let prevTs = null;
  for (const f of fills) {
    const tsMs = Date.parse(String(f.time));
    const sec = Number.isFinite(tsMs) ? (tsMs - startMs) / 1000 : null;
    const side = String(f.side || '').toUpperCase() === 'UP' ? 'Up' : 'Down';
    const qty = Number(f.qty) || 0;
    const px = Number(f.price);
    sizes.push(qty);
    if (prevTs != null && Number.isFinite(tsMs)) gaps.push((tsMs - prevTs) / 1000);
    if (Number.isFinite(tsMs)) prevTs = tsMs;
    if (side === 'Up') upS += qty;
    else downS += qty;
    if (dualSec == null && upS > 0 && downS > 0 && sec != null) dualSec = sec;
    if (sec != null && sec >= 180 && px <= 0.15) {
      lateCheapShares += qty;
      lateCheapFills += 1;
    }
    if (px >= 0.70) expensiveFills += 1;
  }
  const vacuumFills = fills.filter((f) => String(f.source || '').startsWith('vacuum')).length;
  return {
    slug,
    start,
    entered: e.reason !== 'no_entry',
    reason: e.reason,
    nFills: e.fillCount ?? fills.length,
    firstSize: sizes[0] ?? null,
    medClip: q(sizes.slice(1), 0.5) ?? q(sizes, 0.5),
    totalShares: (e.upShares || 0) + (e.downShares || 0),
    upShares: e.upShares ?? upS,
    downShares: e.downShares ?? downS,
    buyUsdc: e.cost ?? null,
    avgSum: e.avgSum ?? null,
    balance: e.balance ?? null,
    residual: e.residual ?? null,
    dualSec,
    secFirst: fills[0] ? (Date.parse(String(fills[0].time)) - startMs) / 1000 : null,
    secLast: fills.length ? (Date.parse(String(fills[fills.length - 1].time)) - startMs) / 1000 : null,
    spanSec: fills.length >= 2
      ? (Date.parse(String(fills[fills.length - 1].time)) - Date.parse(String(fills[0].time))) / 1000
      : 0,
    medGap: q(gaps, 0.5),
    lateCheapShares,
    lateCheapFills,
    expensiveFills,
    vacuumFills,
    locked: e.locked ?? false,
    lockReason: e.lockReason ?? null,
    pnl: e.finalPnl ?? null,
    pnlBeforeFees: e.finalPnlBeforeFees ?? null,
  };
}

async function loadTicks(day) {
  const dir = path.resolve(`lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=${day}`);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.parquet')).map((f) => path.join(dir, f));
  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  const pql = `[${files.map((f) => quotedString(f)).join(',')}]`;
  return (await c.runAndReadAll(`
    SELECT ts, event_start, event_end, condition_id, underlying_price, price_to_beat, coverage,
           up_best_ask, up_best_bid, down_best_ask, down_best_bid
    FROM read_parquet(${pql})
    WHERE coverage >= 0.99
    ORDER BY ts
  `)).getRowObjectsJS();
}

function runLab(ticks, params) {
  const runner = exp.createBacktestRunner({ ...params });
  for (const t of ticks) {
    runner.processTick({
      ts: toIso(t.ts),
      event_start: toIso(t.event_start),
      event_end: toIso(t.event_end),
      condition_id: t.condition_id,
      btc_price: Number(t.underlying_price),
      price_to_beat: Number(t.price_to_beat),
      coverage: Number(t.coverage),
      degraded: false,
      up_best_ask: Number(t.up_best_ask),
      up_best_bid: Number(t.up_best_bid),
      down_best_ask: Number(t.down_best_ask),
      down_best_bid: Number(t.down_best_bid),
    });
  }
  const res = runner.finish();
  applyPolymarketFeesToBacktestResult(res, { category: 'crypto', takerRebateRate: 0.44 });
  const bySlug = new Map();
  for (const e of res.events) {
    const s = summarizeLabEvent(e);
    if (s) bySlug.set(s.slug, s);
  }
  return { res, bySlug, summary: res.summary };
}

function pairCompare(dog, lab) {
  return {
    slug: dog.slug,
    doggyPnl: dog.pnl,
    labPnl: lab.pnl,
    delta: lab.pnl != null && dog.pnl != null ? lab.pnl - dog.pnl : null,
    doggyAvg: dog.avgSum,
    labAvg: lab.avgSum,
    avgDelta: lab.avgSum != null && dog.avgSum != null ? lab.avgSum - dog.avgSum : null,
    doggyFills: dog.nFills,
    labFills: lab.nFills,
    doggyShares: dog.totalShares,
    labShares: lab.totalShares,
    sharesRatio: dog.totalShares > 0 ? lab.totalShares / dog.totalShares : null,
    doggyRes: dog.residual,
    labRes: lab.residual,
    doggyBal: dog.balance,
    labBal: lab.balance,
    doggyDualSec: dog.dualSec,
    labDualSec: lab.dualSec,
    doggyLate: dog.lateCheapShares,
    labLate: lab.lateCheapShares,
    doggyLateFills: dog.lateCheapFills,
    labLateFills: lab.lateCheapFills,
    doggyExpensive: dog.expensiveFills,
    labExpensive: lab.expensiveFills,
    doggySpan: dog.spanSec,
    labSpan: lab.spanSec,
    doggyFirstSize: dog.firstSize,
    labFirstSize: lab.firstSize,
    doggyMedClip: dog.medClip,
    labMedClip: lab.medClip,
    doggyBuyUsdc: dog.buyUsdc,
    labBuyUsdc: lab.buyUsdc,
    residualOnWinner: dog.residualOnWinner,
    labVacuum: lab.vacuumFills,
    labLocked: lab.locked,
  };
}

async function main() {
  const activity = JSON.parse(fs.readFileSync(path.join(OUT, 'doggy-activity-fresh.json'), 'utf8'));
  const doggyBySlug = buildDoggyPath(activity);

  const ticksByDay = new Map();
  for (const day of days) {
    process.stdout.write(`load ${day}\n`);
    ticksByDay.set(day, await loadTicks(day));
  }

  // Baseline lab
  const labBySlug = new Map();
  let baselineSummary = { totalPnl: 0, entries: 0 };
  for (const day of days) {
    process.stdout.write(`lab baseline ${day}\n`);
    const { bySlug, summary } = runLab(ticksByDay.get(day), BASE_LAB);
    for (const [slug, e] of bySlug) labBySlug.set(slug, e);
    baselineSummary.totalPnl += summary.totalPnl || 0;
    baselineSummary.entries += summary.totalEntries || 0;
  }

  const both = [];
  for (const [slug, dog] of doggyBySlug) {
    const lab = labBySlug.get(slug);
    if (!lab?.entered || dog.pnl == null || lab.pnl == null) continue;
    both.push(pairCompare(dog, lab));
  }

  const keys = [
    'doggyPnl', 'labPnl', 'delta',
    'doggyAvg', 'labAvg', 'avgDelta',
    'doggyFills', 'labFills',
    'doggyShares', 'labShares', 'sharesRatio',
    'doggyRes', 'labRes',
    'doggyBal', 'labBal',
    'doggyDualSec', 'labDualSec',
    'doggyLate', 'labLate',
    'doggyLateFills', 'labLateFills',
    'doggyExpensive', 'labExpensive',
    'doggySpan', 'labSpan',
    'doggyBuyUsdc', 'labBuyUsdc',
    'labVacuum',
  ];
  const pathStats = {};
  for (const k of keys) pathStats[k] = distStats(both.map((r) => r[k]).filter((x) => x != null && Number.isFinite(x)));

  // Bucket by lab−Doggy delta
  const worse = both.filter((r) => r.delta != null && r.delta < -10);
  const close = both.filter((r) => r.delta != null && Math.abs(r.delta) <= 5);
  const better = both.filter((r) => r.delta != null && r.delta > 5);
  function bucketStats(rows) {
    return {
      n: rows.length,
      medDelta: q(rows.map((r) => r.delta), 0.5),
      medDoggyShares: q(rows.map((r) => r.doggyShares), 0.5),
      medLabShares: q(rows.map((r) => r.labShares), 0.5),
      medSharesRatio: q(rows.map((r) => r.sharesRatio).filter((x) => x != null), 0.5),
      medDoggyAvg: q(rows.map((r) => r.doggyAvg).filter((x) => x != null), 0.5),
      medLabAvg: q(rows.map((r) => r.labAvg).filter((x) => x != null), 0.5),
      medDoggyFills: q(rows.map((r) => r.doggyFills), 0.5),
      medLabFills: q(rows.map((r) => r.labFills), 0.5),
      medDoggyLate: q(rows.map((r) => r.doggyLate), 0.5),
      medLabLate: q(rows.map((r) => r.labLate), 0.5),
      medDoggyRes: q(rows.map((r) => r.doggyRes), 0.5),
      medLabRes: q(rows.map((r) => r.labRes), 0.5),
      residualOnWinnerRate: (() => {
        const xs = rows.filter((r) => r.residualOnWinner != null);
        return xs.length ? xs.filter((r) => r.residualOnWinner).length / xs.length : null;
      })(),
      sumDoggy: rows.reduce((s, r) => s + (r.doggyPnl || 0), 0),
      sumLab: rows.reduce((s, r) => s + (r.labPnl || 0), 0),
    };
  }

  // Correlations (rank-ish via Spearman-lite: sort indices)
  function corr(xs, ys) {
    const pts = [];
    for (let i = 0; i < xs.length; i += 1) {
      if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pts.push([xs[i], ys[i]]);
    }
    if (pts.length < 10) return null;
    const n = pts.length;
    const mx = mean(pts.map((p) => p[0]));
    const my = mean(pts.map((p) => p[1]));
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (const [x, y] of pts) {
      num += (x - mx) * (y - my);
      dx += (x - mx) ** 2;
      dy += (y - my) ** 2;
    }
    const den = Math.sqrt(dx * dy);
    return den > 0 ? num / den : null;
  }
  const drivers = [
    { name: 'avgDelta vs delta', r: corr(both.map((r) => r.avgDelta), both.map((r) => r.delta)) },
    { name: 'sharesRatio vs delta', r: corr(both.map((r) => r.sharesRatio), both.map((r) => r.delta)) },
    { name: 'labLate−doggyLate vs delta', r: corr(both.map((r) => (r.labLate ?? 0) - (r.doggyLate ?? 0)), both.map((r) => r.delta)) },
    { name: 'labFills−doggyFills vs delta', r: corr(both.map((r) => r.labFills - r.doggyFills), both.map((r) => r.delta)) },
    { name: 'labRes−doggyRes vs delta', r: corr(both.map((r) => (r.labRes ?? 0) - (r.doggyRes ?? 0)), both.map((r) => r.delta)) },
    { name: 'labAvg vs delta', r: corr(both.map((r) => r.labAvg), both.map((r) => r.delta)) },
    { name: 'labBuyUsdc vs delta', r: corr(both.map((r) => r.labBuyUsdc), both.map((r) => r.delta)) },
  ].map((d) => ({ ...d, r: d.r != null ? round3(d.r) : null }))
    .sort((a, b) => Math.abs(b.r || 0) - Math.abs(a.r || 0));

  // Ablation grid on full days (not just both) — measure total PnL + both-only PnL
  const ablations = [
    { name: 'baseline', params: {} },
    { name: 'maxFills_8', params: { maxFillsPerEvent: 8 } },
    { name: 'maxFills_12', params: { maxFillsPerEvent: 12 } },
    { name: 'maxFills_24', params: { maxFillsPerEvent: 24 } },
    { name: 'notional_300', params: { maxEventNotional: 300 } },
    { name: 'notional_400', params: { maxEventNotional: 400 } },
    { name: 'notional_800', params: { maxEventNotional: 800 } },
    { name: 'sharesSide_400', params: { maxSharesPerSide: 400 } },
    { name: 'clip_50', params: { clipShares: 50, hedgeShares: 50 } },
    { name: 'lateClip_100', params: { lateClipShares: 100 } },
    { name: 'lateStart_150', params: { lateStartSec: 150 } },
    { name: 'refuse_0.98', params: { refuseAvgSum: 0.98 } },
    { name: 'stopBal_0.95', params: { stopMinBalance: 0.95 } },
    { name: 'noSoftBuild', params: { softLockAllowBuild: false } },
    { name: 'noSoftVacuum', params: { softLockAllowVacuum: false } },
    { name: 'residual_80', params: { maxResidualShares: 80 } },
    { name: 'residual_200', params: { maxResidualShares: 200 } },
    { name: 'compact_doggyish', params: {
      maxFillsPerEvent: 12,
      maxEventNotional: 400,
      maxSharesPerSide: 500,
      maxResidualShares: 100,
      lateClipShares: 50,
    } },
  ];

  const ablationResults = [];
  for (const abl of ablations) {
    process.stdout.write(`ablation ${abl.name}\n`);
    let totalPnl = 0;
    let entries = 0;
    let bothPnl = 0;
    let bothN = 0;
    const merged = new Map();
    for (const day of days) {
      const { bySlug, summary } = runLab(ticksByDay.get(day), { ...BASE_LAB, ...abl.params });
      for (const [slug, e] of bySlug) merged.set(slug, e);
      totalPnl += summary.totalPnl || 0;
      entries += summary.totalEntries || 0;
    }
    for (const [slug, dog] of doggyBySlug) {
      const lab = merged.get(slug);
      if (!lab?.entered || dog.pnl == null || lab.pnl == null) continue;
      bothPnl += lab.pnl;
      bothN += 1;
    }
    ablationResults.push({
      name: abl.name,
      params: abl.params,
      totalPnl,
      entries,
      bothPnl,
      bothN,
      bothMedDelta: (() => {
        const deltas = [];
        for (const [slug, dog] of doggyBySlug) {
          const lab = merged.get(slug);
          if (!lab?.entered || dog.pnl == null || lab.pnl == null) continue;
          deltas.push(lab.pnl - dog.pnl);
        }
        return q(deltas, 0.5);
      })(),
    });
  }
  ablationResults.sort((a, b) => b.bothPnl - a.bothPnl);

  const rules = [];
  rules.push(`Both overlap n=${both.length} · Σ Doggy=${round1(both.reduce((s, r) => s + r.doggyPnl, 0))} · Σ lab=${round1(both.reduce((s, r) => s + r.labPnl, 0))} · med Δ=${round1(q(both.map((r) => r.delta), 0.5))}.`);
  rules.push(`Shares: Doggy med ${round1(pathStats.doggyShares?.med)} vs lab med ${round1(pathStats.labShares?.med)} (ratio med ${round3(pathStats.sharesRatio?.med)}).`);
  rules.push(`Fills: Doggy med ${pathStats.doggyFills?.med} vs lab med ${pathStats.labFills?.med}.`);
  rules.push(`avgSum: Doggy med ${round3(pathStats.doggyAvg?.med)} vs lab med ${round3(pathStats.labAvg?.med)} (Δ med ${round3(pathStats.avgDelta?.med)}).`);
  rules.push(`Late vacuum sh: Doggy med ${round1(pathStats.doggyLate?.med)} vs lab med ${round1(pathStats.labLate?.med)}.`);
  rules.push(`Residual: Doggy med ${round1(pathStats.doggyRes?.med)} vs lab med ${round1(pathStats.labRes?.med)}.`);
  if (drivers[0]) rules.push(`Driver top corr(|r|): ${drivers[0].name} r=${drivers[0].r}.`);
  const bestAbl = ablationResults[0];
  const baseAbl = ablationResults.find((a) => a.name === 'baseline');
  if (bestAbl && baseAbl) {
    rules.push(`Melhor ablação both-PnL: ${bestAbl.name} → ${round1(bestAbl.bothPnl)} (baseline ${round1(baseAbl.bothPnl)}, Δ ${round1(bestAbl.bothPnl - baseAbl.bothPnl)}).`);
  }
  rules.push('Promoção só se ablação material e estável; senão path ainda incompleto (fill/timing intra-segundo).');

  const summary = {
    asOf: new Date().toISOString(),
    days,
    baseLab: BASE_LAB,
    baselineSummary,
    bothN: both.length,
    bothSums: {
      doggy: both.reduce((s, r) => s + r.doggyPnl, 0),
      lab: both.reduce((s, r) => s + r.labPnl, 0),
      medDelta: q(both.map((r) => r.delta), 0.5),
      meanDelta: mean(both.map((r) => r.delta)),
    },
    pathStats,
    buckets: {
      worse_lt_m10: bucketStats(worse),
      close_abs_le_5: bucketStats(close),
      better_gt_5: bucketStats(better),
    },
    drivers,
    ablations: ablationResults,
    inferredRules: rules,
    sampleWorse: worse.sort((a, b) => a.delta - b.delta).slice(0, 8).map((r) => ({
      slug: r.slug,
      delta: round1(r.delta),
      doggyPnl: round1(r.doggyPnl),
      labPnl: round1(r.labPnl),
      doggyAvg: round3(r.doggyAvg),
      labAvg: round3(r.labAvg),
      doggyShares: round1(r.doggyShares),
      labShares: round1(r.labShares),
      doggyFills: r.doggyFills,
      labFills: r.labFills,
      doggyLate: round1(r.doggyLate),
      labLate: round1(r.labLate),
      doggyRes: round1(r.doggyRes),
      labRes: round1(r.labRes),
    })),
    sampleClose: close.slice(0, 5),
  };

  const canvas = {
    asOf: summary.asOf,
    days,
    bothN: both.length,
    bothSums: {
      doggy: Math.round(summary.bothSums.doggy),
      lab: Math.round(summary.bothSums.lab),
      medDelta: round1(summary.bothSums.medDelta),
    },
    pathMed: {
      shares: { doggy: round1(pathStats.doggyShares?.med), lab: round1(pathStats.labShares?.med) },
      fills: { doggy: pathStats.doggyFills?.med, lab: pathStats.labFills?.med },
      avg: { doggy: round3(pathStats.doggyAvg?.med), lab: round3(pathStats.labAvg?.med) },
      late: { doggy: round1(pathStats.doggyLate?.med), lab: round1(pathStats.labLate?.med) },
      residual: { doggy: round1(pathStats.doggyRes?.med), lab: round1(pathStats.labRes?.med) },
      dualSec: { doggy: round1(pathStats.doggyDualSec?.med), lab: round1(pathStats.labDualSec?.med) },
      buyUsdc: { doggy: round1(pathStats.doggyBuyUsdc?.med), lab: round1(pathStats.labBuyUsdc?.med) },
    },
    buckets: {
      worse: summary.buckets.worse_lt_m10,
      close: summary.buckets.close_abs_le_5,
      better: summary.buckets.better_gt_5,
    },
    drivers: drivers.slice(0, 6),
    ablationTop: ablationResults.slice(0, 8).map((a) => ({
      name: a.name,
      bothPnl: Math.round(a.bothPnl),
      totalPnl: Math.round(a.totalPnl),
      bothMedDelta: round1(a.bothMedDelta),
      entries: a.entries,
    })),
    rules,
  };

  fs.writeFileSync(path.join(OUT, 'doggy-path-parity.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, 'doggy-path-parity-canvas.json'), JSON.stringify(canvas, null, 2));
  fs.writeFileSync(path.join(OUT, 'doggy-path-parity-both.json'), JSON.stringify(both, null, 2));

  console.log(JSON.stringify({
    bothN: both.length,
    bothSums: summary.bothSums,
    pathMed: canvas.pathMed,
    buckets: {
      worse: summary.buckets.worse_lt_m10,
      close: summary.buckets.close_abs_le_5,
      better: summary.buckets.better_gt_5,
    },
    drivers: drivers.slice(0, 6),
    ablationTop: canvas.ablationTop,
    rules,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
