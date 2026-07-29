/**
 * MIDAS — perfil da banda barata (a região onde o edge realmente vive).
 *
 * Três perguntas:
 *  1. O edge continua subindo abaixo de ask 0.55? Onde está o piso útil?
 *  2. Dentro da banda barata, quais cortes de z / dist / tau concentram o edge?
 *  3. Multi-ativo: o padrão se repete em ETH/SOL/XRP/DOGE?
 *
 * Envelope de medição = MIDAS sem o gate de ask (o resto igual ao Gold):
 *   tau in [9,30) · dist < 40 · spread <= 0.03 · oddsSum in [0.98,1.06]
 *   coverage >= 0.9 · not degraded · uma entrada por evento
 *
 * Uso: node --max-old-space-size=12288 labs/sandbox/midas-cheap-band-profile.mjs --underlying BTC
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
const SIGMA_DIVISOR = 5.48;
const MIN_ASK = Number(argOf('minAsk', '0.30'));

const GLOB = `lake/backtest_ticks/underlying=${UNDERLYING}/interval=5m/book_depth=25/dt=*/*.parquet`;
const feeOf = (p) => FEE * p * (1 - p);

const SQL = `
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
vol AS (
  SELECT *, stddev_pop(underlying_price) OVER (
      PARTITION BY condition_id ORDER BY tsec RANGE BETWEEN 90 PRECEDING AND CURRENT ROW
    ) AS sigma_level
  FROM raw
),
outcome AS (
  SELECT condition_id, arg_max(CASE WHEN underlying_price >= price_to_beat THEN 'UP' ELSE 'DOWN' END, tsec) AS winner
  FROM raw GROUP BY condition_id
),
tagged AS (
  SELECT v.*,
    CASE WHEN underlying_price >= price_to_beat THEN 'UP' ELSE 'DOWN' END AS fav,
    CASE WHEN underlying_price >= price_to_beat THEN up_best_ask ELSE down_best_ask END AS fav_ask,
    CASE WHEN underlying_price >= price_to_beat THEN up_best_bid ELSE down_best_bid END AS fav_bid,
    abs(underlying_price - price_to_beat) AS dist,
    up_best_ask + down_best_ask AS odds_sum
  FROM vol v
),
cand AS (
  SELECT t.*, o.winner,
    CASE WHEN t.sigma_level > 0 AND t.tau > 0
         THEN t.dist / ((t.sigma_level / ${SIGMA_DIVISOR}) * sqrt(t.tau)) ELSE 0 END AS z,
    row_number() OVER (PARTITION BY t.condition_id ORDER BY t.tsec ASC) AS rn
  FROM tagged t JOIN outcome o USING (condition_id)
  WHERE t.tau >= 9 AND t.tau < 30
    AND t.dist < 40
    AND t.fav_ask >= ${MIN_ASK} AND t.fav_ask <= 0.94
    AND (t.fav_ask - t.fav_bid) <= 0.03
    AND t.odds_sum >= 0.98 AND t.odds_sum <= 1.06
    AND t.coverage >= 0.9 AND t.degraded = false
)
SELECT dt, condition_id, tau, fav_ask, dist, z,
       CASE WHEN fav = winner THEN 1 ELSE 0 END AS won
