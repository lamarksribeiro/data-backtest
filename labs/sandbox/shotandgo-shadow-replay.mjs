#!/usr/bin/env node
/**
 * Shotandgo shadow → runner replay + diff fill-a-fill.
 *
 * Uso:
 *   node labs/sandbox/shotandgo-shadow-replay.mjs --shadow path/to/slug.json
 *   node labs/sandbox/shotandgo-shadow-replay.mjs --shadow ... --mode optimistic
 *   node labs/sandbox/shotandgo-shadow-replay.mjs --from-lake --day 2026-06-15
 *   node labs/sandbox/shotandgo-shadow-replay.mjs --synth  (fixture sintético + self-check)
 *
 * Critério "bateu": mesma sequência de (lado,tipo) ± tolerância; |ΔPnL| < $0.50 ou 5% notional.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const RUNNER_PATH = path.resolve(ROOT, 'labs/legacy/strategy-runners/portable/shotandgo-runner.js');
const DEFAULT_SHADOW_DIRS = [
  path.resolve(ROOT, '../polymarket-fm/logs/shadow'),
  path.resolve(ROOT, 'labs/strategies/carry/shotandgo-v1/shadow'),
];

function loadShotandgo() {
  const code = fs.readFileSync(RUNNER_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict";\n${code}\nreturn __shotandgoExports;`)();
}

function argVal(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  if (/^\d+$/.test(s)) return new Date(Number(s) * (s.length <= 10 ? 1000 : 1)).toISOString();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function num(v, fb = null) {
  if (v == null || v === '') return fb;
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

/** Mapeia CONFIG_SNAPSHOT do Phil → params do runner. */
function configToRunnerParams(shadow, modeOverride = null) {
  const c = shadow.config || {};
  const dry = shadow.mode?.dryRun !== false;
  // Phil com DESC_DRY_RESTING=True → alinhar ao runner honest (resting + cross).
  const descDryResting = c.desc_dry_resting === true
    || c.desc_dry_resting === 1
    || c.desc_dry_resting === 'true';
  const mode = modeOverride
    || shadow.replayHint?.executionMode
    || (descDryResting ? 'honest' : (dry ? 'optimistic' : 'honest'));

  const subPrices = Array.isArray(c.sub) ? c.sub : null;
  const subShares = Array.isArray(c.shares_sub) ? c.shares_sub : null;
  const descPrices = Array.isArray(c.desc) ? c.desc : null;
  const descShares = Array.isArray(c.shares_desc) ? c.shares_desc : null;

  const subLevels = subPrices && subShares
    ? subPrices.map((p, i) => ({ tipo: 'SUB', idx: i + 1, preco: Number(p), shares: Number(subShares[i]) }))
    : null;
  const descLevels = descPrices && descShares
    ? descPrices.map((p, i) => ({ tipo: 'DESC', idx: i + 1, preco: Number(p), shares: Number(descShares[i]) }))
    : null;

  const stop = Array.isArray(c.stop) ? c.stop : [];
  const piso = Array.isArray(c.piso) ? c.piso : [];
  const maxV = Array.isArray(c.max_viradas) ? c.max_viradas : [];
  const filtro = Array.isArray(c.filtro) ? c.filtro : [];
  const anti = Array.isArray(c.anti_glitch) ? c.anti_glitch : [];

  return {
    executionMode: mode,
    mult: Array.isArray(c.mult) ? c.mult.map(Number) : undefined,
    contagio: c.contagio,
    contagioMin: num(c.contagio_min),
    eqPreco: num(c.eq_preco),
    eqEncerra: c.eq_encerra !== false,
    eqLimiteAtivo: c.eq_limite_ativo !== false,
    eqLimiteArmaC: num(c.eq_limite_arma_c),
    eqLimiteCancelaC: num(c.eq_limite_cancela_c),
    eqLimiteReposta: c.eq_limite_reposta !== false,
    stopAtivo: stop[0] !== false && stop[0] !== 0,
    stopVirada: num(stop[1], 4),
    stopLimiar: num(stop[2], 1),
    pisoAtivo: piso[0] !== false && piso[0] !== 0,
    pisoViradas: Array.isArray(piso[1]) ? piso[1].map(Number) : undefined,
    pisoMargem: num(piso[2], 0.2),
    maxViradasAtivo: maxV[0] !== false && maxV[0] !== 0,
    maxViradas: num(maxV[1], 6),
    descModo: c.desc_modo || 'gatilho',
    descVirada: num(c.desc_virada, 5),
    fokAtivo: c.fok_ativo !== false,
    fokPrecoTeto: num(c.fok_preco_teto, 0.95),
    slippageCompra: num(c.slippage_compra, 0.03),
    filterLo: num(filtro[0], 0.1),
    filterHi: num(filtro[1], 0.9),
    antiGlitch: anti[0] !== false,
    somaMinValida: num(anti[1], 85),
    somaMaxValida: num(anti[2], 115),
    maxEventNotional: num(c.max_exposicao, 500),
    maxSecondsLeftToStart: num(c.janela_monitoramento, 280),
    makerTimeoutSec: num(c.pendente_timeout_seg, 45),
    makerFillEpsilon: num(c.maker_fill_epsilon, 0.01),
    applyPolymarketFees: false,
    subLevels,
    descLevels,
    takerLatencyTicks: 0,
    takerPriceMode: 'taker_limit',
  };
}

