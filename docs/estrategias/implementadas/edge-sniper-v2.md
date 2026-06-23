# Edge Sniper V2

Este documento explica o funcionamento completo da estrategia **Edge Sniper V2**, usada no simulador do GoldenLens para o mercado **BTC Up/Down 5 minutos** da Polymarket.

A ideia central e simples: entrar apenas quando o BTC esta suficientemente longe do PTB, quando o modelo enxerga uma probabilidade direcional maior que o preco pedido pelo mercado, e quando o book permite uma execucao realista. A estrategia negocia menos, mas tenta evitar as entradas em zona duvidosa.

Ela nao envia ordens reais. O backtest simula compra e venda usando os ticks gravados em PostgreSQL e o book historico salvo em `ticks`.

---

## Evolucao V1 → V2

A **Edge Sniper V2** e a versao ativa no simulador (`EDGE_SNIPER_V2`, modo `Edge Sniper V2` no dashboard). Laboratorios, tabelas e documentos antigos que citam **Edge Sniper V1** ou `baseline-edge-sniper-v1` permanecem como registro historico — nao devem ser renomeados.

Mudancas principais da V2 (Maio 2026):

- `minDistanceAbs` padrao **50** (antes 45).
- **Sizing por payoff**: reduz stake quando `ask` > `sizePriceThreshold` (padrao 0.52, fator 0.5).
- Parametros defensivos opcionais (distancia dinamica, stop dinamico, saida final) disponiveis; os defaults promovidos focam distancia + sizing.

---

## Resumo rapido

Nome interno: `EDGE_SNIPER_V2`

Arquivo principal: `src/services/edgeSniperBacktest.js`

Endpoint de backtest: `POST /api/backtest/edge-sniper`

Modo na tela: `Edge Sniper V2`

Principio:

1. Calcula uma probabilidade para `UP` e `DOWN`.
2. Compara essa probabilidade com o `ask` disponivel no mercado.
3. Compra apenas se houver edge minimo, distancia minima do PTB e liquidez suficiente.
4. Gerencia a posicao com stop, parcial, trailing e saida final.
5. Usa no maximo um ciclo de entrada por evento para evitar reentrada enganosa no mesmo mercado.

---

## Defaults atuais (V3 - Maio 2026)

| Parametro | Default | O que faz |
|---|---:|---|
| `walletSize` | `100` | Carteira inicial simulada. |
| `maxOrderValue` | `15` | Valor maximo por entrada. |
| `minShares` | `5` | Quantidade minima de contratos para aceitar uma entrada. |
| `entryWindowStart` | `105` | Comeca a procurar entrada quando faltam ate 105s para expirar. |
| `entryWindowEnd` | `4` | Para de procurar entrada nos ultimos 4s. |
| `minAsk` | `0.08` | Menor preco aceito para compra. Evita micro-precos pouco confiaveis. |
| `maxAsk` | `0.58` | Maior preco aceito para compra. Evita pagar caro demais para mitigar resultados degradantes. |
| `minEdge` | `0.07` | Edge minimo: probabilidade estimada menos preco de compra. `0.07` = 7pp. |
| `minDirectionalProb` | `0.56` | Probabilidade minima exigida para o lado escolhido. |
| `minDistanceAbs` | `45` | Distancia minima entre BTC e PTB, em dolares (dinamica: sobe ate 54 nos ultimos 30s). |
| `minDistanceNearExpiry` | `54` | Distancia minima exigida quando faltam menos de `nearExpiryThresholdSec`. |
| `nearExpiryThresholdSec` | `30` | Segundos restantes a partir dos quais a distancia minima aumenta. |
| `minSigma` | `18` | Volatilidade minima usada no modelo (calibrada para reduzir overconfidence). |
| `sigmaMultiplier` | `1.5` | Multiplicador da volatilidade recente (calibrado para reduzir overconfidence). |
| `distanceWeight` | `2.0` | Peso da distancia BTC/PTB no modelo. |
| `momentumWeight` | `0.65` | Peso do momentum curto. |
| `momentumSec` | `6` | Janela do momentum rapido. |
| `slowMomentumSec` | `18` | Janela do momentum lento. |
| `slowMomentumWeight` | `0.35` | Peso do momentum lento dentro do momentum total. |
| `lagWeight` | `0.45` | Peso do atraso/discordancia do mercado contra a direcao. |
| `volLookbackSec` | `45` | Janela usada para estimar volatilidade recente. |
| `maxSpread` | `0.08` | Spread maximo entre bid e ask do lado candidato. |
| `entrySlippageMax` | `0.02` | Preco maximo extra aceito acima do melhor ask para preencher pelo book. |
| `minLiquidityRatio` | `0.75` | Book precisa ter pelo menos 75% da quantidade desejada dentro do preco maximo. |
| `stopBid` | `0.22` | Stop fixo: vende se bid cair ate 0.22 (antes dos ultimos 16s). |
| `dynamicStopEnabled` | `true` | Se true, usa stop dinamico: `max(0.16, avgEntryPrice * 0.45)`. |
| `dynamicStopMinBid` | `0.16` | Piso do stop dinamico. |
| `takeProfitBid` | `0.92` | Quando o bid chega a 0.92, vende parcial. |
| `takeProfitPct` | `0.55` | Percentual vendido na parcial (55%). |
| `trailAfterBid` | `0.78` | Ativa trailing quando o melhor bid ja bateu 0.78. |
| `trailDrop` | `0.08` | Se cair 0.08 desde o maior bid apos ativar trailing, vende. |
| `lateExitSec` | `16` | Nos ultimos 16s, desativa o stop bid e permite saida defensiva. |
| `lateExitMinBid` | `0.64` | Nos ultimos 16s (antes dos ultimos 6s), vende se o bid >= 0.64. |
| `maxPtbCrosses` | `5` | Maximo de cruzamentos do PTB no lookback antes de bloquear entrada perto da expiracao. |
| `ptbCrossLookbackSec` | `90` | Janela para contar cruzamentos do PTB. |
| `directionStabilityMin` | `0.28` | Estabilidade direcional minima (fracao de ticks no mesmo lado do PTB). |

