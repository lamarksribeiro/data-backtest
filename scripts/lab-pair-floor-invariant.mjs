#!/usr/bin/env node
/**
 * Pair Floor Invariant (PFI) V1 — market-neutral dual-side laboratory
 *
 * Theory: only enter UP+DOWN structures whose pre-trade settlement floor
 * after Polymarket crypto taker fees (and optional slippage/partial fills)
 * is non-negative, or whose causal completion path has controlled worst case.
 *
 * Data: local lake parquet (BTC 5m book_depth=25). Optional Postgres not required.
 *
 * Usage:
 *   node scripts/lab-pair-floor-invariant.mjs
 *   node scripts/lab-pair-floor-invariant.mjs --from 2026-05-04T15:00:00.000Z --mode research --batch-size 5000
 *   npm run lab:pair-floor-invariant
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DEFAULT_GLOB = 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=*/*.parquet';
const DEFAULT_FROM = '2026-05-04T15:00:00.000Z';

// Official Polymarket crypto taker fee: fee = shares * feeRate * p * (1-p)
// https://docs.polymarket.com/trading/fees
const FEE_SCENARIOS = {
  pessimistic: { feeRate: 0.07, rebateRate: 0, label: 'taker 7%, no rebate' },
  base: { feeRate: 0.07, rebateRate: 0, label: 'taker 7%, no rebate (base)' },
  optimistic: { feeRate: 0.07, rebateRate: 0.44, label: 'taker 7%, diamond rebate 44%' },
  maker: { feeRate: 0, rebateRate: 0, label: 'maker 0% (counterfactual)' },
};

function parseArgs(argv) {
  const out = {
    from: DEFAULT_FROM,
    to: null,
    mode: 'research',
    batchSize: 5000,
    feeScenario: 'base',
    feeRate: null,
    rebateRate: null,
    glob: DEFAULT_GLOB,
    outJson: null,
    maxEvents: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--from' && next) { out.from = next; i += 1; }
    else if (a === '--to' && next) { out.to = next; i += 1; }
    else if (a === '--mode' && next) { out.mode = next; i += 1; }
    else if (a === '--batch-size' && next) { out.batchSize = Number(next); i += 1; }
    else if (a === '--fee-scenario' && next) { out.feeScenario = next; i += 1; }
    else if (a === '--fee-rate' && next) { out.feeRate = Number(next); i += 1; }
    else if (a === '--rebate-rate' && next) { out.rebateRate = Number(next); i += 1; }
    else if (a === '--glob' && next) { out.glob = next; i += 1; }
    else if (a === '--out-json' && next) { out.outJson = next; i += 1; }
    else if (a === '--max-events' && next) { out.maxEvents = Number(next); i += 1; }
    else if (!a.startsWith('--') && !out._pos) { out.from = a; out._pos = 1; }
    else if (!a.startsWith('--') && out._pos === 1) { out.to = a; out._pos = 2; }
    else if (!a.startsWith('--') && out._pos === 2) { out.mode = a; out._pos = 3; }
    else if (!a.startsWith('--') && out._pos === 3) { out.batchSize = Number(a); out._pos = 4; }
  }
  return out;
}

function round(x, d = 4) {
  const p = 10 ** d;
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * p) / p;
}