function shadowTicksToRunner(shadow) {
  const eventStart = toIso(shadow.eventStart)
    || (() => {
      const m = String(shadow.slug || '').match(/(\d{10})$/);
      return m ? new Date(Number(m[1]) * 1000).toISOString() : null;
    })();
  if (!eventStart) throw new Error('shadow sem eventStart/slug unix');

  const conditionId = shadow.conditionId || shadow.slug || 'shadow-event';
  const end = shadow.end || {};
  const ticks = Array.isArray(shadow.ticks) ? shadow.ticks : [];
  if (!ticks.length) throw new Error('shadow sem ticks[]');

  return ticks.map((t, i) => {
    const askUp = num(t.askUp, num(t.ask_up));
    const askDn = num(t.askDown, num(t.ask_down));
    let ts = toIso(t.ts);
    if (!ts && t.tau != null) {
      // tau = segundos restantes → ts = eventStart + (300 - tau)
      const tau = num(t.tau, 0);
      ts = new Date(Date.parse(eventStart) + (300 - tau) * 1000).toISOString();
    }
    if (!ts) {
      ts = new Date(Date.parse(eventStart) + i * 100).toISOString();
    }
    const bookUp = t.asksUp || t.asks_up || (askUp != null ? [{ price: askUp, size: 500 }] : []);
    const bookDn = t.asksDown || t.asks_down || (askDn != null ? [{ price: askDn, size: 500 }] : []);
    return {
      ts,
      event_start: eventStart,
      condition_id: conditionId,
      price_to_beat: num(t.ptb, num(end.ptb)),
      btc_price: num(t.btc),
      up_best_ask: askUp,
      down_best_ask: askDn,
      up_best_bid: num(t.bidUp, askUp != null ? askUp - 0.01 : null),
      down_best_bid: num(t.bidDown, askDn != null ? askDn - 0.01 : null),
      up_price: askUp,
      down_price: askDn,
      up_book_asks: bookUp,
      down_book_asks: bookDn,
    };
  }).filter((t) => t.up_best_ask != null && t.down_best_ask != null);
}

function fillKey(f) {
  const side = String(f.lado || f.side || '').toUpperCase();
  const tipo = String(f.tipo || '').toUpperCase();
  return `${side}|${tipo}`;
}

