/**
 * Estudo de cauda da MIDAS no sizing live ($2.5 / $4) e de um governador
 * central de risco por slot de 5 minutos.
 *
 * Não altera preset nem runtime. Reexecuta o GLS oficial com book depth 25,
 * settlement 0.995 e taxas taker; depois aceita as entradas de cada slot por
 * ordem real de entryTime até esgotar um orçamento agregado do risco da
 * primeira entrada.
 *
 * Limite importante: este é um contrafactual de admissão, não a implementação
 * do Event Loss Ledger. A estratégia continua livre para fazer reverse depois
 * da entrada; eventRiskAudit mede quando isso faz a perda final furar o risco
 * inicial.
 *
 * Uso:
 *   node --max-old-space-size=12288 labs/sandbox/midas-portfolio-tail-budget.mjs
 *   node --max-old-space-size=12288 labs/sandbox/midas-portfolio-tail-budget.mjs \
 *     --from 2026-07-01 --to 2026-07-26
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSequentialSoA } from '../../src/backtest/engine.js';
import { applyPolymarketFeesToBacktestResult, calculatePolymarketTakerFee } from '../../src/backtest/fees.js';
import { parse } from '../../src/backtestStudio/gls/parser.js';
import { createGlsBacktestRunner } from '../../src/backtestStudio/gls/runtime.js';
import { loadConfig } from '../../src/config.js';
import { loadBacktestColumnSet } from '../../src/query/columnChunkReader.js';
import { closeStateDatabase, openStateDatabase } from '../../src/state/sqlite.js';
import { loadPreset } from '../shared/presets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const STRATEGY_ROOT = path.join(ROOT, 'labs/strategies/terminal/midas-carry-v1');
const OUT_JSON = path.join(ROOT, 'labs/sandbox/midas-portfolio-tail-budget.json');

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
const LIVE_ENTRY_BUDGET = 2.5;
const LIVE_MAX_ENTRY_BUDGET = 4;
const PORTFOLIO_CAPS = [4.1, 6.2, 8.2, 12.3, 20.5];

function parseArgs(argv) {
  const flags = { from: '2026-07-01', to: '2026-07-26' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return flags;
}

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round((finite(value) + Number.EPSILON) * scale) / scale;
}

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function normSlot(value) {
  if (value == null) return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) return String(value);
  return new Date(ms).toISOString();
}

function tradeFee(order) {
  if (order?.liquidity === 'maker') return 0;
  if (Array.isArray(order?.fills) && order.fills.length) {
    return order.fills.reduce(
      (sum, fill) =>
        sum +
        calculatePolymarketTakerFee({
          shares: fill.qty ?? fill.shares,
          price: fill.price,
          feeRate: 0.07,
        }),
      0,
    );
  }
  return calculatePolymarketTakerFee({
    shares: order?.shares ?? order?.qty,
    price: order?.avgPrice ?? order?.price,
    feeRate: 0.07,
  });
}

function primaryEntry(orders) {
  const entries = (orders ?? []).filter((order) => order?.type === 'entry');
  return entries.find((order) => order.orderRole === 'entry') ?? entries[0] ?? null;
}

function maxDrawdown(trades) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const trade of trades) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function summarize(trades) {
  const sortedTrades = [...trades].sort(
    (a, b) => a.slot.localeCompare(b.slot) || a.entryTimeMs - b.entryTimeMs || a.asset.localeCompare(b.asset),
  );
  const pnls = sortedTrades.map((trade) => trade.pnl);
  const pnlAsc = [...pnls].sort((a, b) => a - b);
  const wins = pnls.filter((value) => value > 0);
  const losses = pnls.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = -losses.reduce((sum, value) => sum + value, 0);
  const tailCount = Math.max(1, Math.ceil(pnlAsc.length * 0.05));
  const cvar95 = pnlAsc.length
    ? pnlAsc.slice(0, tailCount).reduce((sum, value) => sum + value, 0) / tailCount
    : 0;

  const bySlot = new Map();
  const byDay = new Map();
  for (const trade of sortedTrades) {
    bySlot.set(trade.slot, (bySlot.get(trade.slot) ?? 0) + trade.pnl);
    const day = trade.slot.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + trade.pnl);
  }
  const slotSeries = [...bySlot.entries()]
    .map(([slot, pnl]) => ({ slot, pnl }))
    .sort((a, b) => a.slot.localeCompare(b.slot));
  const worstSlot = slotSeries.reduce(
    (worst, item) => (worst == null || item.pnl < worst.pnl ? item : worst),
    null,
  );
  const worstDay = [...byDay.entries()].reduce(
    (worst, [day, pnl]) => (worst == null || pnl < worst.pnl ? { day, pnl } : worst),
    null,
  );

  return {
    trades: sortedTrades.length,
    pnl: round(pnls.reduce((sum, value) => sum + value, 0)),
    wins: wins.length,
    losses: losses.length,
    winRatePct: round(sortedTrades.length ? (100 * wins.length) / sortedTrades.length : 0, 2),
    avgWin: round(wins.length ? grossProfit / wins.length : 0),
    avgLoss: round(losses.length ? -grossLoss / losses.length : 0),
    profitFactor: round(grossLoss > 0 ? grossProfit / grossLoss : 0),
    maxLoss: round(pnlAsc[0] ?? 0),
    p05: round(quantile(pnlAsc, 0.05) ?? 0),
    cvar95: round(cvar95),
    maxDrawdown: round(maxDrawdown(sortedTrades)),
    worstSlot: worstSlot ? { slot: worstSlot.slot, pnl: round(worstSlot.pnl) } : null,
    worstDay: worstDay ? { day: worstDay.day, pnl: round(worstDay.pnl) } : null,
  };
}

function selectWithSlotCap(trades, capUsd) {
  const bySlot = new Map();
  for (const trade of trades) {
    if (!bySlot.has(trade.slot)) bySlot.set(trade.slot, []);
    bySlot.get(trade.slot).push(trade);
  }

  const accepted = [];
  const skipped = [];
  let maxReserved = 0;
  for (const slotTrades of bySlot.values()) {
    slotTrades.sort(
      (a, b) => a.entryTimeMs - b.entryTimeMs || a.asset.localeCompare(b.asset),
    );
    let reserved = 0;
    for (const trade of slotTrades) {
      if (reserved + trade.initialWorstLoss <= capUsd + 1e-9) {
        accepted.push(trade);
        reserved += trade.initialWorstLoss;
      } else {
        skipped.push(trade);
      }
    }
    maxReserved = Math.max(maxReserved, reserved);
  }
  return {
    capUsd,
    accepted,
    skipped,
    maxReserved,
    summary: summarize(accepted),
  };
}

async function runAsset(db, glsAst, asset, from, to) {
  const presetId = `${asset.toLowerCase()}-gold-v1`;
  const { params: presetParams } = loadPreset(presetId, {
    strategyFamily: 'terminal',
    strategyId: 'midas-carry-v1',
  });
  const params = {
    ...presetParams,
    entryBudget: LIVE_ENTRY_BUDGET,
    maxEntryBudget: LIVE_MAX_ENTRY_BUDGET,
    tierAskBudgetFactor: 1.5,
    settleWinnerPrice: 0.995,
  };

  console.error(`[${asset}] loading ${from}..${to}`);
  const started = Date.now();
  const columnSet = await loadBacktestColumnSet(db, {
    from: new Date(`${from}T00:00:00.000Z`).toISOString(),
    to: new Date(`${to}T00:00:00.000Z`).toISOString(),
    underlying: asset,
    interval: '5m',
    bookDepth: 25,
    selectBookDepth: 25,
    dataset: 'backtest_ticks',
    includeBook: true,
    validBacktestRows: true,
  });
  const runner = createGlsBacktestRunner(glsAst, params, {
    executionMode: 'compiled-soa',
    fastRun: true,
    bookDepth: 25,
  });
  runner.bindColumnSet(columnSet);
  await runSequentialSoA(runner, columnSet, true);
  const outcome = runner.finish();
  applyPolymarketFeesToBacktestResult(outcome, { category: 'crypto' });

  const trades = [];
  for (const event of outcome.events ?? []) {
    if (event.reason === 'no_entry') continue;
    const entry = primaryEntry(event.orders);
    if (!entry) continue;
    const slot = normSlot(event.eventStart);
    if (!slot) continue;
    const entryCost = finite(entry.notional);
    const entryFee = tradeFee(entry);
    const allEntries = (event.orders ?? []).filter((order) => order?.type === 'entry');
    const allEntryRisk = allEntries.reduce(
      (sum, order) => sum + finite(order.notional) + tradeFee(order),
      0,
    );
    const pnl = finite(event.finalPnl);
    const initialWorstLoss = entryCost + entryFee;
    trades.push({
      asset,
      slot,
      entryTimeMs: Number.isFinite(Number(entry.ts))
        ? Number(entry.ts)
        : Date.parse(String(entry.ts ?? event.entryTime ?? slot)),
      side: entry.side ?? event.positionType ?? null,
      pnl,
      entryCost: round(entryCost),
      entryFee: round(entryFee),
      initialWorstLoss: round(initialWorstLoss),
      allEntryRisk: round(allEntryRisk),
      reversed: allEntries.length > 1,
      initialRiskBreachedByFinalLoss: pnl < -initialWorstLoss - 1e-6,
    });
  }

  console.error(
    `[${asset}] ticks=${columnSet.length} trades=${trades.length} ` +
      `pnl=${trades.reduce((sum, trade) => sum + trade.pnl, 0).toFixed(2)} ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  return trades;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath, { readOnly: true });
  const glsSource = fs.readFileSync(path.join(STRATEGY_ROOT, 'strategy.gls'), 'utf8');
  const glsAst = parse(glsSource);

  const trades = [];
  try {
    for (const asset of ASSETS) {
      trades.push(...(await runAsset(db, glsAst, asset, flags.from, flags.to)));
    }
  } finally {
    closeStateDatabase(db);
  }

  const baseline = summarize(trades);
  const governors = PORTFOLIO_CAPS.map((cap) => {
    const result = selectWithSlotCap(trades, cap);
    return {
      capUsd: cap,
      accepted: result.accepted.length,
      skipped: result.skipped.length,
      skippedPct: round(trades.length ? (100 * result.skipped.length) / trades.length : 0, 2),
      maxReserved: round(result.maxReserved),
      summary: result.summary,
    };
  });

  const riskBreaches = trades.filter((trade) => trade.initialRiskBreachedByFinalLoss);
  const reversed = trades.filter((trade) => trade.reversed);
  const report = {
    meta: {
      from: flags.from,
      to: flags.to,
      assets: ASSETS,
      entryBudget: LIVE_ENTRY_BUDGET,
      maxEntryBudget: LIVE_MAX_ENTRY_BUDGET,
      generatedAt: new Date().toISOString(),
      note:
        'Backtest GLS oficial; cap apenas da primeira entrada, por entryTime. Reverse continua livre. Não é autorização live.',
    },
    perAsset: Object.fromEntries(
      ASSETS.map((asset) => {
        const subset = trades.filter((trade) => trade.asset === asset);
        return [asset, summarize(subset)];
      }),
    ),
    baseline,
    eventRiskAudit: {
      reversedTrades: reversed.length,
      initialRiskBreaches: riskBreaches.length,
      worstBreaches: riskBreaches
        .sort((a, b) => a.pnl - b.pnl)
        .slice(0, 20)
        .map((trade) => ({
          asset: trade.asset,
          slot: trade.slot,
          pnl: round(trade.pnl),
          initialWorstLoss: trade.initialWorstLoss,
          allEntryRisk: trade.allEntryRisk,
        })),
    },
    governors,
  };

  fs.writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.error(`Wrote ${OUT_JSON}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