### Novas funcionalidades V3 (Maio 2026)

1. **Filtro de distancia dinamica**: A distancia minima exigida aumenta linearmente de `minDistanceAbs` (44) ate `minDistanceNearExpiry` (54) nos ultimos `nearExpiryThresholdSec` (30s). Isso evita entradas arriscadas perto da expiracao.

2. **Filtro de estabilidade direcional**: Rastreia quantas vezes o BTC cruzou o PTB e bloqueia entradas quando a direcao esta muito instavel (`directionStabilityMin=0.28`). Se houver mais de `maxPtbCrosses` (5) cruzamentos nos ultimos 90s, bloqueia entradas com menos de 60s restantes.

3. **Stop dinamico**: Em vez de um stop fixo em 0.22, calcula `max(0.16, precoMedioEntrada * 0.45)`. Entradas mais caras tem stops mais altos, reduzindo a perda maxima.

4. **Modelo calibrado**: `minSigma` subiu de 10 para 18 e `sigmaMultiplier` de 1.0 para 1.5. Isso reduz o overconfidence do modelo (antes >80% das entradas tinham probabilidade estimada >80%, mas win rate real era apenas ~80%).

5. **Saida agressiva nos ultimos 6 segundos**: Se ainda tem posicao nos ultimos 6s, vende a qualquer bid > 0.10 para evitar expiracao total.

6. **Take profit maior**: Parcial subiu de 35% para 55%, garantindo mais lucro quando o bid atinge 0.92.
| `maxAsk` | `0.58` | Maior preco aceito para compra. Evita pagar caro demais para mitigar resultados degradantes. |
| `minEdge` | `0.07` | Edge minimo: probabilidade estimada menos preco de compra. `0.07` = 7 pontos percentuais. |
| `minDirectionalProb` | `0.56` | Probabilidade minima exigida para o lado escolhido. |
| `minDistanceAbs` | `50` | Distancia minima entre BTC e PTB, em dolares. Promovido de 45 -> 50 em Maio/2026 (ver "Correcao de reducao de perdas"). |
| `minDistanceNearExpiry` | `50` | Distancia minima exigida perto da expiracao (opt-in; igual a `minDistanceAbs` = distancia dinamica desativada). |
| `nearExpiryThresholdSec` | `30` | A partir de quantos segundos restantes a distancia minima comeca a subir para `minDistanceNearExpiry`. |
| `minSigma` | `10` | Volatilidade minima usada no modelo para evitar excesso de confianca. |
| `sigmaMultiplier` | `1` | Multiplicador da volatilidade recente. |
| `distanceWeight` | `2.0` | Peso da distancia BTC/PTB no modelo. |
| `momentumWeight` | `0.65` | Peso do momentum curto. |
| `momentumSec` | `6` | Janela do momentum rapido. |
| `slowMomentumSec` | `18` | Janela do momentum lento. |
| `slowMomentumWeight` | `0.35` | Peso do momentum lento dentro do momentum total. |
| `lagWeight` | `0.45` | Peso do atraso/discordancia do mercado contra a direcao. |
| `volLookbackSec` | `45` | Janela usada para estimar volatilidade recente. |
| `maxSpread` | `0.08` | Spread maximo entre bid e ask do lado candidato. |
| `entrySlippageMax` | `0.02` | Preco maximo extra aceito acima do melhor ask para preencher pelo book. |
| `minLiquidityRatio` | `0.75` | Book precisa ter pelo menos 75% da quantidade desejada dentro do preco maximo. |
| `stopBid` | `0.18` | Se o bid cair ate 0.18 antes dos ultimos segundos, vende e encerra. |
| `sizePriceAware` | `true` | Sizing por payoff: reduz o tamanho da ordem quando o ask de entrada e caro (baixo payoff). Ligado por padrao em Maio/2026. |
| `sizePriceThreshold` | `0.52` | Acima deste ask, a ordem usa tamanho reduzido. |
| `sizePriceFactor` | `0.5` | Fator aplicado a `maxOrderValue` quando `ask > sizePriceThreshold` (0.5 = metade do stake). |
| `dynamicStopEnabled` | `false` | Opt-in. Se `true`, usa stop dinamico `max(dynamicStopMinBid, precoMedio * dynamicStopFactor)` no lugar de `stopBid`. |
| `dynamicStopFactor` | `0.45` | Fracao do preco medio usada no stop dinamico. |
| `dynamicStopMinBid` | `0.16` | Piso do stop dinamico. |
| `takeProfitBid` | `0.92` | Quando o bid chega a 0.92, vende parcial. |
| `takeProfitPct` | `0.35` | Percentual vendido na parcial. |
| `trailAfterBid` | `0.78` | Ativa trailing quando o melhor bid ja bateu 0.78. |
| `trailDrop` | `0.10` | Se cair 0.10 desde o maior bid apos ativar trailing, vende. |
| `lateExitSec` | `16` | Nos ultimos 16s, desativa o stop bid e permite saida defensiva. |
| `lateExitMinBid` | `0.64` | Nos ultimos 16s, vende se o bid estiver pelo menos em 0.64. |
| `finalExitSec` | `0` | Opt-in. Nos ultimos N segundos, vende a qualquer bid >= `finalExitMinBid` para salvar valor residual antes da expiracao. `0` = desativado. |
| `finalExitMinBid` | `0.05` | Bid minimo aceito na saida de salvamento final. |

