/**
 * MIDAS — validação multi-ativo do achado de banda.
 *
 * Hipótese a refutar: "o edge vive na banda barata e morre na banda cara".
 * Se o padrão se repetir em 5 ativos independentes e em 3 janelas temporais,
 * é estrutural (o mercado precifica mal a incerteza, não a certeza) e não
 * resultado de garimpo em BTC.
 *
 * Para cada ativo mede, com execução honesta:
 *   - edge (WR − WR breakeven) e EV por dólar orçado, por grupo de ask
 *   - o mesmo com latência de 1 s (FAK, teto ask0 + 0.02)
 *
 * Uso: node --max-old-space-size=12288 labs/sandbox/midas-multiasset-band-validation.mjs
 */
import fs from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const ASSETS = argOf('assets', 'BTC,ETH,SOL,XRP,DOGE').split(',');
const FROM = argOf('from', '2026-05-04');
const TO = argOf('to', '2026-07-26');
const SETTLE = 0.995;
const FEE = 0.07;
const SLIPPAGE = 0.02;
const MIN_ASK = 0.30;
const LATENCY = 1.0;

const feeOf = (p) => FEE * p * (1 - p);

function sql(underlying, withLatency) {
  const glob = `lake/backtest_ticks/underlying=${underlying}/interval=5m/book_depth=25/dt=*/*.parquet`;
  const base = `
WITH raw AS (
  SELECT condition_id, dt,
    epoch(CAST(event_end AS TIMESTAMP)) - epoch(CAST(ts AS TIMESTAMP)) AS tau,
    epoch(CAST(ts AS TIMESTAMP)) AS tsec,
    underlying_price, price_to_beat,
    up_best_bid, up_best_ask, down_best_bid, down_best_ask, coverage, degraded
  FROM read_parquet('${glob}', hive_partitioning = true)
  WHERE dt >= '${FROM}' AND dt <= '${TO}'
    AND underlying_price IS NOT NULL AND price_to_beat IS NOT NULL
    AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
    AND up_best_bid IS NOT NULL AND down_best_bid IS NOT NULL
),
outcome AS (
  SELECT condition_id, arg_max(CASE WHEN underlying_price >= price_to_beat THEN 'UP' ELSE 'DOWN' END, tsec) AS winner
  FROM raw GROUP BY condition_id
),
tagged AS (
  SELECT r.*,
    CASE WHEN underlying_price >= price_to_beat THEN 'UP' ELSE 'DOWN' END AS fav,
    CASE WHEN underlying_price >= price_to_beat THEN up_best_ask ELSE down_best_ask END AS fav_ask,
    CASE WHEN underlying_price >= price_to_beat THEN up_best_bid ELSE down_best_bid END AS fav_bid,
    abs(underlying_price - price_to_beat) AS dist,
    up_best_ask + down_best_ask AS odds_sum
  FROM raw r
),
cand AS (
  SELECT t.*, o.winner, row_number() OVER (PARTITION BY t.condition_id ORDER BY t.tsec ASC) AS rn
  FROM tagged t JOIN outcome o USING (condition_id)
  WHERE t.tau >= 9 AND t.tau < 30 AND t.dist < 40
    AND t.fav_ask >= ${MIN_ASK} AND t.fav_ask <= 0.94
    AND (t.fav_ask - t.fav_bid) <= 0.03
    AND t.odds_sum >= 0.98 AND t.odds_sum <= 1.06
    AND t.coverage >= 0.9 AND t.degraded = false
),
entry AS (
  SELECT condition_id, dt, tsec AS t0, fav, fav_ask AS ask0,
         CASE WHEN fav = winner THEN 1 ELSE 0 END AS won
  FROM cand WHERE rn = 1
)`;

  if (!withLatency) {
    return `${base} SELECT dt, ask0, ask0 AS fill_ask, won, 1 AS filled FROM entry`;
  }
  return `${base},
fills AS (
  SELECT e.dt, e.ask0, e.won,
    (SELECT CASE WHEN e.fav = 'UP' THEN t2.up_best_ask ELSE t2.down_best_ask END
     FROM tagged t2 WHERE t2.condition_id = e.condition_id AND t2.tsec >= e.t0 + ${LATENCY}
     ORDER BY t2.tsec ASC LIMIT 1) AS fill_ask
  FROM entry e
)
SELECT dt, ask0, fill_ask, won,
  CASE WHEN fill_ask IS NOT NULL AND fill_ask <= ask0 + ${SLIPPAGE} THEN 1 ELSE 0 END AS filled
FROM fills`;
}

