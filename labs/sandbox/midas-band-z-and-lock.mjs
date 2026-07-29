/**
 * MIDAS — duas perguntas em uma passada:
 *
 * (A) O gate `tierMinZ 2.0` do preset Gold resgata a banda de favorito caro?
 *     Mede o edge (WR − WR breakeven) por banda COM e SEM o gate de z.
 *
 * (B) Existe o "complete-set lock"? Depois de entrar comprado no favorito,
 *     comprar o lado OPOSTO no ask trava um resultado garantido:
 *        lockPnl/share = SETTLE − askEntrada − askOposto − feeEntrada − feeOposto
 *     Se lockPnl > 0, o evento vira lucro certo e o pior caso do evento vai a
 *     zero (libera orçamento de risco no ledger R_event).
 *     Testa uma política CAUSAL: travar no primeiro tick em que lockPnl >= X.
 *     Compara com segurar até o settlement e com vender o próprio no bid.
 *
 * z = dist / (sigma_ps * sqrt(tau)), sigma_ps = stddev_pop(underlying, 90s) / 5.48
 * (idêntico a signals.volatility + sigmaDivisor do GLS).
 *
 * Uso: node --max-old-space-size=8192 labs/sandbox/midas-band-z-and-lock.mjs
 */
import fs from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const UNDERLYING = argOf('underlying', 'BTC');
const FROM = argOf('from', '2026-05-04');
const TO = argOf('to', '2026-07-26');
const SETTLE = Number(argOf('settle', '0.995'));
const FEE = 0.07;
const SIGMA_DIVISOR = 5.48;
// piso de tempo para conseguir executar a segunda perna
const LOCK_MIN_TAU = Number(argOf('lockMinTau', '4'));

const GLOB = `lake/backtest_ticks/underlying=${UNDERLYING}/interval=5m/book_depth=25/dt=*/*.parquet`;
const feeOf = (p) => FEE * p * (1 - p);

