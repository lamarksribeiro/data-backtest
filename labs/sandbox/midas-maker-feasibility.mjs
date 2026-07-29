/**
 * MIDAS — viabilidade da entrada MAKER (ordem passiva em vez de taker).
 *
 * Motivação: a fee taker é 0.07·p·(1−p) por share. Na banda média/barata ela
 * come 20–40% do edge bruto, e ainda se paga o spread. Fill maker na Polymarket
 * é isento de fee (o lab já modela isso: src/backtest/fees.js linha 329-334).
 *
 * O modelo de fill do simulador é deliberadamente pessimista: a ordem só
 * preenche quando o ask CAI através do preço postado (makerFillEpsilon 0.01).
 * Ou seja, só se compra quando o mercado veio contra — seleção adversa integral.
 * Se a entrada maker for lucrativa sob essa regra, é lucrativa de verdade.
 *
 * Mede, para a mesma população de entrada da MIDAS:
 *   - fill rate da ordem passiva postada no bid (e em ask−1c)
 *   - preço efetivo pago e WR/edge do subconjunto preenchido
 *   - comparação direta com o baseline taker
 *
 * Uso: node --max-old-space-size=12288 labs/sandbox/midas-maker-feasibility.mjs --underlying BTC
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
const EPS = 0.01;          // makerFillEpsilon do simulador
const MIN_ASK = 0.30;
const FILL_FLOOR_TAU = Number(argOf('floorTau', '4')); // até quando a ordem fica no book

const GLOB = `lake/backtest_ticks/underlying=${UNDERLYING}/interval=5m/book_depth=25/dt=*/*.parquet`;
const feeOf = (p) => FEE * p * (1 - p);

// mode: 'bid' posta no melhor bid; 'ask1' posta em ask-0.01
function sql(mode) {
  const postExpr = mode === 'bid' ? 'e.bid0' : '(e.ask0 - 0.01)';
  return `
WITH raw AS (
  SELECT condition_id, dt,
    epoch(CAST(event_end AS TIMESTAMP)) - epoch(CAST(ts AS TIMESTAMP)) AS tau,
    epoch(CAST(ts AS TIMESTAMP)) AS tsec,
    underlying_price, price_to_beat,
    up_best_bid, up_best_ask, down_best_bid, down_best_ask, coverage, degraded
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
  SELECT t.*, o.winner, row_number() OVER (PARTITION BY t.condition_id ORDER BY t.tsec ASC) AS rn
  FROM tagged t JOIN outcome o USING (condition_id)
  WHERE t.tau >= 9 AND t.tau < 30 AND t.dist < 40
    AND t.fav_ask >= ${MIN_ASK} AND t.fav_ask <= 0.94
    AND (t.fav_ask - t.fav_bid) <= 0.03
    AND t.odds_sum >= 0.98 AND t.odds_sum <= 1.06
    AND t.coverage >= 0.9 AND t.degraded = false
),
entry AS (
  SELECT condition_id, dt, tsec AS t0, fav, fav_ask AS ask0, fav_bid AS bid0,
         CASE WHEN fav = winner THEN 1 ELSE 0 END AS won
  FROM cand WHERE rn = 1
)
SELECT e.dt, e.ask0, e.bid0, e.won, ${postExpr} AS post_px,
  -- preenche se o ask do MESMO lado cair até post_px - eps enquanto a ordem vive
  (SELECT count(*) FROM tagged t2
    WHERE t2.condition_id = e.condition_id
      AND t2.tsec > e.t0 AND t2.tau >= ${FILL_FLOOR_TAU}
      AND (CASE WHEN e.fav = 'UP' THEN t2.up_best_ask ELSE t2.down_best_ask END) <= ${postExpr} - ${EPS}
  ) AS cross_ticks