const GROUPS = [
  { label: '[0.30,0.55)', lo: MIN_ASK, hi: 0.55 },
  { label: '[0.55,0.70)', lo: 0.55, hi: 0.70 },
  { label: '[0.70,0.82)', lo: 0.70, hi: 0.82 },
  { label: '[0.82,0.94]', lo: 0.82, hi: 0.9401 },
];

function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - s) / d, (c + s) / d];
}

function stats(sel) {
  const n = sel.length;
  if (!n) return null;
  const wins = sel.reduce((a, r) => a + r.won, 0);
  const wr = wins / n;
  const avg = sel.reduce((a, r) => a + r.fill_ask, 0) / n;
  const fee = feeOf(avg);
  const beWr = (avg + fee) / SETTLE;
  const evShare = wr * (SETTLE - avg) - (1 - wr) * avg - fee;
  const [lo, hi] = wilson(wins, n);
  return {
    n, wr: wr * 100, avg,
    edgePp: (wr - beWr) * 100, edgeLo: (lo - beWr) * 100, edgeHi: (hi - beWr) * 100,
    evPerDollar: evShare / avg,
    ratio: (SETTLE - avg - fee) / (avg + fee),
  };
}

const splitOf = (dt) => (dt < '2026-06-01' ? 'train' : dt <= '2026-06-30' ? 'june' : 'july');