FROM cand WHERE rn = 1 ORDER BY dt
`;

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
  const avgAsk = sel.reduce((a, r) => a + r.fav_ask, 0) / n;
  const fee = feeOf(avgAsk);
  const beWr = (avgAsk + fee) / SETTLE;
  const evShare = wr * (SETTLE - avgAsk) - (1 - wr) * avgAsk - fee;
  const [lo, hi] = wilson(wins, n);
  // EV por trade com orçamento fixo de $1 (shares = 1/ask)
  const evPerDollarBudget = evShare / avgAsk;
  return {
    n, wr: wr * 100, avgAsk, beWr: beWr * 100,
    edgePp: (wr - beWr) * 100, edgeLo: (lo - beWr) * 100, edgeHi: (hi - beWr) * 100,
    ratio: (SETTLE - avgAsk - fee) / (avgAsk + fee),
    evShare, evPerRisk: (evShare / (avgAsk + fee)) * 100,
    evPerDollarBudget,
  };
}

function row(label, s) {
  if (!s) return null;
  return `| ${label} | ${s.n} | ${s.wr.toFixed(1)} | ${s.avgAsk.toFixed(3)} | ${s.edgePp >= 0 ? '+' : ''}${s.edgePp.toFixed(2)} | [${s.edgeLo.toFixed(2)}, ${s.edgeHi.toFixed(2)}] | ${s.ratio.toFixed(3)} | ${s.evPerRisk >= 0 ? '+' : ''}${s.evPerRisk.toFixed(2)} | ${s.evPerDollarBudget >= 0 ? '+' : ''}${s.evPerDollarBudget.toFixed(4)} |`;
}
const HEAD = '| Corte | n | WR% | ask méd | edge pp | IC95 pp | razão G/P | EV/$ risco % | EV/$ orçado |';
const SEP = '|---|--:|--:|--:|--:|--:|--:|--:|--:|';

const splitOf = (dt) => (dt < '2026-06-01' ? 'train' : dt <= '2026-06-30' ? 'june' : 'july');

(async () => {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  process.stderr.write(`consultando ${UNDERLYING} ${FROM}..${TO} (banda barata, minAsk ${MIN_ASK})\n`);
  const rows = (await conn.runAndReadAll(SQL)).getRowObjects().map((r) => ({
    dt: String(r.dt), tau: Number(r.tau), fav_ask: Number(r.fav_ask),
    dist: Number(r.dist), z: Number(r.z), won: Number(r.won),
  }));
  process.stderr.write(`entradas: ${rows.length}\n`);

  const P = [];
  P.push(`# MIDAS — perfil da banda barata (${UNDERLYING})`);
  P.push('');
  P.push(`Janela ${FROM}..${TO} · settlement ${SETTLE} · fee 0.07·p·(1−p) · uma entrada por evento.`);
  P.push(`Envelope: tau∈[9,30) · dist<40 · spread≤0.03 · oddsSum∈[0.98,1.06] · ask∈[${MIN_ASK},0.94].`);
  P.push('');
  P.push('`EV/$ orçado` = lucro esperado por dólar de orçamento por entrada — é a métrica de alocação correta com orçamento fixo por evento.');

  // 1. bandas finas de ask
  P.push('\n## 1. Edge por banda fina de ask\n');
  P.push(HEAD); P.push(SEP);
  const fine = [];
  for (let lo = MIN_ASK; lo < 0.94; lo += 0.04) {
    const hi = Math.min(lo + 0.04, 0.9401);
    fine.push({ label: `[${lo.toFixed(2)},${hi.toFixed(2)})`, lo, hi });
  }
  for (const b of fine) {
    const r = row(b.label, stats(rows.filter((x) => x.fav_ask >= b.lo && x.fav_ask < b.hi)));
    if (r) P.push(r);
  }

  // 2. estabilidade por split na banda barata
  P.push('\n## 2. Estabilidade temporal — ask < 0.70 vs ask >= 0.82\n');
  P.push(HEAD); P.push(SEP);
  for (const k of ['train', 'june', 'july']) {
    const sub = rows.filter((r) => splitOf(r.dt) === k);
    const r1 = row(`${k} · ask<0.70`, stats(sub.filter((x) => x.fav_ask < 0.70)));
    const r2 = row(`${k} · ask>=0.82`, stats(sub.filter((x) => x.fav_ask >= 0.82)));
    if (r1) P.push(r1);
    if (r2) P.push(r2);
  }

  // 3. dentro da banda barata: cortes de z, dist, tau
  const cheap = rows.filter((r) => r.fav_ask < 0.70);
  P.push(`\n## 3. Dentro da banda barata (ask < 0.70, n=${cheap.length}) — onde o edge se concentra\n`);
  P.push(HEAD); P.push(SEP);
  for (const zb of [[0, 0.5], [0.5, 1], [1, 1.5], [1.5, 2.5], [2.5, 99]]) {
    const r = row(`z ∈ [${zb[0]},${zb[1]})`, stats(cheap.filter((x) => x.z >= zb[0] && x.z < zb[1])));
    if (r) P.push(r);
  }
  P.push('| | | | | | | | | |');
  for (const db of [[0, 5], [5, 10], [10, 20], [20, 40]]) {
    const r = row(`dist ∈ [${db[0]},${db[1]})`, stats(cheap.filter((x) => x.dist >= db[0] && x.dist < db[1])));
    if (r) P.push(r);
  }
  P.push('| | | | | | | | | |');
  for (const tb of [[9, 15], [15, 22], [22, 30]]) {
    const r = row(`tau ∈ [${tb[0]},${tb[1]})`, stats(cheap.filter((x) => x.tau >= tb[0] && x.tau < tb[1])));
    if (r) P.push(r);
  }

  // 4. contribuição de EV: quem paga a conta
  P.push('\n## 4. Contribuição de EV com orçamento fixo por entrada\n');
  const groups = [
    { label: `ask ∈ [${MIN_ASK},0.55)`, f: (r) => r.fav_ask < 0.55 },
    { label: 'ask ∈ [0.55,0.70)', f: (r) => r.fav_ask >= 0.55 && r.fav_ask < 0.70 },
    { label: 'ask ∈ [0.70,0.82)', f: (r) => r.fav_ask >= 0.70 && r.fav_ask < 0.82 },
    { label: 'ask ∈ [0.82,0.94]', f: (r) => r.fav_ask >= 0.82 },
  ];
  const contrib = groups.map((g) => {
    const sel = rows.filter(g.f);
    const s = stats(sel);
    return { label: g.label, n: sel.length, ev: s ? s.evPerDollarBudget * sel.length : 0, s };
  });
  const totalEv = contrib.reduce((a, c) => a + c.ev, 0);
  P.push('| Grupo | trades | % dos trades | EV total (por $1 de orçamento) | % do EV | razão G/P |');
  P.push('|---|--:|--:|--:|--:|--:|');
  for (const c of contrib) {
    P.push(`| ${c.label} | ${c.n} | ${(100 * c.n / rows.length).toFixed(1)} | ${c.ev.toFixed(1)} | ${(100 * c.ev / totalEv).toFixed(1)} | ${c.s ? c.s.ratio.toFixed(3) : '—'} |`);
  }

  const md = P.join('\n');
  console.log(md);
  fs.writeFileSync(`labs/sandbox/midas-cheap-band-${UNDERLYING.toLowerCase()}.md`, md);
})().catch((e) => { console.error('ERRO:', e.message, e.stack); process.exit(1); });
