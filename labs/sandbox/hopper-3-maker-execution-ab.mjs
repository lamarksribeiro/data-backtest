/**
 * A/B Hopper 3 — optimistic_maker vs resting_maker vs taker (mesmos ticks sintéticos).
 *
 * Uso:
 *   node labs/sandbox/hopper-3-maker-execution-ab.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyPolymarketFeesToBacktestResult } from '../../src/backtest/fees.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const RUNNER_PATH = path.join(ROOT, 'labs/legacy/strategy-runners/portable/hopper-3-runner.js');
const EXP_PATH = path.join(ROOT, 'labs/strategies/carry/hopper-3/experiments/maker-execution-ab.json');
const REPORT_PATH = path.join(ROOT, 'labs/sandbox/hopper-3-maker-execution-ab-report.md');

function loadHopper() {
  const code = fs.readFileSync(RUNNER_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict";\n${code}\nreturn __hopperExports;`)();
}

function makeTicks() {
  // 3 eventos: (1) ask atravessa → resting fill; (2) ask não atravessa → timeout; (3) mercado estável
  const events = [];
  const mk = (eventStart, conditionId, points) => {
    for (const p of points) {
      events.push({
        ts: p.ts,
        event_start: eventStart,
        condition_id: conditionId,
        price_to_beat: 100000,
        btc_price: 100050,
        up_best_ask: p.ask,
        up_best_bid: p.bid,
        down_best_ask: Number((1 - p.ask + 0.02).toFixed(2)),
        down_best_bid: Number((1 - p.ask).toFixed(2)),
        up_price: (p.ask + p.bid) / 2,
        down_price: 0.5,
        up_book_asks: JSON.stringify([{ price: p.ask, size: 500 }]),
        up_book_bids: JSON.stringify([{ price: p.bid, size: 500 }]),
        down_book_asks: JSON.stringify([{ price: Number((1 - p.ask + 0.02).toFixed(2)), size: 500 }]),
        down_book_bids: JSON.stringify([{ price: Number((1 - p.ask).toFixed(2)), size: 500 }]),
      });
    }
  };

  // Evento A: place @ bid 0.68, depois ask cruza 0.67
  mk('2026-06-01T12:00:00.000Z', 'evt-cross', [
    { ts: '2026-06-01T12:01:00.000Z', ask: 0.70, bid: 0.68 },
    { ts: '2026-06-01T12:01:05.000Z', ask: 0.67, bid: 0.66 },
    { ts: '2026-06-01T12:04:50.000Z', ask: 0.80, bid: 0.78 },
  ]);

  // Evento B: place e nunca cruza (timeout 15s)
  mk('2026-06-01T12:05:00.000Z', 'evt-timeout', [
    { ts: '2026-06-01T12:06:00.000Z', ask: 0.70, bid: 0.68 },
    { ts: '2026-06-01T12:06:20.000Z', ask: 0.71, bid: 0.69 },
    { ts: '2026-06-01T12:09:50.000Z', ask: 0.75, bid: 0.73 },
  ]);

  // Evento C: outro cross
  mk('2026-06-01T12:10:00.000Z', 'evt-cross-2', [
    { ts: '2026-06-01T12:11:00.000Z', ask: 0.72, bid: 0.70 },
    { ts: '2026-06-01T12:11:08.000Z', ask: 0.69, bid: 0.68 },
    { ts: '2026-06-01T12:14:50.000Z', ask: 0.85, bid: 0.83 },
  ]);

  return events;
}

function summarize(mode, result) {
  const withFees = applyPolymarketFeesToBacktestResult(
    structuredClone(result),
    { category: 'crypto' },
  );
  const feeTotal = withFees.events.reduce((s, e) => s + (e.fees?.totalFee || 0), 0);
  return {
    mode,
    totalEvents: result.summary.totalEvents,
    totalEntries: result.summary.totalEntries,
    totalNoEntry: result.summary.totalNoEntry,
    totalPnl: Number(result.summary.totalPnl.toFixed(4)),
    totalPnlAfterFees: Number((result.summary.totalPnl - feeTotal).toFixed(4)),
    fees: Number(feeTotal.toFixed(4)),
    restingPlaced: result.summary.restingPlaced,
    restingFilled: result.summary.restingFilled,
    restingCancelled: result.summary.restingCancelled,
    makerFillRate: result.summary.makerFillRate,
  };
}

function main() {
  const hopper = loadHopper();
  const exp = JSON.parse(fs.readFileSync(EXP_PATH, 'utf8'));
  const ticks = makeTicks();
  const rows = [];

  for (const mode of exp.modes) {
    const result = hopper.runHopper3Backtest({ ...exp.baseParams, executionMode: mode }, ticks);
    rows.push(summarize(mode, result));
  }

  const optimistic = rows.find((r) => r.mode === 'optimistic_maker');
  const resting = rows.find((r) => r.mode === 'resting_maker');
  const taker = rows.find((r) => r.mode === 'taker');

  const md = [
    '# Hopper 3 — A/B executionMode (sintético)',
    '',
    `Gerado: ${new Date().toISOString()}`,
    '',
    'Mesmos ticks sintéticos (3 eventos: 2 com atravessamento de ask, 1 timeout).',
    '',
    '| mode | entries | no_entry | PnL bruto | fees | PnL pós-fee | resting placed/filled/cancel | fill rate |',
    '|------|---------|----------|-----------|------|-------------|------------------------------|-----------|',
    ...rows.map((r) =>
      `| ${r.mode} | ${r.totalEntries} | ${r.totalNoEntry} | ${r.totalPnl} | ${r.fees} | ${r.totalPnlAfterFees} | ${r.restingPlaced}/${r.restingFilled}/${r.restingCancelled} | ${r.makerFillRate == null ? '—' : (r.makerFillRate * 100).toFixed(0) + '%'} |`),
    '',
    '## Leitura',
    '',
    `- optimistic_maker entries=${optimistic.totalEntries} (fill imediato no bid)`,
    `- resting_maker entries=${resting.totalEntries}, fill rate=${resting.makerFillRate == null ? 'n/a' : (resting.makerFillRate * 100).toFixed(0) + '%'} (só quando ask atravessa)`,
    `- taker entries=${taker.totalEntries}, fees=${taker.fees}`,
    '',
    'Critério OK: resting fill rate < 100% quando há timeout; optimistic entra em todos os sinais; taker paga fee.',
    '',
  ].join('\n');

  fs.writeFileSync(REPORT_PATH, md);
  console.log(md);
  console.log(`\nSalvo: ${REPORT_PATH}`);
}

main();