function num(x) {
  if (x == null) return null;
  if (typeof x === 'bigint') return Number(x);
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function feePerShare(price, feeRate) {
  const p = num(price);
  const r = num(feeRate) ?? 0;
  if (p == null || r <= 0) return 0;
  if (p <= 0 || p >= 1) return 0;
  return r * p * (1 - p);
}

function feeOn(price, qty, feeRate) {
  const q = num(qty) ?? 0;
  return q * feePerShare(price, feeRate);
}

function netFee(price, qty, feeRate, rebateRate) {
  const gross = feeOn(price, qty, feeRate);
  return gross * (1 - (num(rebateRate) ?? 0));
}

/** Pre-trade dual floor for equal qty q=1 (per share pair). */
export function pairFloorPerShare(ua, da, feeRate, rebateRate = 0) {
  const feeU = feePerShare(ua, feeRate) * (1 - rebateRate);
  const feeD = feePerShare(da, feeRate) * (1 - rebateRate);
  const cost = ua + da + feeU + feeD;
  const floor = 1 - cost; // settlement always pays 1 for equal pair
  return {
    askSum: ua + da,
    feeUp: feeU,
    feeDown: feeD,
    allInCost: cost,
    floorNet: floor,
    pnlIfUp: floor,
    pnlIfDown: floor,
    worst: floor,
    best: floor,
  };
}

/** Walk L1..depth asks up to maxPrice; respect sizes and fill fraction. */
function walkBuy(tick, side, targetQty, maxPrice, fillFrac = 1, depth = 25) {
  const prefix = side === 'UP' ? 'up_ask' : 'down_ask';
  let remaining = targetQty;
  let cost = 0;
  let filled = 0;
  const levels = [];

  for (let i = 1; i <= depth && remaining > 1e-9; i += 1) {
    const px = num(tick[`${prefix}_px_${i}`] ?? (i === 1 ? (side === 'UP' ? tick.ua : tick.da) : null));
    let sz = num(tick[`${prefix}_sz_${i}`] ?? (i === 1 ? (side === 'UP' ? tick.uas : tick.das) : null));
    if (px == null || px <= 0) break;
    if (px > maxPrice + 1e-12) break;
    if (sz == null || sz <= 0) {
      // missing size: allow at most target on L1 only as conservative half-fill proxy
      if (i === 1) sz = targetQty * fillFrac;
      else break;
    } else {
      sz *= fillFrac;
    }
    const take = Math.min(remaining, sz);
    if (take <= 0) continue;
    cost += take * px;
    filled += take;
    remaining -= take;
    levels.push({ px, qty: take });
  }

  if (filled < 1e-9) return null;
  const avg = cost / filled;
  return { qty: filled, cost, avgPx: avg, levels, partial: remaining > 1e-6 };
}

function bookValid(tick, maxSpread) {
  const ua = num(tick.ua), da = num(tick.da), ub = num(tick.ub), db = num(tick.db);
  if (ua == null || da == null || ub == null || db == null) return false;
  if (!(ua > 0 && da > 0 && ub > 0 && db > 0)) return false;
  if (ub > ua + 1e-12 || db > da + 1e-12) return false; // inverted = data artifact
  if (ua - ub > maxSpread || da - db > maxSpread) return false;
  return true;
}

async function loadCoverage(conn, glob, from, to) {
  const toClause = to ? `AND TRY_CAST(ts AS TIMESTAMP) <= TIMESTAMP '${to.replace('T', ' ').replace('Z', '')}'` : '';
  const fromSql = from.replace('T', ' ').replace('Z', '');
  const sql = `
    SELECT
      count(*)::BIGINT AS ticks,
      count(DISTINCT condition_id)::BIGINT AS events,
      min(ts)::VARCHAR AS first_ts,
      max(ts)::VARCHAR AS last_ts,
      count(*) FILTER (
        WHERE up_ask_px_1 > 0 AND down_ask_px_1 > 0
          AND up_bid_px_1 > 0 AND down_bid_px_1 > 0
      )::BIGINT AS ticks_both_books,
      count(*) FILTER (
        WHERE up_ask_px_1 > 0 AND down_ask_px_1 > 0
          AND up_bid_px_1 > 0 AND down_bid_px_1 > 0
          AND up_bid_px_1 <= up_ask_px_1 AND down_bid_px_1 <= down_ask_px_1
      )::BIGINT AS ticks_valid_books
    FROM read_parquet('${glob}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${fromSql}'
    ${toClause}
  `;
  const r = await conn.runAndReadAll(sql);
  const row = r.getRowObjectsJson()[0];
  return {
    ticks: num(row.ticks),
    events: num(row.events),
    first_ts: row.first_ts,
    last_ts: row.last_ts,
    ticks_both_books: num(row.ticks_both_books),
    ticks_valid_books: num(row.ticks_valid_books),
  };
}

async function loadOpportunityStats(conn, glob, from, to, feeRate) {
  const toClause = to ? `AND TRY_CAST(ts AS TIMESTAMP) <= TIMESTAMP '${to.replace('T', ' ').replace('Z', '')}'` : '';
  const fromSql = from.replace('T', ' ').replace('Z', '');
  const sql = `
    WITH base AS (
      SELECT
        condition_id,
        up_ask_px_1 AS ua, down_ask_px_1 AS da,
        up_bid_px_1 AS ub, down_bid_px_1 AS db,
        1 - up_ask_px_1 - down_ask_px_1
          - ${feeRate}*up_ask_px_1*(1-up_ask_px_1)
          - ${feeRate}*down_ask_px_1*(1-down_ask_px_1) AS floor_net,
        up_ask_px_1 + down_ask_px_1 AS ask_sum,
        up_bid_px_1 + down_bid_px_1 AS bid_sum
      FROM read_parquet('${glob}', hive_partitioning=true, union_by_name=true)
      WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${fromSql}'
      ${toClause}
        AND COALESCE(degraded, false) = false AND coverage >= 0.99
        AND up_ask_px_1 BETWEEN 0.01 AND 0.99 AND down_ask_px_1 BETWEEN 0.01 AND 0.99
        AND up_bid_px_1 > 0 AND down_bid_px_1 > 0
        AND up_bid_px_1 <= up_ask_px_1 AND down_bid_px_1 <= down_ask_px_1
        AND up_ask_px_1 - up_bid_px_1 <= 0.04
        AND down_ask_px_1 - down_bid_px_1 <= 0.04
        AND up_ask_sz_1 >= 3 AND down_ask_sz_1 >= 3
    )
    SELECT
      count(*)::BIGINT AS n,
      avg(ask_sum) AS avg_ask_sum,
      avg(bid_sum) AS avg_bid_sum,
      min(ask_sum) AS min_ask_sum,
      count(*) FILTER (WHERE ask_sum < 1.0)::BIGINT AS ask_sum_lt_1,
      count(*) FILTER (WHERE floor_net > 0)::BIGINT AS ticks_floor_pos,
      count(DISTINCT condition_id) FILTER (WHERE floor_net > 0)::BIGINT AS events_floor_pos,
      count(*) FILTER (WHERE floor_net >= 0.005)::BIGINT AS ticks_floor_5bp,
      count(DISTINCT condition_id) FILTER (WHERE floor_net >= 0.005)::BIGINT AS events_floor_5bp,
      count(*) FILTER (WHERE floor_net >= -0.01 AND floor_net < 0)::BIGINT AS ticks_quasi_1c,
      count(DISTINCT condition_id) FILTER (WHERE floor_net >= -0.01 AND floor_net < 0)::BIGINT AS events_quasi_1c,
      max(floor_net) AS best_floor,
      avg(floor_net) AS avg_floor
    FROM base
  `;
  const r = await conn.runAndReadAll(sql);
  const row = r.getRowObjectsJson()[0];
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : (typeof v === 'bigint' ? Number(v) : v)]));
}

function coerceRow(row) {
  const o = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') o[k] = Number(v);
    else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) o[k] = Number(v);
    else o[k] = v;
  }
  return o;
}

async function listDays(conn, glob, from, to) {
  const toClause = to ? `AND TRY_CAST(ts AS TIMESTAMP) <= TIMESTAMP '${to.replace('T', ' ').replace('Z', '')}'` : '';
  const fromSql = from.replace('T', ' ').replace('Z', '');
  const sql = `
    SELECT DISTINCT dt::VARCHAR AS day
    FROM read_parquet('${glob}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${fromSql}'
    ${toClause}
    ORDER BY 1
  `;
  const r = await conn.runAndReadAll(sql);
  return r.getRowObjectsJson().map((x) => String(x.day));
}

