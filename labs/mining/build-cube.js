/**
 * D1 — Builder do cubo de features BTC 5m (labs/mining).
 *
 * Para cada tick de decisão (cadência 5s por evento), computa features sem
 * look-ahead e labels de PnL líquido hold-to-settlement (varredura do book
 * depth 25 + taxa taker 0.07*p*(1-p) por share, orçamento $10).
 *
 * Saída: CSV por dia em labs/mining/cube/dt=YYYY-MM-DD.csv (resume automático).
 *
 * Uso: node --max-old-space-size=6144 labs/mining/build-cube.js [--from 2026-04-23] [--to 2026-06-27]
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../src/config.js';
import { openStateDatabase } from '../../src/state/sqlite.js';
import { openBacktestTickSession } from '../../src/query/duckdbQuery.js';

const CUBE_DIR = path.join('labs', 'mining', 'cube');
const BUDGET = 10;
const FEE_RATE = 0.07;
const CADENCE_MS = 5000;
const DEPTH = 25;

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : fallback;
}
const FROM = argValue('--from', '2026-04-23');
const TO = argValue('--to', '2026-06-27');

const HEADER = [
  'dt', 'condition_id', 'ts_ms', 'tau', 'spot', 'ptb', 'dist', 'dist_abs', 'fav',
  'ask_fav', 'bid_fav', 'spread_fav', 'ask_up', 'ask_down', 'odds_sum',
  'd_spot_5', 'd_spot_10', 'd_spot_15', 'd_spot_20', 'd_spot_30', 'd_spot_60',
  'sigma_ps_90', 'flips_60', 'secs_since_flip', 'pin45',
  'd_askfav_10', 'd_askfav_15', 'd_askfav_30', 'sigma_askfav_15',
  'depth5_ask_fav', 'depth5_bid_fav', 'obi5', 'ladder_fav',
  'fill_px_fav', 'fill_sh_fav', 'fill_px_non', 'fill_sh_non',
  'p_phys', 'edge_phys', 'coverage', 'degraded', 'mkt_agree',
  'winner', 'fav_won', 'pnl_fav', 'pnl_non',
].join(',');

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}
const normalCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

/** Varre asks do book do lado `side`, orçamento budget, fee por share 0.07*p*(1-p). */
function sweepFill(row, side, budget) {
  let remaining = budget;
  let shares = 0;
  const prefix = side === 'UP' ? 'up_ask' : 'down_ask';
  for (let i = 1; i <= DEPTH; i += 1) {
    const px = row[`${prefix}_px_${i}`];
    const sz = row[`${prefix}_sz_${i}`];
    if (!(px > 0) || !(sz > 0) || px >= 1) continue;
    const eff = px + FEE_RATE * px * (1 - px);
    const levelCost = sz * eff;
    if (remaining >= levelCost) {
      shares += sz;
      remaining -= levelCost;
    } else {
      shares += remaining / eff;
      remaining = 0;
      break;
    }
  }
  const spent = budget - remaining;
  if (spent <= 0 || shares <= 0) return null;
  return { shares, spent, avgPx: spent / shares };
}

