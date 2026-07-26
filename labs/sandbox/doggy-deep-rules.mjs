/**
 * Deep Doggy path rules: hedge trigger, residual tilt, late vacuum, stop behavior.
 * Usage: node labs/sandbox/doggy-deep-rules.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const OUT = path.resolve('.tmp/pair-ladder-re');
const WALLET = '0x0484e64092ba4108c2786b61e6fc052d3bf41b1a';

function q(arr, p) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.floor((a.length - 1) * p)))];
}
function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}
function eventStartFromSlug(slug) {
  const m = String(slug || '').match(/btc-updown-5m-(\d+)/i);
  return m ? Number(m[1]) : null;
}

const rows = JSON.parse(fs.readFileSync(path.join(OUT, 'doggy-activity-fresh.json'), 'utf8'));
const trades = rows.filter((r) => r.type === 'TRADE' && r.side === 'BUY' && /btc-updown-5m/i.test(r.slug || ''));
const redeems = rows.filter((r) => r.type === 'REDEEM' && /btc-updown-5m/i.test(r.slug || ''));

const redeemBySlug = new Map();
for (const r of redeems) {
  if (!redeemBySlug.has(r.slug)) redeemBySlug.set(r.slug, { usdc: 0, outcome: r.outcome });
  const x = redeemBySlug.get(r.slug);
  x.usdc += r.usdcSize || 0;
  x.outcome = r.outcome || x.outcome;
}

const bySlug = new Map();
for (const t of trades) {
  if (!bySlug.has(t.slug)) bySlug.set(t.slug, []);
  bySlug.get(t.slug).push({
    ts: t.timestamp,
    price: t.price,
    size: t.size,
    outcome: String(t.outcome || '').toLowerCase().includes('up') ? 'Up' : 'Down',
    usdc: t.usdcSize,
  });
}

const events = [];
for (const [slug, fills] of bySlug) {
  fills.sort((a, b) => a.ts - b.ts || a.price - b.price);
  const start = eventStartFromSlug(slug);
  let upS = 0; let downS = 0; let upC = 0; let downC = 0;
  const path = [];
  for (const f of fills) {
    if (f.outcome === 'Up') { upS += f.size; upC += f.price * f.size; }
    else { downS += f.size; downC += f.price * f.size; }
    const bal = Math.min(upS, downS);
    const avgSum = upS > 0 && downS > 0 ? upC / upS + downC / downS : null;
    path.push({
      ts: f.ts,
      sec: start != null ? f.ts - start : null,
      outcome: f.outcome,
      price: f.price,
      size: f.size,
      upS, downS, avgSum,
      residual: Math.abs(upS - downS),
      residualSide: upS > downS ? 'Up' : downS > upS ? 'Down' : null,
      balRatio: Math.max(upS, downS) > 0 ? bal / Math.max(upS, downS) : 0,
    });
  }
  const redeem = redeemBySlug.get(slug);
  const buyUsdc = fills.reduce((s, f) => s + f.usdc, 0);
  const avgUp = upS > 0 ? upC / upS : null;
  const avgDown = downS > 0 ? downC / downS : null;
  events.push({
    slug, start, fills, path,
    upS, downS, avgUp, avgDown,
    avgSum: avgUp != null && avgDown != null ? avgUp + avgDown : null,
    residual: Math.abs(upS - downS),
    residualSide: upS > downS ? 'Up' : downS > upS ? 'Down' : null,
    buyUsdc,
    redeemUsdc: redeem?.usdc ?? null,
    redeemOutcome: redeem?.outcome ?? null,
    pnl: redeem ? redeem.usdc - buyUsdc : null,
  });
}

// --- Hedge rule: first opposite fill ---
const hedgeStats = {
  n: 0,
  gapSec: [],
  firstPx: [],
  hedgePx: [],
  pairSum: [],
  hedgeCheaperThanFirst: 0,
  hedgeBelow55: 0,
  hedgeBelow50: 0,
  hedgeBelow45: 0,
  hedgeBelow40: 0,
  firstInBand: 0,
};

for (const e of events) {
  if (e.fills.length < 2) continue;
  const f0 = e.fills[0];
  const f1 = e.fills.find((f) => f.outcome !== f0.outcome);
  if (!f1) continue;
  hedgeStats.n += 1;
  const gap = f1.ts - f0.ts;
  hedgeStats.gapSec.push(gap);
  hedgeStats.firstPx.push(f0.price);
  hedgeStats.hedgePx.push(f1.price);
  hedgeStats.pairSum.push(f0.price + f1.price);
  if (f1.price < f0.price - 1e-9) hedgeStats.hedgeCheaperThanFirst += 1;
  if (f0.price >= 0.45 && f0.price <= 0.55) hedgeStats.firstInBand += 1;
  if (f1.price <= 0.55) hedgeStats.hedgeBelow55 += 1;
  if (f1.price <= 0.50) hedgeStats.hedgeBelow50 += 1;
  if (f1.price <= 0.45) hedgeStats.hedgeBelow45 += 1;
  if (f1.price <= 0.40) hedgeStats.hedgeBelow40 += 1;
}

// --- After dual: does he keep buying overweight or underweight? ---
const afterDual = { under: 0, over: 0, flat: 0, cheapUnder: 0, expensiveOver: 0 };
for (const e of events) {
  let dualIdx = -1;
  let seenUp = false; let seenDown = false;
  for (let i = 0; i < e.path.length; i += 1) {
    if (e.path[i].outcome === 'Up') seenUp = true;
    else seenDown = true;
    if (seenUp && seenDown) { dualIdx = i; break; }
  }
  if (dualIdx < 0) continue;
  for (let i = dualIdx + 1; i < e.path.length; i += 1) {
    const prev = e.path[i - 1];
    const cur = e.path[i];
    if (!prev.residualSide) { afterDual.flat += 1; continue; }
    if (cur.outcome !== prev.residualSide) {
      afterDual.under += 1; // buying underweight
      if (cur.price <= 0.40) afterDual.cheapUnder += 1;
    } else {
      afterDual.over += 1;
      if (cur.price >= 0.60) afterDual.expensiveOver += 1;
    }
  }
}

// --- Residual tilt vs final winner: when does imbalance appear? ---
const tilt = {
  earlyResidualWinner: 0, // residual side after first 60s matches winner
  midResidualWinner: 0,
  finalResidualWinner: 0,
  nEarly: 0, nMid: 0, nFinal: 0,
  // does he add to residual side when price of residual > 0.6 (momentum)?
  momAdds: 0, momN: 0,
  fadeAdds: 0, fadeN: 0,
};

for (const e of events) {
  if (!e.redeemOutcome || !e.path.length) continue;
  const win = String(e.redeemOutcome).toLowerCase().includes('up') ? 'Up' : 'Down';
  const at = (secMax) => {
    let last = null;
    for (const p of e.path) {
      if (p.sec != null && p.sec <= secMax) last = p;
    }
    return last;
  };
  const early = at(60);
  const mid = at(180);
  const fin = e.path.at(-1);
  if (early?.residualSide) {
    tilt.nEarly += 1;
    if (early.residualSide === win) tilt.earlyResidualWinner += 1;
  }
  if (mid?.residualSide) {
    tilt.nMid += 1;
    if (mid.residualSide === win) tilt.midResidualWinner += 1;
  }
  if (fin?.residualSide) {
    tilt.nFinal += 1;
    if (fin.residualSide === win) tilt.finalResidualWinner += 1;
  }

  for (let i = 1; i < e.path.length; i += 1) {
    const prev = e.path[i - 1];
    const cur = e.path[i];
    if (!prev.residualSide || prev.residual < 25) continue;
    if (cur.outcome === prev.residualSide) {
      // adding to overweight
      if (cur.price >= 0.60) { tilt.momN += 1; tilt.momAdds += 1; }
      if (cur.price <= 0.40) { tilt.fadeN += 1; /* adding expensive? weird */ }
    } else {
      // buying underweight
      if (cur.price <= 0.40) { tilt.fadeN += 1; tilt.fadeAdds += 1; }
      if (cur.price >= 0.60) { tilt.momN += 1; }
    }
  }
}