function normalizeFills(list) {
  return (list || [])
    .filter((f) => num(f.shares, 0) > 0)
    .map((f) => ({
      key: fillKey(f),
      side: String(f.lado || f.side || '').toUpperCase(),
      tipo: String(f.tipo || ''),
      shares: num(f.shares, 0),
      price: num(f.price ?? f.odd, 0),
      liquidity: f.liquidity || null,
    }));
}

function diffFills(shadowFills, runnerFills, { priceTol = 0.015, sizeTol = 0.51 } = {}) {
  const a = normalizeFills(shadowFills);
  const b = normalizeFills(runnerFills);
  const divergences = [];
  const n = Math.max(a.length, b.length);
  const paired = [];

  for (let i = 0; i < n; i++) {
    const s = a[i];
    const r = b[i];
    if (!s && r) {
      divergences.push({ kind: 'extra_runner', idx: i, runner: r });
      continue;
    }
    if (s && !r) {
      divergences.push({ kind: 'missing_runner', idx: i, shadow: s });
      continue;
    }
    const row = { idx: i, shadow: s, runner: r, ok: true, issues: [] };
    if (s.key !== r.key) {
      row.ok = false;
      row.issues.push(`tipo/lado ${s.key} vs ${r.key}`);
    }
    if (Math.abs(s.shares - r.shares) > sizeTol) {
      row.ok = false;
      row.issues.push(`shares Δ=${(r.shares - s.shares).toFixed(2)}`);
    }
    if (Math.abs(s.price - r.price) > priceTol) {
      row.ok = false;
      row.issues.push(`price Δ=${((r.price - s.price) * 100).toFixed(1)}¢`);
    }
    if (!row.ok) divergences.push({ kind: 'mismatch', ...row });
    paired.push(row);
  }
  return { paired, divergences, shadowCount: a.length, runnerCount: b.length };
}

function pnlPass(shadowPnl, runnerPnl, notional) {
  const d = Math.abs(num(shadowPnl, 0) - num(runnerPnl, 0));
  const tol = Math.max(0.5, Math.abs(num(notional, 0)) * 0.05);
  return { delta: d, tol, pass: d <= tol };
}

function buildReport(shadow, result, mode) {
  const ev = (result.events || []).find((e) => e.reason !== 'no_entry') || result.events?.[0];
  const end = shadow.end || {};
  const shadowFills = shadow.fills || [];
  const runnerFills = ev?.fills || [];
  const fillDiff = diffFills(shadowFills, runnerFills);
  const shadowPnl = num(end.pnl, 0);
  const runnerPnl = num(ev?.finalPnl, 0);
  const notional = num(end.invested, ev?.cost);
  const pnl = pnlPass(shadowPnl, runnerPnl, notional);

  const seqShadow = normalizeFills(shadowFills).map((f) => f.key);
  const seqRunner = normalizeFills(runnerFills).map((f) => f.key);
  const seqMatch = seqShadow.length === seqRunner.length
    && seqShadow.every((k, i) => k === seqRunner[i]);

  const pass = seqMatch && fillDiff.divergences.length === 0 && pnl.pass;

  return {
    slug: shadow.slug,
    mode,
    pass,
    criterion: {
      seqMatch,
      fillDivergences: fillDiff.divergences.length,
      pnl,
    },
    shadow: {
      fillCount: fillDiff.shadowCount,
      sharesUp: end.sharesUp,
      sharesDown: end.sharesDown,
      invested: end.invested,
      equalizou: end.equalizou,
      viradas: end.viradas,
      pnl: shadowPnl,
      winner: end.winner,
      resultado: end.resultado,
    },
    runner: {
      fillCount: fillDiff.runnerCount,
      sharesUp: ev?.sharesUp,
      sharesDown: ev?.sharesDown,
      cost: ev?.cost,
      equalized: ev?.equalized,
      viradas: ev?.viradas,
      pnl: runnerPnl,
      reason: ev?.reason,
    },
    sequence: { shadow: seqShadow, runner: seqRunner },
    divergences: fillDiff.divergences,
    pairedSample: fillDiff.paired.slice(0, 20),
  };
}