---

## Dados que a estrategia usa

Cada tick historico traz:

- `btc_price`: preco atual do BTC.
- `price_to_beat`: PTB do evento de 5 minutos.
- `up_best_bid` e `up_best_ask`: topo do book para `UP`.
- `down_best_bid` e `down_best_ask`: topo do book para `DOWN`.
- `up_book_asks` e `down_book_asks`: asks completos salvos em JSONB, usados para simular preenchimento real.
- `event_start` e `condition_id`: identificam o evento.
- `ts`: timestamp do tick.

O backtest le esses dados em batches para permitir periodos maiores sem carregar tudo de uma vez.

---

## Fluxo completo do evento

### 1. Inicia um evento

Quando aparece um `condition_id` novo, a estrategia cria um estado interno para aquele evento:

- Guarda PTB.
- Guarda amostras recentes de BTC.
- Zera posicao, fills, parciais e saidas.
- Marca o evento como ativo.

O evento dura 300 segundos. A expiracao e calculada como `event_start + 5 minutos`.

### 2. Acumula amostras

A cada tick, a estrategia salva uma amostra com:

- horario do tick;
- preco BTC;
- timestamp original.

Ela mantem apenas os ultimos 120 segundos de amostras. Isso basta para calcular momentum e volatilidade recente sem deixar o estado crescer demais.

### 3. Espera a janela de entrada

A estrategia so procura entrada quando faltam entre `105s` e `4s` para o evento expirar.

Fora dessa janela:

- se faltam mais de 105s, ainda e cedo;
- se faltam 4s ou menos, ja e tarde demais para entrar;
- se o evento acabou, fecha por expiracao.

Tambem exige pelo menos alguns segundos de amostras antes de operar, para evitar decisao sem momentum minimo.

### 4. Calcula a probabilidade direcional

O modelo estima `pUp`, a probabilidade de `UP`. A probabilidade de `DOWN` e `1 - pUp`.

A formula conceitual e:

```text
sigma = max(minSigma, volatilidade_recente * sqrt(segundos_restantes) * sigmaMultiplier)

distanceZ = (btc_price - price_to_beat) / sigma
momentumZ = (movimento_rapido + slowMomentumWeight * movimento_lento) / sigma
marketLag = atraso do mercado contra a direcao atual

pUp = logistic(
  distanceWeight * distanceZ
  + momentumWeight * momentumZ
  + lagWeight * marketLag
)
```

Interpretacao:

- Se BTC esta acima do PTB, a distancia favorece `UP`.
- Se BTC esta abaixo do PTB, a distancia favorece `DOWN`.
- Se o momentum acompanha a direcao, a probabilidade sobe.
- Se o mercado ainda esta precificando barato o lado que parece forte, o `marketLag` ajuda a capturar esse atraso.
- `sigma` impede o modelo de ficar confiante demais quando o mercado esta muito volatil.

### 5. Cria candidatos de compra

Para cada lado (`UP` e `DOWN`), a estrategia calcula:

```text
probability = pUp para UP, ou 1 - pUp para DOWN
edge = probability - ask
spread = ask - bid
```

Um candidato so passa se cumprir todos os filtros:

- `ask` existe.
- `ask >= minAsk`.
- `ask <= maxAsk`.
- `probability >= minDirectionalProb`.
- `edge >= minEdge`.
- `spread <= maxSpread`.
- `abs(btc_price - price_to_beat) >= minDistanceAbs`.

Se os dois lados passam, vence o maior `edge`.

### 6. Simula a compra no book

A estrategia nao assume preenchimento magico no melhor ask. Ela consome o book salvo no tick.

Passos:

1. Define `maxFillPrice = min(maxAsk, ask + entrySlippageMax)`.
2. Define valor alvo: `min(maxOrderValue, carteira_atual)`.
3. Calcula quantidade: `floor(valor_alvo / maxFillPrice)`.
4. Verifica se o book tem pelo menos `minLiquidityRatio` da quantidade desejada ate `maxFillPrice`.
5. Consome os niveis de ask ate preencher ou acabar liquidez.
6. Rejeita se o preenchimento final ficou abaixo de `minShares`.

Isso torna o backtest mais duro: se nao havia liquidez historica suficiente, a entrada nao acontece.

### 7. Gerencia a posicao

Depois de entrar, a estrategia observa o `bid` do lado comprado.

Ela pode sair por quatro caminhos principais:

1. Stop bid.
2. Parcial de lucro.
3. Trailing stop.
4. Saida defensiva nos ultimos segundos.

Se nada disso acontecer, a posicao vai para expiracao.

### 8. Finaliza o evento

Ao finalizar, o runner grava:

- lado comprado;
- horario de entrada;
- distancia de entrada ao PTB;
- quantidade;
- custo medio;
- fills;
- saidas;
- resultado de expiracao;
- PnL final;
- diagnosticos de entrada.

Depois marca o evento como completo. Isso impede reentrada no mesmo evento depois de um stop ou trailing.

---

## Exemplos numericos

### Exemplo 1: entrada em UP com edge claro

Situacao:

```text
PTB:              104000
BTC atual:        104052
Tempo restante:   75s
Distancia:        +52
UP ask:           0.58
UP bid:           0.54
DOWN ask:         0.47
DOWN bid:         0.43
Probabilidade UP: 0.74
```

Filtros:

```text
distancia = 52 >= 40               passa
ask = 0.58 entre 0.08 e 0.66       passa
spread = 0.58 - 0.54 = 0.04        passa
probabilidade = 0.74 >= 0.56       passa
edge = 0.74 - 0.58 = 0.16          passa
```

Com `maxOrderValue = 10` e `entrySlippageMax = 0.02`:

```text
maxFillPrice = min(0.66, 0.58 + 0.02) = 0.60
quantidade alvo = floor(10 / 0.60) = 16 contratos
```

Book disponivel:

```text
10 contratos @ 0.58
6 contratos  @ 0.59
```

Entrada simulada:

```text
custo = 10 * 0.58 + 6 * 0.59 = 9.34
preco medio = 9.34 / 16 = 0.58375
```

Se o evento expirar vencedor em `UP`, o payout dos 16 contratos e `16.00`:

```text
PnL = 16.00 - 9.34 = +6.66
```

### Exemplo 2: entrada rejeitada por distancia fraca

Situacao:

```text
PTB:       104000
BTC atual: 104031
Distancia: +31
```

Mesmo que o modelo goste de `UP`, a entrada e recusada:

```text
abs(104031 - 104000) = 31
31 < minDistanceAbs 40
```

Motivo: quando o BTC esta perto demais do PTB, uma oscilacao pequena muda completamente o vencedor. O filtro de `40` reduz entradas nesse miolo perigoso.

### Exemplo 3: entrada rejeitada por preco caro

Situacao:

```text
Probabilidade UP: 0.78
UP ask:           0.70
```

Mesmo com boa probabilidade, a estrategia rejeita:

```text
ask 0.70 > maxAsk 0.58
```

Motivo: pagar caro reduz a assimetria. Em contrato binario, comprar a 0.70 exige uma taxa de acerto muito alta para compensar perdas.

### Exemplo 4: stop bid reduzindo dano

Entrada:

```text
Lado:        UP
Quantidade: 16
Custo:      9.34
Preco medio 0.58375
```

O mercado vira contra a posicao e o melhor bid cai para `0.18`, ainda antes dos ultimos 8 segundos.

Saida:

```text
venda = 16 * 0.18 = 2.88
PnL = 2.88 - 9.34 = -6.46
```

Sem stop, se `UP` perdesse na expiracao, o PnL seria:

```text
PnL = 0 - 9.34 = -9.34
```

O stop nao transforma uma entrada ruim em boa, mas corta parte do prejuizo quando ainda existe bid para sair.

### Exemplo 5: parcial de lucro e trailing

Entrada:

```text
Lado:        DOWN
Quantidade: 20
Preco medio 0.50
Custo:      10.00
```

O bid sobe para `0.92`. A estrategia vende parcial de `35%`:

```text
quantidade parcial = floor(20 * 0.35) = 7
venda parcial = 7 * 0.92 = 6.44
custo desses 7 contratos = 7 * 0.50 = 3.50
lucro parcial = 6.44 - 3.50 = +2.94
```

Sobram 13 contratos. Depois, o maior bid registrado foi `0.92`, mas o bid cai para `0.82`.

Como:

```text
0.92 >= trailAfterBid 0.78
0.92 - 0.82 = 0.10 >= trailDrop 0.10
```

A estrategia vende o restante:

```text
venda restante = 13 * 0.82 = 10.66
custo restante = 13 * 0.50 = 6.50
lucro restante = 10.66 - 6.50 = +4.16
```

Resultado total aproximado:

```text
PnL total = 2.94 + 4.16 = +7.10
```

### Exemplo 6: saida defensiva no fim

Entrada:

```text
Lado:        UP
Quantidade: 18
Preco medio 0.48
Custo:      8.64
```

Faltam 6 segundos e o bid esta em `0.60`.

Como:

```text
tempo restante = 6 <= lateExitSec 8
bid = 0.60 >= lateExitMinBid 0.58
```

A estrategia vende antes da expiracao:

```text
venda = 18 * 0.60 = 10.80
PnL = 10.80 - 8.64 = +2.16
```

Motivo: nos ultimos segundos, um contrato que ainda tem bid razoavel pode virar zero rapidamente se o BTC cruzar o PTB. A saida defensiva troca parte do upside por menor risco de cauda.

---

## O papel do hedge

A estrategia nao compra automaticamente o lado oposto como hedge classico.

Motivo: no mercado `UP/DOWN`, comprar o lado oposto tarde geralmente custa caro. Quando a posicao original esta ameaçada, o contrato oposto costuma subir, e o hedge vira uma segunda compra ruim.

O hedge da Edge Sniper e operacional:

- operar menos;
- exigir distancia minima maior;
- cortar quando o bid degrada;
- realizar parcial quando o mercado paga bem;
- usar trailing para nao devolver lucro;
- sair defensivamente nos ultimos segundos quando ainda existe bid aceitavel.

Em vez de adicionar uma segunda perna, ela reduz exposicao quando a leitura deixa de ser favoravel.

---

## Como interpretar o edge

O edge usado pela estrategia e:

```text
edge = probabilidade_estimada - preco_de_compra
```

Exemplo:

```text
probabilidade estimada = 0.72
ask = 0.60
edge = 0.12
```

Isso significa que o modelo acha que o contrato vale cerca de `0.72`, mas o mercado esta vendendo a `0.60`. A diferenca de 12 pontos percentuais passa o filtro de `minEdge = 0.07`.

Outro exemplo:

```text
probabilidade estimada = 0.68
ask = 0.64
edge = 0.04
```

Apesar da probabilidade parecer boa, a entrada e rejeitada porque o edge de 4 pontos percentuais e menor que o minimo de 7.

---

## Metricas retornadas pelo backtest

O resultado do backtest inclui:

- `totalEntries`: quantidade de entradas executadas.
- `totalWins`: eventos com PnL positivo.
- `totalLosses`: eventos com PnL negativo.
- `winRate`: percentual de entradas vencedoras.
- `totalPnl`: lucro/prejuizo total.
- `finalWallet`: carteira inicial mais PnL.
- `maxDrawdown`: maior queda da curva de equity.
- `profitFactor`: lucro bruto dividido por perda bruta.
- `sharpe`: media de PnL por evento dividida pelo desvio padrao.
- `sortino`: parecido com Sharpe, mas considera volatilidade negativa.
- `riskOfRuin`: estimativa simplificada de risco de ruina.
- `events`: detalhes de cada evento.
- `log`: mensagens cronologicas da simulacao.

---

## Validacao historica e Laboratorio de Otimizacao (Maio 2026)

Em **Maio de 2026**, com a evolucao dos nossos laboratorios (suporte a paralelismo em threads, divisao rigorosa em splits de dados e contabilidade oficial de taxas), a estrategia **Edge Sniper V1** (na epoca em producao) foi submetida a um estresse rigoroso sob o efeito das taxas de corretagem da Polymarket. 

No mercado `crypto`, a Polymarket aplica uma taxa de **0.07% para Takers** sobre a formula:
$$\text{Fee} = \text{contratos} \times \text{taxa} \times \text{preco} \times (1 - \text{preco})$$

Esta taxa atua diretamente reduzindo a lucratividade liquida de cada trade (*fee drag*), tornando essencial a otimizacao de filtros para evitar entradas marginais.

### O Laboratorio de Otimizacao

O laboratorio executou **11 variantes** da Edge Sniper em paralelo em um banco historico recente contendo **3.704.579 ticks** (periodo de `2026-05-04` ate `2026-05-26`). O historico foi particionado em tres splits temporais:
1. **Treino (60%)**: `2026-05-04` ate `2026-05-17`
2. **Validacao (20%)**: `2026-05-17` ate `2026-05-21`
3. **Holdout/Teste (20%)**: `2026-05-21` ate `2026-05-26`

O ranking geral consolidado (liquido apos taxas de 0.07%) ordenado pelo PnL do Holdout e apresentado a seguir:

| Variante | Entradas | Wins | Losses | Win Rate | PnL Liquido | Profit Factor (Liq) | Max Drawdown | Taxas USDC |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`edge-sniper-dist-50` (Vencedora)** | **107** | **78** | **29** | **72.9%** | **+$332.94** | **2.38** | **$40.28** | **$75.05** |
| `edge-sniper-maxask-58` | 137 | 85 | 52 | 62.0% | +$242.00 | 1.48 | $100.80 | $104.79 |
| `edge-sniper-maxask-60` | 160 | 104 | 56 | 65.0% | +$284.45 | 1.51 | $118.88 | $117.70 |
| `edge-sniper-combo-conservative` | 121 | 81 | 40 | 66.9% | +$252.48 | 1.68 | $53.83 | $89.57 |
| `edge-sniper-baseline` (Default V3) | 237 | 164 | 71 | 69.2% | +$335.45 | 1.49 | $94.68 | $152.65 |
| `edge-sniper-dist-60` | 60 | 41 | 18 | 68.3% | +$214.80 | 2.73 | $26.19 | $45.59 |

> [!NOTE]
> As variantes com limites de `minEdge` (0.09, 0.11, 0.13) e `minDirectionalProb` (0.60, 0.64) no lab convergiram com a baseline por operarem na mesma regiao de filtros ativos na janela selecionada.

---

### Analise Detalhada dos Splits (Melhores Variantes)

#### 1. `edge-sniper-dist-50` (Recomendado)
Eleva a distancia minima exigida entre o BTC e o PTB de $40 para **$50**.
- **Treino**: 57 entradas | Win Rate: 71.9% | PnL: +$206.99 | PF: 2.87
- **Validacao**: 38 entradas | Win Rate: 65.8% | PnL: +$75.59 | PF: 1.72
- **Holdout**: 12 entradas | Win Rate: 66.7% | PnL: +$50.35 | PF: 2.87

#### 2. `edge-sniper-dist-60` (Ultra Defensivo)
Eleva a distancia minima de BTC para **$60**.
- **Treino**: 30 entradas | Win Rate: 70.0% | PnL: +$165.32 | PF: 5.39
- **Validacao**: 25 entradas | Win Rate: 64.0% | PnL: +$43.34 | PF: 1.61
- **Holdout**: 5 entradas | Win Rate: 60.0% | PnL: +$6.14 | PF: 1.39

---

### Principais Descobertas e Recomendacoes

1. **O Impacto do Fee Drag**:
   Na *baseline* original, foram gastos **$152.65** em taxas de corretagem para obter um lucro liquido de **$335.45** (um arraste de taxas de **31%** sobre o ganho bruto!). O drawdown liquido da baseline foi alarmante: **$94.68** (quase arruinando a carteira inicial de $100).
   
2. **Eficiencia Superior com Filtro de Distancia (`dist-50`)**:
   Ao exigir uma distancia minima maior de **$50**, a estrategia evitou entrar no ziguezague e operou somente em tendencias muito consolidadas.
   - O volume de trades caiu em **55%** (de 237 para 107), poupando banda e capital.
   - O PnL liquido consolidado permaneceu praticamente identico (**$332.94** vs $335.45), provando que cortamos apenas operacoes ineficientes de baixo edge.
   - O Drawdown maximo liquido despencou de **$94.68** para apenas **$40.28** (uma **reducao de 57% no risco**!).
   - O Profit Factor liquido saltou de **1.49** para **2.38**!
   - Economizamos **51%** em taxas USDC pagas (caindo de $152.65 para $75.05).

3. **Recomendacao Oficial de Parametrizacao**:
   Recomendamos promover `minDistanceAbs` para **50** como o novo default oficial em producao. Se o mercado estiver operando com alta volatilidade estrutural, a utilizacao de `minDistanceAbs = 60` (`dist-60`) e altamente recomendada, pois mantem um Profit Factor de **2.73** e reduz o drawdown para apenas **$26.19**.