// --- Stop: after avgSum crosses below 0.95 / above 1.0, more buys? ---
const stopBehavior = {
  sawBelow95: 0,
  buysAfterBelow95: 0,
  sawAbove1: 0,
  buysAfterAbove1: 0,
  finalBelow95: 0,
  finalAbove1: 0,
  lockedThenScaled: 0,
};

for (const e of events) {
  let below95 = false;
  let above1 = false;
  let buysAfterLock = 0;
  for (const p of e.path) {
    if (p.avgSum == null) continue;
    if (below95 && p.avgSum > 0.95) buysAfterLock += 1;
    if (p.avgSum <= 0.95) {
      if (!below95) stopBehavior.sawBelow95 += 1;
      below95 = true;
    }
    if (p.avgSum >= 1.0) {
      if (!above1) stopBehavior.sawAbove1 += 1;
      above1 = true;
      // count subsequent fills while still trading
    }
  }
  if (below95) {
    const idx = e.path.findIndex((p) => p.avgSum != null && p.avgSum <= 0.95);
    if (idx >= 0 && idx < e.path.length - 1) stopBehavior.buysAfterBelow95 += 1;
    if (buysAfterLock > 0) stopBehavior.lockedThenScaled += 1;
  }
  if (above1) {
    const idx = e.path.findIndex((p) => p.avgSum != null && p.avgSum >= 1.0);
    if (idx >= 0 && idx < e.path.length - 1) stopBehavior.buysAfterAbove1 += 1;
  }
  if (e.avgSum != null && e.avgSum < 0.95) stopBehavior.finalBelow95 += 1;
  if (e.avgSum != null && e.avgSum >= 1.0) stopBehavior.finalAbove1 += 1;
}

