/**
 * Pontua variantes do sweep bad-days vs critérios de aceite do plano.
 *
 * Uso:
 *   node labs/sandbox/midas-bad-days-score.mjs \
 *     --july reports/.../bad-days-levers-july \
 *     --train reports/.../bad-days-levers-train \
 *     --bad-days labs/sandbox/midas-bad-days-july.json
 */
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return flags;
}

function loadVariants(reportDir) {
  const results = JSON.parse(fs.readFileSync(path.join(reportDir, 'results.json'), 'utf8'));
  const list = results.variants || results.results || results.topResults || [];
  return new Map(list.map((v) => [v.id, v]));
}

function stressPnl(variant, badDays) {
  const daily = variant.daily || [];
  return daily
    .filter((d) => badDays.includes(d.dt))
    .reduce((s, d) => s + Number(d.totalPnl ?? d.pnl ?? 0), 0);
}

function worstDay(variant) {
  const daily = variant.summary?.daily;
  if (daily?.worstDayPnl != null) return Number(daily.worstDayPnl);
  const rows = variant.daily || [];
  if (!rows.length) return 0;
  return Math.min(...rows.map((d) => Number(d.totalPnl ?? d.pnl ?? 0)));
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const julyDir = flags.july;
  const trainDir = flags.train;
  const badDaysFile = flags['bad-days'] || 'labs/sandbox/midas-bad-days-july.json';
  const outMd = flags.out || 'labs/sandbox/midas-bad-days-levers-report.md';

  if (!julyDir || !trainDir) {
    console.error('Usage: node labs/sandbox/midas-bad-days-score.mjs --july <dir> --train <dir> [--bad-days json]');
    process.exit(1);
  }

  const badDays = JSON.parse(fs.readFileSync(badDaysFile, 'utf8')).badDays || [];
  const july = loadVariants(julyDir);
  const train = loadVariants(trainDir);
  const baseJuly = july.get('baseline-aggressive');
  const baseTrain = train.get('baseline-aggressive');
  if (!baseJuly || !baseTrain) throw new Error('baseline-aggressive missing from reports');

  const baseJulyPnl = Number(baseJuly.summary?.totalPnl ?? 0);
  const baseTrainPnl = Number(baseTrain.summary?.totalPnl ?? 0);
  const baseStress = stressPnl(baseJuly, badDays);
  const baseWorst = worstDay(baseJuly);
  const baseJulyPf = Number(baseJuly.summary?.profitFactor ?? 0);

  const rows = [];
  for (const [id, vJuly] of july) {
    if (id === 'baseline-aggressive') continue;
    const vTrain = train.get(id);
    if (!vTrain) continue;

    const julyPnl = Number(vJuly.summary?.totalPnl ?? 0);
    const trainPnl = Number(vTrain.summary?.totalPnl ?? 0);
    const stress = stressPnl(vJuly, badDays);
    const worst = worstDay(vJuly);
    const julyPf = Number(vJuly.summary?.profitFactor ?? 0);

    const deltaJulyPct = baseJulyPnl ? ((julyPnl - baseJulyPnl) / Math.abs(baseJulyPnl)) * 100 : 0;
    const deltaTrainPct = baseTrainPnl ? ((trainPnl - baseTrainPnl) / Math.abs(baseTrainPnl)) * 100 : 0;
    const deltaStress = stress - baseStress;
    const worstImproved = baseWorst < 0 && worst > baseWorst
      ? ((worst - baseWorst) / Math.abs(baseWorst)) * 100
      : 0;

    const passStress = stress >= baseStress || worstImproved >= 20;
    const passJuly = deltaJulyPct >= -5 && (julyPf >= baseJulyPf - 0.05);
    const passTrain = deltaTrainPct >= -8;
    const pass = passStress && passJuly && passTrain;

    rows.push({
      id,
      julyPnl: Number(julyPnl.toFixed(2)),
      deltaJulyPct: Number(deltaJulyPct.toFixed(1)),
      trainPnl: Number(trainPnl.toFixed(2)),
      deltaTrainPct: Number(deltaTrainPct.toFixed(1)),
      stressPnl: Number(stress.toFixed(2)),
      deltaStress: Number(deltaStress.toFixed(2)),
      worstDay: Number(worst.toFixed(2)),
      worstImprovedPct: Number(worstImproved.toFixed(1)),
      julyPf: Number(julyPf.toFixed(2)),
      passStress,
      passJuly,
      passTrain,
      pass,
    });
  }

  rows.sort((a, b) => {
    if (a.pass !== b.pass) return a.pass ? -1 : 1;
    return b.deltaStress - a.deltaStress || b.deltaJulyPct - a.deltaJulyPct;
  });

  const winners = rows.filter((r) => r.pass);

  const md = [
    '# MIDAS — lab dias ruins (julho)',
    '',
    `Gerado: ${new Date().toISOString()}`,
    `Bad days (${badDays.length}): ${badDays.join(', ')}`,
    `Baseline julho PnL: ${baseJulyPnl.toFixed(2)} | stress: ${baseStress.toFixed(2)} | worst day: ${baseWorst.toFixed(2)}`,
    `Baseline treino PnL: ${baseTrainPnl.toFixed(2)}`,
    '',
    '## Critérios',
    '',
    '1. Stress: PnL nos badDays ≥ baseline OU worstDay melhora ≥20%',
    '2. Julho: ΔPnL ≥ −5% e PF não cai >0.05',
    '3. Treino: ΔPnL ≥ −8%',
    '',
    '## Resultados',
    '',
    '| variant | pass | jul PnL | Δjul% | train PnL | Δtrain% | stress | Δstress | worst | stress✓ | jul✓ | train✓ |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|',
    ...rows.map((r) => (
      `| ${r.id} | ${r.pass ? '**Y**' : 'N'} | ${r.julyPnl} | ${r.deltaJulyPct}% | ${r.trainPnl} | ${r.deltaTrainPct}% | ${r.stressPnl} | ${r.deltaStress} | ${r.worstDay} | ${r.passStress ? 'Y' : 'N'} | ${r.passJuly ? 'Y' : 'N'} | ${r.passTrain ? 'Y' : 'N'} |`
    )),
    '',
    winners.length
      ? `## Vencedores (${winners.length})\n\n${winners.map((w) => `- \`${w.id}\` — stress Δ${w.deltaStress}, jul ${w.deltaJulyPct}%, train ${w.deltaTrainPct}%`).join('\n')}`
      : '## Vencedores\n\nNenhuma variante passou os 3 critérios. Gap restante é execução/settlement/cobertura, não gate de estratégia.',
    '',
    '## Relatórios',
    '',
    `- Julho: \`${julyDir}\``,
    `- Treino: \`${trainDir}\``,
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(outMd), { recursive: true });
  fs.writeFileSync(outMd, `${md}\n`);
  fs.writeFileSync(
    outMd.replace(/\.md$/, '.json'),
    `${JSON.stringify({ badDays, baseline: { julyPnl: baseJulyPnl, trainPnl: baseTrainPnl, stressPnl: baseStress }, rows, winners: winners.map((w) => w.id) }, null, 2)}\n`,
  );

  console.log(md);
  console.log(`\nSalvo: ${outMd}`);
}

main();