function printReport(report) {
  const tag = report.pass ? 'PASS' : 'FAIL';
  console.log(`\n=== Shotandgo shadow replay [${tag}] ===`);
  console.log(`slug: ${report.slug} | mode: ${report.mode}`);
  console.log(`fills shadow/runner: ${report.shadow.fillCount}/${report.runner.fillCount}`);
  console.log(`shares UP/DOWN shadow: ${report.shadow.sharesUp}/${report.shadow.sharesDown}`
    + ` | runner: ${report.runner.sharesUp}/${report.runner.sharesDown}`);
  console.log(`equalizou shadow=${report.shadow.equalizou} runner=${report.runner.equalized}`
    + ` | viradas ${report.shadow.viradas} vs ${report.runner.viradas}`);
  console.log(`PnL shadow $${Number(report.shadow.pnl).toFixed(2)}`
    + ` | runner $${Number(report.runner.pnl).toFixed(2)}`
    + ` | |Δ|=$${report.criterion.pnl.delta.toFixed(2)} (tol $${report.criterion.pnl.tol.toFixed(2)})`);
  console.log(`seqMatch=${report.criterion.seqMatch} divergences=${report.criterion.fillDivergences}`);
  if (report.divergences.length) {
    console.log('\nDivergências:');
    for (const d of report.divergences.slice(0, 30)) {
      if (d.kind === 'mismatch') {
        console.log(`  [${d.idx}] ${d.issues.join('; ')}`);
      } else if (d.kind === 'extra_runner') {
        console.log(`  [${d.idx}] extra runner ${d.runner.key} ${d.runner.shares}@${d.runner.price}`);
      } else if (d.kind === 'missing_runner') {
        console.log(`  [${d.idx}] faltou runner ${d.shadow.key} ${d.shadow.shares}@${d.shadow.price}`);
      }
    }
  }
  console.log('');
}

function philDefaultConfig() {
  return {
    sub: [55, 60, 65, 70, 75, 80, 85, 90],
    desc: [45, 40, 35, 30, 25, 20, 15, 10],
    shares_sub: [20, 15, 10, 10, 5, 5, 1, 1],
    shares_desc: [5, 5, 5, 5, 5, 5, 5, 5],
    mult: [2, 3, 4, 5, 6, 6],
    contagio: 'global',
    contagio_min: 5,
    eq_preco: 0.05,
    eq_encerra: true,
    eq_limite_ativo: true,
    eq_limite_arma_c: 10,
    eq_limite_cancela_c: 40,
    eq_limite_reposta: true,
    stop: [true, 4, 1.0],
    max_viradas: [true, 6],
    piso: [true, [4, 5], 0.2],
    desc_modo: 'gatilho',
    desc_virada: 5,
    anti_glitch: [true, 85, 115],
    filtro: [0.1, 0.9],
    fok_ativo: true,
    fok_preco_teto: 0.95,
    slippage_compra: 0.03,
    max_exposicao: 500,
    janela_monitoramento: 280,
    shadow_capture: true,
  };
}

