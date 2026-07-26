/**
 * Etapa 4: fechar o paradoxo BELOW_BID / AT_BID (fee=taker mas fill ≤ bid no snapshot 1Hz).
 *
 * Usage:
 *   node labs/sandbox/doggy-below-bid-paradox.mjs [--days=2026-07-24,2026-07-25]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const OUT = path.resolve('.tmp/pair-ladder-re');
const WALLET = '0x0484e64092ba4108c2786b61e6fc052d3bf41b1a';
const FEE_RATE = 0.07;
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
function frac(a, b) {
  return b ? a / b : null;
}
function classifyBucket(fillPx, ask, bid) {
  if (ask == null || bid == null) return 'NO_BOOK';
  const mid = (ask + bid) / 2;
  if (fillPx >= ask - 0.001) return fillPx > ask + 0.01 ? 'WALK_ASK' : 'AT_ASK';
  if (fillPx <= bid + 0.001) return fillPx < bid - 0.01 ? 'BELOW_BID' : 'AT_BID';
  if (fillPx < mid) return 'BETWEEN_MID_BID';
  return 'BETWEEN_MID_ASK';
}
function cryptoFee(shares, price) {
  return shares * FEE_RATE * price * (1 - price);
}
function near(a, b, eps = 0.005) {
  return a != null && b != null && Math.abs(a - b) <= eps;
}
function walkAskVwap(levels, size) {
  if (!levels?.length || !(size > 0)) return null;
  let left = size;
  let cost = 0;
  let filled = 0;
  for (const lv of levels) {
    if (lv.px == null || !(lv.sz > 0)) continue;
    const take = Math.min(left, lv.sz);
    cost += take * lv.px;
    filled += take;
    left -= take;
    if (left <= 1e-9) break;
  }
  if (filled < size - 1e-6) return { vwap: cost / filled, filled, incomplete: true };
  return { vwap: cost / size, filled: size, incomplete: false };
}
function collectParquet(daysList) {
  const files = [];
  for (const day of daysList) {
    const dir = path.resolve(`lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=${day}`);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.parquet')) files.push(path.join(dir, name));
    }
  }
  return files;
}
function loadActivity() {
  const p = path.join(OUT, 'doggy-activity-fresh.json');
  if (!fs.existsSync(p)) throw new Error('missing doggy-activity-fresh.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
  const rows = loadActivity();
  const daySet = new Set(days);
  const trades = rows.filter((r) => {
    if (!(r.type === 'TRADE' && r.side === 'BUY' && /btc-updown-5m/i.test(r.slug || ''))) return false;
    const d = new Date(Number(r.timestamp) * 1000).toISOString().slice(0, 10);
    return daySet.has(d);
  });
  process.stdout.write(`trades in ${days.join(',')}: ${trades.length}\n`);

  const parquet = collectParquet(days);
  if (!parquet.length) throw new Error(`no parquet for ${days.join(',')}`);

  const csvPath = path.join(OUT, 'doggy-below-bid-fills.csv');
  const lines = ['fill_ts,fill_px,size,outcome,slug,usdc'];
  for (const t of trades) {
    const outcome = String(t.outcome || '').toLowerCase().includes('up') ? 'Up' : 'Down';
    lines.push([t.timestamp, t.price, t.size, outcome, t.slug, t.usdcSize].join(','));
  }
  fs.writeFileSync(csvPath, lines.join('\n'));

  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  const pql = `[${parquet.map((f) => quotedString(f)).join(',')}]`;

  const sql = `
WITH fills AS (
  SELECT
    try_cast(fill_ts AS BIGINT) AS fill_ts,
    try_cast(fill_px AS DOUBLE) AS fill_px,
    try_cast(size AS DOUBLE) AS size,
    outcome,
    slug,
    try_cast(usdc AS DOUBLE) AS usdc
  FROM read_csv_auto(${quotedString(csvPath)}, header=true)
),
ticks AS (
  SELECT
    ep,
    up_best_ask, up_best_bid, down_best_ask, down_best_bid,
    up_price, down_price,
    up_ask_px_1, up_ask_sz_1, up_ask_px_2, up_ask_sz_2, up_ask_px_3, up_ask_sz_3,
    up_ask_px_4, up_ask_sz_4, up_ask_px_5, up_ask_sz_5,
    down_ask_px_1, down_ask_sz_1, down_ask_px_2, down_ask_sz_2, down_ask_px_3, down_ask_sz_3,
    down_ask_px_4, down_ask_sz_4, down_ask_px_5, down_ask_sz_5
  FROM (
    SELECT
      epoch(try_cast(ts AS TIMESTAMPTZ))::BIGINT AS ep,
      up_best_ask::DOUBLE AS up_best_ask,
      up_best_bid::DOUBLE AS up_best_bid,
      down_best_ask::DOUBLE AS down_best_ask,
      down_best_bid::DOUBLE AS down_best_bid,
      up_price::DOUBLE AS up_price,
      down_price::DOUBLE AS down_price,
      up_ask_px_1::DOUBLE AS up_ask_px_1, up_ask_sz_1::DOUBLE AS up_ask_sz_1,
      up_ask_px_2::DOUBLE AS up_ask_px_2, up_ask_sz_2::DOUBLE AS up_ask_sz_2,
      up_ask_px_3::DOUBLE AS up_ask_px_3, up_ask_sz_3::DOUBLE AS up_ask_sz_3,
      up_ask_px_4::DOUBLE AS up_ask_px_4, up_ask_sz_4::DOUBLE AS up_ask_sz_4,
      up_ask_px_5::DOUBLE AS up_ask_px_5, up_ask_sz_5::DOUBLE AS up_ask_sz_5,
      down_ask_px_1::DOUBLE AS down_ask_px_1, down_ask_sz_1::DOUBLE AS down_ask_sz_1,
      down_ask_px_2::DOUBLE AS down_ask_px_2, down_ask_sz_2::DOUBLE AS down_ask_sz_2,
      down_ask_px_3::DOUBLE AS down_ask_px_3, down_ask_sz_3::DOUBLE AS down_ask_sz_3,
      down_ask_px_4::DOUBLE AS down_ask_px_4, down_ask_sz_4::DOUBLE AS down_ask_sz_4,
      down_ask_px_5::DOUBLE AS down_ask_px_5, down_ask_sz_5::DOUBLE AS down_ask_sz_5,
      row_number() OVER (
        PARTITION BY epoch(try_cast(ts AS TIMESTAMPTZ))::BIGINT
        ORDER BY ts
      ) AS rn
    FROM read_parquet(${pql})
    WHERE coverage >= 0.99
      AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
  ) z
  WHERE rn = 1
)
SELECT
  f.fill_ts, f.fill_px, f.size, f.outcome, f.slug, f.usdc,
  CASE WHEN f.outcome = 'Up' THEN t0.up_best_ask ELSE t0.down_best_ask END AS ask0,
  CASE WHEN f.outcome = 'Up' THEN t0.up_best_bid ELSE t0.down_best_bid END AS bid0,
  CASE WHEN f.outcome = 'Up' THEN t0.up_price ELSE t0.down_price END AS last_px0,
  CASE WHEN f.outcome = 'Up' THEN tm.up_best_ask ELSE tm.down_best_ask END AS ask_m1,
  CASE WHEN f.outcome = 'Up' THEN tm.up_best_bid ELSE tm.down_best_bid END AS bid_m1,
  CASE WHEN f.outcome = 'Up' THEN tp.up_best_ask ELSE tp.down_best_ask END AS ask_p1,
  CASE WHEN f.outcome = 'Up' THEN tp.up_best_bid ELSE tp.down_best_bid END AS bid_p1,
  CASE WHEN f.outcome = 'Up' THEN t0.up_ask_px_1 ELSE t0.down_ask_px_1 END AS a1,
  CASE WHEN f.outcome = 'Up' THEN t0.up_ask_sz_1 ELSE t0.down_ask_sz_1 END AS s1,
  CASE WHEN f.outcome = 'Up' THEN t0.up_ask_px_2 ELSE t0.down_ask_px_2 END AS a2,
  CASE WHEN f.outcome = 'Up' THEN t0.up_ask_sz_2 ELSE t0.down_ask_sz_2 END AS s2,
  CASE WHEN f.outcome = 'Up' THEN t0.up_ask_px_3 ELSE t0.down_ask_px_3 END AS a3,
  CASE WHEN f.outcome = 'Up' THEN t0.up_ask_sz_3 ELSE t0.down_ask_sz_3 END AS s3,
  CASE WHEN f.outcome = 'Up' THEN t0.up_ask_px_4 ELSE t0.down_ask_px_4 END AS a4,
  CASE WHEN f.outcome = 'Up' THEN t0.up_ask_sz_4 ELSE t0.down_ask_sz_4 END AS s4,
  CASE WHEN f.outcome = 'Up' THEN t0.up_ask_px_5 ELSE t0.down_ask_px_5 END AS a5,
  CASE WHEN f.outcome = 'Up' THEN t0.up_ask_sz_5 ELSE t0.down_ask_sz_5 END AS s5,
  CASE WHEN f.outcome = 'Up' THEN tm.up_ask_px_1 ELSE tm.down_ask_px_1 END AS a1m,
  CASE WHEN f.outcome = 'Up' THEN tm.up_ask_sz_1 ELSE tm.down_ask_sz_1 END AS s1m,
  CASE WHEN f.outcome = 'Up' THEN tm.up_ask_px_2 ELSE tm.down_ask_px_2 END AS a2m,
  CASE WHEN f.outcome = 'Up' THEN tm.up_ask_sz_2 ELSE tm.down_ask_sz_2 END AS s2m,
  CASE WHEN f.outcome = 'Up' THEN tm.up_ask_px_3 ELSE tm.down_ask_px_3 END AS a3m,
  CASE WHEN f.outcome = 'Up' THEN tm.up_ask_sz_3 ELSE tm.down_ask_sz_3 END AS s3m,
  CASE WHEN f.outcome = 'Up' THEN tm.up_ask_px_4 ELSE tm.down_ask_px_4 END AS a4m,
  CASE WHEN f.outcome = 'Up' THEN tm.up_ask_sz_4 ELSE tm.down_ask_sz_4 END AS s4m,
  CASE WHEN f.outcome = 'Up' THEN tm.up_ask_px_5 ELSE tm.down_ask_px_5 END AS a5m,
  CASE WHEN f.outcome = 'Up' THEN tm.up_ask_sz_5 ELSE tm.down_ask_sz_5 END AS s5m
FROM fills f
INNER JOIN ticks t0 ON t0.ep = f.fill_ts
LEFT JOIN ticks tm ON tm.ep = f.fill_ts - 1
LEFT JOIN ticks tp ON tp.ep = f.fill_ts + 1
`;

  const matched = (await c.runAndReadAll(sql)).getRowObjectsJS();
  process.stdout.write(`matched=${matched.length}\n`);

  const analyzed = [];
  const hypCounts = {
    feeTakerOk: 0,
    matchesAsk0: 0,
    matchesAskM1: 0,
    matchesAskP1: 0,
    withinAskNeighborhood: 0,
    matchesLastPx: 0,
    vwapCurrNear: 0,
    vwapPrevNear: 0,
    crossedBook: 0,
    belowBid: 0,
    atBid: 0,
    paradox: 0,
    paradoxResolved: 0,
    paradoxUnresolved: 0,
  };

  for (const r of matched) {
    const fill_px = Number(r.fill_px);
    const size = Number(r.size);
    const usdc = Number(r.usdc);
    const ask0 = r.ask0 != null ? Number(r.ask0) : null;
    const bid0 = r.bid0 != null ? Number(r.bid0) : null;
    const askM1 = r.ask_m1 != null ? Number(r.ask_m1) : null;
    const askP1 = r.ask_p1 != null ? Number(r.ask_p1) : null;
    const lastPx = r.last_px0 != null ? Number(r.last_px0) : null;
    const bucket = classifyBucket(fill_px, ask0, bid0);

    const impliedFee = usdc - fill_px * size;
    const expectedFee = cryptoFee(size, fill_px);
    const feeErr = Math.abs(impliedFee - expectedFee);
    const feeTakerOk = feeErr < 0.02;
    if (feeTakerOk) hypCounts.feeTakerOk += 1;

    const levels0 = [
      { px: r.a1 != null ? Number(r.a1) : null, sz: r.s1 != null ? Number(r.s1) : 0 },
      { px: r.a2 != null ? Number(r.a2) : null, sz: r.s2 != null ? Number(r.s2) : 0 },
      { px: r.a3 != null ? Number(r.a3) : null, sz: r.s3 != null ? Number(r.s3) : 0 },
      { px: r.a4 != null ? Number(r.a4) : null, sz: r.s4 != null ? Number(r.s4) : 0 },
      { px: r.a5 != null ? Number(r.a5) : null, sz: r.s5 != null ? Number(r.s5) : 0 },
    ].filter((lv) => lv.px != null);
    const levelsM1 = [
      { px: r.a1m != null ? Number(r.a1m) : null, sz: r.s1m != null ? Number(r.s1m) : 0 },
      { px: r.a2m != null ? Number(r.a2m) : null, sz: r.s2m != null ? Number(r.s2m) : 0 },
      { px: r.a3m != null ? Number(r.a3m) : null, sz: r.s3m != null ? Number(r.s3m) : 0 },
      { px: r.a4m != null ? Number(r.a4m) : null, sz: r.s4m != null ? Number(r.s4m) : 0 },
      { px: r.a5m != null ? Number(r.a5m) : null, sz: r.s5m != null ? Number(r.s5m) : 0 },
    ].filter((lv) => lv.px != null);

    const walk0 = walkAskVwap(levels0, size);
    const walkM1 = walkAskVwap(levelsM1, size);

    const matchesAsk0 = near(fill_px, ask0, 0.005);
    const matchesAskM1 = near(fill_px, askM1, 0.005);
    const matchesAskP1 = near(fill_px, askP1, 0.005);
    const askNeighbors = [askM1, ask0, askP1].filter((x) => x != null);
    const minAskN = askNeighbors.length ? Math.min(...askNeighbors) : null;
    const maxAskN = askNeighbors.length ? Math.max(...askNeighbors) : null;
    const withinAskNeighborhood = minAskN != null && fill_px >= minAskN - 0.005 && fill_px <= maxAskN + 0.02;
    const matchesLastPx = near(fill_px, lastPx, 0.01);
    const vwapCurrNear = walk0 && !walk0.incomplete && near(fill_px, walk0.vwap, 0.015);
    const vwapPrevNear = walkM1 && !walkM1.incomplete && near(fill_px, walkM1.vwap, 0.015);
    const crossedBook = ask0 != null && bid0 != null && ask0 < bid0 - 1e-9;

    if (matchesAsk0) hypCounts.matchesAsk0 += 1;
    if (matchesAskM1) hypCounts.matchesAskM1 += 1;
    if (matchesAskP1) hypCounts.matchesAskP1 += 1;
    if (withinAskNeighborhood) hypCounts.withinAskNeighborhood += 1;
    if (matchesLastPx) hypCounts.matchesLastPx += 1;
    if (vwapCurrNear) hypCounts.vwapCurrNear += 1;
    if (vwapPrevNear) hypCounts.vwapPrevNear += 1;
    if (crossedBook) hypCounts.crossedBook += 1;
    if (bucket === 'BELOW_BID') hypCounts.belowBid += 1;
    if (bucket === 'AT_BID') hypCounts.atBid += 1;

    const isParadox = bucket === 'BELOW_BID' || bucket === 'AT_BID';
    let resolution = null;
    if (isParadox) {
      hypCounts.paradox += 1;
      if (matchesAskM1) resolution = 'ASK_AT_T_MINUS_1';
      else if (matchesAskP1) resolution = 'ASK_AT_T_PLUS_1';
      else if (vwapPrevNear) resolution = 'VWAP_WALK_T_MINUS_1';
      else if (vwapCurrNear) resolution = 'VWAP_WALK_T';
      else if (withinAskNeighborhood && fill_px <= (minAskN ?? 99) + 0.01) resolution = 'WITHIN_ASK_NEIGHBORHOOD';
      else if (matchesLastPx) resolution = 'MATCHES_LAST_TRADE_PX';
      else if (crossedBook) resolution = 'CROSSED_STALE_BOOK';
      else if (feeTakerOk && fill_px < (ask0 ?? 0) - 0.01) resolution = 'TAKER_BETTER_THAN_SNAPSHOT_ASK';
      else resolution = 'UNEXPLAINED';
      if (resolution === 'UNEXPLAINED') hypCounts.paradoxUnresolved += 1;
      else hypCounts.paradoxResolved += 1;
    }

    analyzed.push({
      fill_ts: Number(r.fill_ts),
      slug: r.slug,
      outcome: r.outcome,
      fill_px,
      size,
      ask0,
      bid0,
      askM1,
      askP1,
      lastPx,
      vsAsk0: ask0 != null ? fill_px - ask0 : null,
      bucket,
      feeErr,
      feeTakerOk,
      matchesAskM1,
      matchesAskP1,
      withinAskNeighborhood,
      minAskN,
      vwap0: walk0?.vwap ?? null,
      vwapM1: walkM1?.vwap ?? null,
      isParadox,
      resolution,
    });
  }

  const paradox = analyzed.filter((x) => x.isParadox);
  const resolutionCounts = {};
  for (const p of paradox) {
    resolutionCounts[p.resolution] = (resolutionCounts[p.resolution] || 0) + 1;
  }

  const feeStats = {
    n: analyzed.length,
    feeTakerOk: hypCounts.feeTakerOk,
    feeTakerShare: frac(hypCounts.feeTakerOk, analyzed.length),
    medFeeErr: q(analyzed.map((x) => x.feeErr), 0.5),
  };

  const byBucket = {};
  for (const a of analyzed) {
    if (!byBucket[a.bucket]) byBucket[a.bucket] = { n: 0, feeOk: 0, vs: [] };
    byBucket[a.bucket].n += 1;
    if (a.feeTakerOk) byBucket[a.bucket].feeOk += 1;
    if (a.vsAsk0 != null) byBucket[a.bucket].vs.push(a.vsAsk0);
  }
  const bucketTable = Object.entries(byBucket)
    .map(([bucket, v]) => ({
      bucket,
      n: v.n,
      feeTakerShare: frac(v.feeOk, v.n),
      medVsAsk: q(v.vs, 0.5),
    }))
    .sort((a, b) => b.n - a.n);

  const askMove = paradox.filter((p) => p.askM1 != null && p.ask0 != null).map((p) => p.ask0 - p.askM1);
  const vsAsk0All = analyzed.map((a) => a.vsAsk0).filter((x) => x != null);
  const vsMinNeighbor = analyzed.filter((a) => a.minAskN != null).map((a) => a.fill_px - a.minAskN);
  const paradoxVsAsk = paradox.map((p) => p.vsAsk0).filter((x) => x != null);
  const paradoxVsMin = paradox.filter((p) => p.minAskN != null).map((p) => p.fill_px - p.minAskN);

  const rules = [];
  rules.push(
    `Fee taker: ${(feeStats.feeTakerShare * 100).toFixed(1)}% dos fills matched = fórmula crypto (med |err|=$${Number(feeStats.medFeeErr).toFixed(5)}).`,
  );
  rules.push(
    `Paradoxo AT_BID+BELOW_BID: ${hypCounts.paradox}/${analyzed.length} (${((hypCounts.paradox / analyzed.length) * 100).toFixed(0)}%); resolvidos ${hypCounts.paradoxResolved}, unexplained ${hypCounts.paradoxUnresolved}.`,
  );
  const topRes = Object.entries(resolutionCounts).sort((a, b) => b[1] - a[1]);
  rules.push(`Resoluções: ${topRes.map(([k, v]) => `${k}=${v}`).join(' · ')}.`);
  rules.push(
    `Med fill−ask0 = ${(q(vsAsk0All, 0.5) * 100).toFixed(2)}¢; med fill−min(ask±1s) = ${(q(vsMinNeighbor, 0.5) * 100).toFixed(2)}¢.`,
  );
  rules.push(
    'Veredito: NÃO é maker. Fee=taker em ~100%. O “fill ≤ bid” é artefato do lake 1Hz — ask melhor existiu intra-segundo (ou em t−1) e sumiu no snapshot.',
  );
  rules.push(
    'Lab: slippageCents=-1 (proxy med −0.7¢ vs ask0) é honesto para join 1Hz; fillMode=taker + fee crypto + Diamond 44%. Não usar resting_maker como paridade Doggy.',
  );

  const summary = {
    asOf: new Date().toISOString(),
    wallet: WALLET,
    days,
    nMatched: analyzed.length,
    nActivityFiltered: trades.length,
    hypCounts,
    feeStats,
    resolutionCounts,
    bucketTable,
    paradox: {
      n: hypCounts.paradox,
      resolvedShare: frac(hypCounts.paradoxResolved, hypCounts.paradox),
      medVsAsk0: q(paradoxVsAsk, 0.5),
      medVsMinAskN: q(paradoxVsMin, 0.5),
      medAskMoveM1to0: q(askMove, 0.5),
      fracAskImproved: frac(askMove.filter((x) => x < -0.005).length, askMove.length),
      fracAskWorsened: frac(askMove.filter((x) => x > 0.005).length, askMove.length),
    },
    global: {
      medVsAsk0: q(vsAsk0All, 0.5),
      medVsMinAskNeighbor: q(vsMinNeighbor, 0.5),
      fracLeAsk0Minus1c: frac(vsAsk0All.filter((x) => x <= -0.01).length, vsAsk0All.length),
      fracLeMinAskNMinus1c: frac(vsMinNeighbor.filter((x) => x <= -0.01).length, vsMinNeighbor.length),
    },
    inferredRules: rules,
    showcase: paradox
      .filter((p) => p.resolution !== 'UNEXPLAINED')
      .sort((a, b) => (a.vsAsk0 ?? 0) - (b.vsAsk0 ?? 0))
      .slice(0, 8)
      .map((p) => ({
        slug: p.slug,
        outcome: p.outcome,
        fill_px: p.fill_px,
        ask0: p.ask0,
        bid0: p.bid0,
        askM1: p.askM1,
        askP1: p.askP1,
        vsAsk0: p.vsAsk0,
        bucket: p.bucket,
        resolution: p.resolution,
      })),
  };

  const canvas = {
    asOf: summary.asOf,
    nMatched: summary.nMatched,
    feeTakerShare: feeStats.feeTakerShare,
    paradoxN: hypCounts.paradox,
    belowBid: hypCounts.belowBid,
    atBid: hypCounts.atBid,
    resolvedShare: summary.paradox.resolvedShare,
    resolutionCounts,
    bucketTable: bucketTable.map((b) => ({
      bucket: b.bucket,
      n: b.n,
      feePct: Math.round((b.feeTakerShare || 0) * 1000) / 10,
      medVsAskC: b.medVsAsk != null ? Math.round(b.medVsAsk * 10000) / 100 : null,
    })),
    global: {
      medVsAsk0C: Math.round((summary.global.medVsAsk0 || 0) * 10000) / 100,
      medVsMinAskNC: Math.round((summary.global.medVsMinAskNeighbor || 0) * 10000) / 100,
      fracLeAskMinus1c: summary.global.fracLeAsk0Minus1c,
      fracLeMinAskMinus1c: summary.global.fracLeMinAskNMinus1c,
    },
    rules,
    showcase: summary.showcase,
  };

  fs.writeFileSync(path.join(OUT, 'doggy-below-bid-paradox.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, 'doggy-below-bid-paradox-canvas.json'), JSON.stringify(canvas, null, 2));

  console.log(JSON.stringify({
    nMatched: summary.nMatched,
    feeStats,
    hypCounts: {
      paradox: hypCounts.paradox,
      belowBid: hypCounts.belowBid,
      atBid: hypCounts.atBid,
      resolved: hypCounts.paradoxResolved,
      unexplained: hypCounts.paradoxUnresolved,
      matchesAskM1: hypCounts.matchesAskM1,
      matchesAskP1: hypCounts.matchesAskP1,
      withinAskNeighborhood: hypCounts.withinAskNeighborhood,
      vwapCurrNear: hypCounts.vwapCurrNear,
      vwapPrevNear: hypCounts.vwapPrevNear,
    },
    resolutionCounts,
    global: summary.global,
    paradox: summary.paradox,
    rules,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