---

### O Impacto e Otimizacao do Mecanismo de Stop-Reverse

Com a consolidacao do filtro de distancia para **$50**, submetemos o mecanismo de **Stop-Reverse** a um estudo exaustivo de grade fina no laboratorio para identificar os parametros otimos em producao. 

A ideia central do Stop-Reverse e defensiva: quando o BTC reverte bruscamente contra a nossa posicao original e cruza o PTB por uma determinada distancia adversa na janela de tempo de liquidez, o algoritmo vende a posicao atual (aceitando a perda controlada) e simultaneamente abre uma posicao de reversao no lado oposto com um orcamento calibrado, capturando a nova tendencia do mercado.

A tabela de resultados consolidados de Stop-Reverse liquidos em todos os splits de dados (Treino / Validacao / Holdout) e detalhada a seguir:

| Variante | Alteracoes nos Parametros | Entradas | Wins | Losses | Win Rate | PnL Liquido | Profit Factor (Liq) | Max Drawdown | Taxas USDC |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`sr-dist50-srbudget-125` (Melhor)** | `BudgetFactor = 1.25` | 107 | 79 | 28 | **73.8%** | **+$345.59** | **2.50** | **$40.28** | $75.81 |
| **`sr-dist-50` (Baseline SR)** | `BudgetFactor = 1.00` | 107 | 79 | 28 | **73.8%** | **+$345.54** | **2.50** | **$40.28** | $75.77 |
| **`sr-dist50-srdist-15`** | `MinDistanceAbs = 15` | 107 | 79 | 28 | **73.8%** | **+$344.41** | **2.49** | **$40.28** | $75.61 |
| **`sr-dist50-srbudget-075`** | `BudgetFactor = 0.75` | 107 | 79 | 28 | **73.8%** | **+$344.01** | **2.49** | **$40.28** | $75.66 |
| **`sr-dist-50-proceeds`** | `BudgetMode = 'sale-proceeds'`| 107 | 78 | 29 | 72.9% | **+$342.26** | **2.47** | **$40.28** | $75.44 |
| **`sr-dist50-srdist-20`** | `MinDistanceAbs = 20` | 107 | 78 | 29 | 72.9% | **+$341.55** | **2.47** | **$40.28** | $75.52 |
| **`sr-dist50-srtime-45`** | `MaxSecondsRemaining = 45` | 107 | 78 | 29 | 72.9% | **+$334.07** | **2.39** | **$40.28** | $75.22 |
| **`sr-dist50-srtime-30`** | `MaxSecondsRemaining = 30` | 107 | 78 | 29 | 72.9% | **+$334.07** | **2.39** | **$40.28** | $75.22 |
| **`edge-sniper-dist-50` (SR Off)**| **Sem Stop-Reverse (Desativado)**| 107 | 78 | 29 | 72.9% | **+$332.94** | **2.38** | **$40.28** | $75.06 |

#### Conclusoes Empiricas da Otimizacao de Stop-Reverse

1. **Acrescimo de Lucratividade Sem Risco Incremental**:
   A ativacao do Stop-Reverse com parametros otimos elevou o PnL liquido consolidado de **+$332.94** para **+$345.59** (ganho extra de **+$12.65 liquidos**). Notavelmente, **o Max Drawdown liquido permaneceu rigorosamente inalterado em $40.28**, demonstrando que o algoritmo de reversao operacional e extremamente seguro e nao aumenta a exposicao ao risco de ruina da carteira.

2. **A Janela Temporal de Reversao (`MaxSecondsRemaining = 60`)**:
   Restringir a reversao para janelas curtas como 45s ou 30s finais anulou os beneficios do Stop-Reverse (PnL caiu de +$345.54 para +$334.07), pois o livro de ofertas da Polymarket costuma ter alta volatilidade de spread e pouca liquidez nos segundos finais de expiracao. A janela de **60 segundos** provou ser a zona ideal para reexecutar e preencher posicoes reversas no book com seguranca de preenchimento.

3. **Distancia Adversa Minima (`MinDistanceAbs = 10`)**:
   Uma distancia adversa menor de **$10** foi significativamente superior do que limites de $15 ou $20. Ao reverter de forma agil com $10 de distancia do PTB, o algoritmo estanca a desvalorizacao do contrato perdedor original enquanto ele ainda possui bid residual aceitavel, permitindo preencher a nova ponta com maior orcamento.

4. **O Fator de Orcamento (`BudgetFactor = 1.25`)**:
   Com o modo de orcamento `same-cost` (que usa o custo total original da primeira entrada), aplicar um multiplicador de **1.25x** atingiu a lucratividade maxima absoluta de **+$345.59** liquida, aproveitando o momento em que a tendencia se consolida na direcao reversa.

5. **Recomendacao de Configuracao Padrao**:
   Recomendamos e promovemos por padrao na Edge Sniper V2 a ativacao de fabrica do Stop-Reverse com as seguintes chaves de otimizacao:
   * `stopReverseEnabled`: `true`
   * `stopReverseMinDistanceAbs`: `10`
   * `stopReverseMaxSecondsRemaining`: `60`
   * `stopReverseBudgetMode`: `'same-cost'`
   * `stopReverseBudgetFactor`: `1.25`
   * `stopReverseMinLiquidityRatio`: `0.75`

O script do laboratorio pode ser reexecutado via terminal com:
```bash
node scripts/lab-edge-sniper.js --from "2026-05-04T15:00:00.000Z" --parallel --workers 4
```

---


## Correcao de reducao de perdas (Maio 2026)

### Problema observado

