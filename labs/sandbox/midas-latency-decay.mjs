/**
 * MIDAS — teste de decaimento por latência (validade do edge da banda barata).
 *
 * O lab de scoop rejeitou ask<0.55 como "alfa de latência": o ask estaria
 * defasado durante o repricing, então o backtest compra a um preço que não
 * existiria mais quando a ordem chegasse. Este teste mede exatamente isso.
 *
 * Protocolo honesto (FAK):
 *   1. Decisão em t0 com TODOS os gates avaliados nos dados de t0.
 *   2. O lado (fav) fica travado na decisão.
 *   3. A ordem chega em t0 + δ. Preenche se ask(t0+δ) <= ask(t0) + slippage;
 *      caso contrário é FAK miss (nenhum trade).
 *   4. Preço pago = ask(t0+δ) real.
 *
 * Se o edge sobrevive a δ = 1–2 s, não é alfa de latência.
 * Se colapsa já em δ = 0,5 s, a rejeição do scoop se aplica e a banda morre.
 *
 * Uso: node --max-old-space-size=12288 labs/sandbox/midas-latency-decay.mjs --underlying BTC
 */
import fs from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const UNDERLYING = argOf('underlying', 'BTC');
const FROM = argOf('from', '2026-05-04');
const TO = argOf('to', '2026-07-26');
const SETTLE = 0.995;
const FEE = 0.07;
const SLIPPAGE = Number(argOf('slippage', '0.02'));
const MIN_ASK = Number(argOf('minAsk', '0.30'));
const DELAYS = [0, 0.5, 1, 2, 3];

const GLOB = `lake/backtest_ticks/underlying=${UNDERLYING}/interval=5m/book_depth=25/dt=*/*.parquet`;
const feeOf = (p) => FEE * p * (1 - p);

// Base comum: candidatos de entrada (decisão em t0) + série de asks por lado.
const baseCTE = `
WITH raw AS (
  SELECT condition_id, dt,
    epoch(CAST(event_end AS TIMESTAMP)) - epoch(CAST(ts AS TIMESTAMP)) AS tau,
    epoch(CAST(ts AS TIMESTAMP)) AS tsec,
    underlying_price, price_to_beat,
    up_best_bid, up_best_ask, down_best_bid, down_best_ask,
    coverage, degraded
  FROM read_parquet('${GLOB}', hive_partitioning = true)
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
  SELECT t.*, o.winner,
    row_number() OVER (PARTITION BY t.condition_id ORDER BY t.tsec ASC) AS rn
  FROM tagged t JOIN outcome o USING (condition_id)
  WHERE t.tau >= 9 AND t.tau < 30 AND t.dist < 40
    AND t.fav_ask >= ${MIN_ASK} AND t.fav_ask <= 0.94
    AND (t.fav_ask - t.fav_bid) <= 0.03
    AND t.odds_sum >= 0.98 AND t.odds_sum <= 1.06
    AND t.coverage >= 0.9 AND t.degraded = false
),
entry AS (
  SELECT condition_id, dt, tsec AS t0, fav, fav_ask AS ask0, winner,
         CASE WHEN fav = winner THEN 1 ELSE 0 END AS won
  FROM cand WHERE rn = 1
)`;

function sqlForDelay(delay) {
  if (delay === 0) {
    return `${baseCTE}
SELECT dt, ask0, ask0 AS fill_ask, won, 1 AS filled FROM entry`;
  }
  return `${baseCTE},
fills AS (
  SELECT e.dt, e.ask0, e.won, e.condition_id,
    -- primeiro tick disponível em t0 + delay
    (SELECT CASE WHEN e.fav = 'UP' THEN t2.up_best_ask ELSE t2.down_best_ask END
     FROM tagged t2
     WHERE t2.condition_id = e.condition_id AND t2.tsec >= e.t0 + ${delay}
     ORDER BY t2.tsec ASC LIMIT 1) AS fill_ask
  FROM entry e
)
SELECT dt, ask0, fill_ask, won,
       CASE WHEN fill_ask IS NOT NULL AND fill_ask <= ask0 + ${SLIPPAGE} THEN 1 ELSE 0 END AS filled
FROM fills`;
}

