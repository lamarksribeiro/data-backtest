/**
 * Etapa 1: replay tick-a-tick Doggy fill vs lake ask/bid.
 * Painel por evento + erro de sync (±0/1/2s).
 *
 * Usage:
 *   node labs/sandbox/doggy-tick-replay.mjs [--days=2026-07-24,2026-07-25] [--fetch]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, quotedString } from '@duckdb/node-api';

const OUT = path.resolve('.tmp/pair-ladder-re');
const WALLET = '0x0484e64092ba4108c2786b61e6fc052d3bf41b1a';
const args = new Set(process.argv.slice(2));
const fetchMore = args.has('--fetch');
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
function eventStartFromSlug(slug) {
  const m = String(slug || '').match(/btc-updown-5m-(\d+)/i);
  return m ? Number(m[1]) : null;
}
function classifyFill(fillPx, ask, bid) {
  if (ask == null || bid == null) return 'NO_BOOK';
  const mid = (ask + bid) / 2;
  const vsAsk = fillPx - ask;
  const vsBid = fillPx - bid;
  let bucket;
  if (fillPx >= ask - 0.001) bucket = fillPx > ask + 0.01 ? 'WALK_ASK' : 'AT_ASK';
  else if (fillPx <= bid + 0.001) bucket = fillPx < bid - 0.01 ? 'BELOW_BID' : 'AT_BID';
  else if (fillPx < mid) bucket = 'BETWEEN_MID_BID';
  else bucket = 'BETWEEN_MID_ASK';
  return { bucket, vsAsk, vsBid, vsMid: fillPx - mid, spread: ask - bid };
}

async function fetchActivity(limitPages = 30) {
  const all = [];
  const seen = new Set();
  for (let page = 0; page < limitPages; page += 1) {
    const offset = page * 100;
    const url = `https://data-api.polymarket.com/activity?user=${WALLET}&limit=100&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`activity ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
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
    await new Promise((r) => setTimeout(r, 100));
  }
  return all;
}

function loadActivity() {
  const p = path.join(OUT, 'doggy-activity-fresh.json');
  if (!fs.existsSync(p)) throw new Error('missing doggy-activity-fresh.json — run with --fetch');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
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

async function main() {
  let rows = fetchMore ? await fetchActivity(40) : loadActivity();
  if (fetchMore) {
    fs.writeFileSync(path.join(OUT, 'doggy-activity-fresh.json'), JSON.stringify(rows));
  }

  const trades = rows.filter((r) => r.type === 'TRADE' && r.side === 'BUY' && /btc-updown-5m/i.test(r.slug || ''));
  const parquet = collectParquet(days);
  if (!parquet.length) throw new Error(`no parquet for ${days.join(',')}`);

  // CSV of fills for duck join
  const csvPath = path.join(OUT, 'doggy-tick-replay-fills.csv');
  const lines = ['fill_ts,fill_px,size,outcome,slug,usdc,tx'];
  for (const t of trades) {
    const outcome = String(t.outcome || '').toLowerCase().includes('up') ? 'Up' : 'Down';
    lines.push([
      t.timestamp,
      t.price,
      t.size,
      outcome,
      t.slug,
      t.usdcSize,
      (t.transactionHash || '').slice(0, 18),
    ].join(','));
  }
  fs.writeFileSync(csvPath, lines.join('\n'));

  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  const pql = `[${parquet.map((f) => quotedString(f)).join(',')}]`;

  // For each fill, find nearest tick within ±2s and also exact second match stats
  const sql = `
WITH fills AS (
  SELECT fill_ts::BIGINT AS fill_ts, fill_px::DOUBLE AS fill_px, size::DOUBLE AS size,
         outcome, slug, usdc::DOUBLE AS usdc, tx
  FROM read_csv_auto(${quotedString(csvPath)}, header=true)
),
ticks AS (
  SELECT
    epoch(try_cast(ts AS TIMESTAMPTZ))::BIGINT AS ep,
    up_best_ask, up_best_bid, down_best_ask, down_best_bid,
    up_ask_sz_1, down_ask_sz_1,
    coverage
  FROM read_parquet(${pql})
  WHERE coverage >= 0.99
    AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
),
matched AS (
  SELECT
    f.*,
    t.ep AS tick_ep,
    abs(t.ep - f.fill_ts) AS dsec,
    CASE WHEN f.outcome = 'Up' THEN t.up_best_ask ELSE t.down_best_ask END AS ask,
    CASE WHEN f.outcome = 'Up' THEN t.up_best_bid ELSE t.down_best_bid END AS bid,
    CASE WHEN f.outcome = 'Up' THEN t.up_ask_sz_1 ELSE t.down_ask_sz_1 END AS ask_size1,
    CASE WHEN f.outcome = 'Up' THEN t.down_best_ask ELSE t.up_best_ask END AS opp_ask,
    CASE WHEN f.outcome = 'Up' THEN t.down_best_bid ELSE t.up_best_bid END AS opp_bid
  FROM fills f
  JOIN ticks t ON abs(t.ep - f.fill_ts) <= 2
  QUALIFY row_number() OVER (
    PARTITION BY f.fill_ts, f.slug, f.outcome, f.size, f.fill_px, f.tx
    ORDER BY abs(t.ep - f.fill_ts), t.ep
  ) = 1
)
SELECT * FROM matched
ORDER BY fill_ts
`;

  let matchedRows;
  try {
    matchedRows = (await c.runAndReadAll(sql)).getRowObjectsJS();
  } catch (err) {
    // ask sizes may not exist — retry without
    const sql2 = sql
      .replace(/up_ask_size_1, down_ask_size_1,/g, '')
      .replace(/CASE WHEN f\.outcome = 'Up' THEN t\.up_ask_size_1 ELSE t\.down_ask_size_1 END AS ask_size1,/g, 'NULL::DOUBLE AS ask_size1,');
    matchedRows = (await c.runAndReadAll(sql2)).getRowObjectsJS();
  }

  const fills = matchedRows.map((r) => {
    const fill_ts = Number(r.fill_ts);
    const fill_px = Number(r.fill_px);
    const ask = r.ask != null ? Number(r.ask) : null;
    const bid = r.bid != null ? Number(r.bid) : null;
    const cls = classifyFill(fill_px, ask, bid);
    return {
      fill_ts,
      fill_px,
      size: Number(r.size),
      outcome: r.outcome,
      slug: r.slug,
      usdc: Number(r.usdc),
      tx: r.tx,
      tick_ep: Number(r.tick_ep),
      dsec: Number(r.dsec),
      ask,
      bid,
      ask_size1: r.ask_size1 != null ? Number(r.ask_size1) : null,
      opp_ask: r.opp_ask != null ? Number(r.opp_ask) : null,
      opp_bid: r.opp_bid != null ? Number(r.opp_bid) : null,
      ...cls,
    };
  });

  // Sync diagnostics: compare match at 0s vs ±1s vs ±2s
  const syncProbeSql = `
WITH fills AS (
  SELECT fill_ts::BIGINT AS fill_ts, fill_px::DOUBLE AS fill_px, size::DOUBLE AS size, outcome, slug
  FROM read_csv_auto(${quotedString(csvPath)}, header=true)
),
ticks AS (
  SELECT epoch(try_cast(ts AS TIMESTAMPTZ))::BIGINT AS ep,
         up_best_ask, up_best_bid, down_best_ask, down_best_bid
  FROM read_parquet(${pql})
  WHERE coverage >= 0.99 AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
),
m0 AS (
  SELECT f.fill_ts, f.fill_px, f.outcome, f.slug,
    CASE WHEN f.outcome='Up' THEN t.up_best_ask ELSE t.down_best_ask END AS ask
  FROM fills f JOIN ticks t ON t.ep = f.fill_ts
),
m1 AS (
  SELECT f.fill_ts, f.fill_px, f.outcome, f.slug,
    CASE WHEN f.outcome='Up' THEN t.up_best_ask ELSE t.down_best_ask END AS ask,
    abs(t.ep - f.fill_ts) AS dsec
  FROM fills f JOIN ticks t ON abs(t.ep - f.fill_ts) <= 1
  QUALIFY row_number() OVER (PARTITION BY f.fill_ts, f.slug, f.outcome, f.size, f.fill_px ORDER BY abs(t.ep-f.fill_ts))=1
),
m2 AS (
  SELECT f.fill_ts, f.fill_px, f.outcome, f.slug,
    CASE WHEN f.outcome='Up' THEN t.up_best_ask ELSE t.down_best_ask END AS ask,
    abs(t.ep - f.fill_ts) AS dsec
  FROM fills f JOIN ticks t ON abs(t.ep - f.fill_ts) <= 2
  QUALIFY row_number() OVER (PARTITION BY f.fill_ts, f.slug, f.outcome, f.size, f.fill_px ORDER BY abs(t.ep-f.fill_ts))=1
)
SELECT
  (SELECT count(*) FROM fills) AS n_fills,
  (SELECT count(*) FROM m0) AS n_exact_sec,
  (SELECT count(*) FROM m1) AS n_pm1,
  (SELECT count(*) FROM m2) AS n_pm2,
  (SELECT round(avg(fill_px-ask),5) FROM m0 WHERE ask IS NOT NULL) AS mean_vs_ask_exact,
  (SELECT round(approx_quantile(fill_px-ask,0.5),5) FROM m0 WHERE ask IS NOT NULL) AS med_vs_ask_exact,
  (SELECT round(avg(fill_px-ask),5) FROM m1 WHERE ask IS NOT NULL) AS mean_vs_ask_pm1,
  (SELECT round(approx_quantile(fill_px-ask,0.5),5) FROM m1 WHERE ask IS NOT NULL) AS med_vs_ask_pm1,
  (SELECT round(avg(fill_px-ask),5) FROM m2 WHERE ask IS NOT NULL) AS mean_vs_ask_pm2,
  (SELECT round(approx_quantile(fill_px-ask,0.5),5) FROM m2 WHERE ask IS NOT NULL) AS med_vs_ask_pm2
`;
  const syncRow = (await c.runAndReadAll(syncProbeSql)).getRowObjectsJS()[0];
  const sync = {};
  for (const [k, v] of Object.entries(syncRow)) sync[k] = typeof v === 'bigint' ? Number(v) : v;

  // Global buckets
  const buckets = {};
  for (const f of fills) buckets[f.bucket] = (buckets[f.bucket] || 0) + 1;
  const vsAsk = fills.map((f) => f.vsAsk).filter((x) => x != null);
  const dsecs = fills.map((f) => f.dsec);

  // Per-event panels
  const bySlug = new Map();
  for (const f of fills) {
    if (!bySlug.has(f.slug)) bySlug.set(f.slug, []);
    bySlug.get(f.slug).push(f);
  }

  const events = [];
  for (const [slug, eventFills] of bySlug) {
    eventFills.sort((a, b) => a.fill_ts - b.fill_ts);
    const start = eventStartFromSlug(slug);
    const vsAsks = eventFills.map((f) => f.vsAsk);
    const atAsk = eventFills.filter((f) => f.bucket === 'AT_ASK' || f.bucket === 'WALK_ASK').length;
    const betterAsk = eventFills.filter((f) => f.vsAsk < -0.005).length;
    const first = eventFills[0];
    const secondOpp = eventFills.find((f) => f.outcome !== first.outcome);
    let hedgeImprove = null;
    if (secondOpp && first.opp_ask != null) {
      hedgeImprove = first.opp_ask - secondOpp.fill_px; // positive = got cheaper than opp ask at open tick
    }
    // running inventory for display
    let upS = 0; let downS = 0; let upC = 0; let downC = 0;
    const timeline = eventFills.map((f) => {
      if (f.outcome === 'Up') { upS += f.size; upC += f.fill_px * f.size; }
      else { downS += f.size; downC += f.fill_px * f.size; }
      const avgSum = upS > 0 && downS > 0 ? upC / upS + downC / downS : null;
      return {
        sec: start != null ? f.fill_ts - start : null,
        outcome: f.outcome,
        size: f.size,
        fill_px: f.fill_px,
        ask: f.ask,
        bid: f.bid,
        vsAsk: f.vsAsk,
        bucket: f.bucket,
        dsec: f.dsec,
        avgSum,
        residual: Math.abs(upS - downS),
      };
    });
    events.push({
      slug,
      start,
      nFills: eventFills.length,
      meanVsAsk: mean(vsAsks),
      medVsAsk: q(vsAsks, 0.5),
      fracAtOrAboveAsk: atAsk / eventFills.length,
      fracBetterThanAskHalfCent: betterAsk / eventFills.length,
      meanDsec: mean(eventFills.map((f) => f.dsec)),
      firstPx: first.fill_px,
      firstVsAsk: first.vsAsk,
      hedgePx: secondOpp?.fill_px ?? null,
      hedgeVsAsk: secondOpp?.vsAsk ?? null,
      hedgeGapSec: secondOpp ? secondOpp.fill_ts - first.fill_ts : null,
      hedgeImproveVsOppAtOpen: hedgeImprove,
      finalAvgSum: timeline.at(-1)?.avgSum ?? null,
      timeline,
    });
  }
  events.sort((a, b) => (b.start || 0) - (a.start || 0));

  // Pick showcase panels: best improvement, worst walk, typical, hedge-wait
  const withHedge = events.filter((e) => e.hedgeGapSec != null);
  const showcase = {
    bestMeanImprove: [...events].sort((a, b) => (a.meanVsAsk ?? 0) - (b.meanVsAsk ?? 0)).slice(0, 3),
    worstWalk: [...events].sort((a, b) => (b.meanVsAsk ?? 0) - (a.meanVsAsk ?? 0)).slice(0, 3),
    longestHedgeWait: [...withHedge].sort((a, b) => b.hedgeGapSec - a.hedgeGapSec).slice(0, 3),
    typical: events.filter((e) => e.nFills >= 6 && e.nFills <= 12).slice(0, 4),
  };

  const summary = {
    asOf: new Date().toISOString(),
    wallet: WALLET,
    days,
    nTradesActivity: trades.length,
    nMatched: fills.length,
    matchRate: fills.length / Math.max(1, trades.length),
    sync,
    global: {
      buckets,
      vsAsk: {
        mean: mean(vsAsk),
        med: q(vsAsk, 0.5),
        p10: q(vsAsk, 0.1),
        p90: q(vsAsk, 0.9),
        fracLeMinus1c: vsAsk.filter((x) => x <= -0.01).length / vsAsk.length,
        fracAtAskBand: vsAsk.filter((x) => x >= -0.005 && x <= 0.005).length / vsAsk.length,
        fracWalkGt1c: vsAsk.filter((x) => x > 0.01).length / vsAsk.length,
      },
      dsec: { mean: mean(dsecs), med: q(dsecs, 0.5), fracExact0: dsecs.filter((d) => d === 0).length / dsecs.length },
      nEvents: events.length,
      eventsMeanVsAskMed: q(events.map((e) => e.meanVsAsk).filter((x) => x != null), 0.5),
    },
  };

  const out = { summary, showcase, events };
  fs.writeFileSync(path.join(OUT, 'doggy-tick-replay.json'), JSON.stringify(out));
  // compact for canvas embed
  const canvasPayload = {
    summary,
    showcase: {
      bestMeanImprove: showcase.bestMeanImprove.map(slimEvent),
      worstWalk: showcase.worstWalk.map(slimEvent),
      longestHedgeWait: showcase.longestHedgeWait.map(slimEvent),
      typical: showcase.typical.map(slimEvent),
    },
    // top 40 events by |meanVsAsk| for interactive-ish table
    eventTable: events.slice(0, 40).map((e) => ({
      slug: e.slug.replace('btc-updown-5m-', ''),
      n: e.nFills,
      meanVsAsk: round4(e.meanVsAsk),
      medVsAsk: round4(e.medVsAsk),
      fracBetter: round4(e.fracBetterThanAskHalfCent),
      fracAtAsk: round4(e.fracAtOrAboveAsk),
      hedgeGap: e.hedgeGapSec,
      hedgeImprove: round4(e.hedgeImproveVsOppAtOpen),
      finalAvgSum: round4(e.finalAvgSum),
      meanDsec: round4(e.meanDsec),
    })),
  };
  fs.writeFileSync(path.join(OUT, 'doggy-tick-replay-canvas.json'), JSON.stringify(canvasPayload));

  console.log(JSON.stringify({
    ...summary,
    showcaseSlugs: {
      best: showcase.bestMeanImprove.map((e) => e.slug),
      worst: showcase.worstWalk.map((e) => e.slug),
      longHedge: showcase.longestHedgeWait.map((e) => e.slug),
    },
    out: path.join(OUT, 'doggy-tick-replay.json'),
  }, null, 2));
}

function slimEvent(e) {
  return {
    slug: e.slug,
    nFills: e.nFills,
    meanVsAsk: round4(e.meanVsAsk),
    medVsAsk: round4(e.medVsAsk),
    fracBetterThanAskHalfCent: round4(e.fracBetterThanAskHalfCent),
    fracAtOrAboveAsk: round4(e.fracAtOrAboveAsk),
    hedgeGapSec: e.hedgeGapSec,
    hedgeImproveVsOppAtOpen: round4(e.hedgeImproveVsOppAtOpen),
    finalAvgSum: round4(e.finalAvgSum),
    timeline: e.timeline.map((t) => ({
      sec: t.sec,
      o: t.outcome[0],
      s: t.size,
      px: round4(t.fill_px),
      ask: round4(t.ask),
      bid: round4(t.bid),
      vs: round4(t.vsAsk),
      b: t.bucket,
      d: t.dsec,
      avg: round4(t.avgSum),
      res: round4(t.residual),
    })),
  };
}

function round4(x) {
  if (x == null || !Number.isFinite(x)) return null;
  return Math.round(x * 1e4) / 1e4;
}

await main();
