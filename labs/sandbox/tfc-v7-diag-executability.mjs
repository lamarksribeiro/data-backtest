/**
 * Seção B — auditoria de executabilidade tick-level (DuckDB → Parquet, chunked por dia).
 *
 * Uso: node --max-old-space-size=6144 labs/sandbox/tfc-v7-diag-executability.mjs
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../../src/state/sqlite.js';
import { queryTicks } from '../../src/query/duckdbQuery.js';
import {
  FROM, TO, CACHE_DIR, BUDGET, FEE_RATE, dateRange,
  parseArgs, percentile, fmtPct, fmtUsd, loadJson, writeJson, parseDateEnd,
  sweepFillFromRow, topAskDepthUsd, v5EntryGates, signedDistance, tsMs,
} from './tfc-v7-diag-lib.mjs';

const BOOK_DEPTH = 25;

function secsUntilEnd(row) {
  const ts = new Date(row.ts).getTime();
  const end = new Date(row.event_end).getTime();
  return Math.max(0, (end - ts) / 1000);
}

function enrichRow(row) {
  const tau = secsUntilEnd(row);
  const spot = Number(row.underlying_price);
  const ptb = Number(row.price_to_beat);
  const fav = spot >= ptb ? 'UP' : 'DOWN';
  const askFav = fav === 'UP' ? Number(row.up_best_ask) : Number(row.down_best_ask);
  const bidFav = fav === 'UP' ? Number(row.up_best_bid) : Number(row.down_best_bid);
  return {
    ...row,
    tau,
    dist_abs: Math.abs(spot - ptb),
    fav,
    ask_fav: askFav,
    bid_fav: bidFav,
    spread_fav: askFav - bidFav,
    ask_up: Number(row.up_best_ask),
    ask_down: Number(row.down_best_ask),
    odds_sum: Number(row.up_best_ask) + Number(row.down_best_ask),
  };
}

function validBook(row) {
  for (const s of ['UP', 'DOWN']) {
    const ask = s === 'UP' ? row.up_best_ask : row.down_best_ask;
    const bid = s === 'UP' ? row.up_best_bid : row.down_best_bid;
    if (!(ask > 0 && ask < 1 && bid > 0 && bid < 1)) return false;
  }
  return true;
}

function aggCadence(gaps) {
  const sorted = [...gaps].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    pctGt2s: sorted.length ? sorted.filter((g) => g > 2).length / sorted.length : 0,
  };
}

function bookStats(ticks) {
  if (!ticks.length) return { n: 0, pctValidBook: 0, pctSpreadLe003: 0, pctDepthGe10: 0, pctDepthGe50: 0 };
  const n = ticks.length;
  const valid = ticks.filter(validBook).length;
  const tightSpread = ticks.filter((r) => r.spread_fav <= 0.03).length;
  const depth10 = ticks.filter((r) => topAskDepthUsd(r, r.fav) >= 10).length;
  const depth50 = ticks.filter((r) => topAskDepthUsd(r, r.fav) >= 50).length;
  return {
    n,
    pctValidBook: valid / n,
    pctSpreadLe003: tightSpread / n,
    pctDepthGe10: depth10 / n,
    pctDepthGe50: depth50 / n,
  };
}

function reservoirPush(sample, item, maxSize) {
  if (sample.length < maxSize) {
    sample.push(item);
    return;
  }
  const j = Math.floor(Math.random() * (sample.length + 1));
  if (j < maxSize) sample[j] = item;
}

function processEventTicks(rows, acc) {
  rows.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const enriched = rows.map(enrichRow);

  let prev30 = null;
  let prev10 = null;
  let hole30 = false;
  let hole10 = false;
  for (const r of enriched) {
    const ts = new Date(r.ts).getTime();
    if (r.tau <= 30) {
      if (prev30 != null) {
        const gap = (ts - prev30) / 1000;
        reservoirPush(acc.gaps30, gap, acc.maxGapSample);
        if (gap > 2) hole30 = true;
      }
      prev30 = ts;
    }
    if (r.tau <= 10) {
      if (prev10 != null) {
        const gap = (ts - prev10) / 1000;
        reservoirPush(acc.gaps10, gap, acc.maxGapSample);
        if (gap > 2) hole10 = true;
      }
      prev10 = ts;
    }
  }

  acc.eventsWithHole30.total += 1;
  acc.eventsWithHole10.total += 1;
  if (hole30) acc.eventsWithHole30.holes += 1;
  if (hole10) acc.eventsWithHole10.holes += 1;

  const actionTicks = enriched.filter((r) => r.tau >= 4 && r.tau < 8);
  const entryTicks = enriched.filter((r) => r.tau >= 5 && r.tau < 30);
  const forbiddenTicks = enriched.filter((r) => r.tau >= 0 && r.tau < 4);

  mergeBookAgg(acc.actionAgg, bookStats(actionTicks));
  mergeBookAgg(acc.entryAgg, bookStats(entryTicks));
  mergeBookAgg(acc.forbiddenAgg, bookStats(forbiddenTicks));

  for (const r of entryTicks) {
    if (!v5EntryGates(r)) continue;
    const fill = sweepFillFromRow(r, r.fav, BUDGET);
    if (!fill) continue;
    acc.entryFills.push(fill);
    acc.entryDepth.push({
      topDepth: topAskDepthUsd(r, r.fav),
      levels: fill.levels,
      slippage: fill.avgPx - r.ask_fav,
    });
    break;
  }
}

function mergeBookAgg(agg, src) {
  agg.n += src.n;
  agg.valid += src.pctValidBook * src.n;
  agg.spread += src.pctSpreadLe003 * src.n;
  agg.d10 += src.pctDepthGe10 * src.n;
  agg.d50 += src.pctDepthGe50 * src.n;
}

function normAgg(agg) {
  return {
    tickCount: agg.n,
    pctValidBook: agg.n ? agg.valid / agg.n : 0,
    pctSpreadLe003: agg.n ? agg.spread / agg.n : 0,
    pctDepthGe10: agg.n ? agg.d10 / agg.n : 0,
    pctDepthGe50: agg.n ? agg.d50 / agg.n : 0,
  };
}

function findLatencyTick(rows, entrySide, entryMs, crossTauMin, latencySec) {
  const ptb = Number(rows[0]?.price_to_beat);
  let crossTick = null;
  for (const r of rows) {
    const tickMs = new Date(r.ts).getTime();
    if (tickMs < entryMs) continue;
    const dist = signedDistance(entrySide, Number(r.underlying_price), ptb);
    if (dist != null && dist <= 0 && r.tau >= 4 && r.tau <= 8) {
      crossTick = r;
      break;
    }
  }
  if (!crossTick) return null;
  const actMs = new Date(crossTick.ts).getTime() + latencySec * 1000;
  return rows.find((r) => new Date(r.ts).getTime() >= actMs) ?? null;
}

async function loadEventTicks(db, conditionId, from, to) {
  const select = [
    'condition_id', 'event_end', 'ts', 'underlying_price', 'price_to_beat',
    'up_best_bid', 'up_best_ask', 'down_best_bid', 'down_best_ask',
  ];
  for (const side of ['up_ask', 'up_bid', 'down_ask', 'down_bid']) {
    for (let i = 1; i <= BOOK_DEPTH; i += 1) {
      select.push(`${side}_px_${i}`, `${side}_sz_${i}`);
    }
  }
  const rows = await queryTicks(db, {
    dataset: 'backtest_ticks',
    underlying: 'BTC',
    interval: '5m',
    bookDepth: BOOK_DEPTH,
    from: `${from}T00:00:00.000Z`,
    to: parseDateEnd(to).toISOString(),
    validBacktestRows: true,
    select: select.join(', '),
    conditionId,
  });
  return rows.map(enrichRow).sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

async function latencyPass(db, events, from, to) {
  const lateActions = events.filter((e) =>
    (e.orders || []).some((o) => String(o.reason || '').includes('late_flip')),
  );
  const eventTicks = new Map();
  for (const e of lateActions) {
    const cid = e.eventId?.split('|')?.[0] ?? e.eventId;
    if (eventTicks.has(cid)) continue;
    eventTicks.set(cid, await loadEventTicks(db, cid, from, to));
  }
  return latencyPnlDegradation(lateActions, eventTicks);
}

function latencyPnlDegradation(events, eventTicks) {
  const results = { '0': [], '0.5': [], '1.0': [] };
  for (const e of events) {
    const cid = e.eventId?.split('|')?.[0] ?? e.eventId;
    const rows = eventTicks.get(cid);
    if (!rows?.length || !e.entry) continue;
    const entryMs = tsMs(e.entry.ts);
    const simPnl = Number(e.finalPnl || 0);
    for (const lat of ['0', '0.5', '1.0']) {
      const actTick = findLatencyTick(rows, e.entry.side, entryMs, 4, Number(lat));
      if (!actTick) continue;
      const bid = e.entry.side === 'UP' ? Number(actTick.up_best_bid) : Number(actTick.down_best_bid);
      const opp = e.entry.side === 'UP' ? 'DOWN' : 'UP';
      const entryCost = Number(e.entry.cost || BUDGET);
      const shares = Number(e.entry.shares || entryCost / Number(e.entry.price || 0.7));
      const exitProceeds = shares * bid * (1 - FEE_RATE * bid * (1 - bid));
      const reverseFill = sweepFillFromRow(actTick, opp, BUDGET);
      const reverseCost = reverseFill?.spent ?? BUDGET;
      const reverseShares = reverseFill?.shares ?? 0;
      const winner = e.winnerSide;
      const reverseExpiry = winner === opp ? reverseShares : 0;
      const proxyPnl = exitProceeds - entryCost + reverseExpiry - reverseCost;
      results[lat].push({ simPnl, proxyPnl, delta: proxyPnl - simPnl });
    }
  }
  const summary = {};
  for (const [lat, rows] of Object.entries(results)) {
    const n = rows.length;
    summary[lat] = {
      n,
      avgSimPnl: n ? rows.reduce((s, r) => s + r.simPnl, 0) / n : 0,
      avgProxyPnl: n ? rows.reduce((s, r) => s + r.proxyPnl, 0) / n : 0,
      avgDelta: n ? rows.reduce((s, r) => s + r.delta, 0) / n : 0,
    };
  }
  return summary;
}

async function loadDayTicks(db, dt) {
  const select = [
    'condition_id', 'event_start', 'event_end', 'ts',
    'underlying_price', 'price_to_beat',
    'up_best_bid', 'up_best_ask', 'down_best_bid', 'down_best_ask',
  ];
  for (const side of ['up_ask', 'up_bid', 'down_ask', 'down_bid']) {
    for (let i = 1; i <= BOOK_DEPTH; i += 1) {
      select.push(`${side}_px_${i}`, `${side}_sz_${i}`);
    }
  }
  const next = new Date(`${dt}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return queryTicks(db, {
    dataset: 'backtest_ticks',
    underlying: 'BTC',
    interval: '5m',
    bookDepth: BOOK_DEPTH,
    from: `${dt}T00:00:00.000Z`,
    to: next.toISOString(),
    validBacktestRows: true,
    select: select.join(', '),
  });
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const from = flags.from || FROM;
  const to = flags.to || TO;

  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath, { readOnly: true });

  const acc = {
    gaps30: [],
    gaps10: [],
    maxGapSample: 50000,
    eventsWithHole30: { total: 0, holes: 0 },
    eventsWithHole10: { total: 0, holes: 0 },
    actionAgg: { n: 0, valid: 0, spread: 0, d10: 0, d50: 0 },
    entryAgg: { n: 0, valid: 0, spread: 0, d10: 0, d50: 0 },
    forbiddenAgg: { n: 0, valid: 0, spread: 0, d10: 0, d50: 0 },
    entryFills: [],
    entryDepth: [],
  };

  try {
    for (const dt of dateRange(from, to)) {
      console.error(`[executability] ${dt}`);
      const rows = await loadDayTicks(db, dt);
      const byEvent = new Map();
      for (const row of rows) {
        const cid = row.condition_id;
        if (!byEvent.has(cid)) byEvent.set(cid, []);
        byEvent.get(cid).push(row);
      }
      for (const [, evRows] of byEvent) processEventTicks(evRows, acc);
    }

    let latency = null;
    const eventsPath = path.join(CACHE_DIR, 'events-v5-practical.json');
    if (fs.existsSync(eventsPath)) {
      console.error('[executability] latency pass...');
      latency = await latencyPass(db, loadJson(eventsPath).events || [], from, to);
    }

    const output = {
      window: { from, to },
      cadence: {
        last30s: aggCadence(acc.gaps30),
        last10s: aggCadence(acc.gaps10),
        eventsWithGapGt2s_last30s: acc.eventsWithHole30,
        eventsWithGapGt2s_last10s: acc.eventsWithHole10,
      },
      bookPresence: {
        actionWindow_tau_4_8: normAgg(acc.actionAgg),
        entryWindow_tau_5_30: normAgg(acc.entryAgg),
        forbiddenZone_tau_0_4: normAgg(acc.forbiddenAgg),
      },
      entryExecution: {
        nEntriesSimulated: acc.entryFills.length,
        avgTopDepthUsd: acc.entryDepth.length ? acc.entryDepth.reduce((s, r) => s + r.topDepth, 0) / acc.entryDepth.length : 0,
        avgLevelsConsumed: acc.entryFills.length ? acc.entryFills.reduce((s, r) => s + r.levels, 0) / acc.entryFills.length : 0,
        avgSlippageVsBestAsk: acc.entryDepth.length ? acc.entryDepth.reduce((s, r) => s + r.slippage, 0) / acc.entryDepth.length : 0,
        pctSingleLevel: acc.entryFills.length ? acc.entryFills.filter((r) => r.levels <= 1).length / acc.entryFills.length : 0,
      },
      latencyDegradation: latency,
      limitations: [
        'Latência: primeiro snapshot ≥ t+latência após cruzamento na janela 4-8s; sem fila de ordens.',
        'Proxy PnL sob latência: exit no bid + reverse taker; não replica hedge stop V6.',
        'Entradas: primeiro tick com gates V5 no evento (pode divergir 1 tick do motor).',
        'eventTicks para latência mantidos só para eventos com ação tardia (memória).',
      ],
    };

    writeJson(path.join(CACHE_DIR, 'executability.json'), output);

    console.log('=== B. Cadência ===');
    console.log(`  últimos 30s: p50=${output.cadence.last30s.p50.toFixed(2)}s p90=${output.cadence.last30s.p90.toFixed(2)}s`);
    console.log(`  buracos >2s (30s): ${fmtPct(acc.eventsWithHole30.holes / acc.eventsWithHole30.total)}`);
    const aw = output.bookPresence.actionWindow_tau_4_8;
    console.log(`\n=== B. Janela ação 4-8s ===`);
    console.log(`  book válido ${fmtPct(aw.pctValidBook)} | spread≤0.03 ${fmtPct(aw.pctSpreadLe003)} | depth≥$10 ${fmtPct(aw.pctDepthGe10)}`);
    const fz = output.bookPresence.forbiddenZone_tau_0_4;
    console.log(`\n=== B. Zona 0-4s === depth≥$10 ${fmtPct(fz.pctDepthGe10)} spread≤0.03 ${fmtPct(fz.pctSpreadLe003)}`);
    if (latency) {
      for (const lat of ['0', '0.5', '1.0']) {
        const l = latency[lat];
        console.log(`  lat ${lat}s: n=${l.n} delta=${fmtUsd(l.avgDelta)}/trade`);
      }
    }
    console.error('\nSalvo em labs/sandbox/cache/executability.json');
  } finally {
    closeStateDatabase(db);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
