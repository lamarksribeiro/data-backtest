import fs from 'node:fs';
const reportDir = process.argv[2];
const results = JSON.parse(fs.readFileSync(`${reportDir}/results.json`, 'utf8'));
const list = results.variants || results.results || results.topResults || results;
const byId = new Map();
for (const r of list) byId.set(r.id, r);

const base = byId.get('parity-tfc-v7');
const scoop = byId.get('scoop-only');
if (!base || !scoop) {
  console.log('ids:', [...byId.keys()]);
  process.exit(1);
}
const baseDaily = new Map((base.daily || []).map((d) => [d.dt, d]));
console.log('dt | scoopPnl | basePnl | delta | scoopEntries | baseEntries');
let deltaSum = 0;
const deltas = [];
for (const d of scoop.daily || []) {
  const b = baseDaily.get(d.dt) || { totalPnl: 0, entries: 0 };
  const delta = d.totalPnl - b.totalPnl;
  deltaSum += delta;
  deltas.push({ dt: d.dt, delta, scoop: d.totalPnl, base: b.totalPnl, se: d.entries, be: b.entries });
}
deltas.sort((a, b) => a.delta - b.delta);
console.log('\n== piores 8 dias do delta (scoop vs base) ==');
for (const d of deltas.slice(0, 8)) console.log(`${d.dt} delta=${d.delta.toFixed(1)} scoop=${d.scoop.toFixed(1)} base=${d.base.toFixed(1)} entries ${d.se}/${d.be}`);
console.log('\n== melhores 8 dias ==');
for (const d of deltas.slice(-8).reverse()) console.log(`${d.dt} delta=${d.delta.toFixed(1)} scoop=${d.scoop.toFixed(1)} base=${d.base.toFixed(1)} entries ${d.se}/${d.be}`);
const pos = deltas.filter((d) => d.delta > 0).length;
console.log(`\ndelta total=${deltaSum.toFixed(1)} | dias delta>0: ${pos}/${deltas.length}`);
const top3 = deltas.slice(-3).reduce((s, d) => s + d.delta, 0);
console.log(`concentração: top-3 dias = ${top3.toFixed(1)} (${(100 * top3 / deltaSum).toFixed(0)}% do delta)`);