/** Load one partition day (L1 only — memory safe). */
async function loadDayTicks(conn, glob, day, from, to) {
  const toClause = to ? `AND TRY_CAST(ts AS TIMESTAMP) <= TIMESTAMP '${to.replace('T', ' ').replace('Z', '')}'` : '';
  const fromSql = from.replace('T', ' ').replace('Z', '');
  // Prefer hive day partition path when glob is default-style
  const dayGlob = glob.includes('dt=*')
    ? glob.replace('dt=*', `dt=${day}`)
    : glob;
  const sql = `
    SELECT
      condition_id,
      epoch_ms(TRY_CAST(ts AS TIMESTAMP)) AS ts_ms,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau,
      up_ask_px_1 AS ua, down_ask_px_1 AS da,
      up_bid_px_1 AS ub, down_bid_px_1 AS db,
      COALESCE(up_ask_sz_1, 0) AS uas, COALESCE(down_ask_sz_1, 0) AS das,
      underlying_price AS btc, price_to_beat AS ptb
    FROM read_parquet('${dayGlob}', hive_partitioning=true, union_by_name=true)
    WHERE TRY_CAST(ts AS TIMESTAMP) >= TIMESTAMP '${fromSql}'
    ${toClause}
      AND COALESCE(degraded, false) = false
      AND coverage >= 0.99
      AND up_ask_px_1 IS NOT NULL AND down_ask_px_1 IS NOT NULL
      AND underlying_price IS NOT NULL AND price_to_beat IS NOT NULL
      AND epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) BETWEEN 3 AND 297
    ORDER BY condition_id, ts_ms
  `;
  const reader = await conn.runAndReadAll(sql);
  const rows = reader.getRowObjectsJson().map(coerceRow);
  const map = new Map();
  for (const r of rows) {
    const id = String(r.condition_id);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(r);
  }
  return { map, rowCount: rows.length };
}

/**
 * H1 — Atomic Pair Floor (APF)
 * Buy equal UP+DOWN only when pre-trade floor after fees >= minEdge, valid books.
 */
function simAtomicPairFloor(ticks, params) {
  const {
    minEdge = 0.005,
    minTau = 10,
    maxTau = 260,
    maxSpread = 0.04,
    minAsk = 0.02,
    maxAsk = 0.98,
    budget = 15,
    fillFrac = 0.5,
    slipMax = 0.02,
    minQty = 1,
    feeRate = 0.07,
    rebateRate = 0,
    confirmTicks = 1,
  } = params;

  let streak = 0;
  let lastBtc = null, lastPtb = null;
  let pos = null;

  for (const t of ticks) {
    const btc = num(t.btc), ptb = num(t.ptb), tau = num(t.tau);
    if (btc != null) lastBtc = btc;
    if (ptb != null) lastPtb = ptb;
    if (pos) continue;
    if (!bookValid(t, maxSpread)) { streak = 0; continue; }
    if (tau == null || tau < minTau || tau > maxTau) { streak = 0; continue; }
    const ua = num(t.ua), da = num(t.da);
    if (ua < minAsk || ua > maxAsk || da < minAsk || da > maxAsk) { streak = 0; continue; }

    const pre = pairFloorPerShare(ua, da, feeRate, rebateRate);
    if (pre.floorNet < minEdge) { streak = 0; continue; }
    streak += 1;
    if (streak < confirmTicks) continue;

    // size by budget and both books with slippage cap
    const maxUp = ua + slipMax;
    const maxDn = da + slipMax;
    const qTarget = budget / Math.max(ua + da, 0.01);
    const upFill = walkBuy(t, 'UP', qTarget, maxUp, fillFrac, 5);
    const dnFill = walkBuy(t, 'DOWN', qTarget, maxDn, fillFrac, 5);
    if (!upFill || !dnFill) continue;
    const q = Math.min(upFill.qty, dnFill.qty);
    if (q < minQty) continue;

    // re-walk exact equal qty
    const up = walkBuy(t, 'UP', q, maxUp, fillFrac, 5);
    const dn = walkBuy(t, 'DOWN', q, maxDn, fillFrac, 5);
    if (!up || !dn) continue;
    const qq = Math.min(up.qty, dn.qty);
    if (qq < minQty) continue;

    const feeU = netFee(up.avgPx, qq, feeRate, rebateRate);
    const feeD = netFee(dn.avgPx, qq, feeRate, rebateRate);
    const upCost = up.avgPx * qq;
    const downCost = dn.avgPx * qq;
    const allIn = upCost + downCost + feeU + feeD;
    // realized floor after walk may be worse than TOB pre
    const realizedFloor = qq - allIn;
    if (realizedFloor < minEdge * qq * 0.25 && realizedFloor < 0) continue; // reject if walk destroyed edge

    pos = {
      hypothesis: 'H1-atomic-pair-floor',
      upQ: qq,
      downQ: qq,
      upCost,
      downCost,
      fees: feeU + feeD,
      cash: 0,
      entryTau: tau,
      entryUa: ua,
      entryDa: da,
      preFloor: pre.floorNet,
      realizedFloorPerShare: realizedFloor / qq,
      askSum: ua + da,
      partial: !!(up.partial || dn.partial),
      locked: true,
      status: 'atomic_locked',
    };
  }

  if (!pos || lastBtc == null || lastPtb == null) return null;
  return settle(pos, lastBtc, lastPtb);
}

/**
 * H2 — Armed Sequential Completion (ASC)
 * Open only when projected lock already near-flat; complete same/next ticks or dump residual.
 */