const BANDS = [
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

// Estatísticas sobre os trades EFETIVAMENTE preenchidos, usando o preço pago.
function stats(sel) {
  const n = sel.length;
  if (!n) return null;
  const wins = sel.reduce((a, r) => a + r.won, 0);
  const wr = wins / n;
  const avgFill = sel.reduce((a, r) => a + r.fill_ask, 0) / n;
  const fee = feeOf(avgFill);
  const beWr = (avgFill + fee) / SETTLE;
  const evShare = wr * (SETTLE - avgFill) - (1 - wr) * avgFill - fee;
  const [lo, hi] = wilson(wins, n);
  return {
    n, wr: wr * 100, avgFill,
    edgePp: (wr - beWr) * 100,
    edgeLo: (lo - beWr) * 100,
    edgeHi: (hi - beWr) * 100,
    evPerDollarBudget: evShare / avgFill,
  };
}

(async () => {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();

  const results = {};
  for (const d of DELAYS) {
    process.stderr.write(`δ = ${d}s ...\n`);
    const rows = (await conn.runAndReadAll(sqlForDelay(d))).getRowObjects().map((r) => ({
      dt: String(r.dt),
      ask0: Number(r.ask0),
      fill_ask: r.fill_ask == null ? null : Number(r.fill_ask),
      won: Number(r.won),
      filled: Number(r.filled),
    }));
    results[d] = rows;
  }

  const P = [];
  P.push(`# MIDAS — decaimento do edge por latência de execução (${UNDERLYING})`);
  P.push('');
  P.push(`Janela ${FROM}..${TO} · settlement ${SETTLE} · slippage máx ${SLIPPAGE} (FAK) · ticks a ~500 ms.`);
  P.push('Decisão em t0; ordem chega em t0+δ; preenche só se o ask ainda couber no teto.');
  P.push('A banda é definida pelo ask **da decisão** (ask0), para comparar a mesma população.');
  P.push('');
  P.push('Se o edge some em δ pequeno, é alfa de latência (quote defasado) e não é negociável.');

  for (const b of BANDS) {
    P.push(`\n## Banda ${b.label}\n`);
    P.push('| δ (s) | candidatos | preenchidos | fill rate % | ask médio pago | WR% | edge pp | IC95 pp | EV/$ orçado |');
    P.push('|---|--:|--:|--:|--:|--:|--:|--:|--:|');
    for (const d of DELAYS) {
      const all = results[d].filter((r) => r.ask0 >= b.lo && r.ask0 < b.hi);
      const filled = all.filter((r) => r.filled === 1 && r.fill_ask != null);
      const s = stats(filled);
      if (!s) { P.push(`| ${d} | ${all.length} | 0 | 0.0 | — | — | — | — | — |`); continue; }
      P.push(`| ${d} | ${all.length} | ${s.n} | ${(100 * s.n / all.length).toFixed(1)} | ${s.avgFill.toFixed(3)} | ${s.wr.toFixed(1)} | ${s.edgePp >= 0 ? '+' : ''}${s.edgePp.toFixed(2)} | [${s.edgeLo.toFixed(2)}, ${s.edgeHi.toFixed(2)}] | ${s.evPerDollarBudget >= 0 ? '+' : ''}${s.evPerDollarBudget.toFixed(4)} |`);
    }
  }

  // leitura agregada: EV total capturado por banda a cada latência
  P.push('\n## EV total capturado (por $1 de orçamento por entrada)\n');
  P.push('| δ (s) | ' + BANDS.map((b) => b.label).join(' | ') + ' | TOTAL |');
  P.push('|---|' + BANDS.map(() => '--:').join('|') + '|--:|');
  for (const d of DELAYS) {
    const cells = [];
    let tot = 0;
    for (const b of BANDS) {
      const filled = results[d].filter((r) => r.ask0 >= b.lo && r.ask0 < b.hi && r.filled === 1 && r.fill_ask != null);
      const s = stats(filled);
      const ev = s ? s.evPerDollarBudget * s.n : 0;
      tot += ev;
      cells.push(ev.toFixed(1));
    }
    P.push(`| ${d} | ${cells.join(' | ')} | ${tot.toFixed(1)} |`);
  }

  const md = P.join('\n');
  console.log(md);
  fs.writeFileSync(`labs/sandbox/midas-latency-decay-${UNDERLYING.toLowerCase()}.md`, md);
})().catch((e) => { console.error('ERRO:', e.message, e.stack); process.exit(1); });