// Uma linha por ENTRADA (primeiro tick que passa o envelope), já com z,
// e com as estatísticas do caminho pós-entrada para a política de lock.
const SQL = `
WITH raw AS (
  SELECT
    condition_id, dt,
    epoch(CAST(event_end AS TIMESTAMP)) - epoch(CAST(ts AS TIMESTAMP)) AS tau,
    epoch(CAST(ts AS TIMESTAMP)) AS tsec,
    underlying_price, price_to_beat,
    up_best_bid, up_best_ask, down_best_bid, down_best_ask,
    up_ask_sz_1, down_ask_sz_1,
    coverage, degraded
  FROM read_parquet('${GLOB}', hive_partitioning = true)
  WHERE dt >= '${FROM}' AND dt <= '${TO}'
    AND underlying_price IS NOT NULL AND price_to_beat IS NOT NULL
    AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
    AND up_best_bid IS NOT NULL AND down_best_bid IS NOT NULL
),
vol AS (
  SELECT *,
    -- sigma de níveis em janela de 90s (mesmo estimador do GLS: stddev populacional)
    stddev_pop(underlying_price) OVER (
      PARTITION BY condition_id ORDER BY tsec
      RANGE BETWEEN 90 PRECEDING AND CURRENT ROW
    ) AS sigma_level
  FROM raw
),
outcome AS (
  SELECT condition_id,
         arg_max(CASE WHEN underlying_price >= price_to_beat THEN 'UP' ELSE 'DOWN' END, tsec) AS winner
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
         THEN t.dist / ((t.sigma_level / ${SIGMA_DIVISOR}) * sqrt(t.tau))
         ELSE 0 END AS z,
    row_number() OVER (PARTITION BY t.condition_id ORDER BY t.tsec ASC) AS rn
  FROM tagged t
  JOIN outcome o USING (condition_id)
  WHERE t.tau >= 9 AND t.tau < 30
    AND t.dist < 40
    AND t.fav_ask >= 0.55 AND t.fav_ask <= 0.94
    AND (t.fav_ask - t.fav_bid) <= 0.03
    AND t.odds_sum >= 0.98 AND t.odds_sum <= 1.06
    AND t.coverage >= 0.9 AND t.degraded = false
),
entry AS (
  SELECT condition_id, dt, tsec AS entry_tsec, tau AS entry_tau, fav, fav_ask, fav_bid, dist, z, winner,
         CASE WHEN fav = winner THEN 1 ELSE 0 END AS won
  FROM cand WHERE rn = 1
),
-- caminho pós-entrada: para cada tick depois da entrada, o valor do lock
-- (comprar o lado oposto no ask) e o valor de vender o próprio no bid.
path AS (
  SELECT e.condition_id,
         t.tsec, t.tau,
         CASE WHEN e.fav = 'UP' THEN t.down_best_ask ELSE t.up_best_ask END AS opp_ask,
         CASE WHEN e.fav = 'UP' THEN t.down_ask_sz_1 ELSE t.up_ask_sz_1 END AS opp_ask_sz,
         CASE WHEN e.fav = 'UP' THEN t.up_best_bid  ELSE t.down_best_bid END AS own_bid
  FROM entry e
  JOIN tagged t USING (condition_id)
  WHERE t.tsec > e.entry_tsec AND t.tau >= ${LOCK_MIN_TAU}
),
pathval AS (
  SELECT p.*, e.fav_ask,
    -- lucro travado por share, líquido das duas fees taker
    ${SETTLE} - e.fav_ask - p.opp_ask
      - ${FEE} * e.fav_ask * (1 - e.fav_ask)
      - ${FEE} * p.opp_ask * (1 - p.opp_ask) AS lock_pnl,
    -- vender o próprio no bid, líquido das duas fees taker
    p.own_bid - e.fav_ask
      - ${FEE} * e.fav_ask * (1 - e.fav_ask)
      - ${FEE} * p.own_bid * (1 - p.own_bid) AS sell_pnl
  FROM path p JOIN entry e USING (condition_id)
)
SELECT e.*,
  pv.max_lock, pv.max_sell,
  pv.lock_at_000, pv.lock_at_010, pv.lock_at_020, pv.lock_at_030, pv.lock_at_050,
  pv.sell_at_020, pv.sell_at_050,
  pv.min_opp_ask, pv.n_path
FROM entry e
LEFT JOIN (
  SELECT condition_id,
    max(lock_pnl) AS max_lock,
    max(sell_pnl) AS max_sell,
    min(opp_ask)  AS min_opp_ask,
    count(*)      AS n_path,
    -- política causal: valor do lock no PRIMEIRO tick que cruza o limiar
    arg_min(lock_pnl, tsec) FILTER (WHERE lock_pnl >= 0.000 AND opp_ask_sz >= 5) AS lock_at_000,
    arg_min(lock_pnl, tsec) FILTER (WHERE lock_pnl >= 0.010 AND opp_ask_sz >= 5) AS lock_at_010,
    arg_min(lock_pnl, tsec) FILTER (WHERE lock_pnl >= 0.020 AND opp_ask_sz >= 5) AS lock_at_020,
    arg_min(lock_pnl, tsec) FILTER (WHERE lock_pnl >= 0.030 AND opp_ask_sz >= 5) AS lock_at_030,
    arg_min(lock_pnl, tsec) FILTER (WHERE lock_pnl >= 0.050 AND opp_ask_sz >= 5) AS lock_at_050,
    arg_min(sell_pnl, tsec) FILTER (WHERE sell_pnl >= 0.020) AS sell_at_020,
    arg_min(sell_pnl, tsec) FILTER (WHERE sell_pnl >= 0.050) AS sell_at_050
  FROM pathval GROUP BY condition_id
) pv USING (condition_id)
ORDER BY e.dt, e.condition_id
`;

const BANDS = [
  { label: '[0.55,0.62)', lo: 0.55, hi: 0.62 },
  { label: '[0.62,0.70)', lo: 0.62, hi: 0.70 },
  { label: '[0.70,0.78)', lo: 0.70, hi: 0.78 },
  { label: '[0.78,0.82)', lo: 0.78, hi: 0.82 },
  { label: '[0.82,0.86)', lo: 0.82, hi: 0.86 },
  { label: '[0.86,0.90)', lo: 0.86, hi: 0.90 },
  { label: '[0.90,0.94]', lo: 0.90, hi: 0.9401 },
];