function std(values) {
  if (values.length < 2) return 0;
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmt(v) {
  if (v == null || Number.isNaN(v)) return '';
  if (typeof v === 'number') return Math.abs(v) < 1e-12 ? '0' : String(Math.round(v * 1e6) / 1e6);
  return String(v);
}

/** Processa os ticks de um evento e devolve linhas do cubo. */
function processEvent(ticks, dt) {
  if (ticks.length < 10) return [];
  const eventEndMs = ticks[ticks.length - 1]._eventEndMs;
  const ptb = num(ticks[0].price_to_beat);
  if (ptb == null || ptb <= 1000 || !Number.isFinite(eventEndMs)) return [];

  // Vencedor inferido pelo último tick com book válido (ticks sem book podem
  // carregar spot congelado de feed stale intercalado — ex.: 2026-05-29).
  let lastValid = null;
  for (let i = ticks.length - 1; i >= 0; i -= 1) {
    const tk = ticks[i];
    if (num(tk.underlying_price) == null) continue;
    if (num(tk.up_best_ask) == null || num(tk.down_best_ask) == null) continue;
    lastValid = tk;
    break;
  }
  if (!lastValid) return [];
  const finalSpot = num(lastValid.underlying_price);
  const winner = finalSpot > (num(lastValid.price_to_beat) ?? ptb) ? 'UP' : 'DOWN';

  // Validação do label contra o consenso do mercado no fim do evento:
  // mid do lado vencedor no último tick válido deve ser > 0.5.
  let mktAgree = '';
  {
    const au = num(lastValid.up_best_ask); const bu = num(lastValid.up_best_bid);
    const ad = num(lastValid.down_best_ask); const bd = num(lastValid.down_best_bid);
    const tauHere = (eventEndMs - lastValid._tsMs) / 1000;
    if (au != null && ad != null && bu != null && bd != null && tauHere <= 30) {
      const midWinner = winner === 'UP' ? (au + bu) / 2 : (ad + bd) / 2;
      mktAgree = midWinner > 0.5 ? 1 : 0;
    }
  }

  const rows = [];
  const win = []; // janela deslizante de {t, spot, sign, askU, askD}
  let lastEmit = -Infinity;
  let lastFlipMs = null;
  let prevSign = null;

  for (const tick of ticks) {
    const t = tick._tsMs;
    const spot = num(tick.underlying_price);
    const tickPtb = num(tick.price_to_beat) ?? ptb;
    if (spot == null || !Number.isFinite(t)) continue;
    const dist = spot - tickPtb;
    const sign = dist > 0 ? 1 : dist < 0 ? -1 : prevSign ?? 0;
    if (prevSign != null && sign !== 0 && prevSign !== 0 && sign !== prevSign) lastFlipMs = t;
    if (sign !== 0) prevSign = sign;

    const askU = num(tick.up_best_ask);
    const askD = num(tick.down_best_ask);
    // Ticks sem book (feed CLOB stale/intercalado) não entram na janela:
    // spot congelado duplicado gera flips e momentum fictícios.
    if (askU == null || askD == null) continue;
    win.push({ t, spot, sign, askU, askD });
    while (win.length && t - win[0].t > 95_000) win.shift();

    const tau = (eventEndMs - t) / 1000;
    if (tau <= 0 || tau > 300) continue;
    if (t - lastEmit < CADENCE_MS) continue;

    const fav = dist >= 0 ? 'UP' : 'DOWN';
    const askFav = fav === 'UP' ? askU : askD;
    const bidFav = num(fav === 'UP' ? tick.up_best_bid : tick.down_best_bid);
    if (askFav == null || bidFav == null || askU == null || askD == null) continue;

    lastEmit = t;

    // lookbacks de spot
    const at = (secs) => {
      const target = t - secs * 1000;
      let best = null;
      for (let i = win.length - 1; i >= 0; i -= 1) {
        if (win[i].t <= target) { best = win[i]; break; }
      }
      return best;
    };
    const dSpot = {};
    for (const s of [5, 10, 15, 20, 30, 60]) {
      const ref = at(s);
      dSpot[s] = ref ? spot - ref.spot : null;
    }
    const refAsk = (secs) => {
      const ref = at(secs);
      if (!ref) return null;
      const a = fav === 'UP' ? ref.askU : ref.askD;
      return a == null ? null : askFav - a;
    };

    // vol realizada por sqrt(s): incrementos ~5s na janela de 90s
    const sq = [];
    let anchor = win[0];
    for (const w of win) {
      const dtSec = (w.t - anchor.t) / 1000;
      if (dtSec >= 4) {
        sq.push(((w.spot - anchor.spot) ** 2) / dtSec);
        anchor = w;
      }
    }
    const sigmaPs = sq.length >= 3 ? Math.sqrt(sq.reduce((s, v) => s + v, 0) / sq.length) : null;

    // flips e pin na janela
    let flips = 0;
    let pinCount = 0;
    let pinTotal = 0;
    let prevS = null;
    for (const w of win) {
      if (t - w.t <= 60_000) {
        if (prevS != null && w.sign !== 0 && prevS !== 0 && w.sign !== prevS) flips += 1;
        if (w.sign !== 0) prevS = w.sign;
      }
      if (t - w.t <= 45_000) {
        pinTotal += 1;
        if (Math.abs(w.spot - tickPtb) <= 8) pinCount += 1;
      }
    }
    const askWindow = win.filter((w) => t - w.t <= 15_000)
      .map((w) => (fav === 'UP' ? w.askU : w.askD))
      .filter((v) => v != null);

    // book agregado top-5 do favorito
    const favAskPrefix = fav === 'UP' ? 'up_ask' : 'down_ask';
    const favBidPrefix = fav === 'UP' ? 'up_bid' : 'down_bid';
    let depthAsk = 0;
    let depthBid = 0;
    for (let i = 1; i <= 5; i += 1) {
      depthAsk += num(tick[`${favAskPrefix}_sz_${i}`]) ?? 0;
      depthBid += num(tick[`${favBidPrefix}_sz_${i}`]) ?? 0;
    }
    const px1 = num(tick[`${favAskPrefix}_px_1`]);
    const px5 = num(tick[`${favAskPrefix}_px_5`]);
    const ladder = px1 != null && px5 != null ? px5 - px1 : null;

    const fillFav = sweepFill(tick, fav, BUDGET);
    const fillNon = sweepFill(tick, fav === 'UP' ? 'DOWN' : 'UP', BUDGET);
    if (!fillFav || !fillNon) continue;

    const sigmaValid = sigmaPs != null && sigmaPs > 0;
    const pPhys = sigmaValid ? normalCdf(Math.abs(dist) / (sigmaPs * Math.sqrt(tau))) : null;

    const favWon = winner === fav ? 1 : 0;
    const pnlFav = favWon ? fillFav.shares - fillFav.spent : -fillFav.spent;
    const pnlNon = favWon ? -fillNon.spent : fillNon.shares - fillNon.spent;

    rows.push([
      dt, tick.condition_id, t, Math.round(tau * 10) / 10, spot, tickPtb,
      fmt(dist), fmt(Math.abs(dist)), fav,
      fmt(askFav), fmt(bidFav), fmt(askFav - bidFav), fmt(askU), fmt(askD), fmt(askU + askD),
      fmt(dSpot[5]), fmt(dSpot[10]), fmt(dSpot[15]), fmt(dSpot[20]), fmt(dSpot[30]), fmt(dSpot[60]),
      fmt(sigmaPs), flips,
      lastFlipMs != null ? Math.round((t - lastFlipMs) / 100) / 10 : '',
      pinTotal ? fmt(pinCount / pinTotal) : '',
      fmt(refAsk(10)), fmt(refAsk(15)), fmt(refAsk(30)), fmt(std(askWindow)),
      fmt(depthAsk), fmt(depthBid),
      fmt(depthAsk + depthBid > 0 ? (depthBid - depthAsk) / (depthBid + depthAsk) : null),
      fmt(ladder),
      fmt(fillFav.avgPx), fmt(fillFav.shares), fmt(fillNon.avgPx), fmt(fillNon.shares),
      fmt(pPhys), fmt(pPhys != null ? pPhys - askFav : null),
      fmt(num(tick.coverage)), tick.degraded ? 1 : 0, mktAgree,
      winner, favWon, fmt(pnlFav), fmt(pnlNon),
    ].join(','));
  }
  return rows;
}

async function buildDay(db, dt) {
  const outPath = path.join(CUBE_DIR, `dt=${dt}.csv`);
  if (fs.existsSync(outPath)) return { dt, skipped: true };
  const from = `${dt}T00:00:00.000Z`;
  const to = new Date(Date.parse(from) + 86_400_000).toISOString();
  const session = await openBacktestTickSession(db, {
    underlying: 'BTC', interval: '5m', bookDepth: DEPTH,
    from, to, validBacktestRows: true, jsonSafe: false,
  });
  const lines = [HEADER];
  let offset = 0;
  let pending = new Map(); // condition_id -> ticks[]
  let events = 0;
  try {
    for (;;) {
      const batch = await session.readBatch(offset, 25_000);
      if (!batch.length) break;
      offset += batch.length;
      for (const row of batch) {
        let list = pending.get(row.condition_id);
        if (!list) { list = []; pending.set(row.condition_id, list); }
        list.push(row);
      }
      // finaliza eventos cujo event_end já passou do último ts lido
      const lastTs = batch[batch.length - 1]._tsMs;
      for (const [cid, ticks] of pending) {
        if (ticks[ticks.length - 1]._eventEndMs < lastTs - 60_000) {
          for (const line of processEvent(ticks, dt)) lines.push(line);
          events += 1;
          pending.delete(cid);
        }
      }
    }
    for (const [, ticks] of pending) {
      for (const line of processEvent(ticks, dt)) lines.push(line);
      events += 1;
    }
    pending = new Map();
  } finally {
    session.close();
  }
  fs.mkdirSync(CUBE_DIR, { recursive: true });
  fs.writeFileSync(`${outPath}.tmp`, lines.join('\n'));
  fs.renameSync(`${outPath}.tmp`, outPath);
  return { dt, events, rows: lines.length - 1, ticks: offset };
}

const db = openStateDatabase(loadConfig().stateDbPath, { readOnly: true });
const days = [];
for (let ms = Date.parse(`${FROM}T00:00:00Z`); ms <= Date.parse(`${TO}T00:00:00Z`); ms += 86_400_000) {
  days.push(new Date(ms).toISOString().slice(0, 10));
}
const startedAt = Date.now();
for (const dt of days) {
  const t0 = Date.now();
  try {
    const res = await buildDay(db, dt);
    if (res.skipped) console.log(`${dt} SKIP (existe)`);
    else console.log(`${dt} ok: ${res.events} eventos, ${res.rows} linhas cubo, ${res.ticks} ticks, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error(`${dt} ERRO: ${err.message}`);
  }
}
console.log(`CUBO COMPLETO em ${((Date.now() - startedAt) / 60000).toFixed(1)} min`);
