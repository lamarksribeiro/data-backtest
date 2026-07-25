/**
 * Replay MIDAS micro-aggressive em todos os eventos live e gera tabela de paridade.
 * No Brutus:
 *   node scratch/live-vs-backtest/compare-all-live.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { parse } from '../../src/backtestStudio/gls/parser.js';
import { analyzeStrategyColumns } from '../../src/backtestStudio/gls/columnAnalysis.js';
import { runBacktest } from '../../src/backtest/engine.js';
import { loadConfig } from '../../src/config.js';
import { closeStateDatabase, openStateDatabase } from '../../src/state/sqlite.js';
import { loadPreset } from '../../labs/shared/presets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const livePath = path.join(__dirname, 'live-markets.json');
const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
const rows = live.rows || [];

const TARGET_STARTS = new Set(rows.map((r) => r.eventStart));

const { params, strategyRoot } = loadPreset('btc-micro-aggressive-v1', {
  strategyFamily: 'terminal',
  strategyId: 'midas-carry-v1',
});
const strategy = JSON.parse(fs.readFileSync(path.join(strategyRoot, 'strategy.json'), 'utf8'));
const sourcePath = path.resolve(strategy.source.path || strategy.source.glsPath);
const glsAst = parse(fs.readFileSync(sourcePath, 'utf8'));
const bookDepth = Number(strategy.defaultBookDepth || 25);
const columnAnalysis = analyzeStrategyColumns(glsAst, bookDepth);

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath);
const byStart = new Map();

function parseDateStart(value) {
  return new Date(`${value}T00:00:00.000Z`);
}
function parseDateEndExclusive(value) {
  // to is exclusive end-of-day next
  const d = new Date(`${value}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

try {
  await runBacktest(db, {
    from: parseDateStart('2026-07-24').toISOString(),
    to: parseDateEndExclusive('2026-07-25').toISOString(),
    underlying: 'BTC',
    interval: '5m',
    bookDepth,
    batchSize: 25_000,
    strategy: `gls:${strategy.id}`,
    strategyLabel: strategy.name,
    glsAst,
    columnAnalysis,
    params,
    fastRun: false,
    glsExecution: 'compiled-soa',
    strategyMeta: { lab: true, analysis: 'live-vs-backtest-all' },
    onEventFinalized: (event) => {
      const start = event.eventStart ? new Date(event.eventStart).toISOString() : null;
      if (!TARGET_STARTS.has(start)) return;
      const orders = (event.orders || []).map((o) => ({
        type: o.type,
        side: o.side,
        ts: o.ts,
        iso: o.ts != null ? new Date(o.ts).toISOString() : null,
        avgPrice: o.avgPrice ?? o.price ?? null,
        qty: o.qty ?? o.quantity ?? null,
        reason: o.reason ?? null,
      }));
      const entry = orders.find((o) => o.type === 'entry') || null;
      const exits = orders.filter((o) => o.type === 'exit' || o.type === 'reverse' || String(o.reason || '').includes('reverse'));
      byStart.set(start, {
        conditionId: event.eventId || event.conditionId || null,
        eventStart: start,
        eventEnd: event.eventEnd ? new Date(event.eventEnd).toISOString() : null,
        finalPnl: event.finalPnl ?? event.pnl ?? 0,
        winnerSide: event.winnerSide ?? event.winner ?? null,
        reason: event.reason ?? null,
        entry,
        exits,
        orders,
        marks: (event.marks || []).slice(0, 12).map((m) => ({
          ts: m.ts ?? m.timestamp ?? null,
          name: m.name ?? m.mark ?? null,
          data: m.data ?? null,
        })),
      });
    },
  });

  const comparisons = rows.map((liveRow) => {
    const bt = byStart.get(liveRow.eventStart) || null;
    const entryDeltaMs =
      bt?.entry?.ts != null && liveRow.opened
        ? Number(bt.entry.ts) - Date.parse(liveRow.opened)
        : null;
    const sameSide =
      bt?.entry?.side && liveRow.side
        ? String(bt.entry.side).toUpperCase() === String(liveRow.side).toUpperCase()
        : false;
    const btExitReasons = [
      ...new Set(
        (bt?.orders || [])
          .filter((o) => o.type !== 'entry')
          .map((o) => o.reason || o.type)
          .filter(Boolean),
      ),
    ];
    const pnlLive = Number(liveRow.pnl || 0);
    const pnlBt = bt ? Number(bt.finalPnl || 0) : null;
    return {
      marketId: liveRow.marketId,
      eventStart: liveRow.eventStart,
      live: {
        side: liveRow.side,
        entry: liveRow.entry,
        qty: liveRow.qty,
        pnl: pnlLive,
        winner: liveRow.winner,
        exitKind: liveRow.exitKind,
        rev: liveRow.rev,
        opened: liveRow.opened,
        closed: liveRow.closed,
        exitPrice: liveRow.exitPrice,
        enterLegs: liveRow.enterLegs,
        settLegs: liveRow.settLegs,
      },
      backtest: bt
        ? {
            entered: Boolean(bt.entry),
            side: bt.entry?.side ?? null,
            entryPrice: bt.entry?.avgPrice ?? null,
            entryIso: bt.entry?.iso ?? null,
            entryReason: bt.entry?.reason ?? null,
            pnl: pnlBt,
            winnerSide: bt.winnerSide,
            reason: bt.reason,
            exitReasons: btExitReasons,
            orders: bt.orders,
            marks: bt.marks,
            lakePresent: true,
          }
        : {
            entered: false,
            side: null,
            entryPrice: null,
            entryIso: null,
            entryReason: null,
            pnl: null,
            winnerSide: null,
            reason: 'missing_from_lake_or_no_callback',
            exitReasons: [],
            orders: [],
            marks: [],
            lakePresent: false,
          },
      parity: {
        btFound: Boolean(bt),
        entered: Boolean(bt?.entry),
        sameSide,
        entryDeltaMs,
        entryPriceLive: liveRow.entry,
        entryPriceBt: bt?.entry?.avgPrice ?? null,
        exitLive: liveRow.exitKind,
        exitBt: btExitReasons,
        pnlLive,
        pnlBt,
        pnlDelta: pnlBt == null ? null : Number((pnlLive - pnlBt).toFixed(4)),
        class:
          !bt
            ? 'bt_missing'
            : !bt.entry
              ? 'bt_no_entry'
              : !sameSide
                ? 'side_mismatch'
                : liveRow.rev !== btExitReasons.some((r) => String(r).includes('reverse'))
                  ? 'exit_path_diff'
                  : Math.abs(pnlLive - pnlBt) < 0.15
                    ? 'near_parity'
                    : 'pnl_gap',
      },
    };
  });

  const classes = comparisons.reduce((acc, c) => {
    const k = c.parity.class;
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  const out = {
    generatedAt: new Date().toISOString(),
    preset: 'btc-micro-aggressive-v1',
    strategy: 'midas-carry-v1',
    liveSummary: live.summary,
    targets: TARGET_STARTS.size,
    captured: byStart.size,
    classes,
    totals: {
      livePnl: Number(comparisons.reduce((s, c) => s + c.parity.pnlLive, 0).toFixed(4)),
      btPnlOnLiveMarkets: Number(
        comparisons.reduce((s, c) => s + (c.parity.pnlBt ?? 0), 0).toFixed(4),
      ),
      btEntered: comparisons.filter((c) => c.parity.entered).length,
      sameSide: comparisons.filter((c) => c.parity.sameSide).length,
      nearParity: comparisons.filter((c) => c.parity.class === 'near_parity').length,
      exitPathDiff: comparisons.filter((c) => c.parity.class === 'exit_path_diff').length,
      btNoEntry: comparisons.filter((c) => c.parity.class === 'bt_no_entry').length,
      btMissing: comparisons.filter((c) => c.parity.class === 'bt_missing').length,
    },
    comparisons,
  };

  const outPath = path.join(__dirname, 'full-parity-report.json');
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        ok: true,
        outPath,
        targets: out.targets,
        captured: out.captured,
        classes: out.classes,
        totals: out.totals,
      },
      null,
      2,
    ),
  );
} finally {
  closeStateDatabase(db);
}
