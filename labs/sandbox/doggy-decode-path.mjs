/**
 * Decode Doggy Clip Ladder from activity + optional lake join.
 * Usage: node labs/sandbox/doggy-decode-path.mjs [--fetch] [--lake-days=2026-07-20,2026-07-25]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const WALLET = '0x0484e64092ba4108c2786b61e6fc052d3bf41b1a';
const OUT = path.resolve('.tmp/pair-ladder-re');
const args = new Set(process.argv.slice(2));
const fetchMore = args.has('--fetch');
const lakeArg = [...args].find((a) => a.startsWith('--lake-days='));
const lakeDays = lakeArg
  ? lakeArg.slice('--lake-days='.length).split(',').map((s) => s.trim()).filter(Boolean)
  : ['2026-07-24', '2026-07-25'];

fs.mkdirSync(OUT, { recursive: true });

function q(arr, p) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.floor((a.length - 1) * p)))];
}

function feeCrypto(size, price) {
  return size * 0.07 * price * (1 - price);
}

function eventStartFromSlug(slug) {
  const m = String(slug || '').match(/btc-updown-5m-(\d+)/i);
  return m ? Number(m[1]) : null;
}

async function fetchActivity(limitPages = 40) {
  const all = [];
  const seen = new Set();
  for (let page = 0; page < limitPages; page += 1) {
    const offset = page * 100;
    const url = `https://data-api.polymarket.com/activity?user=${WALLET}&limit=100&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`activity ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    let novel = 0;
    for (const row of batch) {
      const key = `${row.type}|${row.transactionHash}|${row.timestamp}|${row.asset}|${row.size}|${row.price}|${row.usdcSize}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(row);
      novel += 1;
    }
    process.stdout.write(`fetch page ${page} +${novel} total ${all.length}\n`);
    if (batch.length < 100 || novel === 0) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  return all;
}

function loadActivity() {
  const fresh = path.join(OUT, 'doggy-activity-fresh.json');
  const legacy = path.join(OUT, 'doggystyie', 'activity.json');
  const candidates = [fresh, legacy].filter((p) => fs.existsSync(p));
  if (!candidates.length) throw new Error('no activity file');
  // prefer larger / fresher merge
  let merged = [];
  const seen = new Set();
  for (const file of candidates) {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const row of rows) {
      const key = `${row.type}|${row.transactionHash}|${row.timestamp}|${row.asset}|${row.size}|${row.price}|${row.usdcSize}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
  }
  return merged;
}

function buildEventLedger(rows) {
  const trades = rows.filter((r) => r.type === 'TRADE' && r.side === 'BUY' && /btc-updown-5m/i.test(r.slug || ''));
  const redeems = rows.filter((r) => r.type === 'REDEEM' && /btc-updown-5m/i.test(r.slug || ''));
  const rebates = rows.filter((r) => r.type === 'TAKER_REBATE');

  const bySlug = new Map();
  for (const t of trades) {
    if (!bySlug.has(t.slug)) {
      bySlug.set(t.slug, {
        slug: t.slug,
        fills: [],
        upS: 0,
        downS: 0,
        upCost: 0,
        downCost: 0,
        fees: 0,
        buyUsdc: 0,
      });
    }
    const e = bySlug.get(t.slug);
    const fee = (t.usdcSize ?? 0) - (t.price * t.size);
    const o = String(t.outcome || '').toLowerCase();
    const side = o.includes('up') ? 'Up' : 'Down';
    e.fills.push({
      ts: t.timestamp,
      price: t.price,
      size: t.size,
      outcome: side,
      usdc: t.usdcSize,
      fee,
    });
    if (side === 'Up') {
      e.upS += t.size;
      e.upCost += t.price * t.size;
    } else {
      e.downS += t.size;
      e.downCost += t.price * t.size;
    }
    e.fees += fee;
    e.buyUsdc += t.usdcSize;
  }

  const redeemBySlug = new Map();
  for (const r of redeems) {
    if (!redeemBySlug.has(r.slug)) redeemBySlug.set(r.slug, { usdc: 0, size: 0, outcome: r.outcome, n: 0 });
    const x = redeemBySlug.get(r.slug);
    x.usdc += r.usdcSize || 0;
    x.size += r.size || 0;
    x.outcome = r.outcome || x.outcome;
    x.n += 1;
  }

  const events = [];
  for (const e of bySlug.values()) {
    e.fills.sort((a, b) => a.ts - b.ts || a.price - b.price);
    const start = eventStartFromSlug(e.slug);
    const bal = Math.min(e.upS, e.downS);
    const avgUp = e.upS > 0 ? e.upCost / e.upS : null;
    const avgDown = e.downS > 0 ? e.downCost / e.downS : null;
    const avgSum = avgUp != null && avgDown != null ? avgUp + avgDown : null;
    const residual = Math.abs(e.upS - e.downS);
    const residualSide = e.upS > e.downS ? 'Up' : e.downS > e.upS ? 'Down' : null;
    const lockedPnl = avgSum != null ? bal * (1 - avgSum) : null;
    const redeem = redeemBySlug.get(e.slug) || null;
    const redeemUsdc = redeem?.usdc || 0;
    const pnl = redeem ? redeemUsdc - e.buyUsdc : null;
    const first = e.fills[0];
    const last = e.fills[e.fills.length - 1];
    const secIntoFirst = start != null && first ? first.ts - start : null;
    const secIntoLast = start != null && last ? last.ts - start : null;
    const sizes = e.fills.map((f) => Math.round(f.size * 100) / 100);
    const lateCheap = e.fills.filter((f) => {
      if (start == null) return false;
      const sec = f.ts - start;
      return sec >= 180 && f.price <= 0.15;
    }).length;
    const cheapFills = e.fills.filter((f) => f.price <= 0.20).length;
    const expensiveFills = e.fills.filter((f) => f.price >= 0.70).length;

    // running avgSum after each fill (both sides present)
    let ru = 0;
    let rd = 0;
    let cu = 0;
    let cd = 0;
    const pathAvg = [];
    for (const f of e.fills) {
      if (f.outcome === 'Up') {
        ru += f.size;
        cu += f.price * f.size;
      } else {
        rd += f.size;
        cd += f.price * f.size;
      }
      if (ru > 0 && rd > 0) {
        pathAvg.push({
          t: start != null ? f.ts - start : null,
          avgSum: cu / ru + cd / rd,
          bal: Math.min(ru, rd) / Math.max(ru, rd),
          residual: Math.abs(ru - rd),
        });
      }
    }

    // same-second dual (UP+DOWN within 1s)
    let sameSecPairs = 0;
    for (let i = 0; i < e.fills.length; i += 1) {
      for (let j = i + 1; j < e.fills.length; j += 1) {
        if (Math.abs(e.fills[j].ts - e.fills[i].ts) > 1) break;
        if (e.fills[i].outcome !== e.fills[j].outcome) sameSecPairs += 1;
      }
    }

    events.push({
      slug: e.slug,
      start,
      nFills: e.fills.length,
      upS: e.upS,
      downS: e.downS,
      avgUp,
      avgDown,
      avgSum,
      bal: Math.max(e.upS, e.downS) > 0 ? bal / Math.max(e.upS, e.downS) : 0,
      balShares: bal,
      residual,
      residualSide,
      fees: e.fees,
      buyUsdc: e.buyUsdc,
      redeemUsdc,
      redeemOutcome: redeem?.outcome || null,
      pnl,
      lockedPnl,
      residualPnlProxy: pnl != null && lockedPnl != null ? pnl - lockedPnl + e.fees : null,
      // residual contribution rough: total pnl - locked + fees back into residual bucket
      firstPrice: first?.price ?? null,
      firstSize: first?.size ?? null,
      firstOutcome: first?.outcome ?? null,
      secIntoFirst,
      secIntoLast,
      spanSec: secIntoFirst != null && secIntoLast != null ? secIntoLast - secIntoFirst : null,
      sizes,
      sizeSig: sizes.slice(0, 8).map((s) => Math.round(s)).join('-'),
      lateCheap,
      cheapFills,
      expensiveFills,
      sameSecPairs,
      pathAvgFinal: pathAvg.at(-1) || null,
      pathAvgMin: pathAvg.length ? Math.min(...pathAvg.map((p) => p.avgSum)) : null,
      fills: e.fills,
    });
  }

  events.sort((a, b) => (b.start || 0) - (a.start || 0));
  return {
    events,
    rebates: rebates.map((r) => ({ ts: r.timestamp, usdc: r.usdcSize })),
    nTrades: trades.length,
    nRedeems: redeems.length,
  };
}

function summarize(ledger) {
  const { events, rebates, nTrades, nRedeems } = ledger;
  const withRedeem = events.filter((e) => e.pnl != null);
  const dual = events.filter((e) => e.upS > 0 && e.downS > 0);
  const pnls = withRedeem.map((e) => e.pnl);
  const avgSums = dual.map((e) => e.avgSum).filter((x) => x != null);
  const firstPx = events.map((e) => e.firstPrice).filter((x) => x != null);
  const secFirst = events.map((e) => e.secIntoFirst).filter((x) => x != null);
  const fillsPer = events.map((e) => e.nFills);
  const notionals = events.map((e) => e.buyUsdc);
  const residuals = dual.map((e) => e.residual);
  const lateCheapN = events.filter((e) => e.lateCheap > 0).length;
  const sameSecN = events.filter((e) => e.sameSecPairs > 0).length;
  const win = withRedeem.filter((e) => e.pnl > 0).length;
  const loss = withRedeem.filter((e) => e.pnl < 0).length;
  const flat = withRedeem.filter((e) => e.pnl === 0).length;
  const totalPnl = pnls.reduce((s, x) => s + x, 0);
  const totalFees = events.reduce((s, e) => s + e.fees, 0);
  const totalLocked = dual.reduce((s, e) => s + (e.lockedPnl || 0), 0);
  const rebateUsd = rebates.reduce((s, r) => s + r.usdc, 0);

  const sigs = {};
  for (const e of events) sigs[e.sizeSig] = (sigs[e.sizeSig] || 0) + 1;
  const topSigs = Object.entries(sigs).sort((a, b) => b[1] - a[1]).slice(0, 12);

  // stop behavior: did they keep buying after avgSum crossed 1?
  let crossedThenBought = 0;
  let stoppedBelow95 = 0;
  for (const e of events) {
    let ru = 0;
    let rd = 0;
    let cu = 0;
    let cd = 0;
    let sawBelow95 = false;
    let sawAbove1 = false;
    for (const f of e.fills) {
      if (ru > 0 && rd > 0) {
        const a = cu / ru + cd / rd;
        if (a <= 0.95) sawBelow95 = true;
        if (a >= 1.0) sawAbove1 = true;
        if (sawBelow95 && a > 0.95) {
          /* continued after good lock */
        }
      }
      if (f.outcome === 'Up') {
        ru += f.size;
        cu += f.price * f.size;
      } else {
        rd += f.size;
        cd += f.price * f.size;
      }
    }
    if (sawAbove1 && e.nFills >= 3) crossedThenBought += 1;
    if (sawBelow95) stoppedBelow95 += 1;
  }

  // price buckets of fills
  const allFills = events.flatMap((e) => e.fills);
  const priceBuckets = {
    le10: allFills.filter((f) => f.price <= 0.1).length,
    le20: allFills.filter((f) => f.price <= 0.2).length,
    mid45_55: allFills.filter((f) => f.price >= 0.45 && f.price <= 0.55).length,
    ge70: allFills.filter((f) => f.price >= 0.7).length,
    ge85: allFills.filter((f) => f.price >= 0.85).length,
  };

  // opening rules
  const openInBand = firstPx.filter((p) => p >= 0.45 && p <= 0.55).length / Math.max(1, firstPx.length);
  const openEarly = secFirst.filter((s) => s >= 0 && s <= 30).length / Math.max(1, secFirst.length);

  // residual vs winner
  let residualWon = 0;
  let residualLost = 0;
  let residualFlat = 0;
  for (const e of withRedeem) {
    if (!e.residualSide || e.residual < 1) {
      residualFlat += 1;
      continue;
    }
    const winSide = String(e.redeemOutcome || '');
    if (winSide.toLowerCase().includes(e.residualSide.toLowerCase())) residualWon += 1;
    else residualLost += 1;
  }

  return {
    nEvents: events.length,
    nDual: dual.length,
    nWithRedeem: withRedeem.length,
    nTrades,
    nRedeems,
    pnl: {
      total: totalPnl,
      totalWithRebate: totalPnl + rebateUsd,
      rebateUsd,
      totalFees,
      totalLockedPnl: totalLocked,
      mean: withRedeem.length ? totalPnl / withRedeem.length : null,
      med: q(pnls, 0.5),
      p10: q(pnls, 0.1),
      p90: q(pnls, 0.9),
      winRate: withRedeem.length ? win / withRedeem.length : null,
      win,
      loss,
      flat,
    },
    avgSum: {
      med: q(avgSums, 0.5),
      p10: q(avgSums, 0.1),
      p90: q(avgSums, 0.9),
      fracLt1: avgSums.filter((x) => x < 1).length / Math.max(1, avgSums.length),
      fracLt095: avgSums.filter((x) => x < 0.95).length / Math.max(1, avgSums.length),
    },
    open: {
      firstPxMed: q(firstPx, 0.5),
      firstPxP10: q(firstPx, 0.1),
      firstPxP90: q(firstPx, 0.9),
      fracOpen45_55: openInBand,
      fracSec0_30: openEarly,
      secIntoMed: q(secFirst, 0.5),
      secIntoP90: q(secFirst, 0.9),
    },
    structure: {
      fillsMed: q(fillsPer, 0.5),
      fillsP90: q(fillsPer, 0.9),
      notionalMed: q(notionals, 0.5),
      notionalP90: q(notionals, 0.9),
      residualMed: q(residuals, 0.5),
      residualP90: q(residuals, 0.9),
      lateCheapEvents: lateCheapN,
      sameSecEvents: sameSecN,
      fracSameSec: sameSecN / Math.max(1, events.length),
      topSigs,
      priceBuckets,
      crossedAvgSum1ThenBought: crossedThenBought,
      eventsSawAvgSumBelow95: stoppedBelow95,
      residualWon,
      residualLost,
      residualFlatOrNone: residualFlat,
      residualWinRate: (residualWon + residualLost) > 0 ? residualWon / (residualWon + residualLost) : null,
    },
  };
}