function simArmedSequential(ticks, params) {
  const {
    minOpenTau = 40,
    maxOpenTau = 200,
    maxSpread = 0.04,
    minOpenAsk = 0.15,
    maxOpenAsk = 0.52,
    minOtherAsk = 0.40,
    maxOtherAsk = 0.58,
    minProj = -0.005,
    minLockEdge = 0.0,
    maxCompleteAsk = 0.58,
    minCompleteTau = 8,
    dumpTau = 15,
    minDumpBid = 0.04,
    budget = 10,
    fillFrac = 0.7,
    slipMax = 0.02,
    minQty = 1,
    feeRate = 0.07,
    rebateRate = 0,
    preferSameTick = true,
  } = params;

  let upQ = 0, downQ = 0, upCost = 0, downCost = 0, fees = 0, cash = 0;
  let opened = false, finished = false, status = 'none';
  let lastBtc = null, lastPtb = null;
  let entryMeta = null;

  for (const t of ticks) {
    const btc = num(t.btc), ptb = num(t.ptb), tau = num(t.tau);
    if (btc != null) lastBtc = btc;
    if (ptb != null) lastPtb = ptb;
    if (!bookValid(t, maxSpread)) continue;
    const ua = num(t.ua), da = num(t.da), ub = num(t.ub), db = num(t.db);

    if (finished) continue;

    if (opened && Math.abs(upQ - downQ) > 1e-6) {
      const needUp = upQ < downQ;
      const ask = needUp ? ua : da;
      const otherAvg = needUp ? downCost / downQ : upCost / upQ;
      const qNeed = Math.abs(upQ - downQ);
      const maxPx = ask + slipMax;
      const fill = walkBuy(t, needUp ? 'UP' : 'DOWN', qNeed, maxPx, fillFrac, 5);
      if (fill && fill.qty >= minQty) {
        const feeLeg = netFee(fill.avgPx, fill.qty, feeRate, rebateRate);
        const net = 1 - fill.avgPx - otherAvg - feePerShare(fill.avgPx, feeRate) * (1 - rebateRate);
        if (net >= minLockEdge && fill.avgPx <= maxCompleteAsk && tau >= minCompleteTau) {
          if (needUp) { upQ += fill.qty; upCost += fill.cost; }
          else { downQ += fill.qty; downCost += fill.cost; }
          fees += feeLeg;
          if (Math.abs(upQ - downQ) <= 0.05) {
            finished = true;
            status = 'locked';
          }
          continue;
        }
      }
      if (tau <= dumpTau) {
        if (upQ > downQ && ub >= minDumpBid) {
          const q = upQ - downQ;
          cash += q * ub;
          fees += netFee(ub, q, feeRate, rebateRate);
          const avg = upCost / upQ;
          upCost -= avg * q;
          upQ -= q;
          finished = true;
          status = 'dumped';
        } else if (downQ > upQ && db >= minDumpBid) {
          const q = downQ - upQ;
          cash += q * db;
          fees += netFee(db, q, feeRate, rebateRate);
          const avg = downCost / downQ;
          downCost -= avg * q;
          downQ -= q;
          finished = true;
          status = 'dumped';
        } else if (tau <= 5) {
          finished = true;
          status = 'residual_hold';
        }
      }
      continue;
    }

    if (opened) continue;
    if (tau == null || tau < minOpenTau || tau > maxOpenTau) continue;

    const ask = Math.min(ua, da);
    const other = Math.max(ua, da);
    const openUp = ua <= da;
    if (ask < minOpenAsk || ask > maxOpenAsk) continue;
    if (other < minOtherAsk || other > maxOtherAsk) continue;
    const proj = pairFloorPerShare(ua, da, feeRate, rebateRate).floorNet;
    if (proj < minProj) continue;

    if (preferSameTick && proj >= minLockEdge) {
      const qTarget = budget / Math.max(ua + da, 0.01);
      const up = walkBuy(t, 'UP', qTarget, ua + slipMax, fillFrac, 5);
      const dn = walkBuy(t, 'DOWN', qTarget, da + slipMax, fillFrac, 5);
      if (up && dn) {
        const q = Math.min(up.qty, dn.qty);
        if (q >= minQty) {
          upQ = q; downQ = q;
          upCost = up.avgPx * q;
          downCost = dn.avgPx * q;
          fees = netFee(up.avgPx, q, feeRate, rebateRate) + netFee(dn.avgPx, q, feeRate, rebateRate);
          opened = true;
          finished = true;
          status = 'same_tick_lock';
          entryMeta = { ua, da, tau, proj };
          continue;
        }
      }
    }

    const side = openUp ? 'UP' : 'DOWN';
    const openPx = openUp ? ua : da;
    const fill = walkBuy(t, side, budget / openPx, openPx + slipMax, fillFrac, 5);
    if (!fill || fill.qty < minQty) continue;
    if (openUp) { upQ = fill.qty; upCost = fill.cost; }
    else { downQ = fill.qty; downCost = fill.cost; }
    fees = netFee(fill.avgPx, fill.qty, feeRate, rebateRate);
    opened = true;
    status = 'opened';
    entryMeta = { ua, da, tau, proj, openSide: side, openPx: fill.avgPx };
  }

  if (!opened || lastBtc == null || lastPtb == null) return null;
  const pos = {
    hypothesis: 'H2-armed-sequential',
    upQ, downQ, upCost, downCost, fees, cash,
    entryTau: entryMeta?.tau,
    entryUa: entryMeta?.ua,
    entryDa: entryMeta?.da,
    preFloor: entryMeta?.proj,
    askSum: (entryMeta?.ua ?? 0) + (entryMeta?.da ?? 0),
    locked: Math.abs(upQ - downQ) <= 0.05,
    status,
  };
  return settle(pos, lastBtc, lastPtb);
}

/**
 * H3 — Quasi Floor Hold (QFH)
 * Buy dual when floor in [-maxLoss, 0) — controlled near-zero worst case, no active exit.
 * Expected to lose slightly after fees; used as controlled baseline of "cheap straddle".
 */
