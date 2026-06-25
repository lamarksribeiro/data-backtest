import { openStateDatabase } from '../src/state/sqlite.js';
import { bindStrategyLibraryDatabase } from '../src/backtestStudio/nativeLibrary/registry.js';
import { getStrategyBySlug } from '../src/backtestStudio/state/strategies.js';
import { resolveVersionForBacktest } from '../src/backtestStudio/strategyJs/resolveVersion.js';
import { loadStrategy } from '../src/backtest/strategyLoader.js';
import { DuckDbTickProvider } from '../src/backtest/tickProvider.js';
import { applyPolymarketFeesToBacktestResult } from '../src/backtest/fees.js';
import { writeFileSync } from 'node:fs';

async function main() {
  const db = openStateDatabase('./state/data-backtest.db', { readOnly: true });
  bindStrategyLibraryDatabase(db);

  // Amostragem estatística de 3 dias totais para calibração rápida e estável
  const trainFrom = '2026-06-01';
  const trainTo = '2026-06-03';
  const valFrom = '2026-06-03';
  const valTo = '2026-06-04';

  console.log(`1. Carregando ticks do lakehouse DuckDB para Treino (${trainFrom} a ${trainTo})...`);
  const provider = new DuckDbTickProvider(db, {
    underlying: 'BTC',
    interval: '5m',
    bookDepth: 25,
  });

  const trainTicks = [];
  let startLoad = performance.now();
  for await (const batch of provider.streamTicks({ from: trainFrom, to: trainTo })) {
    for (const tick of batch) {
      trainTicks.push(tick);
    }
  }
  console.log(`Ticks de Treino carregados: ${trainTicks.length} em ${((performance.now() - startLoad) / 1000).toFixed(2)}s`);

  console.log(`2. Carregando ticks para Validação (${valFrom} a ${valTo})...`);
  const valTicks = [];
  startLoad = performance.now();
  for await (const batch of provider.streamTicks({ from: valFrom, to: valTo })) {
    for (const tick of batch) {
      valTicks.push(tick);
    }
  }
  console.log(`Ticks de Validação carregados: ${valTicks.length} em ${((performance.now() - startLoad) / 1000).toFixed(2)}s`);

  if (trainTicks.length === 0 || valTicks.length === 0) {
    console.error('Nenhum tick encontrado em um dos períodos. Verifique se o lakehouse possui dados.');
    return;
  }

  console.log('3. Carregando estratégia cofre-sete-v1...');
  const strategyDef = getStrategyBySlug(db, 'cofre-sete-v1');
  if (!strategyDef) {
    console.error('Estratégia cofre-sete-v1 não encontrada.');
    return;
  }

  const row = db.prepare(`
    SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version DESC LIMIT 1
  `).get(strategyDef.id);
  const version = {
    ...row,
    params_schema: JSON.parse(row.params_schema_json || '{}'),
    validation: JSON.parse(row.validation_json || '{}'),
    compiled: row.compiled_json ? JSON.parse(row.compiled_json) : null,
  };

  const resolved = resolveVersionForBacktest(version, { bookDepth: 25, db });
  const loaded = await loadStrategy({
    glsAst: resolved.glsAst,
    columnAnalysis: resolved.columnAnalysis,
    runnerLibrary: resolved.runnerLibrary,
    extensionLibraries: resolved.extensionLibraries,
    generatedSource: resolved.generatedSource,
    embeddedModels: resolved.embeddedModels,
    strategySourceCode: resolved.strategySourceCode,
    db,
    bookDepth: 25,
  });

  // Função para rodar o teste na memória APLICANDO AS TAXAS OPERACIONAIS LIQUIDAS
  function runBacktestMem(ticksList, params) {
    const runner = loaded.createRunner(params, { fastRun: true, bookDepth: 25 });
    for (const tick of ticksList) {
      runner.processTick(tick);
    }
    const rawResult = runner.finish();
    
    // Aplicar as taxas Polymarket de 0.07 (crypto) no resultado
    const resultWithFees = applyPolymarketFeesToBacktestResult(rawResult, { 
      enabled: true, 
      category: 'crypto' 
    });
    
    return resultWithFees;
  }

  console.log('4. Rodando o Baseline (parâmetros padrão com taxas aplicadas)...');
  const baselineTrain = runBacktestMem(trainTicks, {});
  const baselineVal = runBacktestMem(valTicks, {});

  console.log('\n=== BASELINE TREINO (LÍQUIDO PÓS-TAXAS) ===');
  console.log(`PnL Líquido: $${baselineTrain.summary.totalPnl.toFixed(2)} | Taxas Pagas: $${baselineTrain.summary.totalFees.toFixed(2)} | Trades: ${baselineTrain.summary.totalEntries} | PF Líquido: ${baselineTrain.summary.profitFactor.toFixed(2)} | DD Líquido: $${baselineTrain.summary.maxDrawdown.toFixed(2)}`);
  console.log('\n=== BASELINE VALIDAÇÃO (LÍQUIDO PÓS-TAXAS) ===');
  console.log(`PnL Líquido: $${baselineVal.summary.totalPnl.toFixed(2)} | Taxas Pagas: $${baselineVal.summary.totalFees.toFixed(2)} | Trades: ${baselineVal.summary.totalEntries} | PF Líquido: ${baselineVal.summary.profitFactor.toFixed(2)} | DD Líquido: $${baselineVal.summary.maxDrawdown.toFixed(2)}`);

  console.log('\n5. Iniciando Otimização de Parâmetros Líquidos (Treino)...');
  
  const candidates = [];
  const baseParams = baselineTrain.params;

  // Espaço de busca focado em reduzir o "fee drag" (sobre-operação) e maximizar o ganho líquido
  const edges = [0.055, 0.065, 0.075, 0.085, 0.095]; // Aumentamos o minEdge para filtrar apenas trades de alta margem
  const probs = [0.55, 0.57, 0.59, 0.61];
  const distances = [25, 35, 45, 60]; // Aumentamos a distância mínima para filtrar ruído e economizar taxas
  const maxAsks = [0.68, 0.74, 0.80];
  const kellyFractions = [0.15, 0.22, 0.30];
  const trapToggles = [false, true];
  const hedgeToggles = [false, true];
  const takeProfits = [0.88, 0.90, 0.92];
  const stopBids = [0.08, 0.10, 0.12];

  // Grid estruturado ~ 80 combinações
  for (const minEdge of edges) {
    for (const minDirectionalProb of probs) {
      for (const trapEnabled of trapToggles) {
        for (const hedgeEnabled of hedgeToggles) {
          candidates.push({
            ...baseParams,
            minEdge,
            minDirectionalProb,
            trapEnabled,
            hedgeEnabled,
            name: `grid-e${minEdge}-p${minDirectionalProb}-t${trapEnabled ? 1 : 0}-h${hedgeEnabled ? 1 : 0}`,
          });
        }
      }
    }
  }

  // Busca aleatória ~ 250 combinações
  for (let i = 0; i < 250; i++) {
    const minEdge = edges[Math.floor(Math.random() * edges.length)];
    const minDirectionalProb = probs[Math.floor(Math.random() * probs.length)];
    const minDistanceAbs = distances[Math.floor(Math.random() * distances.length)];
    const maxAsk = maxAsks[Math.floor(Math.random() * maxAsks.length)];
    const kellyFraction = kellyFractions[Math.floor(Math.random() * kellyFractions.length)];
    const trapEnabled = Math.random() > 0.5;
    const hedgeEnabled = Math.random() > 0.5;
    const takeProfitBid = takeProfits[Math.floor(Math.random() * takeProfits.length)];
    const stopBid = stopBids[Math.floor(Math.random() * stopBids.length)];
    const cooldownSec = Math.random() > 0.5 ? 5 : 10; // Aumentamos cooldown para evitar trades colados que geram taxas duplicadas
    const trailDrop = Math.random() > 0.5 ? 0.10 : 0.14;

    let trapParams = {};
    if (trapEnabled) {
      trapParams = {
        trapMaxValue: Math.random() > 0.5 ? 2.0 : 3.5,
        trapMinDecelZ: Math.random() > 0.5 ? 0.50 : 0.30,
        trapMinEdge: Math.random() > 0.5 ? 0.01 : -0.02,
      };
    }

    candidates.push({
      ...baseParams,
      minEdge,
      minDirectionalProb,
      minDistanceAbs,
      maxAsk,
      kellyFraction,
      trapEnabled,
      hedgeEnabled,
      takeProfitBid,
      stopBid,
      cooldownSec,
      trailDrop,
      ...trapParams,
      name: `rand-${i}`,
    });
  }

  console.log(`Candidatos gerados: ${candidates.length}`);
  console.log('Executando simulações na CPU com foco em PnL Líquido...');

  const results = [];
  const startSweep = performance.now();
  let count = 0;

  for (const candidate of candidates) {
    const { name, ...params } = candidate;
    try {
      const res = runBacktestMem(trainTicks, params);
      const s = res.summary;
      
      // Penaliza drawdowns líquidos e penaliza severamente o excesso de trades ineficientes (fee drag)
      const score = s.totalPnl - (s.maxDrawdown * 1.8) - (Math.abs(s.maxLoss) * 2.0) - (s.totalEntries < 5 ? 500 : 0);

      results.push({
        name,
        params,
        trainSummary: {
          totalPnl: s.totalPnl,
          totalFees: s.totalFees,
          totalEntries: s.totalEntries,
          totalWins: s.totalWins,
          totalLosses: s.totalLosses,
          winRate: s.winRate,
          profitFactor: s.profitFactor,
          maxDrawdown: s.maxDrawdown,
          maxLoss: s.maxLoss,
          score,
        }
      });
    } catch (err) {
      // Ignorar
    }

    count++;
    if (count % 50 === 0) {
      const elapsed = (performance.now() - startSweep) / 1000;
      console.log(`Progresso Treino: ${count}/${candidates.length} em ${elapsed.toFixed(1)}s (${(count / elapsed).toFixed(1)} runs/s)`);
    }
  }

  results.sort((a, b) => b.trainSummary.score - a.trainSummary.score);

  console.log('\n6. Validando os Top 15 Candidatos out-of-sample (Validação)...');
  const finalRanked = [];

  for (let i = 0; i < Math.min(15, results.length); i++) {
    const candidate = results[i];
    try {
      const resVal = runBacktestMem(valTicks, candidate.params);
      const sVal = resVal.summary;
      
      // Score combinado focado exclusivamente no PnL líquido
      const scoreFinal = candidate.trainSummary.score + sVal.totalPnl - (sVal.maxDrawdown * 1.8);

      finalRanked.push({
        ...candidate,
        valSummary: {
          totalPnl: sVal.totalPnl,
          totalFees: sVal.totalFees,
          totalEntries: sVal.totalEntries,
          totalWins: sVal.totalWins,
          totalLosses: sVal.totalLosses,
          winRate: sVal.winRate,
          profitFactor: sVal.profitFactor,
          maxDrawdown: sVal.maxDrawdown,
          maxLoss: sVal.maxLoss,
        },
        scoreFinal,
      });
    } catch (err) {
      // Ignorar
    }
  }

  finalRanked.sort((a, b) => b.scoreFinal - a.scoreFinal);

  console.log('\n=== CLASSIFICAÇÃO DOS TOP CANDIDATOS (ORDENADOS POR ROBUSTEZ LÍQUIDA COMBINADA) ===');
  for (let i = 0; i < finalRanked.length; i++) {
    const r = finalRanked[i];
    const t = r.trainSummary;
    const v = r.valSummary;
    console.log(`#${i + 1} | Treino PnL Líq: +$${t.totalPnl.toFixed(2)} (Fees: $${t.totalFees.toFixed(2)}, PF: ${t.profitFactor.toFixed(2)}) | Validação PnL Líq: +$${v.totalPnl.toFixed(2)} (Fees: $${v.totalFees.toFixed(2)}, PF: ${v.profitFactor.toFixed(2)}) | Score: ${r.scoreFinal.toFixed(1)}`);
  }

  const champion = finalRanked[0];
  console.log('\n=== CAMPEÃO DA OTIMIZAÇÃO LÍQUIDA ===');
  console.log(JSON.stringify(champion.params, null, 2));

  // Salva no formato preset de cofre-sete-v1
  const presetContent = {
    id: "btc-champion",
    name: "BTC · Champion Optimized",
    studioVersion: 1,
    params: champion.params
  };

  const outputPath = './labs/strategies/carry/cofre-sete-v1/presets/btc-champion.json';
  writeFileSync(outputPath, JSON.stringify(presetContent, null, 2), 'utf8');
  console.log(`\nPreset campeão salvo com sucesso em ${outputPath}`);

  // Atualizar o manifest.json para incluir o novo preset btc-champion
  const manifestPath = './labs/strategies/carry/cofre-sete-v1/presets/manifest.json';
  const newManifest = {
    presets: ["v1", "btc-champion"]
  };
  writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2), 'utf8');
  console.log(`Manifest de presets atualizado em ${manifestPath}`);
}

main().catch(console.error);
