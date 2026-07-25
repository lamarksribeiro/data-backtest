// Sonda 2 (auditoria Escada Dupla 2026-07-25): gap entre o preço do nível SUB
// e o ask real no momento do cruzamento (tick-a-tick, ambos os lados).
// Se o gap for grande, os modos formula/capped compram a preços que não existem.
// Rodar da raiz do repo: node --max-old-space-size=8192 scratch/escada-dupla-gap-probe.js
const { DuckDBInstance } = require('@duckdb/node-api');

const GLOB = 'lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-07-1*/*.parquet';
const LEVELS = [55, 60, 65, 70, 75, 80, 85, 90].map((c) => c / 100);

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

(async () => {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  const sql = `
    SELECT condition_id, event_start, ts, up_best_ask, down_best_ask
    FROM read_parquet('${GLOB}')
    WHERE up_best_ask IS NOT NULL AND down_best_ask IS NOT NULL
    ORDER BY condition_id, event_start, ts
  `;
  const r = await conn.run(sql);
  const rows = await r.getRowObjects();
  console.log('ticks:', rows.length);

  const gaps = [];
  const gapsByLevel = new Map();
  let prevKey = null;
  let prev = null;
  let crossings = 0;

  for (const row of rows) {
    const key = `${row.event_start}|${row.condition_id}`;
    for (const side of ['up', 'down']) {
      const ask = Number(row[`${side}_best_ask`]);
      if (prevKey === key && prev) {
        const prevAsk = Number(prev[`${side}_best_ask`]);
        for (const L of LEVELS) {
          if (prevAsk < L && ask >= L) {
            crossings += 1;
            const gapC = (ask - L) * 100;
            gaps.push(gapC);
            const lc = Math.round(L * 100);
            if (!gapsByLevel.has(lc)) gapsByLevel.set(lc, []);
            gapsByLevel.get(lc).push(gapC);
          }
        }
      }
    }
    prevKey = key;
    prev = row;
  }

  console.log('cruzamentos SUB detectados:', crossings);
  console.log(`gap no cruzamento (¢ acima do nível): p50=${pct(gaps, 0.5)?.toFixed(2)} p75=${pct(gaps, 0.75)?.toFixed(2)} p90=${pct(gaps, 0.9)?.toFixed(2)} p99=${pct(gaps, 0.99)?.toFixed(2)} media=${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2)}`);
  const fr = (t) => (gaps.filter((g) => g > t).length / gaps.length * 100).toFixed(1);
  console.log(`% cruzamentos com gap > 1¢: ${fr(1)}% | > 2¢: ${fr(2)}% | > 5¢: ${fr(5)}%`);
  for (const [lc, arr] of [...gapsByLevel.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  nível ${lc}¢: n=${arr.length} gap p50=${pct(arr, 0.5).toFixed(2)} p90=${pct(arr, 0.9).toFixed(2)} media=${(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
