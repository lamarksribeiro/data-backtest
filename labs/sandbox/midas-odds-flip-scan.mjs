/**
 * Detecta viradas abruptas de odds UP/DOWN no final do evento e cruza com perdas MIDAS.
 *
 * Uso:
 *   node --max-old-space-size=8192 labs/sandbox/midas-odds-flip-scan.mjs
 *   node labs/sandbox/midas-odds-flip-scan.mjs --from 2026-07-01 --to 2026-07-26
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/config.js';
import { openStateDatabase, closeStateDatabase } from '../../src/state/sqlite.js';
import { parse } from '../../src/backtestStudio/gls/parser.js';
import { createGlsBacktestRunner } from '../../src/backtestStudio/gls/runtime.js';
import { runSequentialSoA } from '../../src/backtest/engine.js';
import { loadBacktestColumnSet } from '../../src/query/columnChunkReader.js';
import { applyPolymarketFeesToBacktestResult } from '../../src/backtest/fees.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const STRATEGY_ROOT = path.join(ROOT, 'labs/strategies/terminal/midas-carry-v1');
const OUT_JSON = path.join(ROOT, 'labs/sandbox/midas-odds-flip-scan.json');
const OUT_MD = path.join(ROOT, 'labs/sandbox/midas-odds-flip-scan.md');

const BASELINE_PARAMS = {
  maxAsk: 0.94,
  maxDistAbs: 40,
  tierAskBudgetFactor: 2.0,
  entryBudget: 10,
  maxEntryBudget: 30,
};

function parseArgs(argv) {
  const flags = {};
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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mid(ask, bid) {
  if (ask == null || bid == null) return ask ?? bid ?? null;
  return (ask + bid) / 2;
}

function decodeCode(columnSet, name, row) {
  const codes = columnSet.codes?.get(name);
  const dict = columnSet.dictionaries?.get(name);
  if (!codes || !dict) return null;
  const code = codes[row];
  if (!Number.isInteger(code) || code < 0 || code >= dict.length) return null;
  return dict[code] || null;
}

function col(columnSet, name) {
  return columnSet.columns?.get(name) || null;
}

/**
 * Classifica o path de odds no evento.
 * Padrão-alvo (imagem): um lado dominante no late, depois X-cross violento nos últimos segundos.
 */
function classifyOddsPath(points) {
  if (!points || points.length < 20) return null;

  const at = (lo, hi) => points.filter((p) => p.secsLeft >= lo && p.secsLeft < hi);
  const windowMid = (lo, hi) => {
    const w = at(lo, hi);
    if (!w.length) return null;
    const up = w.reduce((s, p) => s + p.up, 0) / w.length;
    const down = w.reduce((s, p) => s + p.down, 0) / w.length;
    return { up, down, n: w.length, dominant: up >= down ? 'UP' : 'DOWN', edge: Math.abs(up - down) };
  };

  const midPhase = windowMid(60, 150);
  const latePhase = windowMid(15, 45);
  const finalPhase = windowMid(0, 8);
  if (!midPhase || !latePhase || !finalPhase) return null;

  const lateDom = latePhase.dominant;
  const lateDomMid = lateDom === 'UP' ? latePhase.up : latePhase.down;
  const finalOppMid = lateDom === 'UP' ? finalPhase.down : finalPhase.up;
  const finalDomMid = lateDom === 'UP' ? finalPhase.up : finalPhase.down;
  const oddsDelta = lateDomMid - finalDomMid;
  const oppRise = finalOppMid - (lateDom === 'UP' ? latePhase.down : latePhase.up);

  const last = points[points.length - 1];
  const spotWinner = last.spot != null && last.ptb != null
    ? (last.spot >= last.ptb ? 'UP' : 'DOWN')
    : null;

  const lateDominantStrong = latePhase.edge >= 0.25;
  const violentCross =
    lateDominantStrong
    && oddsDelta >= 0.35
    && oppRise >= 0.30
    && finalPhase.dominant !== latePhase.dominant;

  const softCross =
    latePhase.edge >= 0.15
    && oddsDelta >= 0.20
    && finalPhase.dominant !== latePhase.dominant;

  const settlementSurprise =
    spotWinner
    && latePhase.dominant !== spotWinner
    && lateDominantStrong;

  let maxOddsVel = 0;
  let maxOddsVelSecs = null;
  const latePts = points.filter((p) => p.secsLeft <= 20);
  for (let i = 1; i < latePts.length; i += 1) {
    const dt = Math.abs(latePts[i - 1].secsLeft - latePts[i].secsLeft);
    if (dt < 0.3 || dt > 3) continue;
    const dUp = Math.abs(latePts[i].up - latePts[i - 1].up);
    const vel = dUp / dt;
    if (vel > maxOddsVel) {
      maxOddsVel = vel;
      maxOddsVelSecs = latePts[i].secsLeft;
    }
  }

  let label = 'stable';
  if (violentCross) label = 'violent_odds_cross';
  else if (settlementSurprise) label = 'settlement_surprise';
  else if (softCross) label = 'soft_odds_cross';
  else if (maxOddsVel >= 0.25) label = 'high_odds_velocity';

  return {
    label,
    midPhase,
    latePhase,
    finalPhase,
    oddsDelta: Number(oddsDelta.toFixed(3)),
    oppRise: Number(oppRise.toFixed(3)),
    maxOddsVel: Number(maxOddsVel.toFixed(3)),
    maxOddsVelSecs: maxOddsVelSecs != null ? Number(maxOddsVelSecs.toFixed(2)) : null,
    spotWinner,
    lateDominant: latePhase.dominant,
    finalDominant: finalPhase.dominant,
    violentCross,
    softCross,
    settlementSurprise,
  };
}