/** Fixture sintético: path de odds → runner optimistic → pacote shadow. */
function buildSynthShadow(sg) {
  const eventStart = '2026-06-15T14:00:00.000Z';
  const conditionId = 'synth-shotandgo-shadow-1';
  const slug = `btc-updown-5m-${Math.floor(Date.parse(eventStart) / 1000)}`;
  const pathCents = sg.expandPathTargets([50, 55, 60, 45, 55, 70, 40, 90, 10]);
  const ticksShadow = [];
  const runnerTicks = [];
  const stepSec = 300 / Math.max(pathCents.length, 1);

  for (let i = 0; i < pathCents.length; i++) {
    const upC = pathCents[i];
    const dnC = Math.max(1, Math.min(99, 100 - upC));
    const upAsk = upC / 100;
    const dnAsk = dnC / 100;
    const sec = Math.min(295, Math.round(i * stepSec) + 5);
    const ts = new Date(Date.parse(eventStart) + sec * 1000).toISOString();
    const tau = 300 - sec;
    ticksShadow.push({
      ts,
      tau,
      askUp: upAsk,
      askDown: dnAsk,
      bidUp: Math.max(0.01, upAsk - 0.01),
      bidDown: Math.max(0.01, dnAsk - 0.01),
      asksUp: [{ price: upAsk, size: 800 }, { price: Math.min(0.99, upAsk + 0.01), size: 800 }],
      asksDown: [{ price: dnAsk, size: 800 }, { price: Math.min(0.99, dnAsk + 0.01), size: 800 }],
      btc: 100100,
      ptb: 100000,
      escadaArmada: true,
      viradas: 0,
      sharesUp: 0,
      sharesDown: 0,
      invested: 0,
    });
    runnerTicks.push({
      ts,
      event_start: eventStart,
      condition_id: conditionId,
      price_to_beat: 100000,
      btc_price: 100100,
      up_best_ask: upAsk,
      down_best_ask: dnAsk,
      up_best_bid: Math.max(0.01, upAsk - 0.01),
      down_best_bid: Math.max(0.01, dnAsk - 0.01),
      up_price: upAsk,
      down_price: dnAsk,
      up_book_asks: [{ price: upAsk, size: 800 }, { price: Math.min(0.99, upAsk + 0.01), size: 800 }],
      down_book_asks: [{ price: dnAsk, size: 800 }, { price: Math.min(0.99, dnAsk + 0.01), size: 800 }],
    });
  }

  // Mesmos params do replay (Phil defaults + optimistic) — self-check deve PASS.
  const params = configToRunnerParams({ config: philDefaultConfig(), mode: { dryRun: true } }, 'optimistic');
  const raw = sg.runShotandgoBacktest(params, runnerTicks);
  const ev = (raw.events || []).find((e) => e.reason !== 'no_entry');
  if (!ev) throw new Error('synth: runner sem entry');

  const fills = (ev.fills || []).map((f) => ({
    ts: f.time || eventStart,
    lado: f.side,
    side: f.side,
    tipo: f.tipo,
    shares: f.shares,
    price: f.price,
    fator: 1,
    liquidity: f.liquidity || 'taker',
    dry: true,
    status: 'simulado',
  }));

  return {
    schemaVersion: 1,
    kind: 'shotandgo-shadow',
    slug,
    conditionId,
    eventStart,
    capturedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    source: 'synth-optimistic-self',
    mode: { modoReal: true, dryRun: true, shadow: true },
    replayHint: { executionMode: 'optimistic', params },
    config: philDefaultConfig(),
    ticks: ticksShadow,
    intents: [],
    fills,
    blocks: [],
    end: {
      ts: new Date().toISOString(),
      winner: num(runnerTicks.at(-1)?.up_best_ask, 0) >= 0.5 ? 'UP' : 'DOWN',
      sharesUp: ev.sharesUp,
      sharesDown: ev.sharesDown,
      costUp: null,
      costDown: null,
      invested: ev.cost,
      equalizou: ev.equalized,
      vendeu: false,
      pnl: ev.finalPnl,
      payout: (ev.equalized
        ? Math.min(ev.sharesUp, ev.sharesDown)
        : (num(runnerTicks.at(-1)?.up_best_ask, 0) >= 0.5 ? ev.sharesUp : ev.sharesDown)),
      resultado: ev.equalized ? 'EQUALIZADO_SYNTH' : 'EXPOSTO_SYNTH',
      viradas: ev.viradas,
      fonteResolucao: 'odds',
    },
    stats: {
      tickCount: ticksShadow.length,
      fillCount: fills.length,
      intentCount: 0,
      blockCount: 0,
    },
  };
}

