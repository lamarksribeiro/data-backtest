/**
 * MIDAS — economia honesta por banda de ask.
 *
 * Pergunta central: o "edge" (WR real menos WR de breakeven) é constante em
 * pontos percentuais ao longo das bandas de ask? Se for, a banda barata entrega
 * o MESMO retorno por dólar arriscado com uma razão ganho/perda muito melhor —
 * e o tier de favorito caro é cauda sem remuneração.
 *
 * População = envelope MIDAS Gold (sem o gate de z, medido à parte):
 *   tau in [9,30) · dist < 40 · ask in [0.55,0.94] · spread <= 0.03
 *   oddsSum in [0.98,1.06] · coverage >= 0.9 · not degraded
 * Uma entrada por evento (primeiro tick que passa, em ordem cronológica).
 *
 * Uso: node labs/sandbox/midas-band-edge-economics.mjs [--underlying BTC] [--from D] [--to D]
 */
import { DuckDBInstance } from '@duckdb/node-api';

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const UNDERLYING = argOf('underlying', 'BTC');
const FROM = argOf('from', '2026-05-04');
const TO = argOf('to', '2026-07-26');
const SETTLE = Number(argOf('settle', '0.995'));
const FEE_RATE = 0.07;

const GLOB = `lake/backtest_ticks/underlying=${UNDERLYING}/interval=5m/book_depth=25/dt=*/*.parquet`;

// fee taker por share = 0.07 * p * (1-p)
const feeOf = (p) => FEE_RATE * p * (1 - p);

const SQL = `
WITH raw AS (
  SELECT
    condition_id,
    dt,
    epoch(CAST(event_end AS TIMESTAMP)) - epoch(CAST(ts AS TIMESTAMP)) AS tau,
    CAST(ts AS TIMESTAMP) AS tsx,
    underlying_price,
    price_to_beat,
    up_best_bid, up_best_ask, down_best_bid, down_best_ask,
    coverage, degraded
  FROM read_parquet('${GLOB}', hive_partitioning = true)
  WHERE dt >= '${FROM}' AND dt <= '${TO}'
    AND underlying_price IS NOT NULL AND price_to_beat IS NOT NULL
    AND up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
    AND up_best_bid IS NOT NULL AND down_best_bid IS NOT NULL
),
-- desfecho canônico do evento: último tick observado (regra UP se >=)
outcome AS (
  SELECT condition_id,
         arg_max(CASE WHEN underlying_price >= price_to_beat THEN 'UP' ELSE 'DOWN' END, tsx) AS winner
  FROM raw
  GROUP BY condition_id
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
    row_number() OVER (PARTITION BY t.condition_id ORDER BY t.tsx ASC) AS rn
  FROM tagged t
  JOIN outcome o USING (condition_id)
  WHERE t.tau >= 9 AND t.tau < 30
    AND t.dist < 40
    AND t.fav_ask >= 0.55 AND t.fav_ask <= 0.94
    AND (t.fav_ask - t.fav_bid) <= 0.03
    AND t.odds_sum >= 0.98 AND t.odds_sum <= 1.06
    AND t.coverage >= 0.9 AND t.degraded = false
)
SELECT dt, condition_id, tau, fav, fav_ask, fav_bid, dist, odds_sum, winner,
       CASE WHEN fav = winner THEN 1 ELSE 0 END AS won
FROM cand
WHERE rn = 1
ORDER BY dt, condition_id
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

function splitOf(dt) {
  if (dt < '2026-06-01') return 'train';
  if (dt <= '2026-06-30') return 'june';
  return 'july';
}

// Wilson score interval para a taxa de acerto
function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - s) / d, (c + s) / d];
}

function summarize(rows, label) {
  const out = [];
  for (const band of BANDS) {
    const sel = rows.filter((r) => r.fav_ask >= band.lo && r.fav_ask < band.hi);
    if (sel.length === 0) continue;
    const n = sel.length;
    const wins = sel.reduce((a, r) => a + r.won, 0);
    const wr = wins / n;
    const avgAsk = sel.reduce((a, r) => a + r.fav_ask, 0) / n;

    // Economia por share, com haircut de settlement e fee taker na entrada.
    // ganho se vencer = SETTLE - ask ; perda se perder = ask ; fee sempre paga.
    const fee = feeOf(avgAsk);
    const winPerShare = SETTLE - avgAsk - fee;
    const lossPerShare = avgAsk + fee;
    const evPerShare = wr * (SETTLE - avgAsk) - (1 - wr) * avgAsk - fee;
    // WR de breakeven inclui a fee
    const beWr = (avgAsk + fee) / SETTLE;
    const edgePp = (wr - beWr) * 100;
    const evPerRisk = evPerShare / lossPerShare; // retorno por dólar em risco
    const [lo, hi] = wilson(wins, n);
    const edgeLoPp = (lo - beWr) * 100;
    const edgeHiPp = (hi - beWr) * 100;

    out.push({
      band: band.label,
      n,
      wr: wr * 100,
      avgAsk,
      beWr: beWr * 100,
      edgePp,
      edgeLoPp,
      edgeHiPp,
      winPerShare,
      lossPerShare,
      ratio: winPerShare / lossPerShare,
      evPerShare,
      evPerRisk: evPerRisk * 100,
    });
  }
  return { label, rows: out };
}

function renderTable(summary) {
  const lines = [];
  lines.push(`\n### ${summary.label}\n`);
  lines.push('| Banda | n | WR% | ask méd | WR breakeven% | edge pp | edge IC95 pp | ganho/share | perda/share | razão G/P | EV/share | EV por $ risco % |');
  lines.push('|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
  for (const r of summary.rows) {
    lines.push(`| ${r.band} | ${r.n} | ${r.wr.toFixed(1)} | ${r.avgAsk.toFixed(3)} | ${r.beWr.toFixed(1)} | ${r.edgePp >= 0 ? '+' : ''}${r.edgePp.toFixed(2)} | [${r.edgeLoPp.toFixed(2)}, ${r.edgeHiPp.toFixed(2)}] | ${r.winPerShare.toFixed(4)} | ${r.lossPerShare.toFixed(4)} | ${r.ratio.toFixed(3)} | ${r.evPerShare >= 0 ? '+' : ''}${r.evPerShare.toFixed(4)} | ${r.evPerRisk >= 0 ? '+' : ''}${r.evPerRisk.toFixed(2)} |`);
  }
  return lines.join('\n');
}