function summarize(rows) {
  const n = rows.length;
  const pnl = rows.reduce((s, r) => s + (r.finalPnl || 0), 0);
  const losses = rows.filter((r) => (r.finalPnl || 0) < -0.01);
  const wins = rows.filter((r) => (r.finalPnl || 0) > 0.01);
  return {
    n,
    pnl: Number(pnl.toFixed(2)),
    losses: losses.length,
    wins: wins.length,
    lossPnl: Number(losses.reduce((s, r) => s + r.finalPnl, 0).toFixed(2)),
    wr: n ? Number((wins.length / n).toFixed(3)) : 0,
  };
}

function isFlipRelated(row) {
  return row.violentCross
    || row.settlementSurprise
    || row.label === 'soft_odds_cross'
    || row.label === 'high_odds_velocity'
    || row.label === 'violent_odds_cross'
    || row.label === 'settlement_surprise';
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const from = flags.from || '2026-07-01';
  const to = flags.to || '2026-07-26';

  const config = loadConfig();
  const db = openStateDatabase(config.stateDbPath, { readOnly: true });
  const defaults = JSON.parse(fs.readFileSync(path.join(STRATEGY_ROOT, 'defaults.json'), 'utf8'));
  const glsSource = fs.readFileSync(path.join(STRATEGY_ROOT, 'strategy.gls'), 'utf8');
  const glsAst = parse(glsSource);
  const params = { ...defaults, ...BASELINE_PARAMS };

  console.log(`Carregando ticks ${from} → ${to}...`);
  const columnSet = await loadBacktestColumnSet(db, {
    from: new Date(`${from}T00:00:00.000Z`).toISOString(),
    to: new Date(`${to}T00:00:00.000Z`).toISOString(),
    underlying: 'BTC',
    interval: '5m',
    bookDepth: 25,
    selectBookDepth: 25,
    dataset: 'backtest_ticks',
    includeBook: true,
    validBacktestRows: true,
  });
  console.log(`ColumnSet: ${columnSet.length} ticks, events=${columnSet.events?.length ?? 0}`);

  const tsArr = col(columnSet, 'ts') || col(columnSet, '_ts_ms');
  const endArr = col(columnSet, 'event_end') || col(columnSet, '_event_end_ms');
  const spotArr = col(columnSet, 'underlying_price');
  const ptbArr = col(columnSet, 'price_to_beat');
  const upAskArr = col(columnSet, 'up_best_ask');
  const downAskArr = col(columnSet, 'down_best_ask');
  const upBidArr = col(columnSet, 'up_best_bid');
  const downBidArr = col(columnSet, 'down_best_bid');
  const upPriceArr = col(columnSet, 'up_price');
  const downPriceArr = col(columnSet, 'down_price');

  const classified = [];
  const byCondition = new Map();

  for (const ev of columnSet.events || []) {
    const endMs = Number(ev.eventEnd);
    const points = [];
    for (let i = ev.startRow; i < ev.endRow; i += 1) {
      const ts = Number(tsArr?.[i]);
      if (!Number.isFinite(ts) || !Number.isFinite(endMs)) continue;
      // ts pode estar em ms epoch ou em micros DuckDB timestamp — ColumnSet usa ms
      const secsLeft = (endMs - ts) / 1000;
      if (secsLeft < 0 || secsLeft > 300) continue;
      const upAsk = num(upAskArr?.[i]) ?? num(upPriceArr?.[i]);
      const downAsk = num(downAskArr?.[i]) ?? num(downPriceArr?.[i]);
      const upBid = num(upBidArr?.[i]);
      const downBid = num(downBidArr?.[i]);
      const up = mid(upAsk, upBid) ?? upAsk;
      const down = mid(downAsk, downBid) ?? downAsk;
      if (up == null || down == null) continue;
      points.push({
        secsLeft,
        up,
        down,
        spot: num(spotArr?.[i]),
        ptb: num(ptbArr?.[i]) ?? num(ev.priceToBeat),
      });
    }
    points.sort((a, b) => b.secsLeft - a.secsLeft);
    const pathInfo = classifyOddsPath(points);
    if (!pathInfo) continue;

    const conditionId = decodeCode(columnSet, 'condition_id', ev.startRow) || String(ev.conditionCode);
    const shortId = String(conditionId).slice(0, 12);
    const eventStartIso = Number.isFinite(ev.eventStart)
      ? new Date(ev.eventStart).toISOString()
      : null;
    const row = {
      conditionId: shortId,
      conditionIdFull: conditionId,
      eventStart: eventStartIso,
      dt: eventStartIso ? eventStartIso.slice(0, 10) : null,
      ptb: num(ev.priceToBeat),
      nPoints: points.length,
      ...pathInfo,
    };
    classified.push(row);
    byCondition.set(shortId, row);
    byCondition.set(conditionId, row);
  }

  const byLabel = {};
  for (const row of classified) {
    byLabel[row.label] = (byLabel[row.label] || 0) + 1;
  }
  console.log('Labels:', byLabel);

  console.log('Rodando MIDAS baseline...');
  const runner = createGlsBacktestRunner(glsAst, params, {
    executionMode: 'compiled-soa',
    fastRun: true,
    bookDepth: 25,
  });
  runner.bindColumnSet(columnSet);
  await runSequentialSoA(runner, columnSet, true);
  const outcome = runner.finish();
  applyPolymarketFeesToBacktestResult(outcome, { category: 'crypto' });
  closeStateDatabase(db);

  const traded = (outcome.events || []).filter((e) => e.reason !== 'no_entry');
  const tradeRows = [];
  for (const ev of traded) {
    const cidFull = String(ev.conditionId || ev.condition_id || ev.eventId || '');
    const cid = cidFull.slice(0, 12);
    const pathInfo = byCondition.get(cidFull) || byCondition.get(cid);
    const finalPnl = Number(ev.finalPnl ?? 0);
    tradeRows.push({
      conditionId: cid,
      dt: String(ev.eventStart || ev.closedAt || '').slice(0, 10),
      finalPnl,
      side: ev.positionType,
      ask: num(ev.avgEntryPrice),
      label: pathInfo?.label || 'unclassified',
      oddsDelta: pathInfo?.oddsDelta ?? null,
      maxOddsVel: pathInfo?.maxOddsVel ?? null,
      lateDominant: pathInfo?.lateDominant ?? null,
      spotWinner: pathInfo?.spotWinner ?? null,
      violentCross: Boolean(pathInfo?.violentCross),
      settlementSurprise: Boolean(pathInfo?.settlementSurprise),
    });
  }

  const overall = summarize(tradeRows);
  const flipTrades = tradeRows.filter(isFlipRelated);
  const flipLosses = flipTrades.filter((r) => r.finalPnl < -0.01);
  const nonFlip = tradeRows.filter((r) => !isFlipRelated(r));
  const byTradeLabel = {};
  for (const label of [...new Set(tradeRows.map((r) => r.label))]) {
    byTradeLabel[label] = summarize(tradeRows.filter((r) => r.label === label));
  }

  const topFlipLosses = [...flipLosses].sort((a, b) => a.finalPnl - b.finalPnl).slice(0, 15);
  const imageCandidates = classified.filter((c) => {
    const ptbOk = c.ptb != null && c.ptb > 64300 && c.ptb < 64400;
    const dayOk = c.dt === '2026-07-25';
    return ptbOk && dayOk;
  });

  const report = {
    generatedAt: new Date().toISOString(),
    window: { from, to },
    eventCounts: byLabel,
    midas: {
      overall,
      flipTrades: summarize(flipTrades),
      flipLosses: summarize(flipLosses),
      nonFlip: summarize(nonFlip),
      byTradeLabel,
      flipLossShareOfLossPnl: overall.lossPnl
        ? Number((summarize(flipLosses).lossPnl / overall.lossPnl).toFixed(3))
        : null,
    },
    imageCandidates,
    topFlipLosses,
  };

  fs.writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`);

  const md = [];
  md.push('# MIDAS — scan de virada abrupta UP/DOWN');
  md.push('');
  md.push(`Gerado: ${report.generatedAt}`);
  md.push(`Janela: ${from} → ${to}`);
  md.push('');
  md.push('## Eventos no lake (todos)');
  md.push('');
  md.push('| label | n |');
  md.push('|---|---:|');
  for (const [k, v] of Object.entries(byLabel).sort((a, b) => b[1] - a[1])) {
    md.push(`| ${k} | ${v} |`);
  }
  md.push('');
  md.push('## MIDAS baseline (aggressive dist40/tier2)');
  md.push('');
  md.push(`Trades: ${overall.n} · PnL ${overall.pnl} · WR ${overall.wr} · Loss PnL ${overall.lossPnl}`);
  md.push('');
  md.push('| path | n | PnL | WR | losses | loss PnL |');
  md.push('|---|---:|---:|---:|---:|---:|');
  for (const [k, s] of Object.entries(byTradeLabel).sort((a, b) => a[1].pnl - b[1].pnl)) {
    md.push(`| ${k} | ${s.n} | ${s.pnl} | ${s.wr} | ${s.losses} | ${s.lossPnl} |`);
  }
  md.push('');
  md.push(`Flip-related trades: ${report.midas.flipTrades.n} (PnL ${report.midas.flipTrades.pnl})`);
  md.push(`Flip losses share of loss PnL: ${report.midas.flipLossShareOfLossPnl}`);
  md.push('');
  md.push('## Top flip losses');
  md.push('');
  md.push('| event | dt | pnl | label | oddsΔ | vel | late→spot |');
  md.push('|---|---|---:|---|---:|---:|---|');
  for (const r of topFlipLosses) {
    md.push(`| ${r.conditionId} | ${r.dt} | ${r.finalPnl.toFixed(2)} | ${r.label} | ${r.oddsDelta} | ${r.maxOddsVel} | ${r.lateDominant}→${r.spotWinner} |`);
  }
  md.push('');
  md.push('## Candidatos ao evento da imagem (25/07 PTB~64341)');
  md.push('');
  for (const c of imageCandidates) {
    md.push(`- ${c.conditionId} start=${c.eventStart} ptb=${c.ptb} label=${c.label} late=${c.lateDominant} final=${c.finalDominant} oddsΔ=${c.oddsDelta} vel=${c.maxOddsVel}`);
  }
  fs.writeFileSync(OUT_MD, `${md.join('\n')}\n`);
  console.log(`Wrote ${OUT_MD}`);
  console.log(JSON.stringify(report.midas, null, 2));
  if (imageCandidates.length) {
    console.log('Image candidates:', JSON.stringify(imageCandidates, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