async function shadowFromLake({ day, conditionId = null }) {
  const { DuckDBInstance, quotedString } = await import('@duckdb/node-api');
  const dir = path.resolve(ROOT, `lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=${day}`);
  if (!fs.existsSync(dir)) throw new Error(`lake day não encontrado: ${dir}`);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.parquet')).map((f) => path.resolve(dir, f));
  if (!files.length) throw new Error(`sem parquet em ${dir}`);

  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  const pql = `[${files.map((f) => quotedString(f)).join(',')}]`;
  const bookCols = [];
  for (let level = 1; level <= 10; level += 1) {
    bookCols.push(
      `up_ask_px_${level}`, `up_ask_sz_${level}`,
      `down_ask_px_${level}`, `down_ask_sz_${level}`,
    );
  }
  const pick = conditionId
    ? `condition_id = ${quotedString(conditionId)}`
    : `condition_id = (
         SELECT condition_id FROM read_parquet(${pql})
         WHERE coverage >= 0.99 AND up_best_ask IS NOT NULL
         GROUP BY condition_id ORDER BY COUNT(*) DESC LIMIT 1
       )`;

  const rows = (await c.runAndReadAll(`
    SELECT ts, event_start, condition_id, underlying_price, price_to_beat, coverage,
           up_best_ask, up_best_bid, down_best_ask, down_best_bid,
           ${bookCols.join(', ')}
    FROM read_parquet(${pql})
    WHERE coverage >= 0.99 AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
      AND ${pick}
    ORDER BY ts
  `)).getRowObjectsJS();

  if (!rows.length) throw new Error('lake: nenhum tick para o evento');

  const eventStart = toIso(rows[0].event_start);
  const cid = String(rows[0].condition_id);
  const slug = `btc-updown-5m-${Math.floor(Date.parse(eventStart) / 1000)}`;

  function bookFromRow(row, side) {
    const out = [];
    const prefix = side === 'UP' ? 'up_ask' : 'down_ask';
    for (let level = 1; level <= 10; level += 1) {
      const price = num(row[`${prefix}_px_${level}`]);
      const size = num(row[`${prefix}_sz_${level}`]);
      if (price != null && size != null && price > 0 && size > 0) {
        out.push({ price, size });
      }
    }
    if (!out.length) {
      const ask = side === 'UP' ? num(row.up_best_ask) : num(row.down_best_ask);
      if (ask != null) out.push({ price: ask, size: 500 });
    }
    return out;
  }

  const ticks = rows.map((r) => {
    const ts = toIso(r.ts);
    const tau = Math.max(0, (Date.parse(eventStart) + 300000 - Date.parse(ts)) / 1000);
    const askUp = Number(r.up_best_ask);
    const askDn = Number(r.down_best_ask);
    return {
      ts,
      tau: Math.round(tau * 10) / 10,
      askUp,
      askDown: askDn,
      bidUp: num(r.up_best_bid),
      bidDown: num(r.down_best_bid),
      asksUp: bookFromRow(r, 'UP'),
      asksDown: bookFromRow(r, 'DOWN'),
      btc: num(r.underlying_price),
      ptb: num(r.price_to_beat),
      escadaArmada: true,
      viradas: 0,
      sharesUp: 0,
      sharesDown: 0,
      invested: 0,
    };
  });

  // Bootstrap fills via runner optimistic (não é Phil live — serve de pacote + baseline).
  const sg = loadShotandgo();
  const runnerTicks = shadowTicksToRunner({
    eventStart, conditionId: cid, slug, ticks, end: {},
  });
  const params = configToRunnerParams({ config: philDefaultConfig(), mode: { dryRun: true } }, 'optimistic');
  const raw = sg.runShotandgoBacktest(params, runnerTicks);
  const ev = (raw.events || []).find((e) => e.reason !== 'no_entry');
  const fills = (ev?.fills || []).map((f) => ({
    ts: f.time || eventStart,
    lado: f.side,
    side: f.side,
    tipo: f.tipo,
    shares: f.shares,
    price: f.price,
    fator: 1,
    liquidity: f.liquidity || 'taker',
    dry: true,
    status: 'lake-bootstrap',
  }));

  const last = ticks[ticks.length - 1];
  return {
    schemaVersion: 1,
    kind: 'shotandgo-shadow',
    slug,
    conditionId: cid,
    eventStart,
    capturedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    source: 'lake-bootstrap-optimistic',
    mode: { modoReal: false, dryRun: true, shadow: true },
    replayHint: { executionMode: 'optimistic', note: 'fills bootstrap via runner — trocar por Phil DRY_RUN para paridade real' },
    config: philDefaultConfig(),
    ticks,
    intents: [],
    fills,
    blocks: [],
    end: {
      ts: new Date().toISOString(),
      winner: last.askUp >= last.askDown ? 'UP' : 'DOWN',
      sharesUp: ev?.sharesUp ?? 0,
      sharesDown: ev?.sharesDown ?? 0,
      costUp: null,
      costDown: null,
      invested: ev?.cost ?? 0,
      equalizou: ev?.equalized ?? false,
      vendeu: false,
      pnl: ev?.finalPnl ?? 0,
      payout: 0,
      resultado: ev ? (ev.equalized ? 'EQUALIZADO_LAKE' : String(ev.reason)) : 'no_entry',
      viradas: ev?.viradas ?? 0,
      fonteResolucao: 'odds',
    },
    stats: {
      tickCount: ticks.length,
      fillCount: fills.length,
      intentCount: 0,
      blockCount: 0,
    },
  };
}

