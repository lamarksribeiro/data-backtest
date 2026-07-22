import { runLabPreset } from '../labs/shared/labRunner.js';

async function runComparison() {
  console.log('===============================================================');
  console.log(' COMPARAÇÃO DE ESTRATÉGIAS APROVADAS VS AETHER EDGE PRO V1');
  console.log(' Estratégias: MIDAS Carry V1, TFC, Apex Triad V1, Aether Edge Pro V1');
  console.log('===============================================================\n');

  const strategies = [
    { preset: 'btc-champion-v1', strategy: 'midas-carry-v1', family: 'terminal', name: 'MIDAS Carry V1 (v1 Champion)' },
    { preset: 'btc-champion-v7', strategy: 'tfc', family: 'terminal', name: 'TFC V7 (Champion)' },
    { preset: 'btc-candidate-v1', strategy: 'apex-triad-v1', family: 'portfolio', name: 'Apex Triad V1' },
    { preset: 'btc-champion-v1', strategy: 'aether-edge-v1', family: 'portfolio', name: 'Aether Edge Pro V1 (NOVA)' },
  ];

  const windows = [
    { label: 'Treino (Maio 2026)', from: '2026-05-04', to: '2026-05-31' },
    { label: 'Validação (Junho 2026)', from: '2026-06-01', to: '2026-06-30' },
    { label: 'Holdout Cego (Julho 2026)', from: '2026-07-01', to: '2026-07-20' },
  ];

  const results = {};

  for (const win of windows) {
    console.log(`\n>>> Executando janela: ${win.label} (${win.from} até ${win.to}) ...`);
    results[win.label] = [];

    for (const strat of strategies) {
      try {
        const res = await runLabPreset(strat.preset, {
          strategyId: strat.strategy,
          strategyFamily: strat.family,
          from: win.from,
          to: win.to,
          underlying: 'BTC',
          bookDepth: 25,
        });

        if (res.ok && res.topResults?.[0]?.summary) {
          const s = res.topResults[0].summary;
          const wr = typeof s.winRate === 'number' ? (s.winRate > 1 ? s.winRate : s.winRate * 100).toFixed(1) + '%' : 'N/A';
          const trades = s.entries ?? s.totalEntries ?? s.tradesCount ?? 0;
          
          results[win.label].push({
            name: strat.name,
            pnl: (s.netPnl ?? s.totalPnl ?? 0).toFixed(2),
            winRate: wr,
            profitFactor: s.profitFactor ? s.profitFactor.toFixed(2) : 'N/A',
            maxDrawdown: s.maxDrawdown ? '$' + s.maxDrawdown.toFixed(2) : 'N/A',
            trades,
          });
          console.log(`  [OK] ${strat.name}: PnL=$${(s.netPnl ?? s.totalPnl ?? 0).toFixed(2)} | PF=${s.profitFactor?.toFixed(2)} | WR=${wr} | Trades=${trades}`);
        } else {
          console.log(`  [ERRO] ${strat.name}: ${res.error || 'Falha ao executar'}`);
        }
      } catch (err) {
        console.error(`  [EXCEÇÃO] ${strat.name}: ${err.message}`);
      }
    }
  }

  console.log('\n===============================================================');
  console.log(' RESUMO CONSOLIDADO DE DESEMPENHO');
  console.log('===============================================================\n');
  console.log(JSON.stringify(results, null, 2));
}

runComparison().catch(console.error);