function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - s) / d, (c + s) / d];
}

function bandStats(sel) {
  const n = sel.length;
  if (!n) return null;
  const wins = sel.reduce((a, r) => a + r.won, 0);
  const wr = wins / n;
  const avgAsk = sel.reduce((a, r) => a + r.fav_ask, 0) / n;
  const fee = feeOf(avgAsk);
  const beWr = (avgAsk + fee) / SETTLE;
  const evShare = wr * (SETTLE - avgAsk) - (1 - wr) * avgAsk - fee;
  const [lo, hi] = wilson(wins, n);
  return {
    n, wr: wr * 100, avgAsk, beWr: beWr * 100,
    edgePp: (wr - beWr) * 100,
    edgeLo: (lo - beWr) * 100,
    edgeHi: (hi - beWr) * 100,
    ratio: (SETTLE - avgAsk - fee) / (avgAsk + fee),
    evShare,
    evPerRisk: (evShare / (avgAsk + fee)) * 100,
  };
}

function tableByBand(rows, title) {
  const out = [`\n### ${title} — n=${rows.length}\n`];
  out.push('| Banda | n | WR% | ask méd | breakeven% | edge pp | IC95 pp | razão G/P | EV/$ risco % |');
  out.push('|---|--:|--:|--:|--:|--:|--:|--:|--:|');
  for (const b of BANDS) {
    const s = bandStats(rows.filter((r) => r.fav_ask >= b.lo && r.fav_ask < b.hi));
    if (!s) continue;
    out.push(`| ${b.label} | ${s.n} | ${s.wr.toFixed(1)} | ${s.avgAsk.toFixed(3)} | ${s.beWr.toFixed(1)} | ${s.edgePp >= 0 ? '+' : ''}${s.edgePp.toFixed(2)} | [${s.edgeLo.toFixed(2)}, ${s.edgeHi.toFixed(2)}] | ${s.ratio.toFixed(3)} | ${s.evPerRisk >= 0 ? '+' : ''}${s.evPerRisk.toFixed(2)} |`);
  }
  return out.join('\n');
}

