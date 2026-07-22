import { runLabPreset } from '../labs/shared/labRunner.js';

async function runBenchmark() {
  console.log('================================================================');
  console.log(' BENCHMARK COMPARATIVO: CHRONOS KINETIC V1 VS MIDAS, TFC & APEX');
  console.log('================================================================\n');

  const strategies = [
    { id: 'chronos-kinetic-v1', family: 'microstructure', preset: 'btc-champion-v1', name: 'CHRONOS KINETIC V1 (NOVA)' },
    { id: 'midas-carry-v1', family: 'terminal', preset: 'btc-champion-v1', name: 'MIDAS CARRY V1' },
    { id: 'tfc', family: 'terminal', preset: 'btc-champion-v6-hybrid', name: 'TFC V7' },
    { id: 'apex-triad-v1', family: 'portfolio', preset: 'btc-candidate-v1', name: 'APEX TRIAD V1' }
  ];

  const windows = [
    { name: 'Maio 2026 (Treino)', from: '2026-05-04', to: '2026-05-31' },
    { name: 'Junho 2026 (Validação)', from: '2026-06-01', to: '2026-06-30' },
    { name: 'Julho 2026 (Holdout Cego)', from: '2026-07-01', to: '2026-07-20' },
    { name: '78 Dias Acumulado (Mai - Jul)', from: '2026-05-04', to: '2026-07-20' }
  ];

  for (const win of windows) {
    console.log(`\n----------------------------------------------------------------`);
    console.log(` JANELA: ${win.name} (${win.from} até ${win.to})`);
    console.log(`----------------------------------------------------------------`);

    for (const strat of strategies) {
      try {
        const res = await runLabPreset(strat.preset, {
          strategyId: strat.id,
          strategyFamily: strat.family,
          from: win.from,
          to: win.to
        });

        const s = res.topResults?.[0]?.summary;
        if (s) {
          const pnl = s.netPnl ?? s.totalPnl ?? s.pnl ?? 0;
          const wr = (s.winRate > 1 ? s.winRate : s.winRate * 100).toFixed(1);
          const pf = (s.profitFactor ?? 0).toFixed(2);
          const dd = (s.maxDrawdown ?? 0).toFixed(2);
          const entries = s.entries ?? s.totalEntries ?? 0;
          const fees = (s.feesPaid ?? s.totalFees ?? 0).toFixed(2);

          console.log(`  [${strat.name.padEnd(28)}] -> PnL: $${pnl.toFixed(2).padStart(8)} | WR: ${wr.padStart(5)}% | PF: ${pf.padStart(4)} | Max DD: $${dd.padStart(6)} | Trades: ${String(entries).padStart(4)} | Fees: $${fees}`);
        }
      } catch (err) {
        console.error(`  [${strat.name}] Erro:`, err.message);
      }
    }
  }
}

runBenchmark().catch(console.error);
