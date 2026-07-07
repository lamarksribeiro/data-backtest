/**
 * Seção A — decomposição de PnL por mecanismo (V5 Practical + V6 Hybrid).
 *
 * Uso: node labs/sandbox/tfc-v7-diag-pnl-mechanism.mjs
 * Pré-requisito: tfc-v7-diag-run-events.mjs
 */
import path from 'node:path';
import {
  CACHE_DIR, classifyOutcome, stats, fmtPct, fmtUsd, loadJson, writeJson,
} from './tfc-v7-diag-lib.mjs';

function orderReasons(event) {
  return (event.orders || []).map((o) => o.reason).filter(Boolean);
}

function hadLateFlipAction(event) {
  const reasons = orderReasons(event);
  return reasons.some((r) => String(r).includes('late_flip'));
}

function hadHedgeStopFill(event) {
  return Boolean(event.hedgeFill) || (event.orders || []).some((o) => String(o.reason || '').includes('hedge_stop'));
}

function hedgeOutcome(event) {
  const entry = event.entry;
  if (!entry) return 'no_entry';
  const favWon = event.winnerSide === entry.side;
  const hedgeFilled = hadHedgeStopFill(event);
  if (!hedgeFilled) return 'no_hedge';
  if (!favWon) return 'hedge_fav_lost';
  return 'hedge_whipsaw';
}

function isFallbackTaker(event) {
  const reasons = orderReasons(event);
  const hasReverse = reasons.some((r) => String(r).includes('late_flip_reverse'));
  const hedgeFilled = hadHedgeStopFill(event);
  return hasReverse && !hedgeFilled;
}

function pnlFromHedge(event) {
  if (event.hedgePnl != null) return Number(event.hedgePnl);
  const hedgeOrders = (event.orders || []).filter((o) => String(o.reason || '').includes('hedge'));
  return hedgeOrders.reduce((s, o) => s + Number(o.notional || 0) * -1, 0);
}

function analyzeVariant(filePath) {
  const data = loadJson(filePath);
  const events = data.events || [];
  const traded = events.filter((e) => e.entry);

  const byOutcome = {};
  for (const e of traded) {
    const outcome = classifyOutcome(e);
    if (!byOutcome[outcome]) byOutcome[outcome] = [];
    byOutcome[outcome].push(e);
  }

  const splits = { train: [], june: [], all: traded };
  for (const e of traded) {
    splits[e.split]?.push(e);
  }

  const splitStats = {};
  for (const [name, rows] of Object.entries(splits)) {
    const missed = rows.filter((e) => e.cross?.missedFlipAfterFloor);
    splitStats[name] = {
      overall: stats(rows),
      missedFlipAfterFloor: {
        ...stats(missed),
        pct: rows.length ? missed.length / rows.length : 0,
      },
      byOutcome: Object.fromEntries(
        Object.entries(byOutcome).map(([k, allRows]) => {
          const subset = allRows.filter((r) => name === 'all' || r.split === name);
          const st = stats(subset);
          return [k, { ...st, pct: traded.length ? subset.length / (name === 'all' ? traded.length : splits[name].length) : 0 }];
        }),
      ),
    };
  }

  return {
    variant: data.variant,
    window: data.window,
    summary: data.summary,
    splitStats,
    byOutcome: Object.fromEntries(
      Object.entries(byOutcome).map(([k, rows]) => [k, stats(rows)]),
    ),
  };
}

function compareContrafactual(v5, hold) {
  const out = {};
  for (const split of ['train', 'june', 'all']) {
    const pnlV5 = v5.splitStats[split]?.overall?.sum ?? 0;
    const pnlHold = hold.splitStats[split]?.overall?.sum ?? 0;
    const nV5 = v5.splitStats[split]?.overall?.n ?? 0;
    const nHold = hold.splitStats[split]?.overall?.n ?? 0;
    out[split] = {
      v5Pnl: pnlV5,
      holdPnl: pnlHold,
      lateMechanismValue: pnlV5 - pnlHold,
      v5Entries: nV5,
      holdEntries: nHold,
      pctOfV5Pnl: pnlV5 !== 0 ? (pnlV5 - pnlHold) / pnlV5 : null,
    };
  }
  return out;
}

