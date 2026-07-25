// Sonda 1 (auditoria Escada Dupla 2026-07-25): profundidade real do book
// nos pontos onde a escada compra (ask 50–92¢).
// Pergunta: comprar 20–30 shares a mercado custa quanto acima do best ask?
// Rodar da raiz do repo: node scratch/escada-dupla-book-depth-probe.js
const { DuckDBInstance } = require('@duckdb/node-api');

const GLOB = 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-07-*/*.parquet';

function walkCost(levels, qty) {
  let rest = qty, cost = 0, last = levels[0]?.px;
  for (const { px, sz } of levels) {
    if (rest <= 1e-9) break;
    last = px;
    const take = Math.min(rest, sz);
    cost += take * px;
    rest -= take;
  }
  if (rest > 1e-9) cost += rest * last;
  return cost / qty;
}

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

(async () => {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  const cols = [];
  for (let i = 1; i <= 25; i++) cols.push(`up_ask_px_${i}`, `up_ask_sz_${i}`);
  const sql = `
    SELECT up_best_ask, up_best_bid, ${cols.join(',')}
    FROM read_parquet('${GLOB}')
    WHERE up_best_ask BETWEEN 0.50 AND 0.92
      AND up_best_bid IS NOT NULL
    USING SAMPLE 60000 ROWS
  `;
  const r = await conn.run(sql);
  const rows = await r.getRowObjects();
  console.log('amostra:', rows.length);

  const spreadC = [], topSz = [], slip20 = [], slip30 = [], within1c = [];
  for (const row of rows) {
    const best = Number(row.up_best_ask);
    const bid = Number(row.up_best_bid);
    const levels = [];
    for (let i = 1; i <= 25; i++) {
      const px = Number(row[`up_ask_px_${i}`]);
      const sz = Number(row[`up_ask_sz_${i}`]);
      if (Number.isFinite(px) && Number.isFinite(sz) && px > 0 && sz > 0) levels.push({ px, sz });
    }
    if (!levels.length) continue;
    levels.sort((a, b) => a.px - b.px);
    spreadC.push((best - bid) * 100);
    topSz.push(levels[0].sz);
    slip20.push((walkCost(levels, 20) - best) * 100);
    slip30.push((walkCost(levels, 30) - best) * 100);
    let cum = 0;
    for (const { px, sz } of levels) if (px <= best + 0.01 + 1e-9) cum += sz;
    within1c.push(cum);
  }

  const stats = (name, arr, unit) => {
    console.log(`${name}: p10=${pct(arr, 0.1)?.toFixed(2)} p50=${pct(arr, 0.5)?.toFixed(2)} p90=${pct(arr, 0.9)?.toFixed(2)} p99=${pct(arr, 0.99)?.toFixed(2)} ${unit}`);
  };
  stats('spread (¢)', spreadC, '¢');
  stats('tamanho do best ask (shares)', topSz, 'sh');
  stats('depth ate best+1¢ (shares)', within1c, 'sh');
  stats('slip medio p/ 20sh vs best (¢)', slip20, '¢');
  stats('slip medio p/ 30sh vs best (¢)', slip30, '¢');
  const frac20 = slip20.filter((x) => x <= 1).length / slip20.length;
  const frac30 = slip30.filter((x) => x <= 1).length / slip30.length;
  console.log(`fracao de ticks onde 20sh custam <= best+1¢: ${(frac20 * 100).toFixed(1)}%`);
  console.log(`fracao de ticks onde 30sh custam <= best+1¢: ${(frac30 * 100).toFixed(1)}%`);
})().catch((e) => { console.error(e); process.exit(1); });
