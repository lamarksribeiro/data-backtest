/**
 * Replay MIDAS nos 2 eventos live a partir dos ticks crus do PG (sem omit do lake).
 */
import fs from 'fs';
import path from 'path';

import { parse } from '../src/backtestStudio/gls/parser.js';
import { createGlsBacktestRunner } from '../src/backtestStudio/gls/runtime.js';
import { loadConfig } from '../src/config.js';
import { createSourcePool, closeSourcePool, getTicksWithBooksForEvents } from '../src/source/postgres.js';
import { loadPreset } from '../labs/shared/presets.js';

const TARGETS = [
  {
    slug: 'btc-updown-5m-1784931300',
    conditionId: '0x146a2fba5a334afede478638aa55eba82f6d313fc87f6fa590ad60590bdce533',
    live: {
      side: 'UP',
      fillTs: 1784931570804,
      avgPrice: 0.51,
      limit: 0.66,
      qty: 3,
      pnlDelta: 1.47,
      exit: 'binary_expiry_settlement',
      winner: 'Up',
    },
  },
  {
    slug: 'btc-updown-5m-1784933100',
    conditionId: '0x28477124fba87d3db9f8a59b1d398eba765dd234b6de5d5c7288f645df7979c5',
    live: {
      side: 'DOWN',
      fillTs: 1784933384632,
      avgPrice: 0.53,
      limit: 0.6,
      qty: 3,
      pnlDelta: -1.59,
      exit: 'binary_expiry_settlement',
      winner: 'Up',
    },
  },
];

const config = loadConfig();
const pool = createSourcePool(config);
const partition = {
  marketId: '9586e5b0-d92a-40f4-8ca3-d2329a4d92e1',
  underlying: 'BTC',
  interval: '5m',
  dt: '2026-07-24',
  bookDepth: 25,
};

const { params, strategyRoot } = loadPreset('btc-micro-aggressive-v1', {
  strategyFamily: 'terminal',
  strategyId: 'midas-carry-v1',
});
const strategy = JSON.parse(fs.readFileSync(path.join(strategyRoot, 'strategy.json'), 'utf8'));
const sourcePath = path.resolve(strategy.source.path || strategy.source.glsPath);
const glsAst = parse(fs.readFileSync(sourcePath, 'utf8'));

function toLegacyTick(r) {
  return {
    condition_id: r.conditionId,
    event_start: r.eventStart,
    event_end: r.eventEnd,
    market_id: r.marketId,
    underlying: r.underlying || 'BTC',
    interval: '5m',
    ts: r.ts,
    _tsMs: new Date(r.ts).getTime(),
    underlying_price: r.underlyingPrice,
    price_to_beat: r.priceToBeat,
    up_price: r.upPrice,
    down_price: r.downPrice,
    up_best_bid: r.upBestBid,
    up_best_ask: r.upBestAsk,
    down_best_bid: r.downBestBid,
    down_best_ask: r.downBestAsk,
    book_depth: 25,
    coverage: r.coverage,
    degraded: r.degraded,
    up_book_asks: typeof r.upBookAsks === 'string' ? JSON.parse(r.upBookAsks || '[]') : (r.upBookAsks || []),
    up_book_bids: typeof r.upBookBids === 'string' ? JSON.parse(r.upBookBids || '[]') : (r.upBookBids || []),
    down_book_asks: typeof r.downBookAsks === 'string' ? JSON.parse(r.downBookAsks || '[]') : (r.downBookAsks || []),
    down_book_bids: typeof r.downBookBids === 'string' ? JSON.parse(r.downBookBids || '[]') : (r.downBookBids || []),
  };
}

function summarize(event) {
  if (!event) return null;
  return {
    conditionId: event.eventId,
    eventStart: event.eventStart,
    finalPnl: event.finalPnl,
    winnerSide: event.winnerSide,
    reason: event.reason,
    orders: (event.orders || []).map((o) => ({
      type: o.type,
      side: o.side,
      ts: o.ts,
      iso: typeof o.ts === 'number' ? new Date(o.ts).toISOString() : o.ts,
      avgPrice: o.avgPrice ?? o.price,
      reason: o.reason,
    })),
    marks: (event.marks || []).slice(0, 10).map((m) => ({
      ts: m.ts,
      name: m.name,
      data: m.data,
    })),
  };
}

try {
  const comparisons = [];
  for (const target of TARGETS) {
    const rows = await getTicksWithBooksForEvents(pool, partition, [target.conditionId]);
    if (!rows.length) {
      comparisons.push({ slug: target.slug, error: 'no_pg_ticks', live: target.live });
      continue;
    }

    const captured = [];
    const runner = createGlsBacktestRunner(glsAst, params, {
      fastRun: false,
      bookDepth: 25,
      executionMode: 'compiled-soa',
      onEventFinalized: (event) => captured.push(event),
    });

    for (const row of rows) {
      runner.processTick(toLegacyTick(row));
    }
    const finished = runner.finish();
    const event = captured[0] || finished.events?.[0] || null;
    const bt = summarize(event);
    const btEntry = (bt?.orders || []).find((o) => o.type === 'entry');

    comparisons.push({
      slug: target.slug,
      conditionId: target.conditionId,
      tickCount: rows.length,
      lakeNote: target.slug.includes('1784931300')
        ? 'omitted_from_lake_underlying_stale_flat'
        : 'present_in_lake',
      live: {
        ...target.live,
        fillIso: new Date(target.live.fillTs).toISOString(),
      },
      backtest: bt,
      parity: {
        entered: Boolean(btEntry),
        sameSide: btEntry ? btEntry.side === target.live.side : false,
        entryDeltaMs: btEntry ? Number(btEntry.ts) - target.live.fillTs : null,
        entryPriceLive: target.live.avgPrice,
        entryPriceBt: btEntry?.avgPrice ?? null,
        exitLive: target.live.exit,
        exitBt: (bt?.orders || []).filter((o) => o.type !== 'entry').map((o) => o.reason),
        pnlLive: target.live.pnlDelta,
        pnlBt: bt?.finalPnl ?? null,
      },
    });
  }

  const out = {
    preset: 'btc-micro-aggressive-v1',
    strategy: 'midas-carry-v1',
    source: 'postgres_raw_ticks_bypass_lake_omit',
    comparisons,
  };
  fs.writeFileSync('/app/scratch/live-vs-backtest-parity.json', `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
} finally {
  await closeSourcePool(pool);
}