// --- Late vacuum: fills after 180s with px<=0.15 ---
const vacuum = { events: 0, fills: 0, improvedAvg: 0, meanPx: [], sizes: [] };
for (const e of events) {
  const late = e.path.filter((p) => p.sec != null && p.sec >= 180 && p.price <= 0.15);
  if (!late.length) continue;
  vacuum.events += 1;
  vacuum.fills += late.length;
  for (const p of late) {
    vacuum.meanPx.push(p.price);
    vacuum.sizes.push(p.size);
  }
  const before = e.path.filter((p) => p.sec != null && p.sec < 180 && p.avgSum != null).at(-1);
  if (before && e.avgSum != null && e.avgSum < before.avgSum) vacuum.improvedAvg += 1;
}

// --- Join first+hedge vs lake ask (Jul 24-25) ---
let lakeHedge = null;
const days = ['2026-07-24', '2026-07-25'];
const parquet = [];
for (const day of days) {
  const dir = path.resolve(`lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=${day}`);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.parquet')) parquet.push(path.join(dir, name));
  }
}

if (parquet.length) {
  const pairs = [];
  for (const e of events) {
    if (!e.start || e.start < 1784900000) continue; // rough filter to jul24+
    if (e.fills.length < 2) continue;
    const f0 = e.fills[0];
    const f1 = e.fills.find((f) => f.outcome !== f0.outcome);
    if (!f1) continue;
    pairs.push({
      slug: e.slug,
      open_ts: f0.ts,
      open_px: f0.price,
      open_side: f0.outcome,
      hedge_ts: f1.ts,
      hedge_px: f1.price,
      hedge_side: f1.outcome,
      gap: f1.ts - f0.ts,
    });
  }
  const csv = path.join(OUT, 'doggy-hedge-pairs.csv');
  fs.writeFileSync(csv, ['open_ts,open_px,open_side,hedge_ts,hedge_px,hedge_side,gap,slug',
    ...pairs.map((p) => [p.open_ts, p.open_px, p.open_side, p.hedge_ts, p.hedge_px, p.hedge_side, p.gap, p.slug].join(','))].join('\n'));

  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  const pql = `[${parquet.map((f) => quotedString(f)).join(',')}]`;
  const sql = `
WITH pairs AS (
  SELECT * FROM read_csv_auto(${quotedString(csv)}, header=true)
),
ticks AS (
  SELECT epoch(try_cast(ts AS TIMESTAMPTZ))::BIGINT AS ep,
         up_best_ask, down_best_ask, up_best_bid, down_best_bid
  FROM read_parquet(${pql})
  WHERE coverage >= 0.99
),
joined AS (
  SELECT
    p.*,
    CASE WHEN p.open_side = 'Up' THEN o.up_best_ask ELSE o.down_best_ask END AS open_ask,
    CASE WHEN p.hedge_side = 'Up' THEN h.up_best_ask ELSE h.down_best_ask END AS hedge_ask,
    CASE WHEN p.hedge_side = 'Up' THEN h.down_best_ask ELSE h.up_best_ask END AS held_ask_at_hedge,
    CASE WHEN p.open_side = 'Up' THEN o.down_best_ask ELSE o.up_best_ask END AS opp_ask_at_open
  FROM pairs p
  JOIN ticks o ON abs(o.ep - p.open_ts) <= 1
  JOIN ticks h ON abs(h.ep - p.hedge_ts) <= 1
  QUALIFY row_number() OVER (PARTITION BY p.slug ORDER BY abs(o.ep-p.open_ts)+abs(h.ep-p.hedge_ts)) = 1
)
SELECT
  count(*)::BIGINT AS n,
  round(avg(open_px - open_ask),5) AS mean_open_vs_ask,
  round(avg(hedge_px - hedge_ask),5) AS mean_hedge_vs_ask,
  round(approx_quantile(hedge_px - hedge_ask, 0.5),5) AS med_hedge_vs_ask,
  round(avg(opp_ask_at_open),5) AS mean_opp_ask_at_open,
  round(avg(hedge_px),5) AS mean_hedge_px,
  round(avg(opp_ask_at_open - hedge_px),5) AS mean_opp_improve,
  round(approx_quantile(opp_ask_at_open - hedge_px, 0.5),5) AS med_opp_improve,
  sum(CASE WHEN hedge_px + 1e-9 < opp_ask_at_open THEN 1 ELSE 0 END)::BIGINT AS hedge_better_than_opp_at_open,
  sum(CASE WHEN open_px + hedge_px < 1.0 THEN 1 ELSE 0 END)::BIGINT AS pair_sum_lt1,
  round(avg(open_px + hedge_px),5) AS mean_pair_sum,
  round(approx_quantile(open_px + hedge_px, 0.5),5) AS med_pair_sum
FROM joined
WHERE open_ask IS NOT NULL AND hedge_ask IS NOT NULL
`;
  const row = (await c.runAndReadAll(sql)).getRowObjectsJS()[0];
  lakeHedge = {};
  for (const [k, v] of Object.entries(row)) lakeHedge[k] = typeof v === 'bigint' ? Number(v) : v;
}

