/**
 * Extrai dias ruins de um relatório lab com dailyMetrics.
 *
 * Uso:
 *   node labs/sandbox/midas-bad-days-map.mjs <reportDir> [--out labs/sandbox/midas-bad-days-july.json]
 */
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      flags.out = argv[++i];
      continue;
    }
    if (!arg.startsWith('--')) flags._.push(arg);
  }
  return flags;
}

function loadVariant(results, id = 'baseline-aggressive') {
  const list = results.variants || results.results || results.topResults || [];
  const found = list.find((v) => v.id === id) || list[0];
  if (!found) throw new Error(`variant ${id} not found; ids=${list.map((v) => v.id).join(', ')}`);
  return found;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const reportDir = flags._[0];
  if (!reportDir) {
    console.error('Usage: node labs/sandbox/midas-bad-days-map.mjs <reportDir> [--out path.json]');
    process.exit(1);
  }

  const results = JSON.parse(fs.readFileSync(path.join(reportDir, 'results.json'), 'utf8'));
  const variant = loadVariant(results);
  const daily = variant.daily || variant.summary?.daily?.series || [];
  if (!daily.length) throw new Error('no daily[] in report — was dailyMetrics:true set?');

  const rows = daily.map((d) => ({
    dt: d.dt,
    pnl: Number(d.totalPnl ?? d.pnl ?? 0),
    entries: Number(d.entries ?? 0),
    wins: Number(d.wins ?? 0),
    losses: Number(d.losses ?? 0),
    maxDrawdown: Number(d.maxDrawdown ?? 0),
    feesPaid: Number(d.feesPaid ?? 0),
  })).sort((a, b) => a.pnl - b.pnl);

  const negativeDays = rows.filter((r) => r.pnl < 0);
  const bottomQuartile = rows.slice(0, Math.max(1, Math.ceil(rows.length * 0.25)));
  const badDays = [...new Set([
    ...negativeDays.map((r) => r.dt),
    ...bottomQuartile.map((r) => r.dt),
  ])].sort();

  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  const stressPnl = rows.filter((r) => badDays.includes(r.dt)).reduce((s, r) => s + r.pnl, 0);

  const out = {
    generatedAt: new Date().toISOString(),
    reportDir,
    variantId: variant.id,
    window: {
      from: rows[0]?.dt,
      to: rows[rows.length - 1]?.dt,
      days: rows.length,
    },
    totalPnl: Number(totalPnl.toFixed(2)),
    stressPnl: Number(stressPnl.toFixed(2)),
    badDays,
    negativeDays: negativeDays.map((r) => r.dt),
    ranking: rows,
    summary: variant.summary || {},
  };

  const outPath = flags.out || path.join('labs/sandbox/midas-bad-days-july.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);

  console.log(`variant=${variant.id} days=${rows.length} totalPnl=${totalPnl.toFixed(2)}`);
  console.log(`badDays (${badDays.length}): ${badDays.join(', ')}`);
  console.log('\n== piores 8 dias ==');
  for (const r of rows.slice(0, 8)) {
    console.log(`${r.dt} pnl=${r.pnl.toFixed(2)} entries=${r.entries} W/L=${r.wins}/${r.losses} dd=${r.maxDrawdown.toFixed(2)}`);
  }
  console.log(`\nSalvo: ${outPath}`);
}

main();