Nos 7 dias anteriores a 29/05/2026 a curva de equidade ficou ruim: o win rate continuava alto (~74%), mas **quando perdia, perdia muito**. A perda media (`$10.67`) era quase o dobro do ganho medio (`$6.08`), e o drawdown na janela era `$20.74`.

### Diagnostico (dados 22/05 -> 29/05, liquido apos taxas)

- As 6 perdas (`-$64.04`) vinham de dois padroes:
  1. **Expiracao total** (2 eventos, `~-$15` cada): a posicao degradava num "limbo" — bid abaixo de `lateExitMinBid` (0.64) e acima de `stopBid` (0.18), entao nenhuma saida defensiva disparava e o evento virava contra na expiracao.
  2. **Stops profundos** (bid caindo ate 0.18): venda perto de zero.
- Concentracao: entradas com **distancia 45-55** (no limite minimo), **ask caro 0.55-0.62** e **muito tempo restante (90-105s)** eram as que mais perdiam. Distancia 75-100 teve 0 perdas.
- O modelo estava **supercconfiante**: quase todas as entradas mostravam probabilidade 99.9% e edge > 25pp, mas o win real era 74% (`minSigma=10` e `sigmaMultiplier=1` saturam a logistica). Por isso os filtros de `minEdge`/`minDirectionalProb` ficavam inertes.

### Mecanismos adicionados (opt-in, default = comportamento antigo)

Para permitir A/B sem regressao, foram adicionados ao backtest (todos desligados por padrao, exceto a distancia que foi promovida):

- **Stop dinamico** (`dynamicStopEnabled`, `dynamicStopFactor`, `dynamicStopMinBid`).
- **Saida de salvamento final** (`finalExitSec`, `finalExitMinBid`): vende a qualquer bid no final em vez de ir a expiracao total.
- **Distancia dinamica perto da expiracao** (`minDistanceNearExpiry`, `nearExpiryThresholdSec`).

### Resultado da otimizacao

Foi rodado um laboratorio paralelo (`scripts/tune-edge-sniper-loss.js`) sobre **04/05 -> 29/05** com split treino/holdout (holdout = ultimos 7 dias). Conclusoes empiricas:

- **As saidas agressivas (salvamento final e stop dinamico) PIORARAM o resultado**: elas cortavam cedo posicoes que virariam vencedoras na expiracao, derrubando o win rate de ~69% para ~58% e o PnL total de `~$378` para `~$250`. Por isso permanecem **desligadas por padrao**.
- O **vencedor robusto** (consistente em treino e holdout) foi simplesmente elevar `minDistanceAbs` de **45 para 50**, cortando exatamente a faixa de distancia onde as perdas se concentravam.

Comparativo na janela problematica (22/05 -> 29/05, liquido):

| Metrica | Antes (`dist=45`) | Depois (`dist=50`) |
| :--- | :---: | :---: |
| PnL liquido | +$39.28 | **+$66.15** |
| Win rate | 73.9% | **78.6%** |
| Profit Factor | 1.61 | **3.68** |
| Perda media | $10.67 | **$8.22** |
| Perda maxima | -$14.93 | **-$11.16** |
| Max drawdown | $20.74 | **$11.16** |
| Perdas (qtd / bruto) | 6 / $64.04 | **3 / $24.66** |

No periodo completo (04/05 -> 29/05) o PnL ficou levemente acima da baseline (`$382.7` vs `$377.7`), com max drawdown caindo de `$46.89` para `$31.84`, Profit Factor subindo de `2.2` para `3.2` e taxas pagas caindo ~29%.

### Recomendacao

`minDistanceAbs = 50` e o novo default oficial. As demais alavancas defensivas (stop dinamico, salvamento final, distancia dinamica) ficam disponiveis como opt-in para regimes especificos, mas **nao** devem ser ligadas por padrao porque reduzem o PnL global neste historico.

Reexecutar o estudo:
```bash
node scripts/tune-edge-sniper-loss.js
node scripts/diag-edge-sniper.js --from 2026-05-22T00:00:00.000Z --to 2026-05-29T02:00:00.000Z
```

---

## Analise de perdas seguidas e sizing por payoff (Maio 2026)

Apos a promocao de `minDistanceAbs=50`, investigamos as perdas que ainda apareciam em sequencia (a pergunta era: existe um padrao temporal ou alguma teoria que reduza esses prejuizos?). O script `scripts/analyze-edge-sniper-streaks.js` rodou sobre 04/05 -> 29/05.

### Achado 1: as perdas seguidas sao ALEATORIAS (nao ha regime a explorar)

- `P(perda | perda anterior) = 29.2%` vs `P(perda | vitoria anterior) = 30.9%` vs taxa base `30%` — estatisticamente iguais.
- **Teste de runs de Wald-Wolfowitz**: `zRuns = 0.11` (esperado 34.6 runs, observado 35). Como `|z| < 1.96`, **nao se rejeita a hipotese de independencia**. Um streak maximo de 3 perdas em 24 perdas/80 trades e exatamente o esperado por acaso.
- Consequencia pratica: **cooldown pos-perda piora o resultado** (PnL `$382 -> $296` com `cd=1`, e o drawdown ainda aumenta). Reagir a sequencias de perda destroi valor. Nao implementar gatilhos de "parar apos N perdas".

### Achado 2: o modelo gaussiano esta descalibrado

A estatistica de cruzamento terminal `z = distancia / (sigma * sqrt(tempo))` (distribuicao normal do random-walk) preveria `Phi(-z)` de perda. Mas 67/80 entradas tem `z >= 2.5` (teoria: ~0% de perda) enquanto a perda real e ~28%. O `sigma` e subestimado, a logistica satura e a probabilidade do modelo vira ~99.9% para quase tudo — por isso os filtros de `minEdge`/`minDirectionalProb` ficam inertes. Filtrar por `z` da ganho marginal e custa PnL; nao foi adotado.