FROM entry e`;
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

// isMaker: fee zero e preço = post_px. Senão taker no ask0.
function stats(sel, isMaker) {
  const n = sel.length;
  if (!n) return null;
  const wins = sel.reduce((a, r) => a + r.won, 0);
  const wr = wins / n;
  const px = sel.reduce((a, r) => a + (isMaker ? r.post_px : r.ask0), 0) / n;
  const fee = isMaker ? 0 : feeOf(px);
  const beWr = (px + fee) / SETTLE;
  const evShare = wr * (SETTLE - px) - (1 - wr) * px - fee;
  const [lo, hi] = wilson(wins, n);
  return {
    n, wr: wr * 100, px, fee,
    edgePp: (wr - beWr) * 100, edgeLo: (lo - beWr) * 100, edgeHi: (hi - beWr) * 100,
    evPerDollar: evShare / px,
    ratio: (SETTLE - px - fee) / (px + fee),
  };
}

(async () => {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();

  const P = [];
  P.push(`# MIDAS — viabilidade da entrada MAKER (${UNDERLYING})`);
  P.push('');
  P.push(`Janela ${FROM}..${TO} · settlement ${SETTLE} · fill maker isento de fee.`);
  P.push(`Regra de fill (a do simulador, pessimista): o ask precisa CAIR até preço_postado − ${EPS}.`);
  P.push(`A ordem vive de t0 até tau = ${FILL_FLOOR_TAU}s. Seleção adversa integral: só preenche quando o mercado veio contra.`);

  for (const mode of ['bid', 'ask1']) {
    const label = mode === 'bid' ? 'postar no melhor BID' : 'postar em ASK − 0.01';
    process.stderr.write(`${UNDERLYING} modo ${mode} ...\n`);
    const rows = (await conn.runAndReadAll(sql(mode))).getRowObjects().map((r) => ({
      dt: String(r.dt), ask0: Number(r.ask0), bid0: Number(r.bid0),
      post_px: Number(r.post_px), won: Number(r.won), cross: Number(r.cross_ticks),
    }));

    P.push(`\n## Modo: ${label}\n`);
    P.push('| Banda (por ask0) | candidatos | fill maker | fill % | preço maker | WR maker % | edge maker pp | IC95 pp | EV/$ maker | EV/$ taker (mesma pop.) |');
    P.push('|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
    for (const g of GROUPS) {
      const all = rows.filter((r) => r.ask0 >= g.lo && r.ask0 < g.hi);
      const filled = all.filter((r) => r.cross > 0);
      const sm = stats(filled, true);
      const st = stats(filled, false); // mesma população, mas paga taker no ask0
      if (!sm) { P.push(`| ${g.label} | ${all.length} | 0 | 0.0 | — | — | — | — | — | — |`); continue; }
      P.push(`| ${g.label} | ${all.length} | ${sm.n} | ${(100 * sm.n / all.length).toFixed(1)} | ${sm.px.toFixed(3)} | ${sm.wr.toFixed(1)} | ${sm.edgePp >= 0 ? '+' : ''}${sm.edgePp.toFixed(2)} | [${sm.edgeLo.toFixed(2)}, ${sm.edgeHi.toFixed(2)}] | ${sm.evPerDollar >= 0 ? '+' : ''}${sm.evPerDollar.toFixed(4)} | ${st.evPerDollar >= 0 ? '+' : ''}${st.evPerDollar.toFixed(4)} |`);
    }

    // baseline taker sobre TODOS os candidatos (o que a MIDAS faz hoje)
    P.push('\nBaseline taker sobre todos os candidatos (o que a MIDAS faz hoje):\n');
    P.push('| Banda | n | preço | edge pp | EV/$ orçado |');
    P.push('|---|--:|--:|--:|--:|');
    for (const g of GROUPS) {
      const all = rows.filter((r) => r.ask0 >= g.lo && r.ask0 < g.hi);
      const st = stats(all, false);
      if (!st) continue;
      P.push(`| ${g.label} | ${st.n} | ${st.px.toFixed(3)} | ${st.edgePp >= 0 ? '+' : ''}${st.edgePp.toFixed(2)} | ${st.evPerDollar >= 0 ? '+' : ''}${st.evPerDollar.toFixed(4)} |`);
    }
  }

  const md = P.join('\n');
  console.log(md);
  fs.writeFileSync(`labs/sandbox/midas-maker-feasibility-${UNDERLYING.toLowerCase()}.md`, md);
})().catch((e) => { console.error('ERRO:', e.message, e.stack); process.exit(1); });