function simQuasiFloorHold(ticks, params) {
  const p = {
    minEdge: -0.01,
    maxEdge: 0,
    minTau: 40,
    maxTau: 180,
    maxSpread: 0.03,
    minAsk: 0.25,
    maxAsk: 0.70,
    budget: 10,
    fillFrac: 0.5,
    slipMax: 0.015,
    minQty: 1,
    feeRate: 0.07,
    rebateRate: 0,
    ...params,
  };
  // reuse atomic with negative minEdge band via custom loop
  let lastBtc = null, lastPtb = null, pos = null;
  for (const t of ticks) {
    const btc = num(t.btc), ptb = num(t.ptb), tau = num(t.tau);
    if (btc != null) lastBtc = btc;
    if (ptb != null) lastPtb = ptb;
    if (pos) continue;
    if (!bookValid(t, p.maxSpread)) continue;
    if (tau == null || tau < p.minTau || tau > p.maxTau) continue;
    const ua = num(t.ua), da = num(t.da);
    if (ua < p.minAsk || ua > p.maxAsk || da < p.minAsk || da > p.maxAsk) continue;
    const pre = pairFloorPerShare(ua, da, p.feeRate, p.rebateRate);
    if (pre.floorNet < p.minEdge || pre.floorNet >= p.maxEdge) continue;
    const qTarget = p.budget / Math.max(ua + da, 0.01);
    const up = walkBuy(t, 'UP', qTarget, ua + p.slipMax, p.fillFrac, 5);
    const dn = walkBuy(t, 'DOWN', qTarget, da + p.slipMax, p.fillFrac, 5);
    if (!up || !dn) continue;
    const q = Math.min(up.qty, dn.qty);
    if (q < p.minQty) continue;
    const feeU = netFee(up.avgPx, q, p.feeRate, p.rebateRate);
    const feeD = netFee(dn.avgPx, q, p.feeRate, p.rebateRate);
    pos = {
      hypothesis: 'H3-quasi-floor-hold',
      upQ: q, downQ: q,
      upCost: up.avgPx * q,
      downCost: dn.avgPx * q,
      fees: feeU + feeD,
      cash: 0,
      entryTau: tau,
      entryUa: ua,
      entryDa: da,
      preFloor: pre.floorNet,
      askSum: ua + da,
      locked: true,
      status: 'quasi_hold',
    };
  }
  if (!pos || lastBtc == null || lastPtb == null) return null;
  return settle(pos, lastBtc, lastPtb);
}

function settle(pos, lastBtc, lastPtb) {
  const winnerUp = lastBtc >= lastPtb;
  const payout = (winnerUp ? pos.upQ : pos.downQ);
  const totalCost = pos.upCost + pos.downCost;
  const pnlGross = (pos.cash || 0) + payout - totalCost;
  const pnl = pnlGross - pos.fees;
  const pnlIfUp = (pos.cash || 0) + pos.upQ - totalCost - pos.fees;
  const pnlIfDown = (pos.cash || 0) + pos.downQ - totalCost - pos.fees;
  const worst = Math.min(pnlIfUp, pnlIfDown);
  const best = Math.max(pnlIfUp, pnlIfDown);
  const balanced = Math.abs(pos.upQ - pos.downQ) <= Math.max(0.05, 0.02 * Math.max(pos.upQ, pos.downQ, 1));
  const nearZero = Math.abs(pnl) < 0.15;
  const freeroll = balanced && worst >= -0.05 && best > 0.2;
  const lockProfit = balanced && worst > 0.01;

  return {
    ...pos,
    totalCost,
    pnlGross,
    pnl,
    pnlIfUp,
    pnlIfDown,
    worst,
    best,
    balanced,
    winnerUp,
    nearZero,
    freeroll,
    lockProfit,
    sideNeutral: Math.abs(pnlIfUp - pnlIfDown) < 0.15,
  };
}

// ---- baselines ----
function simOnlySide(ticks, side, params) {
  const { minTau = 60, maxTau = 180, minAsk = 0.2, maxAsk = 0.55, budget = 10, fillFrac = 0.5, slipMax = 0.02, minQty = 1, feeRate = 0.07, rebateRate = 0, maxSpread = 0.05 } = params;
  let lastBtc = null, lastPtb = null, pos = null;
  for (const t of ticks) {
    const btc = num(t.btc), ptb = num(t.ptb), tau = num(t.tau);
    if (btc != null) lastBtc = btc;
    if (ptb != null) lastPtb = ptb;
    if (pos) continue;
    if (!bookValid(t, maxSpread)) continue;
    if (tau == null || tau < minTau || tau > maxTau) continue;
    const ask = side === 'UP' ? num(t.ua) : num(t.da);
    if (ask == null || ask < minAsk || ask > maxAsk) continue;
    const fill = walkBuy(t, side, budget / ask, ask + slipMax, fillFrac, 5);
    if (!fill || fill.qty < minQty) continue;
    const fee = netFee(fill.avgPx, fill.qty, feeRate, rebateRate);
    pos = {
      hypothesis: `baseline-only-${side}`,
      upQ: side === 'UP' ? fill.qty : 0,
      downQ: side === 'DOWN' ? fill.qty : 0,
      upCost: side === 'UP' ? fill.cost : 0,
      downCost: side === 'DOWN' ? fill.cost : 0,
      fees: fee,
      cash: 0,
      locked: false,
      status: 'single',
      askSum: ask,
      preFloor: null,
    };
  }
  if (!pos || lastBtc == null || lastPtb == null) return null;
  return settle(pos, lastBtc, lastPtb);
}

function simRandomDual(ticks, params) {
  const { minTau = 60, maxTau = 180, budget = 10, fillFrac = 0.5, slipMax = 0.02, feeRate = 0.07, rebateRate = 0, maxSpread = 0.05 } = params;
  const cands = [];
  let lastBtc = null, lastPtb = null;
  for (const t of ticks) {
    const btc = num(t.btc), ptb = num(t.ptb), tau = num(t.tau);
    if (btc != null) lastBtc = btc;
    if (ptb != null) lastPtb = ptb;
    if (!bookValid(t, maxSpread)) continue;
    if (tau == null || tau < minTau || tau > maxTau) continue;
    cands.push(t);
  }
  if (!cands.length || lastBtc == null || lastPtb == null) return null;
  const t = cands[Math.floor(cands.length * 0.35)];
  const ua = num(t.ua), da = num(t.da);
  const qTarget = budget / Math.max(ua + da, 0.01);
  const up = walkBuy(t, 'UP', qTarget, ua + slipMax, fillFrac, 5);
  const dn = walkBuy(t, 'DOWN', qTarget, da + slipMax, fillFrac, 5);
  if (!up || !dn) return null;
  const q = Math.min(up.qty, dn.qty);
  const fees = netFee(up.avgPx, q, feeRate, rebateRate) + netFee(dn.avgPx, q, feeRate, rebateRate);
  return settle({
    hypothesis: 'baseline-random-dual',
    upQ: q, downQ: q,
    upCost: up.avgPx * q,
    downCost: dn.avgPx * q,
    fees, cash: 0,
    askSum: ua + da,
    preFloor: pairFloorPerShare(ua, da, feeRate, rebateRate).floorNet,
    locked: true,
    status: 'random_dual',
  }, lastBtc, lastPtb);
}