async function joinLake(events, days) {
  const fills = [];
  for (const e of events) {
    for (const f of e.fills) {
      fills.push({
        slug: e.slug,
        fill_ts: f.ts,
        fill_px: f.price,
        size: f.size,
        outcome: f.outcome,
      });
    }
  }
  if (!fills.length) return null;

  const parquet = [];
  for (const day of days) {
    const dir = path.resolve(`lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=${day}`);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.parquet')) parquet.push(path.join(dir, name));
    }
  }
  if (!parquet.length) return { error: 'no parquet', days };

  const csvPath = path.join(OUT, 'doggy-decode-fills.csv');
  const lines = ['fill_ts,fill_px,size,outcome,slug'];
  for (const f of fills) {
    lines.push([f.fill_ts, f.fill_px, f.size, f.outcome, f.slug].join(','));
  }
  fs.writeFileSync(csvPath, lines.join('\n'));

  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  const pql = `[${parquet.map((f) => quotedString(f)).join(',')}]`;

  const sql = `
WITH fills AS (
  SELECT fill_ts::BIGINT AS fill_ts, fill_px::DOUBLE AS fill_px, size::DOUBLE AS size, outcome, slug
  FROM read_csv_auto(${quotedString(csvPath)}, header=true)
),
ticks AS (
  SELECT
    epoch(try_cast(ts AS TIMESTAMPTZ))::BIGINT AS ep,
    up_best_ask, up_best_bid, down_best_ask, down_best_bid
  FROM read_parquet(${pql})
  WHERE coverage >= 0.99
    AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
),
best AS (
  SELECT
    f.fill_ts, f.fill_px, f.size, f.outcome, f.slug,
    CASE WHEN f.outcome = 'Up' THEN t.up_best_ask ELSE t.down_best_ask END AS ask,
    CASE WHEN f.outcome = 'Up' THEN t.up_best_bid ELSE t.down_best_bid END AS bid,
    abs(t.ep - f.fill_ts) AS dsec
  FROM fills f
  JOIN ticks t ON abs(t.ep - f.fill_ts) <= 1
  QUALIFY row_number() OVER (
    PARTITION BY f.fill_ts, f.slug, f.outcome, f.size, f.fill_px
    ORDER BY abs(t.ep - f.fill_ts)
  ) = 1
)
SELECT
  count(*)::BIGINT AS n,
  round(avg(dsec), 3) AS mean_dsec,
  round(avg(fill_px - ask), 5) AS mean_vs_ask,
  round(approx_quantile(fill_px - ask, 0.5), 5) AS med_vs_ask,
  round(approx_quantile(fill_px - ask, 0.1), 5) AS p10_vs_ask,
  round(approx_quantile(fill_px - ask, 0.9), 5) AS p90_vs_ask,
  round(avg(fill_px - bid), 5) AS mean_vs_bid,
  sum(CASE WHEN fill_px >= ask - 0.001 THEN 1 ELSE 0 END)::BIGINT AS at_or_above_ask,
  sum(CASE WHEN fill_px <= bid + 0.001 THEN 1 ELSE 0 END)::BIGINT AS at_or_below_bid,
  sum(CASE WHEN fill_px > ask + 0.01 THEN 1 ELSE 0 END)::BIGINT AS walk_gt_1c,
  sum(CASE WHEN fill_px < ask - 0.01 THEN 1 ELSE 0 END)::BIGINT AS better_than_ask_1c,
  round(avg(ask - bid), 5) AS mean_spread
FROM best
WHERE ask IS NOT NULL AND bid IS NOT NULL
`;
  const summary = (await c.runAndReadAll(sql)).getRowObjectsJS()[0];
  // coerce bigints
  const clean = {};
  for (const [k, v] of Object.entries(summary)) clean[k] = typeof v === 'bigint' ? Number(v) : v;
  return { days, matched: clean };
}

