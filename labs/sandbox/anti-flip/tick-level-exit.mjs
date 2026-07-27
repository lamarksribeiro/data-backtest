/**
 * Simulacao tick-a-tick da saida anti-flip no BTC 5m.
 * Entrada: favorito no instante tauEntry (default 30s), taker no ask, $10.
 * Monitor: cada tick ate o fim. Regras de saida testadas em paralelo.
 * Saida: taker no bid do nosso lado (+ fee), sem lookahead.
 *
 * Emite CSV por trade com PnL de cada variante + antecedencia do sinal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = 'D:/Projetos/projeto-goldenlens/data-backtest';
const OUT = process.argv[process.argv.indexOf('--out') + 1] || path.join(ROOT, 'scratch/tick-exit.csv');
const TAU_ENTRY = 30;
const BUDGET = 10;
const SETTLE = 0.995;
const FEE = (p) => 0.07 * p * (1 - p);

const baseDir = path.join(ROOT, 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25');
const days = fs.readdirSync(baseDir).filter((d) => d.startsWith('dt=')).map((d) => d.slice(3)).sort();

// Variantes de saida: cada uma recebe estado do tick e decide sair
const VARIANTS = [
  { name: 'hold', fn: () => false },
  // perde lideranca no spot
  { name: 'lead', fn: (s) => s.leaderNow !== s.side },
  // perde lideranca E book confirma
  { name: 'lead_bid45', fn: (s) => s.leaderNow !== s.side && s.ourBid < 0.45 },
  { name: 'lead_bid40', fn: (s) => s.leaderNow !== s.side && s.ourBid < 0.40 },
  // book sozinho: nosso bid desabou
  { name: 'bid35', fn: (s) => s.ourBid < 0.35 },
  { name: 'bid45', fn: (s) => s.ourBid < 0.45 },
  // book desabou rapido (choque de odds)
  { name: 'shock', fn: (s) => s.ourMid - s.ourMid2sAgo < -0.15 },
  // combinada: lideranca perdida OU nosso bid < 0.35
  { name: 'lead_or_bid35', fn: (s) => (s.leaderNow !== s.side) || s.ourBid < 0.35 },
  // z-based: prob brownian do nosso lado ganhar < 0.4
  { name: 'zexit40', fn: (s) => s.pWinBrown < 0.40 },
  { name: 'zexit30', fn: (s) => s.pWinBrown < 0.30 },
  // lideranca perdida E z confirma que nao volta
  { name: 'lead_and_z', fn: (s) => s.leaderNow !== s.side && s.pWinBrown < 0.40 },
];

function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return s * y;
}
const phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

const out = fs.createWriteStream(OUT);
out.write(['day', 'event_start', 'side', 'ask', 'win', ...VARIANTS.map((v) => `pnl_${v.name}`), ...VARIANTS.map((v) => `t_${v.name}`)].join(',') + '\n');

function runEvent(ticks, day, eventStart) {
  const n = ticks.length;
  if (n < 100) return null;
  const last = ticks[n - 1];
  const ptb = last.ptb;
  if (!(ptb > 0)) return null;
  const dur = last.t;
  const winner = last.spot > ptb ? 1 : -1;

  // validacao de label pelo book final
  let ms = 0, mn = 0;
  for (let i = n - 1; i >= 0 && last.t - ticks[i].t <= 5; i -= 1) {
    if (ticks[i].ub != null && ticks[i].ua != null) { ms += (ticks[i].ub + ticks[i].ua) / 2; mn += 1; }
  }
  if (!mn) return null;
  if ((ms / mn > 0.5 ? 1 : -1) !== winner) return null;

  // instante de entrada
  const tEntry = dur - TAU_ENTRY;
  let ei = -1;
  for (let i = n - 1; i >= 0; i -= 1) if (ticks[i].t <= tEntry) { ei = i; break; }
  if (ei < 30) return null;
  const e = ticks[ei];
  if (e.ub == null || e.ua == null || e.db == null || e.da == null) return null;
  const dist0 = e.spot - ptb;
  if (dist0 === 0) return null;
  const side = dist0 > 0 ? 1 : -1;
  const ask = side === 1 ? e.ua : e.da;
  if (!(ask > 0.5 && ask <= 0.94)) return null;

  const shares = BUDGET / ask;
  const feeIn = FEE(ask) * shares;
  const win = side === winner ? 1 : 0;

  // vol realizada 60s antes da entrada (para pWinBrown)
  let sumSq = 0, dtSum = 0;
  for (let i = ei; i >= 1; i -= 1) {
    const age = e.t - ticks[i].t;
    if (age > 60) break;
    const d = ticks[i].spot - ticks[i - 1].spot;
    const dt = ticks[i].t - ticks[i - 1].t;
    if (dt > 0) { sumSq += d * d; dtSum += dt; }
  }
  const sigma1s = dtSum > 0 ? Math.sqrt(sumSq / dtSum) : 0;

  const state = VARIANTS.map(() => ({ exited: false, px: null, t: null }));

  for (let i = ei + 1; i < n; i += 1) {
    const tk = ticks[i];
    if (tk.ub == null || tk.ua == null || tk.db == null || tk.da == null) continue;
    const secsLeft = dur - tk.t;
    if (secsLeft < 2) break; // nao da pra sair nos ultimos 2s
    const dist = tk.spot - ptb;
    const leaderNow = dist > 0 ? 1 : dist < 0 ? -1 : side;
    const upMid = (tk.ub + tk.ua) / 2;
    const ourMid = side === 1 ? upMid : 1 - upMid;
    const ourBid = side === 1 ? tk.ub : tk.db;
    // mid de 2s atras
    let ourMid2 = ourMid;
    for (let j = i; j >= 0; j -= 1) {
      if (tk.t - ticks[j].t >= 2) {
        if (ticks[j].ub != null && ticks[j].ua != null) {
          const um = (ticks[j].ub + ticks[j].ua) / 2;
          ourMid2 = side === 1 ? um : 1 - um;
        }
        break;
      }
    }
    // prob brownian do NOSSO lado ganhar
    let pWinBrown = 0.5;
    if (sigma1s > 0 && secsLeft > 0) {
      const zz = (dist * side) / (sigma1s * Math.sqrt(secsLeft));
      pWinBrown = phi(zz);
    } else {
      pWinBrown = leaderNow === side ? 1 : 0;
    }
    const s = { side, leaderNow, ourBid, ourMid, ourMid2sAgo: ourMid2, pWinBrown, secsLeft };

    for (let v = 0; v < VARIANTS.length; v += 1) {
      if (state[v].exited) continue;
      if (VARIANTS[v].fn(s)) {
        state[v].exited = true;
        state[v].px = Math.max(0.01, Math.min(0.99, ourBid));
        state[v].t = secsLeft;
      }
    }
  }

  const pnls = state.map((st) => {
    if (st.exited) return shares * st.px - BUDGET - feeIn - FEE(st.px) * shares;
    return win ? shares * SETTLE - BUDGET - feeIn : -BUDGET - feeIn;
  });

  return [day, eventStart, side, ask.toFixed(3), win,
    ...pnls.map((p) => p.toFixed(4)),
    ...state.map((st) => (st.exited ? st.t.toFixed(1) : ''))].join(',');
}

async function main() {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  await conn.run('SET threads TO 6');
  let total = 0;
  for (const day of days) {
    const glob = path.join(baseDir, `dt=${day}`, '*.parquet').replace(/\\/g, '/');
    const res = await conn.runAndReadAll(`
      SELECT event_start,
        EXTRACT(EPOCH FROM (TRY_CAST(ts AS TIMESTAMP) - TRY_CAST(event_start AS TIMESTAMP))) AS t,
        underlying_price AS spot, price_to_beat AS ptb,
        up_best_bid AS ub, up_best_ask AS ua, down_best_bid AS db, down_best_ask AS da
      FROM read_parquet('${glob}')
      WHERE underlying_price IS NOT NULL AND price_to_beat IS NOT NULL AND price_to_beat > 0 AND coverage >= 0.9
      ORDER BY event_start, ts`);
    const rows = res.getRowObjectsJson();
    let key = null, buf = [], cnt = 0;
    const flush = () => {
      if (!buf.length) return;
      const line = runEvent(buf, day, key);
      if (line) { out.write(line + '\n'); cnt += 1; }
    };
    for (const r of rows) {
      const k = String(r.event_start);
      if (k !== key) { flush(); key = k; buf = []; }
      buf.push({ t: Number(r.t), spot: Number(r.spot), ptb: Number(r.ptb),
        ub: r.ub == null ? null : Number(r.ub), ua: r.ua == null ? null : Number(r.ua),
        db: r.db == null ? null : Number(r.db), da: r.da == null ? null : Number(r.da) });
    }
    flush();
    total += cnt;
    console.error(`[${day}] trades=${cnt}`);
  }
  out.end();
  console.error(`DONE trades=${total} -> ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