(async () => {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  process.stderr.write(`consultando ${UNDERLYING} ${FROM}..${TO}\n`);
  const reader = await conn.runAndReadAll(SQL);
  const rows = reader.getRowObjects().map((r) => ({
    dt: String(r.dt),
    tau: Number(r.tau),
    fav_ask: Number(r.fav_ask),
    fav_bid: Number(r.fav_bid),
    dist: Number(r.dist),
    won: Number(r.won),
  }));
  process.stderr.write(`entradas: ${rows.length}\n`);

  const splits = { train: [], june: [], july: [] };
  for (const r of rows) splits[splitOf(r.dt)].push(r);

  const parts = [];
  parts.push(`# MIDAS — economia honesta por banda de ask (${UNDERLYING})`);
  parts.push('');
  parts.push(`Janela ${FROM}..${TO} · settlement ${SETTLE} · fee taker 0.07·p·(1−p) · uma entrada por evento.`);
  parts.push('População: envelope Gold sem o gate `tierMinZ` (medido à parte).');
  parts.push('');
  parts.push('`edge pp` = WR observada − WR de breakeven. É a métrica que decide alocação:');
  parts.push('se o edge em pp for parecido entre bandas, a banda barata entrega o mesmo');
  parts.push('retorno por dólar arriscado com razão ganho/perda muito melhor.');

  parts.push(renderTable(summarize(rows, `TOTAL (${rows.length} entradas)`)));
  for (const k of ['train', 'june', 'july']) {
    if (splits[k].length) parts.push(renderTable(summarize(splits[k], `${k} (${splits[k].length} entradas)`)));
  }

  const md = parts.join('\n');
  console.log(md);
  const fs = await import('node:fs');
  fs.writeFileSync(`labs/sandbox/midas-band-edge-${UNDERLYING.toLowerCase()}.md`, md);
  fs.writeFileSync(
    `labs/sandbox/midas-band-edge-${UNDERLYING.toLowerCase()}.json`,
    JSON.stringify({ underlying: UNDERLYING, from: FROM, to: TO, settle: SETTLE, total: summarize(rows, 'total'), train: summarize(splits.train, 'train'), june: summarize(splits.june, 'june'), july: summarize(splits.july, 'july') }, null, 2),
  );
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