function inferRules(summary, sampleEvents) {
  return {
    execution: 'taker (100% crypto fee on fills; TAKER_REBATE present)',
    sizing: 'discrete clips ~50 then 100; signature 50-100-100… dominant',
    open: {
      priceBand: '~0.45–0.60 (median ~0.51)',
      timing: 'often early in window (first 30s common)',
      observedFrac45_55: summary.open.fracOpen45_55,
      observedFracSec0_30: summary.open.fracSec0_30,
    },
    stop: {
      note: 'Doggy often continues past avgSum=1 (no hard refuseAvgSum like our lab)',
      crossedThenBought: summary.structure.crossedAvgSum1ThenBought,
      sawBelow95: summary.structure.eventsSawAvgSumBelow95,
    },
    vacuum: {
      lateCheapEvents: summary.structure.lateCheapEvents,
      cheapFillBucket: summary.structure.priceBuckets,
    },
    residual: {
      med: summary.structure.residualMed,
      winRateWhenImbalanced: summary.structure.residualWinRate,
      implication: 'residual is directional edge/noise on top of complete-set; not zero',
    },
    economics: {
      lockedAloneDoesNotCoverFees: summary.pnl.totalLockedPnl < summary.pnl.totalFees,
      rebateMaterial: summary.pnl.rebateUsd > 0,
      dayEdgeSources: ['locked when avgSum<1', 'residual redeem', 'taker rebate'],
    },
    labGapHypotheses: [
      'lab refuseAvgSum/scaleOnlyTowardLock too strict vs Doggy who keeps buying',
      'lab maxEventNotional 300 too small vs Doggy notionals',
      'lab spreadCents=1 worsens taker vs Doggy hitting ask',
      'without modeling taker rebate, lab understates high-volume taker PnL',
      'Doggy selection/skip of bad windows not yet replicated',
    ],
    exampleEvents: sampleEvents,
  };
}