const out = {
  asOf: new Date().toISOString(),
  wallet: WALLET,
  nEvents: events.length,
  hedge: {
    n: hedgeStats.n,
    gapSec: { med: q(hedgeStats.gapSec, 0.5), p10: q(hedgeStats.gapSec, 0.1), p90: q(hedgeStats.gapSec, 0.9), mean: mean(hedgeStats.gapSec) },
    firstPx: { med: q(hedgeStats.firstPx, 0.5), p10: q(hedgeStats.firstPx, 0.1), p90: q(hedgeStats.firstPx, 0.9) },
    hedgePx: { med: q(hedgeStats.hedgePx, 0.5), p10: q(hedgeStats.hedgePx, 0.1), p90: q(hedgeStats.hedgePx, 0.9) },
    pairSum: { med: q(hedgeStats.pairSum, 0.5), p10: q(hedgeStats.pairSum, 0.1), p90: q(hedgeStats.pairSum, 0.9), fracLt1: hedgeStats.pairSum.filter((x) => x < 1).length / hedgeStats.n },
    fracFirstInBand45_55: hedgeStats.firstInBand / hedgeStats.n,
    fracHedgeCheaperThanFirst: hedgeStats.hedgeCheaperThanFirst / hedgeStats.n,
    fracHedgeBelow55: hedgeStats.hedgeBelow55 / hedgeStats.n,
    fracHedgeBelow50: hedgeStats.hedgeBelow50 / hedgeStats.n,
    fracHedgeBelow45: hedgeStats.hedgeBelow45 / hedgeStats.n,
    fracHedgeBelow40: hedgeStats.hedgeBelow40 / hedgeStats.n,
  },
  afterDual,
  tilt: {
    earlyWinRate: tilt.nEarly ? tilt.earlyResidualWinner / tilt.nEarly : null,
    midWinRate: tilt.nMid ? tilt.midResidualWinner / tilt.nMid : null,
    finalWinRate: tilt.nFinal ? tilt.finalResidualWinner / tilt.nFinal : null,
    nEarly: tilt.nEarly, nMid: tilt.nMid, nFinal: tilt.nFinal,
    momAdds: tilt.momAdds, momN: tilt.momN,
    fadeAdds: tilt.fadeAdds, fadeN: tilt.fadeN,
  },
  stopBehavior,
  vacuum: {
    events: vacuum.events,
    fills: vacuum.fills,
    improvedAvgFrac: vacuum.events ? vacuum.improvedAvg / vacuum.events : null,
    pxMed: q(vacuum.meanPx, 0.5),
    sizeMed: q(vacuum.sizes, 0.5),
  },
  lakeHedge,
  inferredRules: [],
};

