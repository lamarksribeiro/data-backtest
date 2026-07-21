import fs from 'node:fs';

const data = JSON.parse(fs.readFileSync('scratch/robustness-compare.json', 'utf8'));

function pick(reportKey, ids) {
  const rows = data[reportKey]?.rows || [];
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId[id]).filter(Boolean);
}

const midasTrain = Object.keys(data).find((k) => k.includes('mitigations-train'));
const midasHold = Object.keys(data).find((k) => k.includes('mitigations-holdout'));
const midasJune = Object.keys(data).find((k) => k.includes('june-stress'));
const tfcTrain = Object.keys(data).find((k) => k.includes('reverse-ablation-train'));

const focus = [
  'champion',
  'dist-30',
  'dist-20',
  'exit-only',
  'reverse-050',
  'reverse-ask-085',
  'reverse-ask-080',
  'no-tier',
  'combo-robust',
  'hold-only',
  'velocity-5',
  'minask-065',
];

console.log('\n=== RISK-ADJUSTED SCOREBOARD (PnL / DD) ===\n');

function table(label, key, ids) {
  if (!key) return;
  const rows = pick(key, ids);
  const champ = rows.find((r) => r.id === 'champion' || r.id === 'v7-champion');
  console.log(`-- ${label} --`);
  console.log(
    'id'.padEnd(20),
    'pnl'.padStart(9),
    'dd'.padStart(7),
    'pnl/dd'.padStart(8),
    'PF'.padStart(5),
    '+days'.padStart(7),
    'Δpnl'.padStart(9),
    'Δdd'.padStart(8),
  );
  for (const r of rows) {
    const ratio = r.dd > 0 ? r.pnl / r.dd : 0;
    const dp = champ ? r.pnl - champ.pnl : 0;
    const dd = champ ? r.dd - champ.dd : 0;
    console.log(
      r.id.padEnd(20),
      r.pnl.toFixed(1).padStart(9),
      r.dd.toFixed(1).padStart(7),
      ratio.toFixed(2).padStart(8),
      r.pf.toFixed(2).padStart(5),
      `${r.profitableDays}/${r.days}`.padStart(7),
      ((dp >= 0 ? '+' : '') + dp.toFixed(1)).padStart(9),
      ((dd >= 0 ? '+' : '') + dd.toFixed(1)).padStart(8),
    );
  }
  console.log('');
}

table('MIDAS train', midasTrain, focus);
table('MIDAS holdout', midasHold, focus);
table('MIDAS june stress', midasJune, focus);
table('TFC train', tfcTrain, ['v7-champion', 'v7-exit-only', 'v7-hold-only', 'v7-reverse-ask-080']);

// Pareto: better DD and not much PnL loss
console.log('=== PARETO CANDIDATES (train): DD better than champ AND PnL loss < 5% ===\n');
if (midasTrain) {
  const rows = data[midasTrain].rows;
  const champ = rows.find((r) => r.id === 'champion');
  for (const r of rows) {
    if (r.id === 'champion') continue;
    const pnlOk = r.pnl >= champ.pnl * 0.95;
    const ddOk = r.dd < champ.dd;
    const pfOk = r.pf >= champ.pf;
    if (ddOk && (pnlOk || pfOk)) {
      console.log(
        `${r.id}: pnl ${r.pnl.toFixed(0)} (${(((r.pnl / champ.pnl) - 1) * 100).toFixed(1)}%) dd ${r.dd.toFixed(1)} (${(((r.dd / champ.dd) - 1) * 100).toFixed(1)}%) pf ${r.pf.toFixed(3)}`,
      );
    }
  }
}

// Cross-validate: variants that beat champ on holdout OR improve DD on both
console.log('\n=== CROSS-WINDOW CONSISTENCY ===\n');
if (midasTrain && midasHold) {
  const tRows = Object.fromEntries(data[midasTrain].rows.map((r) => [r.id, r]));
  const hRows = Object.fromEntries(data[midasHold].rows.map((r) => [r.id, r]));
  const champT = tRows.champion;
  const champH = hRows.champion;
  for (const id of focus) {
    if (id === 'champion' || !tRows[id] || !hRows[id]) continue;
    const t = tRows[id];
    const h = hRows[id];
    const trainDelta = t.pnl - champT.pnl;
    const holdDelta = h.pnl - champH.pnl;
    const trainDd = t.dd - champT.dd;
    const holdDd = h.dd - champH.dd;
    const bothBetterPnl = trainDelta > 0 && holdDelta > 0;
    const bothBetterDd = trainDd < 0 && holdDd < 0;
    const signFlip = Math.sign(trainDelta) !== Math.sign(holdDelta) && Math.abs(trainDelta) > 50;
    console.log(
      `${id.padEnd(20)} trainΔpnl=${trainDelta.toFixed(0).padStart(6)} holdΔpnl=${holdDelta.toFixed(0).padStart(6)} trainΔdd=${trainDd.toFixed(0).padStart(5)} holdΔdd=${holdDd.toFixed(0).padStart(5)} ${bothBetterPnl ? 'PNL++' : ''} ${bothBetterDd ? 'DD++' : ''} ${signFlip ? 'SIGN_FLIP' : ''}`,
    );
  }
}

// June 2 specific vs global
console.log('\n=== JUN2 HELP vs GLOBAL COST (train) ===\n');
if (midasTrain) {
  const rows = data[midasTrain].rows;
  const champ = rows.find((r) => r.id === 'champion');
  for (const r of rows) {
    if (r.id === 'champion') continue;
    const jun2Help = (r.jun2Pnl ?? 0) - (champ.jun2Pnl ?? 0);
    const globalCost = r.pnl - champ.pnl;
    console.log(
      `${r.id.padEnd(20)} jun2Δ=${jun2Help.toFixed(1).padStart(7)} globalΔ=${globalCost.toFixed(1).padStart(8)} efficiency=${jun2Help !== 0 ? (globalCost / jun2Help).toFixed(1) : 'n/a'}`,
    );
  }
}
