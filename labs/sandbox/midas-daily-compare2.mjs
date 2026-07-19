import fs from 'node:fs';
const reportDir = process.argv[2];
const idA = process.argv[3];
const idB = process.argv[4];
const results = JSON.parse(fs.readFileSync(`${reportDir}/results.json`, 'utf8'));
const list = results.variants || results.results || results.topResults || results;
const byId = new Map(list.map((r) => [r.id, r]));
const a = byId.get(idA);
const b = byId.get(idB);
if (!a || !b) {
  console.log('ids disponiveis:', [...byId.keys()]);
  process.exit(1);
}
const bDaily = new Map((b.daily || []).map((d) => [d.dt, d]));
const deltas = [];
let sum = 0;
for (const d of a.daily || []) {
  const bd = bDaily.get(d.dt) || { totalPnl: 0, entries: 0 };
  const delta = d.totalPnl - bd.totalPnl;
  sum += delta;
  deltas.push({ dt: d.dt, delta, a: d.totalPnl, b: bd.totalPnl, ae: d.entries, be: bd.entries });
}
deltas.sort((x, y) => x.delta - y.delta);
console.log(`== ${idA} vs ${idB} ==`);
console.log('piores 6:');
for (const d of deltas.slice(0, 6)) console.log(`  ${d.dt} delta=${d.delta.toFixed(1)} (${d.a.toFixed(1)} vs ${d.b.toFixed(1)}) entries ${d.ae}/${d.be}`);
console.log('melhores 6:');
for (const d of deltas.slice(-6).reverse()) console.log(`  ${d.dt} delta=${d.delta.toFixed(1)} (${d.a.toFixed(1)} vs ${d.b.toFixed(1)}) entries ${d.ae}/${d.be}`);
const pos = deltas.filter((d) => d.delta > 0).length;
console.log(`delta total=${sum.toFixed(1)} | dias delta>0: ${pos}/${deltas.length}`);
const top3 = deltas.slice(-3).reduce((s, d) => s + d.delta, 0);
console.log(`top-3 dias = ${top3.toFixed(1)} (${(100 * top3 / sum).toFixed(0)}% do delta)`);