// Infer rules textually
out.inferredRules.push(`Open: buy ~50sh in 45-55¢ band within first ~30s (observed ${(out.hedge.fracFirstInBand45_55 * 100).toFixed(0)}% in band).`);
out.inferredRules.push(`Hedge: wait for opposite; median gap ${out.hedge.gapSec.med}s; hedge px med ${out.hedge.hedgePx.med}; pairSum med ${out.hedge.pairSum.med} (frac<1=${(out.hedge.pairSum.fracLt1 * 100).toFixed(0)}%).`);
out.inferredRules.push(`Hedge often cheaper than open (${(out.hedge.fracHedgeCheaperThanFirst * 100).toFixed(0)}%); ${(out.hedge.fracHedgeBelow45 * 100).toFixed(0)}% hedge ≤45¢.`);
out.inferredRules.push(`After dual: underweight buys ${afterDual.under} vs overweight ${afterDual.over} (prefer rebalance/chase under).`);
out.inferredRules.push(`Residual vs winner: early ${((out.tilt.earlyWinRate || 0) * 100).toFixed(0)}% · mid ${((out.tilt.midWinRate || 0) * 100).toFixed(0)}% · final ${((out.tilt.finalWinRate || 0) * 100).toFixed(0)}%.`);
out.inferredRules.push(`Stop soft: saw avgSum≤0.95 in ${stopBehavior.sawBelow95} events but continued in ${stopBehavior.buysAfterBelow95}; final≥1 in ${stopBehavior.finalAbove1}.`);
out.inferredRules.push(`Late vacuum: ${vacuum.events} events, ${vacuum.fills} fills ≤15¢ after 180s.`);
if (lakeHedge) {
  out.inferredRules.push(`Lake: opp ask improves by med ${lakeHedge.med_opp_improve} from open→hedge; hedge better than opp@open in ${lakeHedge.hedge_better_than_opp_at_open}/${lakeHedge.n}.`);
}

fs.writeFileSync(path.join(OUT, 'doggy-deep-rules.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