function summarize(results, name) {
  if (!results.length) {
    return {
      name, n: 0, totalPnl: 0, avgPnl: null, winRate: null, lossRate: null, flatRate: null,
      pf: null, maxDd: null, expectancy: null, lockRate: null, freerollRate: null,
      nearZeroRate: null, sideNeutralRate: null, avgWorst: null, avgBest: null,
      totalFees: 0, feeDragPct: null, avgCost: null, maxLoss: null,
    };
  }
  const pnls = results.map((r) => r.pnl);
  const total = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter((x) => x > 0.05).length;
  const losses = pnls.filter((x) => x < -0.05).length;
  const flats = results.length - wins - losses;
  const gp = pnls.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(pnls.filter((x) => x < 0).reduce((a, b) => a + b, 0));
  const pf = gl > 1e-9 ? gp / gl : (gp > 0 ? 99 : 0);
  let eq = 0, peak = 0, dd = 0;
  for (const p of pnls) {
    eq += p;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  const fees = results.reduce((a, r) => a + (r.fees || 0), 0);
  const locks = results.filter((r) => r.lockProfit).length;
  const freerolls = results.filter((r) => r.freeroll).length;
  const nearZero = results.filter((r) => r.nearZero).length;
  const sideNeut = results.filter((r) => r.sideNeutral).length;
  const balanced = results.filter((r) => r.balanced).length;
  const costs = results.map((r) => r.totalCost || 0);
  const worsts = results.map((r) => r.worst);
  return {
    name,
    n: results.length,
    totalPnl: round(total),
    avgPnl: round(total / results.length),
    winRate: round(wins / results.length),
    lossRate: round(losses / results.length),
    flatRate: round(flats / results.length),
    pf: round(pf),
    maxDd: round(dd),
    expectancy: round(total / results.length),
    lockRate: round(locks / results.length),
    freerollRate: round(freerolls / results.length),
    nearZeroRate: round(nearZero / results.length),
    sideNeutralRate: round(sideNeut / results.length),
    balancedRate: round(balanced / results.length),
    avgWorst: round(worsts.reduce((a, b) => a + b, 0) / worsts.length),
    avgBest: round(results.reduce((a, r) => a + r.best, 0) / results.length),
    totalFees: round(fees),
    feeDragPct: round(100 * fees / (Math.abs(total) + fees + 1e-9)),
    avgCost: round(costs.reduce((a, b) => a + b, 0) / costs.length),
    maxLoss: round(Math.min(...pnls)),
  };
}

function splitAndWindows(results, map, order) {
  const n = results.length;
  const i1 = Math.floor(n * 0.6);
  const i2 = Math.floor(n * 0.8);
  const maxTs = Math.max(...order.map((id) => Number(map.get(id)[0].ts_ms)));
  const t72 = maxTs - 72 * 3600 * 1000;
  const t24 = maxTs - 24 * 3600 * 1000;
  return {
    train: summarize(results.slice(0, i1), 'train'),
    validation: summarize(results.slice(i1, i2), 'validation'),
    holdout: summarize(results.slice(i2), 'holdout'),
    last72h: summarize(results.filter((r) => Number(r.ts_ms) >= t72), 'last72h'),
    last24h: summarize(results.filter((r) => Number(r.ts_ms) >= t24), 'last24h'),
  };
}

function finalizeVariant(id, params, results, eventTsById) {
  results.sort((a, b) => a.ts_ms - b.ts_ms);
  const orderIds = results.map((r) => r.condition_id);
  // build minimal map/order adapters for split helper
  const maxTs = results.length ? Math.max(...results.map((r) => r.ts_ms)) : 0;
  const t72 = maxTs - 72 * 3600 * 1000;
  const t24 = maxTs - 24 * 3600 * 1000;
  const n = results.length;
  const i1 = Math.floor(n * 0.6);
  const i2 = Math.floor(n * 0.8);
  return {
    id,
    params,
    full: summarize(results, id),
    splits: {
      train: summarize(results.slice(0, i1), 'train'),
      validation: summarize(results.slice(i1, i2), 'validation'),
      holdout: summarize(results.slice(i2), 'holdout'),
      last72h: summarize(results.filter((r) => r.ts_ms >= t72), 'last72h'),
      last24h: summarize(results.filter((r) => r.ts_ms >= t24), 'last24h'),
    },
    sample: results.slice(0, 5).map((r) => ({
      condition_id: r.condition_id,
      pnl: round(r.pnl),
      worst: round(r.worst),
      best: round(r.best),
      status: r.status,
      preFloor: round(r.preFloor),
      askSum: round(r.askSum),
      fees: round(r.fees),
    })),
    // keep only lightweight stats in memory afterwards
    n: results.length,
    orderIds,
  };
}

function decide(variant) {
  const h = variant.splits.holdout;
  const f = variant.full;
  const reasons = [];
  let interesting = true;
  if (!h.n || h.n < 3) {
    interesting = false;
    reasons.push(`holdout sample too small (n=${h.n || 0})`);
  }
  if ((h.totalPnl ?? 0) <= 0) {
    interesting = false;
    reasons.push(`holdout net PnL not positive (${h.totalPnl})`);
  }
  if ((h.pf ?? 0) < 2 && (h.n || 0) >= 10) {
    interesting = false;
    reasons.push(`holdout PF ${h.pf} < 2`);
  }
  if ((h.sideNeutralRate ?? 0) < 0.8 && (f.sideNeutralRate ?? 0) < 0.8) {
    interesting = false;
    reasons.push('not side-neutral enough');
  }
  if ((variant.splits.last72h.totalPnl ?? 0) < 0 && (variant.splits.last72h.n || 0) > 0) {
    reasons.push('last72h negative (warning)');
  }
  if ((f.n || 0) > 0 && (f.avgWorst ?? -1) < -1) {
    reasons.push(`avg worst case ${f.avgWorst} not near zero`);
  }
  return { interesting, reasons, recommended: interesting };
}

async function main() {
  const args = parseArgs(process.argv);
  const scenario = FEE_SCENARIOS[args.feeScenario] || FEE_SCENARIOS.base;
  const feeRate = args.feeRate ?? scenario.feeRate;
  const rebateRate = args.rebateRate ?? scenario.rebateRate;

  console.log('=== Pair Floor Invariant V1 Laboratory ===');
  console.log(JSON.stringify({
    from: args.from,
    to: args.to,
    mode: args.mode,
    feeScenario: args.feeScenario,
    feeRate,
    rebateRate,
    glob: args.glob,
  }, null, 2));

  const db = await DuckDBInstance.create(':memory:');
  const conn = await db.connect();

  console.log('\n[1] Coverage SQL...');
  const coverage = await loadCoverage(conn, args.glob, args.from, args.to);
  console.log(JSON.stringify(coverage, null, 2));

  console.log('\n[2] Opportunity stats (valid books, after fees)...');
  const opps = await loadOpportunityStats(conn, args.glob, args.from, args.to, feeRate);
  console.log(JSON.stringify(opps, null, 2));

  console.log('\n[3] Streaming day partitions + causal sims...');
  const days = await listDays(conn, args.glob, args.from, args.to);
  console.log(`days=${days.length}`);

  const feeParams = { feeRate, rebateRate };

  const specs = [
    // H1
    { id: 'H1-atomic-5bp', sim: simAtomicPairFloor, params: { minEdge: 0.005, confirmTicks: 1, budget: 15, fillFrac: 0.5, slipMax: 0.02, maxSpread: 0.04, ...feeParams } },
    { id: 'H1-atomic-0', sim: simAtomicPairFloor, params: { minEdge: 0.0, confirmTicks: 1, budget: 15, fillFrac: 0.5, slipMax: 0.02, maxSpread: 0.04, ...feeParams } },
    { id: 'H1-atomic-1c', sim: simAtomicPairFloor, params: { minEdge: 0.01, confirmTicks: 1, budget: 15, fillFrac: 0.5, slipMax: 0.02, maxSpread: 0.04, ...feeParams } },
    { id: 'H1-atomic-5bp-confirm2', sim: simAtomicPairFloor, params: { minEdge: 0.005, confirmTicks: 2, budget: 12, fillFrac: 0.5, slipMax: 0.015, maxSpread: 0.03, ...feeParams } },
    { id: 'H1-atomic-5bp-fill30', sim: simAtomicPairFloor, params: { minEdge: 0.005, confirmTicks: 1, budget: 10, fillFrac: 0.3, slipMax: 0.02, maxSpread: 0.04, ...feeParams } },
    // H2
    { id: 'H2-armed-0', sim: simArmedSequential, params: { minOpenTau: 40, maxOpenTau: 200, maxSpread: 0.04, minOpenAsk: 0.15, maxOpenAsk: 0.52, minOtherAsk: 0.40, maxOtherAsk: 0.58, minProj: -0.005, minLockEdge: 0.0, maxCompleteAsk: 0.58, minCompleteTau: 8, dumpTau: 15, minDumpBid: 0.04, budget: 10, fillFrac: 0.7, slipMax: 0.02, minQty: 1, preferSameTick: true, ...feeParams } },
    { id: 'H2-armed-5bp', sim: simArmedSequential, params: { minOpenTau: 40, maxOpenTau: 200, maxSpread: 0.04, minOpenAsk: 0.15, maxOpenAsk: 0.50, minOtherAsk: 0.40, maxOtherAsk: 0.52, minProj: 0.0, minLockEdge: 0.005, maxCompleteAsk: 0.52, minCompleteTau: 8, dumpTau: 12, minDumpBid: 0.04, budget: 10, fillFrac: 0.7, slipMax: 0.02, minQty: 1, preferSameTick: true, ...feeParams } },
    { id: 'H2-cheaper-toxic', sim: simArmedSequential, params: { minOpenTau: 60, maxOpenTau: 180, maxSpread: 0.06, minOpenAsk: 0.15, maxOpenAsk: 0.40, minOtherAsk: 0.50, maxOtherAsk: 0.80, minProj: -1, minLockEdge: 0.02, maxCompleteAsk: 0.70, minCompleteTau: 10, dumpTau: 20, minDumpBid: 0.04, budget: 10, fillFrac: 1, slipMax: 0.02, minQty: 1, preferSameTick: false, ...feeParams } },
    // H3
    { id: 'H3-quasi-1c', sim: simQuasiFloorHold, params: { minEdge: -0.01, maxEdge: 0, ...feeParams } },
    // baselines
    { id: 'baseline-only-UP', sim: (ticks, p) => simOnlySide(ticks, 'UP', p), params: { ...feeParams, budget: 10 }, baseline: true },
    { id: 'baseline-only-DOWN', sim: (ticks, p) => simOnlySide(ticks, 'DOWN', p), params: { ...feeParams, budget: 10 }, baseline: true },
    { id: 'baseline-random-dual', sim: simRandomDual, params: { ...feeParams, budget: 10 }, baseline: true },
    // fee sensitivity
    { id: 'H1-fee-pessimistic', sim: simAtomicPairFloor, params: { minEdge: 0.005, confirmTicks: 1, budget: 15, fillFrac: 0.5, slipMax: 0.02, maxSpread: 0.04, feeRate: 0.07, rebateRate: 0 }, feeSens: true },
    { id: 'H1-fee-base', sim: simAtomicPairFloor, params: { minEdge: 0.005, confirmTicks: 1, budget: 15, fillFrac: 0.5, slipMax: 0.02, maxSpread: 0.04, feeRate: 0.07, rebateRate: 0 }, feeSens: true },
    { id: 'H1-fee-optimistic', sim: simAtomicPairFloor, params: { minEdge: 0.005, confirmTicks: 1, budget: 15, fillFrac: 0.5, slipMax: 0.02, maxSpread: 0.04, feeRate: 0.07, rebateRate: 0.44 }, feeSens: true },
    { id: 'H1-fee-maker', sim: simAtomicPairFloor, params: { minEdge: 0.005, confirmTicks: 1, budget: 15, fillFrac: 0.5, slipMax: 0.02, maxSpread: 0.04, feeRate: 0, rebateRate: 0 }, feeSens: true },
  ];

  const buckets = Object.fromEntries(specs.map((s) => [s.id, []]));
  let totalRows = 0;
  let totalEvents = 0;
  let eventsSeen = 0;

  for (const day of days) {
    const { map, rowCount } = await loadDayTicks(conn, args.glob, day, args.from, args.to);
    totalRows += rowCount;
    const ids = [...map.keys()].sort((a, b) => Number(map.get(a)[0].ts_ms) - Number(map.get(b)[0].ts_ms));
    totalEvents += ids.length;
    for (const eid of ids) {
      if (args.maxEvents && eventsSeen >= args.maxEvents) break;
      eventsSeen += 1;
      const ticks = map.get(eid);
      const tsMs = Number(ticks[0].ts_ms);
      for (const s of specs) {
        const r = s.sim(ticks, s.params);
        if (!r) continue;
        buckets[s.id].push({
          ...r,
          condition_id: eid,
          ts_ms: tsMs,
        });
      }
    }
    if (args.maxEvents && eventsSeen >= args.maxEvents) break;
    if (days.indexOf(day) % 10 === 0) {
      console.log(`  day ${day} rows=${rowCount} events=${ids.length} cumulativeEvents=${eventsSeen}`);
    }
  }
  conn.closeSync();
  console.log(JSON.stringify({ totalRows, totalEvents: eventsSeen }, null, 2));

  const variants = specs
    .filter((s) => !s.baseline && !s.feeSens)
    .map((s) => finalizeVariant(s.id, s.params, buckets[s.id]));
  const baselines = specs
    .filter((s) => s.baseline)
    .map((s) => finalizeVariant(s.id, s.params, buckets[s.id]));
  const feeSens = specs
    .filter((s) => s.feeSens)
    .map((s) => finalizeVariant(s.id, s.params, buckets[s.id]));

  const decisions = Object.fromEntries(variants.map((v) => [v.id, decide(v)]));

  // Prefer stricter atomic edge among interesting H1 variants (robustness over raw n).
  let recommended = null;
  let bestScore = -Infinity;
  for (const v of variants) {
    const d = decisions[v.id];
    if (!d.interesting) continue;
    const h = v.splits.holdout;
    const minEdge = Number(v.params?.minEdge ?? 0);
    const score = (h.totalPnl || 0) > 0
      ? minEdge * 1000 + (h.pf || 0) * Math.sqrt(h.n || 1) + (h.sideNeutralRate || 0) * 10
      : -1e9;
    if (score > bestScore) {
      bestScore = score;
      recommended = v.id;
    }
  }
  if (!recommended) {
    const atomicPos = variants.filter((v) => v.id.startsWith('H1') && (v.full.totalPnl || 0) > 0 && (v.full.n || 0) > 0);
    if (atomicPos.length) {
      atomicPos.sort((a, b) => (b.full.totalPnl || 0) - (a.full.totalPnl || 0));
      recommended = atomicPos[0].id;
      decisions[recommended] = {
        ...decisions[recommended],
        recommended: true,
        reasons: [...(decisions[recommended]?.reasons || []), 'best atomic among failed interest criteria — research only'],
      };
    }
  }

  const report = {
    theory: 'Pair Floor Invariant V1',
    generatedAt: new Date().toISOString(),
    range: { from: args.from, to: args.to || coverage.last_ts },
    coverage,
    opportunityStats: opps,
    feeModel: {
      formula: 'shares * feeRate * price * (1 - price)',
      category: 'crypto',
      scenario: args.feeScenario,
      feeRate,
      rebateRate,
      docs: 'https://docs.polymarket.com/trading/fees',
    },
    hypotheses: {
      H1: 'Atomic Pair Floor — equal UP+DOWN only when settlement floor after fees >= minEdge on valid books',
      H2: 'Armed Sequential Completion — open when projected floor near zero, complete or dump',
      H3: 'Quasi Floor Hold — dual hold when floor in [-1c, 0) as controlled cheap straddle',
    },
    variants: variants.map((v) => ({
      id: v.id,
      full: v.full,
      splits: v.splits,
      decision: decisions[v.id],
      sample: v.sample,
    })),
    baselines: baselines.map((v) => ({ id: v.id, full: v.full, splits: v.splits })),
    feeSensitivity: feeSens.map((v) => ({ id: v.id, full: v.full, holdout: v.splits.holdout })),
    recommended,
    verdict: recommended && decisions[recommended]?.interesting
      ? 'INTERESTING_RESEARCH — structural market-neutral edge exists but is ultra-low frequency; not ready for size'
      : 'NO_DUAL_SIDE_STRATEGY_SURVIVED_INTEREST_CRITERIA — atomic floor is real but too rare / holdout fragile; sequential residual toxicity kills EV; random dual systematically loses after fees',
  };

  console.log('\n=== VARIANT RESULTS ===');
  for (const v of report.variants) {
    console.log(JSON.stringify({
      id: v.id,
      full: v.full,
      holdout: v.splits.holdout,
      last72h: v.splits.last72h,
      last24h: v.splits.last24h,
      decision: v.decision,
    }));
  }
  console.log('\n=== BASELINES ===');
  for (const b of report.baselines) {
    console.log(JSON.stringify({ id: b.id, full: b.full, holdout: b.splits.holdout }));
  }
  console.log('\n=== FEE SENSITIVITY (H1-atomic-5bp family) ===');
  for (const f of report.feeSensitivity) {
    console.log(JSON.stringify(f));
  }
  console.log('\n=== VERDICT ===');
  console.log(JSON.stringify({ recommended: report.recommended, verdict: report.verdict }, null, 2));

  const outPath = args.outJson
    || resolve(ROOT, 'reports/labs/pair-floor-invariant', `pfi-${Date.now()}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
