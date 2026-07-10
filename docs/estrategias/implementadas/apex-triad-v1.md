# Apex Triad V1

Status: **candidate**, não champion.

A Apex Triad V1 combina um núcleo Terminal Favorite Carry com um módulo Edge antecipado. Ela foi criada para aumentar a frequência sem copiar o `simulateMaker` otimista da Hopper 3 e sem usar martingale.

## Resultado honesto

Janela contínua BTC 5m depth-25: 2026-05-04 a 2026-07-05, 17.504 eventos e 11,29 milhões de ticks processados por variante. Taxas crypto aplicadas pela fórmula `shares × 0,07 × p × (1-p)`.

| Métrica | TFC equivalente | Apex Triad 0,75 | Diferença |
| --- | ---: | ---: | ---: |
| PnL líquido | US$ 4.192,77 | **US$ 4.331,80** | **+3,3%** |
| Entradas | 3.852 | **4.262** | **+10,6%** |
| Profit factor | 1,545 | **1,561** | +1,0% |
| Win rate | **74,45%** | 73,42% | -1,04 pp |
| Drawdown contínuo | **US$ 84,52** | US$ 88,56 | +4,8% |
| Taxas pagas | US$ 1.016,81 | US$ 1.083,23 | +6,5% |

Conclusão: a candidata melhora PnL, frequência e PF, mas **não** melhora o drawdown contínuo. Por isso ela não substitui automaticamente a TFC campeã.

## Separação temporal

| Split | TFC PnL | Apex PnL | Entradas TFC | Entradas Apex | DD TFC | DD Apex |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Treino, maio | 1.755,85 | **1.889,75** | 1.642 | **1.847** | **67,01** | 70,34 |
| Validação, junho | 2.198,47 | **2.215,45** | 1.862 | **2.052** | 76,39 | **69,58** |
| Holdout, 1–5 julho | **238,45** | 226,60 | 348 | **363** | **52,30** | 64,69 |

No holdout, a Apex teve 5/5 dias positivos contra 4/5 da referência, mas perdeu em PnL, PF e DD. O holdout é curto e não autoriza o rótulo de campeã.

## Evidência estatística

A comparação pareada dos 63 dias produziu:

- diferença média de **US$ 2,21/dia** e mediana de US$ 0,47/dia;
- 33 dias melhores, 28 piores e 2 empates;
- teste exato de sinais bilateral: **p = 0,609**;
- t estatístico pareado: 1,05;
- moving-block bootstrap, blocos de 5 dias e 10.000 amostras: IC 95% do delta total **[-US$ 139,24; +US$ 415,94]**;
- probabilidade bootstrap de delta médio positivo: 83,16%.

O intervalo inclui zero e o teste de sinais não rejeita igualdade. Além disso, maio foi usado para seleção de parâmetros. Portanto, os US$ 139,03 adicionais são uma vantagem observada, **não uma vantagem estatisticamente confirmada**.

## Arquitetura

### 1. Regime Edge antecipado

- Janela: 105s a 31s antes do encerramento.
- Distância mínima ao price-to-beat: 40.
- Edge mínimo: 0,04; probabilidade direcional mínima: 0,54.
- OBI participa do score.
- Orçamento: 0,75 × o orçamento-base; acima de ask 0,52 recebe novo corte de 50%.
- Stop, trailing exit, late exit e no máximo uma reversão.

### 2. Núcleo TFC

- Janela: 30s a 5s.
- Favorito perto do price-to-beat, ask 0,55–0,82.
- Gates de spread, soma das odds, velocidade do spot e OBI.
- Late flip reverse entre 8s e 4s.
- Danger exit vol-relativo no piso de 4s.

O Edge roda antes e a TFC só entra se não houver posição. Assim a estratégia adiciona eventos distantes/antecipados sem empilhar risco no mesmo evento.

## O que foi aproveitado — e rejeitado

- **TFC:** núcleo terminal, OBI, velocity guard, late flip e danger exit.
- **Edge Sniper:** probabilidade direcional, edge contra o ask, momentum rápido/lento, lag do book, stop, trailing e sizing price-aware.
- **Hopper 3:** a hipótese de equalização e Maker foi testada, mas o escalonamento/martingale não foi levado à candidata. Ficou apenas a disciplina de uma reversão limitada.

O `simulateMaker` da Hopper 3 dá fill imediato de compra pelo bid e venda pelo ask. Isso não modela fila, espera ou não execução. No comparativo de 59 dias, a Hopper marcou +US$ 4.863 com esse modo, mas -US$ 4.962 com execução taker honesta.

Foi implementado um `profitLock` Maker conservador: depois de uma entrada vencedora, ele tenta comprar o lado oposto abaixo do mercado para travar um custo combinado menor que 1. O experimento elevou o win rate para cerca de 86%, porém cortou demais os vencedores e deixou PnL e PF abaixo de zero/1. O recurso permanece no código, **desativado**.

O preset final registra `makerTradesFree = 0`. A estratégia não reivindica economia Maker que o backtest não conseguiu sustentar.

## Taxa de 0,07

`0,07` é o parâmetro da curva, não uma cobrança linear de 7% sobre o notional. Em `p=0,50`, 100 shares pagam `100 × 0,07 × 0,5 × 0,5 = US$ 1,75`, equivalente a 3,5% sobre os US$ 50 de notional. Makers têm taxa de plataforma zero; rebates são variáveis e não foram somados ao PnL.

Documentação oficial: https://docs.polymarket.com/trading/fees e https://docs.polymarket.com/market-makers/maker-rebates.

## Reproduzir

```bash
npm run lab:run -- --experiment labs/strategies/portfolio/apex-triad-v1/experiments/final-full-single-pass.json --quiet
npm run lab:run -- --experiment labs/strategies/portfolio/apex-triad-v1/experiments/phase3-holdout-july.json --quiet
node scripts/analyze-apex-triad.js
```

Arquivos centrais:

- `labs/strategies/portfolio/apex-triad-v1/strategy.gls`
- `labs/strategies/portfolio/apex-triad-v1/defaults.json`
- `labs/strategies/portfolio/apex-triad-v1/presets/btc-candidate-v1.json`

## Próximo teste legítimo

Congelar o preset e coletar pelo menos mais 30 dias fora da amostra. A promoção de candidate para champion exige, no mínimo:

- PnL e PF acima da TFC na nova janela;
- drawdown contínuo não superior ao da TFC;
- nenhuma dependência de fill Maker instantâneo;
- análise de latência, fila e fill parcial em paper trading.