function analyzeV6(v6) {
  const events = loadJson(path.join(CACHE_DIR, 'events-v6-hybrid.json')).events || [];
  const traded = events.filter((e) => e.entry);

  const splits = { train: [], june: [], all: traded };
  for (const e of traded) splits[e.split]?.push(e);

  const result = {};
  for (const [splitName, rows] of Object.entries(splits)) {
    const hedgeFilled = rows.filter(hadHedgeStopFill);
    const noHedge = rows.filter((e) => !hadHedgeStopFill(e));
    const favLost = hedgeFilled.filter((e) => e.winnerSide !== e.entry?.side);
    const whipsaw = hedgeFilled.filter((e) => e.winnerSide === e.entry?.side);
    const fallbackTaker = rows.filter(isFallbackTaker);
    const lateFlipAny = rows.filter(hadLateFlipAction);

    result[splitName] = {
      n: rows.length,
      pctHedgeFilled: rows.length ? hedgeFilled.length / rows.length : 0,
      hedgePnlWhenFavLost: stats(favLost.map((e) => ({ finalPnl: pnlFromHedge(e) }))),
      hedgePnlWhipsaw: stats(whipsaw.map((e) => ({ finalPnl: pnlFromHedge(e) }))),
      hedgeEventPnlFavLost: stats(favLost),
      hedgeEventPnlWhipsaw: stats(whipsaw),
      fallbackTaker: stats(fallbackTaker),
      lateFlipActions: stats(lateFlipAny),
      hedgeFilledCount: hedgeFilled.length,
      fallbackCount: fallbackTaker.length,
    };
  }
  return { ...v6, hedgeAnalysis: result };
}

function main() {
  const v5Path = path.join(CACHE_DIR, 'events-v5-practical.json');
  const holdPath = path.join(CACHE_DIR, 'events-v5-hold-contrafactual.json');
  const v6Path = path.join(CACHE_DIR, 'events-v6-hybrid.json');

  const v5 = analyzeVariant(v5Path);
  const hold = analyzeVariant(holdPath);
  const v6base = analyzeVariant(v6Path);
  const v6 = analyzeV6(v6base);

  const contrafactual = compareContrafactual(v5, hold);

  const output = { v5, hold, contrafactual, v6 };
  const outPath = path.join(CACHE_DIR, 'pnl-mechanism.json');
  writeJson(outPath, output);

  console.log('=== A. Decomposição PnL V5 Practical ===');
  for (const split of ['train', 'june', 'all']) {
    console.log(`\n-- ${split} --`);
    const st = v5.splitStats[split];
    for (const [outcome, o] of Object.entries(st.byOutcome)) {
      if (!o.n) continue;
      console.log(`  ${outcome}: n=${o.n} (${fmtPct(o.pct)}) sum=${fmtUsd(o.sum)} exp=${fmtUsd(o.exp)}`);
    }
  }

  console.log('\n=== A.2 Valor do mecanismo tardio (V5 - hold) ===');
  for (const split of ['train', 'june', 'all']) {
    const c = contrafactual[split];
    console.log(`  ${split}: V5=${fmtUsd(c.v5Pnl)} hold=${fmtUsd(c.holdPnl)} delta=${fmtUsd(c.lateMechanismValue)} (${fmtPct(c.pctOfV5Pnl ?? 0)} do PnL V5)`);
  }

  console.log('\n=== A.3 V6 Hybrid hedge ===');
  for (const split of ['train', 'june', 'all']) {
    const h = v6.hedgeAnalysis[split];
    console.log(`  ${split}: hedge_fill=${fmtPct(h.pctHedgeFilled)} (n=${h.hedgeFilledCount}) fallback_taker n=${h.fallbackCount} pnl=${fmtUsd(h.fallbackTaker.sum)}`);
    console.log(`    fav_lost hedge events: n=${h.hedgeEventPnlFavLost.n} sum=${fmtUsd(h.hedgeEventPnlFavLost.sum)}`);
    console.log(`    whipsaw hedge events: n=${h.hedgeEventPnlWhipsaw.n} sum=${fmtUsd(h.hedgeEventPnlWhipsaw.sum)}`);
  }

  console.error(`\nSalvo em ${outPath}`);
}

main();