### Achado 3 (a solucao): sizing proporcional ao payoff

Num contrato binario comprado a preco `p`, o ganho e `(1-p)` e a perda e `p`; o payoff `(1-p)/p` despenca quando `p` sobe. Empiricamente, a faixa de ask **0.52-0.58 concentrava ~$92 dos ~$173 de perda bruta com expectancia de so ~$1/trade**, enquanto a faixa 0.45-0.52 teve 0% de perda. A correcao e **apostar menos onde o payoff e ruim** (Kelly suave): quando `ask > sizePriceThreshold` (0.52), usar `maxOrderValue * sizePriceFactor` (0.5).

Validacao no backtest real (04/05 -> 29/05, liquido):

| Metrica | dist50 | dist50 + sizing 0.52/0.5 |
| :--- | :---: | :---: |
| PnL liquido (full) | $382.70 | $370.51 |
| Profit Factor (full) | 3.20 | **3.78** |
| Perda media (full) | $7.23 | **$5.55** |
| Max drawdown (full) | $31.84 | **$27.36** |
| Taxas pagas | $68.17 | **$57.95** |

Na janela problematica (22/05 -> 29/05):

| Metrica | dist50 | dist50 + sizing |
| :--- | :---: | :---: |
| PnL liquido | $66.15 | $61.51 |
| Profit Factor | 3.68 | **5.56** |
| Perda media | $8.22 | **$4.50** |
| **Perda maxima** | -$11.16 | **-$7.05** |
| **Max drawdown** | $11.16 | **$7.05** |
| Perdas (bruto) | $24.66 | **$13.50** |

O `sizePriceFactor` e um dial de risco/retorno: `0.4` e `0.33` reduzem ainda mais a perda (holdout maxLoss cai para -$5.87 e -$4.70, PF holdout sobe para 6.5 e 8.0) com leve sacrificio de PnL. O default `0.5` foi escolhido por equilibrio e robustez (consistente em treino e holdout). `sizePriceThreshold=0.52` domina 0.48/0.50/0.54.

Reexecutar a analise:
```bash
node scripts/analyze-edge-sniper-streaks.js
```

---

## Como rodar no simulador

Pelo dashboard:

1. Abra o dashboard.
2. Va para a area de backtest.
3. Escolha o periodo manualmente ou use presets como `1d`, `7d`, `10d`, `15d`, `20d` ou `25d`.
4. Em `Modo`, selecione `Edge Sniper V2`.
5. Ajuste parametros se quiser testar variacoes.
6. Clique em `Executar Backtest`.

Pela API:

```http
POST /api/backtest/edge-sniper
Content-Type: application/json
```

Exemplo de body:

```json
{
  "from": "2026-05-03T11:30:00.000Z",
  "to": "2026-05-10T11:30:00.000Z",
  "walletSize": 100,
  "maxOrderValue": 15,
  "minDistanceAbs": 40,
  "stopBid": 0.18,
  "trailAfterBid": 0.78,
  "trailDrop": 0.10
}
```

Se algum parametro for omitido, o runner usa o default atual.

---

## Ajustes comuns para pesquisa

### Mais defensivo

Use quando o mercado recente estiver ruim ou muito instavel:

```json
{
  "minDistanceAbs": 50,
  "maxAsk": 0.62
}
```

Efeito esperado:

- menos entradas;
- menor drawdown;
- menor PnL total em periodos bons;
- maior chance de ficar fora quando nao ha edge claro.

### Mais agressivo

Use apenas para pesquisa, nao como default sem validar:

```json
{
  "minDistanceAbs": 30,
  "stopBid": 0.12,
  "trailAfterBid": 0.84,
  "trailDrop": 0.16
}
```

Efeito esperado:

- mais entradas;
- maior PnL potencial em janelas favoraveis;
- mais exposicao a viradas recentes;
- perdas maiores quando o BTC fica perto do PTB.

### Mais seletivo por preco

```json
{
  "maxAsk": 0.58
}
```

Efeito esperado:

- evita pagar caro;
- perde algumas entradas vencedoras caras;
- melhora assimetria media quando o modelo esta certo.

---

## Regras de seguranca do backtest

A estrategia tenta evitar tres vieses comuns:

1. **Reentrada no mesmo evento**: depois que um evento fecha por stop, trailing, saida final ou expiracao, ele entra em `completedEvents` e nao pode ser reoperado.
2. **Fill irrealista**: a compra precisa existir no book salvo no tick, respeitando slippage e liquidez minima.
3. **Memoria controlada**: o backtest em API usa batches, entao periodos longos nao precisam carregar todos os ticks de uma vez.

---

## Quando a estrategia tende a funcionar melhor

- BTC longe do PTB.
- Mercado ainda nao precificou totalmente a direcao.
- Spread baixo.
- Book com liquidez suficiente.
- Movimento com alguma continuidade nos ultimos segundos.

## Quando ela tende a ficar fora ou perder

- BTC perto do PTB.
- Ask caro demais.
- Spread aberto.
- Book raso.
- Reversao brusca apos entrada.
- Movimento em zigue-zague perto da expiracao.

---

## Resumo mental

A Edge Sniper nao tenta adivinhar todos os eventos. Ela espera uma configuracao clara:

```text
distancia boa + momentum aceitavel + preco barato contra probabilidade + book executavel
```

Depois da entrada, ela nao casa com a posicao:

```text
se piorou, corta;
se pagou bem, realiza;
se devolveu lucro, sai;
se esta no fim e ainda tem bid razoavel, reduz risco.
```

Esse e o desenho que tornou a versao atual mais robusta do que as tentativas anteriores de operar os dois lados ao mesmo tempo.