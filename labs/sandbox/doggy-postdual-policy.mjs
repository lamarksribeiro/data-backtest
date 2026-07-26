/**
 * Etapa 2: classificar cada fill pós-dual por estado pré-fill → ação.
 * Extrai política de chase / stop / tilt residual.
 *
 * Usage:
 *   node labs/sandbox/doggy-postdual-policy.mjs [--fetch]
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('.tmp/pair-ladder-re');
const WALLET = '0x0484e64092ba4108c2786b61e6fc052d3bf41b1a';
const args = new Set(process.argv.slice(2));
const fetchMore = args.has('--fetch');

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
function avgBucket(avgSum) {
  if (avgSum == null) return 'NO_DUAL';
  if (avgSum <= 0.95) return 'LE_095';
  if (avgSum <= 0.98) return '095_098';
  if (avgSum < 1.0) return '098_100';
  if (avgSum < 1.02) return '100_102';
  return 'GE_102';
}
function resBucket(residual) {
  if (residual <= 1e-9) return 'FLAT';
  if (residual < 25) return 'R0_25';
  if (residual < 50) return 'R25_50';
  if (residual < 100) return 'R50_100';
  if (residual < 200) return 'R100_200';
  return 'R200p';
}
function secBucket(sec) {
  if (sec == null) return 'UNK';
  if (sec < 60) return 'S0_60';
  if (sec < 120) return 'S60_120';
  if (sec < 180) return 'S120_180';
  if (sec < 240) return 'S180_240';
  return 'S240_300';
}
function pxBucket(px) {
  if (px <= 0.15) return 'VAC_015';
  if (px <= 0.30) return 'CHEAP_030';
  if (px <= 0.45) return 'MID_045';
  if (px <= 0.55) return 'FAIR_055';
  if (px <= 0.70) return 'RICH_070';
  return 'EXP_070p';
}
function sizeBucket(sz) {
  if (sz <= 55) return 'CLIP_50';
  if (sz <= 110) return 'CLIP_100';
  if (sz <= 210) return 'CLIP_200';
  return 'CLIP_BIG';
}
function bump(map, key, n = 1) {
  map[key] = (map[key] || 0) + n;
}
function topEntries(map, n = 12) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => ({ key: k, n: v }));
}
function frac(a, b) {
  return b ? a / b : null;
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
    await new Promise((r) => setTimeout(r, 80));
  }
  return all;
}

function loadActivity() {
  const p = path.join(OUT, 'doggy-activity-fresh.json');
  if (!fs.existsSync(p)) throw new Error('missing doggy-activity-fresh.json — run with --fetch');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function buildEvents(rows) {
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
        upS,
        downS,
        avgSum,
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
      slug,
      start,
      fills,
      path,
      upS,
      downS,
      avgSum: avgUp != null && avgDown != null ? avgUp + avgDown : null,
      residual: Math.abs(upS - downS),
      residualSide: upS > downS ? 'Up' : downS > upS ? 'Down' : null,
      buyUsdc,
      redeemUsdc: redeem?.usdc ?? null,
      redeemOutcome: redeem?.outcome
        ? (String(redeem.outcome).toLowerCase().includes('up') ? 'Up' : 'Down')
        : null,
      pnl: redeem ? redeem.usdc - buyUsdc : null,
    });
  }
  return events;
}

function dualIndex(path) {
  let seenUp = false;
  let seenDown = false;
  for (let i = 0; i < path.length; i += 1) {
    if (path[i].outcome === 'Up') seenUp = true;
    else seenDown = true;
    if (seenUp && seenDown) return i;
  }
  return -1;
}

function classifyTransitions(events) {
  const transitions = [];
  const actionByState = {}; // stateKey -> { UNDER, OVER, FLAT }
  const matrix = {}; // avg|res|sec -> action counts
  const effects = {
    under: { n: 0, improveAvg: 0, reduceRes: 0, worsenAvg: 0, growRes: 0 },
    over: { n: 0, improveAvg: 0, reduceRes: 0, worsenAvg: 0, growRes: 0 },
    flat: { n: 0, improveAvg: 0, reduceRes: 0, worsenAvg: 0, growRes: 0 },
  };
  const byAvgAction = {};
  const byPxAction = {};
  const bySecAction = {};
  const byResAction = {};
  const sizeByAction = { UNDER: [], OVER: [], FLAT: [] };
  const pxByAction = { UNDER: [], OVER: [], FLAT: [] };
  const lockedContinue = { lockedStates: 0, continued: 0, vacuum: 0, under: 0, over: 0 };
  const toxicContinue = { toxicStates: 0, continued: 0, under: 0, over: 0, vacuum: 0 };
  const stopSnaps = [];
  const eventPolicies = [];

  for (const e of events) {
    const dIdx = dualIndex(e.path);
    if (dIdx < 0) continue;
    const post = [];
    let firstLockIdx = -1;
    let firstToxicIdx = -1;

    for (let i = dIdx + 1; i < e.path.length; i += 1) {
      const prev = e.path[i - 1];
      const cur = e.path[i];
      let action = 'FLAT';
      if (prev.residualSide) {
        action = cur.outcome === prev.residualSide ? 'OVER' : 'UNDER';
      } else if (prev.residual <= 1e-9) {
        action = 'FLAT'; // first step off flat
      }

      const avgB = avgBucket(prev.avgSum);
      const resB = resBucket(prev.residual);
      const secB = secBucket(prev.sec);
      const pxB = pxBucket(cur.price);
      const szB = sizeBucket(cur.size);
      // Soft-lock Doggy: avgSum cushion only (balance often still ~50–100 residual).
      const locked = prev.avgSum != null && prev.avgSum <= 0.95;
      const toxic = prev.avgSum != null && prev.avgSum >= 1.0;

      if (locked && firstLockIdx < 0) firstLockIdx = i;
      if (toxic && firstToxicIdx < 0) firstToxicIdx = i;

      const stateKey = `${avgB}|${resB}|${secB}`;
      if (!actionByState[stateKey]) actionByState[stateKey] = { UNDER: 0, OVER: 0, FLAT: 0, n: 0 };
      actionByState[stateKey][action] += 1;
      actionByState[stateKey].n += 1;

      const mKey = `${avgB}|${resB}`;
      if (!matrix[mKey]) matrix[mKey] = { UNDER: 0, OVER: 0, FLAT: 0, n: 0 };
      matrix[mKey][action] += 1;
      matrix[mKey].n += 1;

      bump(byAvgAction, `${avgB}→${action}`);
      bump(byPxAction, `${pxB}→${action}`);
      bump(bySecAction, `${secB}→${action}`);
      bump(byResAction, `${resB}→${action}`);

      sizeByAction[action].push(cur.size);
      pxByAction[action].push(cur.price);

      const eff = action === 'UNDER' ? effects.under : action === 'OVER' ? effects.over : effects.flat;
      eff.n += 1;
      if (prev.avgSum != null && cur.avgSum != null) {
        if (cur.avgSum < prev.avgSum - 1e-12) eff.improveAvg += 1;
        if (cur.avgSum > prev.avgSum + 1e-12) eff.worsenAvg += 1;
      }
      if (cur.residual < prev.residual - 1e-9) eff.reduceRes += 1;
      if (cur.residual > prev.residual + 1e-9) eff.growRes += 1;

      if (locked) {
        lockedContinue.lockedStates += 1;
        lockedContinue.continued += 1;
        if (cur.price <= 0.15) lockedContinue.vacuum += 1;
        if (action === 'UNDER') lockedContinue.under += 1;
        if (action === 'OVER') lockedContinue.over += 1;
      }
      if (toxic) {
        toxicContinue.toxicStates += 1;
        toxicContinue.continued += 1;
        if (cur.price <= 0.15) toxicContinue.vacuum += 1;
        if (action === 'UNDER') toxicContinue.under += 1;
        if (action === 'OVER') toxicContinue.over += 1;
      }

      const row = {
        slug: e.slug,
        i,
        sec: cur.sec,
        action,
        px: cur.price,
        size: cur.size,
        pxB,
        szB,
        avgBefore: prev.avgSum,
        avgAfter: cur.avgSum,
        resBefore: prev.residual,
        resAfter: cur.residual,
        resSideBefore: prev.residualSide,
        balBefore: prev.balRatio,
        locked,
        toxic,
        stateKey,
        avgB,
        resB,
        secB,
        improvesAvg: prev.avgSum != null && cur.avgSum != null && cur.avgSum < prev.avgSum - 1e-12,
        reducesRes: cur.residual < prev.residual - 1e-9,
      };
      transitions.push(row);
      post.push(row);
    }

    const last = e.path.at(-1);
    const lastPost = post.at(-1);
    stopSnaps.push({
      slug: e.slug,
      nPost: post.length,
      finalAvg: e.avgSum,
      finalRes: e.residual,
      finalResSide: e.residualSide,
      finalSec: last?.sec ?? null,
      lastAction: lastPost?.action ?? null,
      lastPx: lastPost?.px ?? null,
      lastAvgB: lastPost?.avgB ?? avgBucket(e.avgSum),
      lastResB: lastPost?.resB ?? resBucket(e.residual),
      hitLock: firstLockIdx >= 0,
      fillsAfterLock: firstLockIdx >= 0 ? e.path.length - firstLockIdx : 0,
      hitToxic: firstToxicIdx >= 0,
      fillsAfterToxic: firstToxicIdx >= 0 ? e.path.length - firstToxicIdx : 0,
      redeemOutcome: e.redeemOutcome,
      residualMatchesWinner: e.redeemOutcome && e.residualSide ? e.residualSide === e.redeemOutcome : null,
      pnl: e.pnl,
    });

    const underN = post.filter((p) => p.action === 'UNDER').length;
    const overN = post.filter((p) => p.action === 'OVER').length;
    const vacN = post.filter((p) => p.px <= 0.15).length;
    eventPolicies.push({
      slug: e.slug,
      nPost: post.length,
      underN,
      overN,
      vacN,
      underShare: frac(underN, post.length),
      avgFinal: e.avgSum,
      resFinal: e.residual,
      residualMatchesWinner: e.redeemOutcome && e.residualSide ? e.residualSide === e.redeemOutcome : null,
      pnl: e.pnl,
    });
  }

  return {
    transitions,
    actionByState,
    matrix,
    effects,
    byAvgAction,
    byPxAction,
    bySecAction,
    byResAction,
    sizeByAction,
    pxByAction,
    lockedContinue,
    toxicContinue,
    stopSnaps,
    eventPolicies,
  };
}

function analyzeTilt(events) {
  const rows = [];
  let cheapLoser = 0; let cheapN = 0;
  let midLoser = 0; let midN = 0;
  let richLoser = 0; let richN = 0;
  let underFlip = 0; let underN = 0;
  let vacFlip = 0; let vacN = 0;
  let openHit = 0; let openN = 0;
  const underPxLoser = [];
  const underPxWinner = [];

  for (const e of events) {
    if (!e.redeemOutcome || e.residual < 1) continue;
    const dIdx = dualIndex(e.path);
    if (dIdx < 0) continue;
    const atDual = e.path[dIdx];
    const at60 = e.path.filter((p) => p.sec != null && p.sec <= 60).at(-1) || atDual;
    const at180 = e.path.filter((p) => p.sec != null && p.sec <= 180).at(-1) || atDual;
    const fin = e.path.at(-1);
    const match = (p) => (p?.residualSide ? p.residualSide === e.redeemOutcome : null);
    let intentionalOverOnWinner = 0;
    let underOnLoser = 0;
    let underOnWinner = 0;
    const openSide = e.fills[0]?.outcome;
    if (openSide) {
      openN += 1;
      if (openSide === e.redeemOutcome) openHit += 1;
    }
    for (let i = dIdx + 1; i < e.path.length; i += 1) {
      const prev = e.path[i - 1];
      const cur = e.path[i];
      if (!prev.residualSide) continue;
      const isUnder = cur.outcome !== prev.residualSide;
      if (!isUnder) {
        if (cur.outcome === e.redeemOutcome) intentionalOverOnWinner += 1;
        continue;
      }
      underN += 1;
      const toLoser = cur.outcome !== e.redeemOutcome;
      if (toLoser) {
        underOnLoser += 1;
        underPxLoser.push(cur.price);
      } else {
        underOnWinner += 1;
        underPxWinner.push(cur.price);
      }
      if (cur.price <= 0.30) {
        cheapN += 1;
        if (toLoser) cheapLoser += 1;
      } else if (cur.price <= 0.55) {
        midN += 1;
        if (toLoser) midLoser += 1;
      } else {
        richN += 1;
        if (toLoser) richLoser += 1;
      }
      const flipped = cur.residualSide && prev.residualSide && cur.residualSide !== prev.residualSide;
      if (flipped) underFlip += 1;
      if (cur.price <= 0.15) {
        vacN += 1;
        if (flipped) vacFlip += 1;
      }
    }
    rows.push({
      slug: e.slug,
      residualFinal: e.residual,
      sideFinal: e.residualSide,
      winner: e.redeemOutcome,
      hit: e.residualSide === e.redeemOutcome,
      dualMatch: match(atDual),
      s60Match: match(at60),
      s180Match: match(at180),
      intentionalOverOnWinner,
      underOnLoser,
      underOnWinner,
      pnl: e.pnl,
    });
  }

  const hit = rows.filter((r) => r.hit);
  const miss = rows.filter((r) => r.hit === false);
  return {
    n: rows.length,
    hitRate: frac(hit.length, rows.length),
    meanResHit: mean(hit.map((r) => r.residualFinal)),
    meanResMiss: mean(miss.map((r) => r.residualFinal)),
    meanPnlHit: mean(hit.map((r) => r.pnl).filter((x) => x != null)),
    meanPnlMiss: mean(miss.map((r) => r.pnl).filter((x) => x != null)),
    dualHitRate: frac(rows.filter((r) => r.dualMatch).length, rows.filter((r) => r.dualMatch != null).length),
    s60HitRate: frac(rows.filter((r) => r.s60Match).length, rows.filter((r) => r.s60Match != null).length),
    s180HitRate: frac(rows.filter((r) => r.s180Match).length, rows.filter((r) => r.s180Match != null).length),
    openHitRate: frac(openHit, openN),
    underOnLoserShare: frac(
      rows.reduce((s, r) => s + r.underOnLoser, 0),
      rows.reduce((s, r) => s + r.underOnLoser + r.underOnWinner, 0),
    ),
    intentionalOverShare: frac(
      rows.reduce((s, r) => s + r.intentionalOverOnWinner, 0),
      rows.reduce((s, r) => s + r.intentionalOverOnWinner + r.underOnLoser + r.underOnWinner, 0),
    ),
    // Mechanism: cheap vacuum buys dying side; rich under chases eventual winner; clip overshoot flips residual
    cheapUnderToLoserShare: frac(cheapLoser, cheapN),
    midUnderToLoserShare: frac(midLoser, midN),
    richUnderToLoserShare: frac(richLoser, richN),
    cheapUnderN: cheapN,
    midUnderN: midN,
    richUnderN: richN,
    underFlipShare: frac(underFlip, underN),
    vacFlipShare: frac(vacFlip, vacN),
    underPxToLoserMed: q(underPxLoser, 0.5),
    underPxToWinnerMed: q(underPxWinner, 0.5),
    byResBucket: (() => {
      const buckets = ['R0_25', 'R25_50', 'R50_100', 'R100_200', 'R200p'];
      return buckets.map((b) => {
        const xs = rows.filter((r) => resBucket(r.residualFinal) === b);
        return {
          bucket: b,
          n: xs.length,
          hitRate: frac(xs.filter((r) => r.hit).length, xs.length),
          meanPnl: mean(xs.map((r) => r.pnl).filter((x) => x != null)),
        };
      }).filter((x) => x.n > 0);
    })(),
  };
}

function analyzeStop(stopSnaps, transitions) {
  const withPost = stopSnaps.filter((s) => s.nPost > 0);
  const lastAction = {};
  const lastAvg = {};
  const lastPx = {};
  for (const s of withPost) {
    bump(lastAction, s.lastAction || 'NONE');
    bump(lastAvg, s.lastAvgB || 'UNK');
    if (s.lastPx != null) bump(lastPx, pxBucket(s.lastPx));
  }

  // Silence before end: gap from last fill to event end (300s)
  const endGaps = withPost
    .filter((s) => s.finalSec != null)
    .map((s) => Math.max(0, 300 - s.finalSec));

  // After lock: what kinds of fills?
  const afterLock = transitions.filter((t) => t.locked);
  const afterToxic = transitions.filter((t) => t.toxic);

  // Conditional: given LE_095 + residual, P(continue with vacuum vs chase mid)
  const lockFillKinds = {
    vacuumUnder: afterLock.filter((t) => t.action === 'UNDER' && t.px <= 0.15).length,
    vacuumOver: afterLock.filter((t) => t.action === 'OVER' && t.px <= 0.15).length,
    chaseUnder: afterLock.filter((t) => t.action === 'UNDER' && t.px > 0.15).length,
    chaseOver: afterLock.filter((t) => t.action === 'OVER' && t.px > 0.15).length,
    flat: afterLock.filter((t) => t.action === 'FLAT').length,
  };

  // Does he stop when avgSum worsens a lot?
  const stopWhenToxic = {
    eventsHitToxic: withPost.filter((s) => s.hitToxic).length,
    continuedAfterToxic: withPost.filter((s) => s.fillsAfterToxic > 0).length,
    meanFillsAfterToxic: mean(withPost.filter((s) => s.hitToxic).map((s) => s.fillsAfterToxic)),
    finalStillToxic: withPost.filter((s) => s.finalAvg != null && s.finalAvg >= 1).length,
  };

  const stopWhenLock = {
    eventsHitLock: withPost.filter((s) => s.hitLock).length,
    continuedAfterLock: withPost.filter((s) => s.fillsAfterLock > 0).length,
    meanFillsAfterLock: mean(withPost.filter((s) => s.hitLock).map((s) => s.fillsAfterLock)),
    finalStillLock: withPost.filter((s) => s.finalAvg != null && s.finalAvg <= 0.95).length,
  };

  return {
    nEvents: withPost.length,
    lastAction: topEntries(lastAction),
    lastAvg: topEntries(lastAvg),
    lastPx: topEntries(lastPx),
    endGapSec: { med: q(endGaps, 0.5), p25: q(endGaps, 0.25), p75: q(endGaps, 0.75), mean: mean(endGaps) },
    lockFillKinds,
    stopWhenToxic,
    stopWhenLock,
    // PnL by stop cohort
    pnlByFinalAvg: [
      { cohort: 'final≤0.95', ...cohortPnl(withPost.filter((s) => s.finalAvg != null && s.finalAvg <= 0.95)) },
      { cohort: '0.95<final<1', ...cohortPnl(withPost.filter((s) => s.finalAvg != null && s.finalAvg > 0.95 && s.finalAvg < 1)) },
      { cohort: 'final≥1', ...cohortPnl(withPost.filter((s) => s.finalAvg != null && s.finalAvg >= 1)) },
    ],
  };
}

function cohortPnl(xs) {
  const pnls = xs.map((x) => x.pnl).filter((x) => x != null);
  return {
    n: xs.length,
    meanPnl: mean(pnls),
    medPnl: q(pnls, 0.5),
    winRate: frac(pnls.filter((x) => x > 0).length, pnls.length),
  };
}

function dominantPolicy(actionByState, minN = 15) {
  return Object.entries(actionByState)
    .filter(([, v]) => v.n >= minN)
    .map(([state, v]) => {
      const entries = [
        ['UNDER', v.UNDER],
        ['OVER', v.OVER],
        ['FLAT', v.FLAT],
      ].sort((a, b) => b[1] - a[1]);
      const [dom, nDom] = entries[0];
      return {
        state,
        n: v.n,
        dominant: dom,
        dominantShare: nDom / v.n,
        UNDER: v.UNDER,
        OVER: v.OVER,
        FLAT: v.FLAT,
      };
    })
    .sort((a, b) => b.n - a.n);
}

function matrixTable(matrix) {
  return Object.entries(matrix)
    .map(([k, v]) => {
      const [avgB, resB] = k.split('|');
      return {
        avgB,
        resB,
        n: v.n,
        underShare: frac(v.UNDER, v.n),
        overShare: frac(v.OVER, v.n),
        flatShare: frac(v.FLAT, v.n),
        UNDER: v.UNDER,
        OVER: v.OVER,
        FLAT: v.FLAT,
      };
    })
    .sort((a, b) => b.n - a.n);
}

function inferRules(summary) {
  const rules = [];
  const mat = summary.matrixTable;
  const underDom = mat.filter((r) => r.underShare >= 0.85 && r.n >= 30);
  rules.push(
    `Pós-dual: UNDER ${summary.actionTotals.UNDER} · OVER ${summary.actionTotals.OVER} · FLAT ${summary.actionTotals.FLAT}`
    + ` (underShare=${(summary.actionTotals.underShare * 100).toFixed(1)}%).`,
  );
  if (underDom.length) {
    rules.push(
      `Estados com ≥85% UNDER (n≥30): ${underDom.map((r) => `${r.avgB}|${r.resB}`).join(', ') || '—'}.`,
    );
  }
  const overish = mat.filter((r) => r.overShare >= 0.2 && r.n >= 20);
  if (overish.length) {
    rules.push(
      `OVER significativo (≥20%): ${overish.map((r) => `${r.avgB}|${r.resB} ${(r.overShare * 100).toFixed(0)}%`).join('; ')}.`,
    );
  } else {
    rules.push('OVER nunca domina nenhum bucket avg×residual com n≥20 → forbidOverweight=true é fiel.');
  }

  const lock = summary.stop.lockFillKinds;
  const lockN = Object.values(lock).reduce((s, x) => s + x, 0);
  rules.push(
    `Após soft-lock (avg≤0.95): ${lockN} fills — vacuumUnder=${lock.vacuumUnder}, chaseUnder=${lock.chaseUnder}, over=${lock.vacuumOver + lock.chaseOver}. Soft stop, não hard.`,
  );
  rules.push(
    `Após toxic (avg≥1): continua em ${summary.stop.stopWhenToxic.continuedAfterToxic}/${summary.stop.stopWhenToxic.eventsHitToxic}`
    + ` (média ${Number(summary.stop.stopWhenToxic.meanFillsAfterToxic || 0).toFixed(1)} fills). Sem hard stop por avgSum.`,
  );
  rules.push(
    `Tilt residual→winner: final ${(summary.tilt.hitRate * 100).toFixed(0)}%`
    + ` · dual ${(summary.tilt.dualHitRate * 100).toFixed(0)}%`
    + ` · open ${(summary.tilt.openHitRate * 100).toFixed(0)}%`
    + ` · intentionalOver ${(summary.tilt.intentionalOverShare * 100).toFixed(1)}%.`,
  );
  rules.push(
    `Mecanismo tilt: under≤30¢ → loser ${(summary.tilt.cheapUnderToLoserShare * 100).toFixed(0)}%`
    + ` · under>55¢ → loser só ${(summary.tilt.richUnderToLoserShare * 100).toFixed(0)}% (chase do winner)`
    + ` · clip overshoot flip ${(summary.tilt.underFlipShare * 100).toFixed(0)}% dos UNDER.`,
  );
  if (summary.tilt.intentionalOverShare < 0.05) {
    rules.push(
      'Tilt NÃO é overweight deliberado: emerge de vacuum do dying side + chase under do lado caro (winner) com clip 100 que vira o residual.',
    );
  } else if (summary.tilt.intentionalOverShare >= 0.2) {
    rules.push('Há overweight deliberado no winner — tilt parcialmente intencional.');
  }
  rules.push(
    `Último fill: ação dominante ${summary.stop.lastAction[0]?.key} (${summary.stop.lastAction[0]?.n}); gap até fim med ${summary.stop.endGapSec.med}s.`,
  );
  return rules;
}

async function main() {
  let rows = fetchMore ? await fetchActivity(40) : loadActivity();
  if (fetchMore) {
    fs.writeFileSync(path.join(OUT, 'doggy-activity-fresh.json'), JSON.stringify(rows));
  }

  const events = buildEvents(rows);
  const classified = classifyTransitions(events);
  const tilt = analyzeTilt(events);
  const stop = analyzeStop(classified.stopSnaps, classified.transitions);

  const actionTotals = {
    UNDER: classified.effects.under.n,
    OVER: classified.effects.over.n,
    FLAT: classified.effects.flat.n,
  };
  actionTotals.n = actionTotals.UNDER + actionTotals.OVER + actionTotals.FLAT;
  actionTotals.underShare = frac(actionTotals.UNDER, actionTotals.n);

  const summary = {
    asOf: new Date().toISOString(),
    wallet: WALLET,
    nEvents: events.length,
    nEventsWithDualPost: classified.stopSnaps.filter((s) => s.nPost > 0).length,
    nTransitions: classified.transitions.length,
    actionTotals,
    effects: {
      under: {
        ...classified.effects.under,
        improveAvgShare: frac(classified.effects.under.improveAvg, classified.effects.under.n),
        reduceResShare: frac(classified.effects.under.reduceRes, classified.effects.under.n),
      },
      over: {
        ...classified.effects.over,
        improveAvgShare: frac(classified.effects.over.improveAvg, classified.effects.over.n),
        reduceResShare: frac(classified.effects.over.reduceRes, classified.effects.over.n),
      },
    },
    sizeMed: {
      UNDER: q(classified.sizeByAction.UNDER, 0.5),
      OVER: q(classified.sizeByAction.OVER, 0.5),
      FLAT: q(classified.sizeByAction.FLAT, 0.5),
    },
    pxMed: {
      UNDER: q(classified.pxByAction.UNDER, 0.5),
      OVER: q(classified.pxByAction.OVER, 0.5),
      FLAT: q(classified.pxByAction.FLAT, 0.5),
    },
    matrixTable: matrixTable(classified.matrix),
    dominantStates: dominantPolicy(classified.actionByState, 20).slice(0, 25),
    byAvgAction: topEntries(classified.byAvgAction, 20),
    byResAction: topEntries(classified.byResAction, 20),
    bySecAction: topEntries(classified.bySecAction, 20),
    byPxAction: topEntries(classified.byPxAction, 20),
    lockedContinue: classified.lockedContinue,
    toxicContinue: classified.toxicContinue,
    stop,
    tilt,
    sampleEvents: classified.eventPolicies
      .filter((e) => e.pnl != null)
      .sort((a, b) => (b.pnl || 0) - (a.pnl || 0))
      .slice(0, 8)
      .concat(
        classified.eventPolicies
          .filter((e) => e.pnl != null)
          .sort((a, b) => (a.pnl || 0) - (b.pnl || 0))
          .slice(0, 4),
      ),
  };
  summary.inferredRules = inferRules(summary);

  // Compact canvas payload
  const canvas = {
    asOf: summary.asOf,
    nEvents: summary.nEvents,
    nTransitions: summary.nTransitions,
    actionTotals: summary.actionTotals,
    effects: summary.effects,
    sizeMed: summary.sizeMed,
    pxMed: summary.pxMed,
    matrixTop: summary.matrixTable.slice(0, 12).map((r) => ({
      state: `${r.avgB} × ${r.resB}`,
      n: r.n,
      underPct: Math.round((r.underShare || 0) * 1000) / 10,
      overPct: Math.round((r.overShare || 0) * 1000) / 10,
    })),
    dominantStates: summary.dominantStates.slice(0, 10).map((r) => ({
      state: r.state,
      n: r.n,
      dominant: r.dominant,
      share: Math.round(r.dominantShare * 1000) / 10,
    })),
    stop: {
      lastAction: summary.stop.lastAction,
      endGapMed: summary.stop.endGapSec.med,
      lockFillKinds: summary.stop.lockFillKinds,
      stopWhenLock: summary.stop.stopWhenLock,
      stopWhenToxic: summary.stop.stopWhenToxic,
      pnlByFinalAvg: summary.stop.pnlByFinalAvg,
    },
    tilt: {
      hitRate: summary.tilt.hitRate,
      dualHitRate: summary.tilt.dualHitRate,
      s60HitRate: summary.tilt.s60HitRate,
      s180HitRate: summary.tilt.s180HitRate,
      openHitRate: summary.tilt.openHitRate,
      underOnLoserShare: summary.tilt.underOnLoserShare,
      intentionalOverShare: summary.tilt.intentionalOverShare,
      cheapUnderToLoserShare: summary.tilt.cheapUnderToLoserShare,
      richUnderToLoserShare: summary.tilt.richUnderToLoserShare,
      underFlipShare: summary.tilt.underFlipShare,
      vacFlipShare: summary.tilt.vacFlipShare,
      underPxToLoserMed: summary.tilt.underPxToLoserMed,
      underPxToWinnerMed: summary.tilt.underPxToWinnerMed,
      meanPnlHit: summary.tilt.meanPnlHit,
      meanPnlMiss: summary.tilt.meanPnlMiss,
      byResBucket: summary.tilt.byResBucket,
    },
    rules: summary.inferredRules,
  };

  fs.writeFileSync(path.join(OUT, 'doggy-postdual-policy.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, 'doggy-postdual-policy-canvas.json'), JSON.stringify(canvas, null, 2));
  // light transitions sample for debug
  fs.writeFileSync(
    path.join(OUT, 'doggy-postdual-transitions-sample.json'),
    JSON.stringify(classified.transitions.slice(0, 200), null, 2),
  );

  console.log(JSON.stringify({
    nEvents: summary.nEvents,
    nTransitions: summary.nTransitions,
    actionTotals: summary.actionTotals,
    tilt: summary.tilt,
    stop: {
      lock: summary.stop.stopWhenLock,
      toxic: summary.stop.stopWhenToxic,
      lockFillKinds: summary.stop.lockFillKinds,
      endGapMed: summary.stop.endGapSec.med,
    },
    matrixTop: summary.matrixTable.slice(0, 8),
    rules: summary.inferredRules,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
