/**
 * Extrai features por evento x checkpoint para estudo de flips no fim do evento (BTC 5m).
 * Sem lookahead: features em cada checkpoint usam apenas ticks <= checkpoint.
 * Label: flip = líder no checkpoint != vencedor no settlement.
 * Quando --winner-csv é informado, usa o resultado canônico e não aplica o
 * filtro retrospectivo de consenso do book final.
 *
 * Uso: node extract-flip-features.mjs --root D:/Projetos/projeto-goldenlens/data-backtest --out flip-features.csv
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const args = process.argv.slice(2);
function flag(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
}
const ROOT = flag('root', 'D:/Projetos/projeto-goldenlens/data-backtest');
const OUT = flag('out', path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'flip-features.csv'));
const WINNER_CSV = flag('winner-csv', null);
const CHECKPOINTS = [120, 90, 60, 45, 30, 20, 10];

function loadWinnerCsv(file) {
  if (!file) return null;
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const header = lines.shift().split(',');
  const eventIndex = header.indexOf('event_start');
  const winnerIndex = header.indexOf('winner');
  if (eventIndex < 0 || winnerIndex < 0) throw new Error('winner CSV precisa de event_start,winner');
  return new Map(lines.map((line) => {
    const values = line.split(',');
    return [new Date(values[eventIndex]).toISOString(), Number(values[winnerIndex])];
  }));
}
const canonicalWinnerByEvent = loadWinnerCsv(WINNER_CSV);

const baseDir = path.join(ROOT, 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25');
const days = fs.readdirSync(baseDir).filter((d) => d.startsWith('dt=')).map((d) => d.slice(3)).sort();

const header = [
  'day', 'event_start', 'tau', 'leader', 'winner', 'flip',
  'dist', 'sigma60', 'z', 'mom10', 'mom30', 'momTo10', 'momTo30',
  'cross60', 'crossTot', 'lastCrossAge', 'range60',
  'favMid', 'favAsk', 'spread', 'oddsSum', 'dMid15', 'staleSecs', 'nTicks',
].join(',');

const outStream = fs.createWriteStream(OUT);
outStream.write(header + '\n');

function std(arr) {
  if (arr.length < 2) return NaN;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1));
}

function processEvent(ticks, day) {
  // ticks: [{t (secs since event_start), spot, ptb, ub, ua, db, da}] ordenado
  const n = ticks.length;
  if (n < 100) return [];
  const ptb = ticks[n - 1].ptb;
  if (!(ptb > 0)) return [];

  // Vencedor canônico quando disponível; fallback legado para último spot.
  const last = ticks[n - 1];
  const winner = canonicalWinnerByEvent?.get(ticks.eventStart) ?? (last.spot > ptb ? 1 : -1);
  if (canonicalWinnerByEvent && !canonicalWinnerByEvent.has(ticks.eventStart)) return [];

  // No fallback legado, preserva a validação de consenso do dataset original.
  if (!canonicalWinnerByEvent) {
    let upMidSum = 0, upMidN = 0;
    for (let i = n - 1; i >= 0 && last.t - ticks[i].t <= 5; i -= 1) {
      const tk = ticks[i];
      if (tk.ub != null && tk.ua != null) { upMidSum += (tk.ub + tk.ua) / 2; upMidN += 1; }
    }
    if (upMidN === 0) return [];
    const upMidEnd = upMidSum / upMidN;
    const mktWinner = upMidEnd > 0.5 ? 1 : -1;
    if (mktWinner !== winner) return [];
  }

  const dur = last.t; // ~300s
  const rows = [];

  // pré-computa série de dist e cruzamentos
  // spot pode congelar (stale) — rastreia último ts em que spot mudou
  for (const tau of CHECKPOINTS) {
    const cutoff = dur - tau;
    if (cutoff < 60) continue;
    // índice do último tick <= cutoff
    let idx = -1;
    for (let i = n - 1; i >= 0; i -= 1) {
      if (ticks[i].t <= cutoff) { idx = i; break; }
    }
    if (idx < 10) continue;
    const cur = ticks[idx];
    if (cur.ub == null || cur.ua == null || cur.db == null || cur.da == null) continue;
    const dist = cur.spot - ptb;
    if (dist === 0) continue;
    const leader = dist > 0 ? 1 : -1;

    // janela 60s para vol/cruzamentos/range
    const deltas = [];
    let dtSum = 0;
    let crosses60 = 0;
    let hi = cur.spot, lo = cur.spot;
    let lastCrossT = null;
    let crossTot = 0;
    let prevSign = null;
    for (let i = 0; i <= idx; i += 1) {
      const s = ticks[i].spot - ptb;
      const sg = s > 0 ? 1 : s < 0 ? -1 : 0;
      if (sg !== 0) {
        if (prevSign != null && sg !== prevSign) {
          crossTot += 1;
          lastCrossT = ticks[i].t;
          if (cur.t - ticks[i].t <= 60) crosses60 += 1;
        }
        prevSign = sg;
      }
    }
    for (let i = idx; i >= 1; i -= 1) {
      const age = cur.t - ticks[i].t;
      if (age > 60) break;
      const d = ticks[i].spot - ticks[i - 1].spot;
      const dt = ticks[i].t - ticks[i - 1].t;
      if (dt > 0) { deltas.push(d); dtSum += dt; }
      if (ticks[i].spot > hi) hi = ticks[i].spot;
      if (ticks[i].spot < lo) lo = ticks[i].spot;
    }
    if (deltas.length < 20) continue;
    // vol realizada em USD por sqrt(segundo)
    const sumSq = deltas.reduce((a, b) => a + b * b, 0);
    const sigma1s = Math.sqrt(sumSq / dtSum);
    const z = sigma1s > 0 ? Math.abs(dist) / (sigma1s * Math.sqrt(tau)) : 99;

    // momentum
    function spotAt(secsAgo) {
      const target = cur.t - secsAgo;
      for (let i = idx; i >= 0; i -= 1) {
        if (ticks[i].t <= target) return ticks[i].spot;
      }
      return null;
    }
    const s10 = spotAt(10), s30 = spotAt(30);
    const mom10 = s10 != null ? cur.spot - s10 : NaN;
    const mom30 = s30 != null ? cur.spot - s30 : NaN;
    // assinado: positivo = a favor do líder (afastando do strike)
    const momTo10 = Number.isFinite(mom10) ? mom10 * leader : NaN;
    const momTo30 = Number.isFinite(mom30) ? mom30 * leader : NaN;

    // book do favorito
    const upMid = (cur.ub + cur.ua) / 2;
    const favMid = leader === 1 ? upMid : 1 - upMid;
    const favAsk = leader === 1 ? cur.ua : cur.da;
    const favBid = leader === 1 ? cur.ub : cur.db;
    const spread = favAsk - favBid;
    const oddsSum = cur.ua + cur.da;

    // dMid15: mudança do mid do favorito nos últimos 15s (book repricing)
    let midPast = null;
    for (let i = idx; i >= 0; i -= 1) {
      if (cur.t - ticks[i].t >= 15) {
        const tk = ticks[i];
        if (tk.ub != null && tk.ua != null) {
          const um = (tk.ub + tk.ua) / 2;
          midPast = leader === 1 ? um : 1 - um;
        }
        break;
      }
    }
    const dMid15 = midPast != null ? favMid - midPast : NaN;

    // staleness do spot
    let staleSecs = 0;
    for (let i = idx; i >= 1; i -= 1) {
      if (ticks[i].spot !== cur.spot) { staleSecs = cur.t - ticks[i].t; break; }
      if (i === 1) staleSecs = cur.t - ticks[0].t;
    }

    const lastCrossAge = lastCrossT != null ? cur.t - lastCrossT : 999;
    const flip = leader !== winner ? 1 : 0;

    rows.push([
      day, ticks.eventStart, tau, leader, winner, flip,
      dist.toFixed(2), sigma1s.toFixed(4), z.toFixed(3),
      Number.isFinite(mom10) ? mom10.toFixed(2) : '',
      Number.isFinite(mom30) ? mom30.toFixed(2) : '',
      Number.isFinite(momTo10) ? momTo10.toFixed(2) : '',
      Number.isFinite(momTo30) ? momTo30.toFixed(2) : '',
      crosses60, crossTot, lastCrossAge.toFixed(1), (hi - lo).toFixed(2),
      favMid.toFixed(4), favAsk.toFixed(3), spread.toFixed(3), oddsSum.toFixed(3),
      Number.isFinite(dMid15) ? dMid15.toFixed(4) : '',
      staleSecs.toFixed(1), idx + 1,
    ].join(','));
  }
  return rows;
}

async function main() {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  await conn.run('SET threads TO 6');
  await conn.run("SET memory_limit = '4GB'");

  let totalEvents = 0, totalRows = 0;
  for (const day of days) {
    const dir = path.join(baseDir, `dt=${day}`);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.parquet'));
    if (!files.length) continue;
    const glob = path.join(dir, '*.parquet').replace(/\\/g, '/');
    const t0 = Date.now();
    const res = await conn.runAndReadAll(`
      SELECT event_start,
        EXTRACT(EPOCH FROM (TRY_CAST(ts AS TIMESTAMP) - TRY_CAST(event_start AS TIMESTAMP))) AS t,
        underlying_price AS spot, price_to_beat AS ptb,
        up_best_bid AS ub, up_best_ask AS ua, down_best_bid AS db, down_best_ask AS da
      FROM read_parquet('${glob}')
      WHERE underlying_price IS NOT NULL AND price_to_beat IS NOT NULL AND price_to_beat > 0
        AND coverage >= 0.9
      ORDER BY event_start, ts
    `);
    const rowsIn = res.getRowObjectsJson();
    let curKey = null, buf = [];
    let dayRows = 0, dayEvents = 0;
    const flush = () => {
      if (buf.length) {
        buf.eventStart = curKey;
        const out = processEvent(buf, day);
        if (out.length) { dayEvents += 1; dayRows += out.length; outStream.write(out.join('\n') + '\n'); }
      }
    };
    for (const r of rowsIn) {
      const key = new Date(String(r.event_start)).toISOString();
      if (key !== curKey) { flush(); curKey = key; buf = []; }
      buf.push({ t: Number(r.t), spot: Number(r.spot), ptb: Number(r.ptb),
        ub: r.ub == null ? null : Number(r.ub), ua: r.ua == null ? null : Number(r.ua),
        db: r.db == null ? null : Number(r.db), da: r.da == null ? null : Number(r.da) });
    }
    flush();
    totalEvents += dayEvents; totalRows += dayRows;
    console.error(`[${day}] events=${dayEvents} rows=${dayRows} ${Date.now() - t0}ms`);
  }
  outStream.end();
  console.error(`DONE events=${totalEvents} rows=${totalRows} -> ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