function resolveShadowPath(explicit) {
  if (explicit) return path.resolve(explicit);
  for (const dir of DEFAULT_SHADOW_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    if (files.length) return path.join(dir, files[files.length - 1]);
  }
  return null;
}

async function main() {
  const sg = loadShotandgo();
  const outDir = path.resolve(ROOT, 'labs/strategies/carry/shotandgo-v1/shadow');
  fs.mkdirSync(outDir, { recursive: true });

  let shadowPath = argVal('--shadow');
  let shadow;

  if (hasFlag('--synth')) {
    shadow = buildSynthShadow(sg);
    shadowPath = path.join(outDir, `${shadow.slug}.json`);
    fs.writeFileSync(shadowPath, `${JSON.stringify(shadow, null, 2)}\n`);
    console.log(`synth shadow → ${shadowPath}`);
  } else if (hasFlag('--from-lake')) {
    const day = argVal('--day', '2026-06-15');
    const cid = argVal('--condition-id', null);
    shadow = await shadowFromLake({ day, conditionId: cid });
    shadowPath = path.join(outDir, `${shadow.slug}.json`);
    fs.writeFileSync(shadowPath, `${JSON.stringify(shadow, null, 2)}\n`);
    console.log(`lake shadow → ${shadowPath} (${shadow.stats.tickCount} ticks, ${shadow.stats.fillCount} fills bootstrap)`);
  } else {
    shadowPath = resolveShadowPath(shadowPath);
    if (!shadowPath || !fs.existsSync(shadowPath)) {
      console.error('Uso: --shadow <json> | --synth | --from-lake --day YYYY-MM-DD');
      process.exit(2);
    }
    shadow = JSON.parse(fs.readFileSync(shadowPath, 'utf8'));
  }

  const mode = argVal('--mode', null);
  const params = configToRunnerParams(shadow, mode);
  const ticks = shadowTicksToRunner(shadow);
  const result = sg.runShotandgoBacktest(params, ticks);
  const report = buildReport(shadow, result, params.executionMode);
  printReport(report);

  const reportPath = shadowPath.replace(/\.json$/i, '.replay-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report → ${reportPath}`);

  if (hasFlag('--strict') && !report.pass) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