(async () => {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();

  const P = [];
  P.push('# MIDAS — validação multi-ativo do achado de banda');
  P.push('');
  P.push(`Ativos: ${ASSETS.join(', ')} · janela ${FROM}..${TO} · settlement ${SETTLE} · fee 0.07·p·(1−p).`);
  P.push('Uma entrada por evento · envelope tau∈[9,30) · dist<40 · spread≤0.03 · oddsSum∈[0.98,1.06].');
  P.push('');
  P.push('Cada ativo é uma amostra praticamente independente. O padrão só é estrutural se repetir.');

  const store = {};
  for (const a of ASSETS) {
    process.stderr.write(`${a} (δ=0) ...\n`);
    const r0 = (await conn.runAndReadAll(sql(a, false))).getRowObjects()
      .map((r) => ({ dt: String(r.dt), ask0: Number(r.ask0), fill_ask: Number(r.fill_ask), won: Number(r.won), filled: 1 }));
    process.stderr.write(`${a} (δ=${LATENCY}s) ...\n`);
    const r1 = (await conn.runAndReadAll(sql(a, true))).getRowObjects()
      .map((r) => ({ dt: String(r.dt), ask0: Number(r.ask0), fill_ask: r.fill_ask == null ? null : Number(r.fill_ask), won: Number(r.won), filled: Number(r.filled) }));
    store[a] = { r0, r1 };
    process.stderr.write(`${a}: ${r0.length} entradas\n`);
  }

  // Tabela 1: edge por grupo, execução imediata
  P.push('\n## 1. Edge por grupo de ask, por ativo (execução imediata)\n');
  P.push('| Ativo | n | ' + GROUPS.map((g) => g.label).join(' | ') + ' |');
  P.push('|---|--:|' + GROUPS.map(() => '--:').join('|') + '|');
  for (const a of ASSETS) {
    const cells = GROUPS.map((g) => {
      const s = stats(store[a].r0.filter((r) => r.ask0 >= g.lo && r.ask0 < g.hi));
      return s ? `${s.edgePp >= 0 ? '+' : ''}${s.edgePp.toFixed(2)}pp (n=${s.n})` : '—';
    });
    P.push(`| ${a} | ${store[a].r0.length} | ${cells.join(' | ')} |`);
  }

  // Tabela 2: EV por dólar orçado
  P.push('\n## 2. EV por dólar de orçamento, por ativo (execução imediata)\n');
  P.push('| Ativo | ' + GROUPS.map((g) => g.label).join(' | ') + ' |');
  P.push('|---|' + GROUPS.map(() => '--:').join('|') + '|');
  for (const a of ASSETS) {
    const cells = GROUPS.map((g) => {
      const s = stats(store[a].r0.filter((r) => r.ask0 >= g.lo && r.ask0 < g.hi));
      return s ? `${s.evPerDollar >= 0 ? '+' : ''}${s.evPerDollar.toFixed(4)}` : '—';
    });
    P.push(`| ${a} | ${cells.join(' | ')} |`);
  }

  // Tabela 3: com latência de 1 s
  P.push(`\n## 3. Mesma medida com latência de ${LATENCY} s (FAK, teto ask0+${SLIPPAGE})\n`);
  P.push('| Ativo | ' + GROUPS.map((g) => g.label).join(' | ') + ' |');
  P.push('|---|' + GROUPS.map(() => '--:').join('|') + '|');
  for (const a of ASSETS) {
    const cells = GROUPS.map((g) => {
      const s = stats(store[a].r1.filter((r) => r.ask0 >= g.lo && r.ask0 < g.hi && r.filled === 1 && r.fill_ask != null));
      return s ? `${s.edgePp >= 0 ? '+' : ''}${s.edgePp.toFixed(2)}pp` : '—';
    });
    P.push(`| ${a} | ${cells.join(' | ')} |`);
  }

  // Tabela 4: contribuição de EV — quem paga a conta, por ativo
  P.push('\n## 4. Fatia do EV total por grupo (execução imediata)\n');
  P.push('| Ativo | ' + GROUPS.map((g) => g.label).join(' | ') + ' |');
  P.push('|---|' + GROUPS.map(() => '--:').join('|') + '|');
  for (const a of ASSETS) {
    const evs = GROUPS.map((g) => {
      const sel = store[a].r0.filter((r) => r.ask0 >= g.lo && r.ask0 < g.hi);
      const s = stats(sel);
      return s ? s.evPerDollar * s.n : 0;
    });
    const tot = evs.reduce((x, y) => x + y, 0);
    P.push(`| ${a} | ${evs.map((e) => `${(100 * e / tot).toFixed(1)}%`).join(' | ')} |`);
  }

  // Tabela 5: fração dos trades por grupo (para contrastar com a fatia de EV)
  P.push('\n## 5. Fatia dos TRADES por grupo (contraste com a tabela 4)\n');
  P.push('| Ativo | ' + GROUPS.map((g) => g.label).join(' | ') + ' |');
  P.push('|---|' + GROUPS.map(() => '--:').join('|') + '|');
  for (const a of ASSETS) {
    const ns = GROUPS.map((g) => store[a].r0.filter((r) => r.ask0 >= g.lo && r.ask0 < g.hi).length);
    const tot = ns.reduce((x, y) => x + y, 0);
    P.push(`| ${a} | ${ns.map((n) => `${(100 * n / tot).toFixed(1)}%`).join(' | ')} |`);
  }

  // Tabela 6: estabilidade temporal do agregado (todos os ativos juntos)
  P.push('\n## 6. Estabilidade temporal — todos os ativos somados\n');
  P.push('| Janela | grupo | n | WR% | edge pp | IC95 pp | razão G/P | EV/$ orçado |');
  P.push('|---|---|--:|--:|--:|--:|--:|--:|');
  const all = ASSETS.flatMap((a) => store[a].r0);
  for (const k of ['train', 'june', 'july']) {
    for (const g of [{ label: 'ask<0.70', f: (r) => r.ask0 < 0.70 }, { label: 'ask>=0.82', f: (r) => r.ask0 >= 0.82 }]) {
      const s = stats(all.filter((r) => splitOf(r.dt) === k && g.f(r)));
      if (!s) continue;
      P.push(`| ${k} | ${g.label} | ${s.n} | ${s.wr.toFixed(1)} | ${s.edgePp >= 0 ? '+' : ''}${s.edgePp.toFixed(2)} | [${s.edgeLo.toFixed(2)}, ${s.edgeHi.toFixed(2)}] | ${s.ratio.toFixed(3)} | ${s.evPerDollar >= 0 ? '+' : ''}${s.evPerDollar.toFixed(4)} |`);
    }
  }

  const md = P.join('\n');
  console.log(md);
  fs.writeFileSync('labs/sandbox/midas-multiasset-band-validation.md', md);
})().catch((e) => { console.error('ERRO:', e.message, e.stack); process.exit(1); });