async function main() {
  let rows;
  if (fetchMore) {
    const fetched = await fetchActivity(50);
    fs.writeFileSync(path.join(OUT, 'doggy-activity-fresh.json'), JSON.stringify(fetched));
    rows = fetched;
    // also merge with legacy if present
    const legacy = path.join(OUT, 'doggystyie', 'activity.json');
    if (fs.existsSync(legacy)) {
      const old = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      const seen = new Set(rows.map((r) => `${r.type}|${r.transactionHash}|${r.timestamp}|${r.asset}|${r.size}|${r.price}|${r.usdcSize}`));
      for (const r of old) {
        const key = `${r.type}|${r.transactionHash}|${r.timestamp}|${r.asset}|${r.size}|${r.price}|${r.usdcSize}`;
        if (!seen.has(key)) rows.push(r);
      }
    }
  } else {
    rows = loadActivity();
  }

  const ledger = buildEventLedger(rows);
  const summary = summarize(ledger);
  const lake = await joinLake(ledger.events, lakeDays);

  // top/bottom events for inspection
  const withPnl = ledger.events.filter((e) => e.pnl != null).sort((a, b) => b.pnl - a.pnl);
  const sampleEvents = {
    best: withPnl.slice(0, 5).map(slimEvent),
    worst: withPnl.slice(-5).map(slimEvent),
    typicalSig: ledger.events.filter((e) => e.sizeSig.startsWith('50-100')).slice(0, 3).map(slimEvent),
  };

  const rules = inferRules(summary, sampleEvents);

  // fee sanity on sample
  let feeErr = [];
  for (const e of ledger.events.slice(0, 50)) {
    for (const f of e.fills) {
      feeErr.push(Math.abs(f.fee - feeCrypto(f.size, f.price)));
    }
  }

  const out = {
    asOf: new Date().toISOString(),
    wallet: WALLET,
    sourceRows: rows.length,
    feeSanityMedianAbsErr: q(feeErr, 0.5),
    summary,
    lakeJoin: lake,
    rules,
  };

  fs.writeFileSync(path.join(OUT, 'doggy-decode.json'), JSON.stringify(out, null, 2));
  // lightweight events dump without full fills for size
  fs.writeFileSync(
    path.join(OUT, 'doggy-events-ledger.json'),
    JSON.stringify(ledger.events.map(slimEvent), null, 2),
  );

  console.log(JSON.stringify({
    events: summary.nEvents,
    trades: summary.nTrades,
    pnl: summary.pnl,
    avgSum: summary.avgSum,
    open: summary.open,
    structure: {
      fillsMed: summary.structure.fillsMed,
      notionalMed: summary.structure.notionalMed,
      residualMed: summary.structure.residualMed,
      topSigs: summary.structure.topSigs.slice(0, 5),
      residualWinRate: summary.structure.residualWinRate,
      lateCheapEvents: summary.structure.lateCheapEvents,
      sameSecFrac: summary.structure.fracSameSec,
    },
    lakeJoin: lake,
    feeSanityMedianAbsErr: out.feeSanityMedianAbsErr,
    out: path.join(OUT, 'doggy-decode.json'),
  }, null, 2));
}

function slimEvent(e) {
  return {
    slug: e.slug,
    nFills: e.nFills,
    avgSum: e.avgSum,
    bal: e.bal,
    residual: e.residual,
    residualSide: e.residualSide,
    fees: e.fees,
    buyUsdc: e.buyUsdc,
    redeemUsdc: e.redeemUsdc,
    redeemOutcome: e.redeemOutcome,
    pnl: e.pnl,
    lockedPnl: e.lockedPnl,
    firstPrice: e.firstPrice,
    firstOutcome: e.firstOutcome,
    secIntoFirst: e.secIntoFirst,
    secIntoLast: e.secIntoLast,
    sizeSig: e.sizeSig,
    lateCheap: e.lateCheap,
    sameSecPairs: e.sameSecPairs,
    pathAvgMin: e.pathAvgMin,
    pathAvgFinal: e.pathAvgFinal,
  };
}

await main();
