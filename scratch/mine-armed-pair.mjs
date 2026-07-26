/**
 * Armed Pair Lock: sem inventário residual.
 * 1) "Arma" quando vê perna barata (não compra ainda)
 * 2) Dispara compra das DUAS pernas só quando o par trava edge
 * 3) Opcional: latência 1 tick
 */
import { DuckDBInstance } from '@duckdb/node-api';

const GLOB = 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=*/*.parquet';
const FEE = 0.07;

function feePair(ua, da, q) {
  return q * FEE * ua * (1 - ua) + q * FEE * da * (1 - da);
}
function round(x) {
  return Math.round(Number(x) * 10000) / 10000;
}
async function query(conn, sql) {
  return (await conn.runAndReadAll(sql)).getRowObjectsJson();
}
function groupByEvent(rows) {
  const map = new Map();
  for (const r of rows) {
    const id = String(r.condition_id);
    let a = map.get(id);
    if (!a) { a = []; map.set(id, a); }
    a.push(r);
  }
  return map;
}

function sim(ticks, v) {
  let armedSide = null; // 'UP' | 'DOWN'
  let armedAsk = null;
  let armedTau = null;
  let done = false;
  let pending = null; // latency: execute next tick
  let upQ = 0, downQ = 0, upCost = 0, downCost = 0, fees = 0;
  let lastBtc = null, lastPtb = null;
  let entries = 0;

  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    const ua = Number(t.ua), da = Number(t.da);
    const tau = Number(t.tau);
    lastBtc = Number(t.btc); lastPtb = Number(t.ptb);
    if (!(ua > 0 && da > 0)) continue;

    // execute pending from latency
    if (pending && !done) {
      const pua = ua, pda = da;
      const sum = pua + pda;
      const f = FEE * pua * (1 - pua) + FEE * pda * (1 - pda);
      const net = 1 - sum - f;
      if (net >= v.minLockEdge && sum <= v.maxSumAtFire && tau >= v.minFireTau) {
        const q = v.budget / Math.max(sum, 0.01);
        upQ = q; downQ = q;
        upCost = q * pua; downCost = q * pda;
        fees = feePair(pua, pda, q);
        entries = 2;
        done = true;
      }
      pending = null;
      continue;
    }

    if (done) continue;
    if (tau < v.minArmTau || tau > v.maxArmTau) continue;
    const dist = Math.abs(lastBtc - lastPtb);
    if (dist > v.maxDist) continue;

    // arm on cheap leg
    if (!armedSide) {
      if (ua <= v.maxArmAsk && da > ua) {
        if (!v.requireOtherMin || da >= v.minOtherAtArm) {
          armedSide = 'UP'; armedAsk = ua; armedTau = tau;
        }
      } else if (da <= v.maxArmAsk && ua > da) {
        if (!v.requireOtherMin || ua >= v.minOtherAtArm) {
          armedSide = 'DOWN'; armedAsk = da; armedTau = tau;
        }
      } else if (ua <= v.maxArmAsk && da <= v.maxArmAsk) {
        // both cheap: fire immediately if locks
        const sum = ua + da;
        const f = FEE * ua * (1 - ua) + FEE * da * (1 - da);
        const net = 1 - sum - f;
        if (net >= v.minLockEdge) {
          if (v.latencyTicks > 0) { pending = true; continue; }
          const q = v.budget / Math.max(sum, 0.01);
          upQ = q; downQ = q; upCost = q * ua; downCost = q * da;
          fees = feePair(ua, da, q); entries = 2; done = true;
        }
      }
      continue;
    }

    // expire arm
    if (armedTau - tau > v.armTtlSec) {
      armedSide = null; armedAsk = null; armedTau = null;
      continue;
    }

    // fire when pair locks at CURRENT prices (both legs now)
    const sum = ua + da;
    const f = FEE * ua * (1 - ua) + FEE * da * (1 - da);
    const net = 1 - sum - f;
    // also require that the originally cheap side is still not crazy expensive
    const sideAsk = armedSide === 'UP' ? ua : da;
    if (sideAsk > v.maxSideAtFire) continue;
    if (net >= v.minLockEdge && sum <= v.maxSumAtFire && tau >= v.minFireTau) {
      if (v.latencyTicks > 0) { pending = true; continue; }
      const q = v.budget / Math.max(sum, 0.01);
      upQ = q; downQ = q; upCost = q * ua; downCost = q * da;
      fees = feePair(ua, da, q); entries = 2; done = true;
    }
  }

  if (entries === 0) return null;
  // fully paired always
  const winnerUp = lastBtc >= lastPtb;
  const payout = winnerUp ? upQ : downQ;
  // for equal qty, payout is always upQ (=downQ)
  const pnl = Math.min(upQ, downQ) - upCost - downCost - fees;
  return { pnl, entries, sumCost: upCost + downCost + fees, pairs: Math.min(upQ, downQ) };
}

function summarize(eventMap, v) {
  let totalPnl = 0, trades = 0, wins = 0, gw = 0, gl = 0, june = 0, july = 0;
  for (const [, ticks] of eventMap) {
    const r = sim(ticks, v);
    if (!r) continue;
    trades += 1; totalPnl += r.pnl;
    if (r.pnl > 0) { wins += 1; gw += r.pnl; } else gl += -r.pnl;
    if (String(ticks[0].dt).startsWith('2026-06')) june += r.pnl; else july += r.pnl;
  }
  return {
    id: v.id, trades, pnl: round(totalPnl), wr: trades ? round(wins / trades) : 0,
    pf: gl > 0 ? round(gw / gl) : (gw > 0 ? 99 : 0),
    exp: trades ? round(totalPnl / trades) : 0, june: round(june), july: round(july),
  };
}

async function main() {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  // broader sample: may+june+july chunks
  const rows = await query(conn, `
    SELECT condition_id, dt,
      epoch_ms(TRY_CAST(ts AS TIMESTAMP)) AS ts_ms,
      epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) AS tau,
      up_ask_px_1 AS ua, down_ask_px_1 AS da,
      underlying_price AS btc, price_to_beat AS ptb
    FROM read_parquet('${GLOB}', hive_partitioning=true)
    WHERE COALESCE(degraded, false) = false AND coverage >= 0.99
      AND dt >= '2026-05-01' AND dt <= '2026-07-14'
      AND up_ask_px_1 BETWEEN 0.01 AND 0.99 AND down_ask_px_1 BETWEEN 0.01 AND 0.99
      AND epoch(TRY_CAST(event_end AS TIMESTAMP)) - epoch(TRY_CAST(ts AS TIMESTAMP)) BETWEEN 5 AND 290
    ORDER BY condition_id, ts_ms
  `);
  console.log('ticks', rows.length);
  const eventMap = groupByEvent(rows);
  console.log('events', eventMap.size);

  const base = {
    budget: 20,
    maxArmAsk: 0.35,
    minOtherAtArm: 0.50,
    requireOtherMin: true,
    maxArmTau: 250,
    minArmTau: 40,
    armTtlSec: 120,
    maxDist: 40,
    minLockEdge: 0.02,
    maxSumAtFire: 0.97,
    maxSideAtFire: 0.55,
    minFireTau: 15,
    latencyTicks: 0,
  };

  const variants = [
    { ...base, id: 'arm35-sum97-e02' },
    { ...base, id: 'arm30-sum96-e02', maxArmAsk: 0.30, maxSumAtFire: 0.96 },
    { ...base, id: 'arm40-sum98-e015', maxArmAsk: 0.40, maxSumAtFire: 0.98, minLockEdge: 0.015 },
    { ...base, id: 'arm35-sum99-e01', maxSumAtFire: 0.99, minLockEdge: 0.01 },
    { ...base, id: 'arm35-sum95-e03', maxSumAtFire: 0.95, minLockEdge: 0.03 },
    { ...base, id: 'arm35-d25', maxDist: 25 },
    { ...base, id: 'arm35-d60', maxDist: 60 },
    { ...base, id: 'arm35-lat1', latencyTicks: 1 },
    { ...base, id: 'arm35-lat1-sum98', latencyTicks: 1, maxSumAtFire: 0.98, minLockEdge: 0.01 },
    { ...base, id: 'no-other-min', requireOtherMin: false },
    { ...base, id: 'ttl60', armTtlSec: 60 },
    { ...base, id: 'ttl180', armTtlSec: 180 },
    { ...base, id: 'wide-fire-side70', maxSideAtFire: 0.70, maxSumAtFire: 0.98 },
    { ...base, id: 'fire-any-sum97', maxSideAtFire: 0.99, maxSumAtFire: 0.97 },
    // pure simultaneous without arm (always arm both)
    { ...base, id: 'pure-sum96', maxArmAsk: 0.99, requireOtherMin: false, maxSumAtFire: 0.96, maxSideAtFire: 0.99 },
    { ...base, id: 'pure-sum97', maxArmAsk: 0.99, requireOtherMin: false, maxSumAtFire: 0.97, maxSideAtFire: 0.99 },
    { ...base, id: 'pure-sum98', maxArmAsk: 0.99, requireOtherMin: false, maxSumAtFire: 0.98, maxSideAtFire: 0.99, minLockEdge: 0.01 },
    { ...base, id: 'pure-sum99', maxArmAsk: 0.99, requireOtherMin: false, maxSumAtFire: 0.99, maxSideAtFire: 0.99, minLockEdge: 0.005 },
    { ...base, id: 'pure-sum98-lat1', maxArmAsk: 0.99, requireOtherMin: false, maxSumAtFire: 0.98, maxSideAtFire: 0.99, minLockEdge: 0.01, latencyTicks: 1 },
    { ...base, id: 'pure-sum97-b50', maxArmAsk: 0.99, requireOtherMin: false, maxSumAtFire: 0.97, maxSideAtFire: 0.99, budget: 50 },
  ];

  for (const v of variants) {
    console.log(JSON.stringify(summarize(eventMap, v)));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
