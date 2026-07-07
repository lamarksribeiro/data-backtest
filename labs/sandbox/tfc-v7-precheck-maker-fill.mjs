/**
 * TFC V7 — pré-check taxa de fill maker (conservador) vs entradas V5 Practical.
 * Uso: node --max-old-space-size=6144 labs/sandbox/tfc-v7-precheck-maker-fill.mjs
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../../src/state/sqlite.js';
import { queryTicks } from '../../src/query/duckdbQuery.js';
import {
  FROM, TO, JUNE_CUTOFF, BUDGET, FEE_RATE, dateRange, parseArgs, parseDateEnd,
  splitName, v5EntryGates, stats,
} from './tfc-v7-diag-lib.mjs';

const BOOK_DEPTH = 25;
const MAKER_DELTA = 0.01;
const MAKER_EPSILON = 0.01;
const DEADLINE_TAU = 10;
const REPORT_PATH = path.join('labs', 'sandbox', 'tfc-v7-precheck-maker-fill-report.md');

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
  const dSpot5 = null;
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
    d_spot_5: dSpot5,
    obi5: null,
  };
}

function bestAskFav(row, fav) {
  return fav === 'UP' ? Number(row.up_best_ask) : Number(row.down_best_ask);
}

function winnerSide(finalRow) {
  const spot = Number(finalRow.underlying_price);
  const ptb = Number(finalRow.price_to_beat);
  return spot > ptb ? 'UP' : 'DOWN';
}

function holdPnl(fav, entryPrice, budget = BUDGET) {
  const shares = Math.floor(budget / entryPrice);
  const cost = shares * entryPrice;
  return { shares, cost };
}

function settleHoldPnl(fav, entryPrice, finalRow, budget = BUDGET) {
  const { shares, cost } = holdPnl(fav, entryPrice, budget);
  const won = winnerSide(finalRow) === fav;
  return won ? shares - cost : -cost;
}

function spotDelta5s(rows, idx) {
  const curr = rows[idx];
  const currMs = new Date(curr.ts).getTime();
  for (let i = idx - 1; i >= 0; i -= 1) {
    const prev = rows[i];
    const prevMs = new Date(prev.ts).getTime();
    if ((currMs - prevMs) / 1000 >= 5) {
      return Number(curr.underlying_price) - Number(prev.underlying_price);
    }
  }
  return null;
}

function gatesWithSpot(row, rows, idx) {
  const dSpot5 = spotDelta5s(rows, idx);
  const enriched = enrichRow({ ...row, d_spot_5: dSpot5 });
  return v5EntryGates(enriched);
}

function makerFillBeforeDeadline(rows, entryIdx, limitPrice, fav) {
  for (let i = entryIdx + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.tau <= DEADLINE_TAU) break;
    const ask = bestAskFav(row, fav);
    if (Number.isFinite(ask) && ask <= limitPrice - MAKER_EPSILON) {
      return { filled: true, fillIdx: i, fillTau: row.tau };
    }
  }
  return { filled: false, fillIdx: null, fillTau: null };
}

function nearestDeadlineTick(rows, entryIdx) {
  let best = null;
  let bestDiff = Infinity;
  for (let i = entryIdx; i < rows.length; i += 1) {
    const tau = rows[i].tau;
    const diff = Math.abs(tau - DEADLINE_TAU);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = { idx: i, row: rows[i] };
    }
    if (tau < DEADLINE_TAU - 1) break;
  }
  return best;
}

function analyzeEvent(rows) {
  rows.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const enriched = rows.map((r, idx) => {
    const e = enrichRow(r);
    e._idx = idx;
    return e;
  });

  let entryIdx = null;
  for (let i = 0; i < enriched.length; i += 1) {
    const row = enriched[i];
    if (!(row.tau >= 5 && row.tau < 30)) continue;
    if (!gatesWithSpot(rows[i], rows, i)) continue;
    entryIdx = i;
    break;
  }
  if (entryIdx == null) return null;

  const entry = enriched[entryIdx];
  const finalRow = rows[rows.length - 1];
  const limitPrice = entry.ask_fav - MAKER_DELTA;
  const fill = makerFillBeforeDeadline(enriched, entryIdx, limitPrice, entry.fav);
  const entryPrice = fill.filled ? limitPrice : entry.ask_fav;
  const pnl = settleHoldPnl(entry.fav, entryPrice, finalRow);

  const deadline = nearestDeadlineTick(enriched, entryIdx);
  const fallbackGatesOk = deadline ? gatesWithSpot(rows[deadline.idx], rows, deadline.idx) : false;
  const fallbackPnl = fallbackGatesOk
    ? settleHoldPnl(entry.fav, bestAskFav(deadline.row, entry.fav), finalRow)
    : null;

  const dt = String(entry.event_start || entry.ts).slice(0, 10);
  return {
    condition_id: entry.condition_id,
    split: splitName(dt),
    fav: entry.fav,
    entryTau: entry.tau,
    limitPrice,
    makerFilled: fill.filled,
    fillTau: fill.fillTau,
    holdPnl: pnl,
    holdWin: pnl > 0,
    fallbackGatesOk,
    fallbackPnl,
    fallbackWin: fallbackPnl != null ? fallbackPnl > 0 : null,
  };
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

function summarizeSplit(rows, split) {
  const subset = split === 'all' ? rows : rows.filter((r) => r.split === split);
  const filled = subset.filter((r) => r.makerFilled);
  const notFilled = subset.filter((r) => !r.makerFilled);
  const fallback = subset.filter((r) => r.fallbackGatesOk);
  return {
    split,
    n: subset.length,
    makerFillPct: subset.length ? filled.length / subset.length : 0,
    wrMakerFill: filled.length ? filled.filter((r) => r.holdWin).length / filled.length : 0,
    wrNoFill: notFilled.length ? notFilled.filter((r) => r.holdWin).length / notFilled.length : 0,
    wrFallback: fallback.length ? fallback.filter((r) => r.fallbackWin).length / fallback.length : 0,
    nFallback: fallback.length,
    expMakerFill: stats(filled, 'holdPnl').exp,
    expNoFill: stats(notFilled, 'holdPnl').exp,
    expFallback: stats(fallback, 'fallbackPnl').exp,
  };
}

function renderReport(summaries, allSummary) {
  const lines = [];
  lines.push('# TFC V7 — Pré-check fill maker (conservador)');
  lines.push('');
  lines.push(`Janela: **${FROM} → ${TO}** | Regra: limit em ask−${MAKER_DELTA}, fill se ask ≤ P−${MAKER_EPSILON} antes de τ=${DEADLINE_TAU}s`);
  lines.push('');
  lines.push('## Números principais');
  lines.push('');
  lines.push('| Split | n entradas | % fill maker | WR c/ fill | WR s/ fill | n fallback τ≈10s | WR fallback |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of summaries) {
    lines.push(`| ${s.split} | ${s.n} | ${(s.makerFillPct * 100).toFixed(1)}% | ${(s.wrMakerFill * 100).toFixed(1)}% | ${(s.wrNoFill * 100).toFixed(1)}% | ${s.nFallback} | ${(s.wrFallback * 100).toFixed(1)}% |`);
  }
  const all = allSummary;
  lines.push(`| **all** | **${all.n}** | **${(all.makerFillPct * 100).toFixed(1)}%** | **${(all.wrMakerFill * 100).toFixed(1)}%** | **${(all.wrNoFill * 100).toFixed(1)}%** | **${all.nFallback}** | **${(all.wrFallback * 100).toFixed(1)}%** |`);
  lines.push('');
  lines.push('## Expectância hold proxy (sem late flip)');
  lines.push('');
  lines.push('| Split | exp maker fill | exp sem fill | exp fallback τ≈10s |');
  lines.push('| --- | --- | --- | --- |');
  for (const s of summaries) {
    lines.push(`| ${s.split} | $${s.expMakerFill.toFixed(2)} | $${s.expNoFill.toFixed(2)} | $${s.expFallback.toFixed(2)} |`);
  }
  lines.push(`| all | $${all.expMakerFill.toFixed(2)} | $${all.expNoFill.toFixed(2)} | $${all.expFallback.toFixed(2)} |`);
  lines.push('');
  lines.push('## Metodologia');
  lines.push('');
  lines.push('- Fonte: DuckDB direto em `backtest_ticks` BTC 5m depth 25.');
  lines.push('- Entrada: primeiro tick com gates V5 Practical em τ∈[5,30).');
  lines.push('- WR hold: compra do favorito ao preço maker (se fill) ou ask de entrada (sem fill); settlement binário no último tick.');
  lines.push('- Fallback: gates reavaliados no tick mais próximo de τ=10s; WR usa ask desse tick.');
  lines.push('- **Informativo** — não bloqueia implementação da infra V7.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const from = flags.from || FROM;
  const to = flags.to || TO;

  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath, { readOnly: true });

  const analyzed = [];
  for (const dt of dateRange(from, to)) {
    console.error(`Carregando ${dt}...`);
    const rows = await loadDayTicks(db, dt);
    const byEvent = new Map();
    for (const row of rows) {
      const cid = row.condition_id;
      if (!byEvent.has(cid)) byEvent.set(cid, []);
      byEvent.get(cid).push(row);
    }
    for (const eventRows of byEvent.values()) {
      const result = analyzeEvent(eventRows);
      if (result) analyzed.push(result);
    }
  }

  closeStateDatabase(db);

  const summaries = [
    summarizeSplit(analyzed, 'train'),
    summarizeSplit(analyzed, 'june'),
  ];
  const allSummary = summarizeSplit(analyzed, 'all');
  const report = renderReport(summaries, allSummary);
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, report, 'utf8');

  console.log(report);
  console.error(`Relatório gravado em ${REPORT_PATH}`);
  console.error(`Entradas V5: ${analyzed.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