(async () => {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  process.stderr.write(`consultando ${UNDERLYING} ${FROM}..${TO} (z + lock)\n`);
  const reader = await conn.runAndReadAll(SQL);
  const rows = reader.getRowObjects().map((r) => ({
    dt: String(r.dt),
    fav_ask: Number(r.fav_ask),
    z: Number(r.z),
    dist: Number(r.dist),
    won: Number(r.won),
    max_lock: r.max_lock == null ? null : Number(r.max_lock),
    max_sell: r.max_sell == null ? null : Number(r.max_sell),
    min_opp_ask: r.min_opp_ask == null ? null : Number(r.min_opp_ask),
    n_path: r.n_path == null ? 0 : Number(r.n_path),
    lock: {
      0.0: r.lock_at_000 == null ? null : Number(r.lock_at_000),
      0.01: r.lock_at_010 == null ? null : Number(r.lock_at_010),
      0.02: r.lock_at_020 == null ? null : Number(r.lock_at_020),
      0.03: r.lock_at_030 == null ? null : Number(r.lock_at_030),
      0.05: r.lock_at_050 == null ? null : Number(r.lock_at_050),
    },
    sell: {
      0.02: r.sell_at_020 == null ? null : Number(r.sell_at_020),
      0.05: r.sell_at_050 == null ? null : Number(r.sell_at_050),
    },
  }));
  process.stderr.write(`entradas: ${rows.length}\n`);

  const parts = [];
  parts.push(`# MIDAS — gate de z na banda cara + complete-set lock (${UNDERLYING})`);
  parts.push('');
  parts.push(`Janela ${FROM}..${TO} · settlement ${SETTLE} · fee taker 0.07·p·(1−p)`);
  parts.push(`Uma entrada por evento · lock exige tau >= ${LOCK_MIN_TAU}s e tamanho >= 5 no topo do book oposto.`);

  // ---------- (A) o gate de z resgata a banda cara? ----------
  parts.push('\n## A. O `tierMinZ` resgata a banda de favorito caro?\n');
  parts.push(tableByBand(rows, 'SEM gate de z (envelope puro)'));
  const zGated = rows.filter((r) => !(r.fav_ask >= 0.82 && r.z < 2.0));
  parts.push(tableByBand(zGated, 'COM tierMinZ 2.0 (gate do preset Gold)'));

  // quanto o gate corta
  const highAll = rows.filter((r) => r.fav_ask >= 0.82).length;
  const highKept = zGated.filter((r) => r.fav_ask >= 0.82).length;
  parts.push(`\nO gate cortou ${highAll - highKept} de ${highAll} entradas caras (${(100 * (1 - highKept / highAll)).toFixed(1)}%).`);

  // ---------- (B) complete-set lock ----------
  parts.push('\n## B. Complete-set lock — comprar o lado oposto trava lucro?\n');
  const withPath = rows.filter((r) => r.n_path > 0);
  parts.push(`Eventos com caminho pós-entrada observável: ${withPath.length} de ${rows.length}.\n`);

  parts.push('| Limiar X (lucro travado/share) | eventos que cruzam | % | lucro travado médio/share | vs segurar (EV/share) |');
  parts.push('|---|--:|--:|--:|--:|');
  for (const X of [0.0, 0.01, 0.02, 0.03, 0.05]) {
    const hit = withPath.filter((r) => r.lock[X] != null);
    const avg = hit.length ? hit.reduce((a, r) => a + r.lock[X], 0) / hit.length : 0;
    // contrafactual: nesses MESMOS eventos, quanto rende segurar até o fim
    const holdEv = hit.length
      ? hit.reduce((a, r) => a + (r.won ? SETTLE - r.fav_ask : -r.fav_ask) - feeOf(r.fav_ask), 0) / hit.length
      : 0;
    parts.push(`| >= ${X.toFixed(3)} | ${hit.length} | ${(100 * hit.length / withPath.length).toFixed(1)} | ${avg >= 0 ? '+' : ''}${avg.toFixed(4)} | ${holdEv >= 0 ? '+' : ''}${holdEv.toFixed(4)} |`);
  }

  // melhor lock alcançável (COM look-ahead — apenas diagnóstico do teto)
  const maxLockPos = withPath.filter((r) => r.max_lock != null && r.max_lock > 0);
  parts.push(`\nDiagnóstico com look-ahead (teto inatingível, só para dimensionar): em ${maxLockPos.length} de ${withPath.length} eventos (${(100 * maxLockPos.length / withPath.length).toFixed(1)}%) existiu ALGUM instante com lock positivo; lucro travável médio no melhor instante ${(maxLockPos.reduce((a, r) => a + r.max_lock, 0) / Math.max(1, maxLockPos.length)).toFixed(4)}/share.`);

  // sell own comparison
  parts.push('\n### Comparação: vender o próprio no bid (mesma população)\n');
  parts.push('| Limiar X | eventos que cruzam | % | lucro médio/share | vs segurar |');
  parts.push('|---|--:|--:|--:|--:|');
  for (const X of [0.02, 0.05]) {
    const hit = withPath.filter((r) => r.sell[X] != null);
    const avg = hit.length ? hit.reduce((a, r) => a + r.sell[X], 0) / hit.length : 0;
    const holdEv = hit.length
      ? hit.reduce((a, r) => a + (r.won ? SETTLE - r.fav_ask : -r.fav_ask) - feeOf(r.fav_ask), 0) / hit.length
      : 0;
    parts.push(`| >= ${X.toFixed(3)} | ${hit.length} | ${(100 * hit.length / withPath.length).toFixed(1)} | ${avg >= 0 ? '+' : ''}${avg.toFixed(4)} | ${holdEv >= 0 ? '+' : ''}${holdEv.toFixed(4)} |`);
  }

  const md = parts.join('\n');
  console.log(md);
  fs.writeFileSync(`labs/sandbox/midas-band-z-lock-${UNDERLYING.toLowerCase()}.md`, md);
})().catch((e) => { console.error('ERRO:', e.message, e.stack); process.exit(1); });
