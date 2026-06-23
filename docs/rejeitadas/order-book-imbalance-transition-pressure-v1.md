# Order Book Imbalance Transition Pressure (OBITP) V1

A **Order Book Imbalance Transition Pressure (OBITP) V1** é uma teoria quantitativa concebida para operar no mercado BTC Up/Down de 5 minutos na Polymarket. Ela investiga uma ineficiência de **microestrutura profunda**: a inércia dos market makers e robôs de varejo em atualizar os preços de topo (*best ask*) durante a zona de transição de estado da barreira (quando o BTC está próximo ao *Price to Beat*). 

A OBITP mede o **Order Book Imbalance (OBI)** profundo nas 3 primeiras faixas de preço para antecipar a direção do rompimento físico do BTC antes do ajuste do preço do favorito.

* **Laboratório:** `scripts/lab-obitp.js`
* **Comando npm:** `npm run lab:obitp`
* **Destino:** **REJEITADA** (arquivada por falha nos critérios de sobrevivência no Holdout).

---

## 1. Hipótese Científica

A hipótese principal da OBITP sustenta que:
1. Quando o BTC está no "limiar de decisão" (zona de gama crítica, próximo ao PTB, medido por $Dist_{norm}$), os criadores de mercado acumulam ordens limitadas de compra de um dos lados no livro profundo antes de deslocar o preço de topo daquele lado.
2. Esse acúmulo de ordens limitadas cria um desbalanceamento volumétrico assimétrico ($OBI_{deep}$) que prevê o lado vencedor antes que o book sofra *repricing* completo.
3. Comprar o favorito quando o seu livro profundo exibe forte pressão compradora ($OBI_{deep} \ge 0.65$) oferece vantagem estatística bruta robusta o suficiente para superar a barreira das taxas taker de 7% reais na Polymarket.

A hipótese secundária de comparação, **Temporal Drift Velocity Dispersion (TDVD)**, propõe que as opções sofrem *mispricing* devido ao descompasso de velocidade física instantânea do BTC de curtíssimo prazo e o decaimento temporal $\tau$, gerando oportunidades quando a dispersão em relação à probabilidade teórica se expande.

---

## 2. Modelagem Matemática

### Hipótese A: OBITP V1
Variáveis extraídas a cada tick:
```text
dist       = btc_price - price_to_beat
tau        = segundos até a expiração do evento
winner     = UP se dist >= 0, senão DOWN
favorite   = UP se dist >= 0, senão DOWN
askFav     = best ask do favorito
bidFav     = best bid do favorito
spreadFav  = askFav - bidFav
```

Medição da profundidade volumétrica ponderada pelo spread nas 3 primeiras faixas do livro de ordens de bids e asks:
```text
bidQty3    = Q_bid_1 + Q_bid_2 + Q_bid_3
askQty3    = Q_ask_1 + Q_ask_2 + Q_ask_3
obiDeep    = (bidQty3 - askQty3) / max(10, bidQty3 + askQty3)
distNorm   = |dist| / sqrt(tau)
```

Modelo de precificação física teórica coerente via Movimento Browniano Geométrico:
```text
sigma_real = std( (BTC_i - BTC_{i-1}) / sqrt(dt) )     ; lookback 60s
zCoherent  = |dist| / (sigma_real * sqrt(tau))
pCoherent  = Phi(zCoherent)                             ; normal cdf
edgeBruto  = pCoherent - askFav
feeShare   = calculatePolymarketTakerFee({ shares: 1, price: askFav })
edgeLiquido = edgeBruto - feeShare
```
**Métrica de Decisão (Entrada):** $obiDeep \ge minObiDeep$ com $distNorm \in [minDistNorm, maxDistNorm]$, $edgeLiquido \ge minNetEdge$ e spread sob controle.

---

## 3. Parâmetros de Execução (Variante Robust)

| Parâmetro | Valor Padrão | Função no Modelo |
|---|---:|---|
| `entryWindowStart` | 150s | Início do monitoramento de transição |
| `entryWindowEnd` | 45s | Evita zona caótica terminal |
| `minObiDeep` | 0.65 | Assimetria mínima volumétrica do livro |
| `minDistNorm` / `maxDistNorm` | 0.45 / 2.0 | Faixa de barreira de transição |
| `askMin` / `askMax` | 0.53 / 0.67 | Payoff viável para suportar taxa e spread |
| `maxSpread` | 0.03 | Liquidez saudável mínima |
| `minNetEdge` | 0.05 | Edge líquido teórico mínimo exigido |
| `volLookbackSec` | 60s | Janela de volatilidade realizada do BTC |
| `maxOrderValue` | $15 | Risco máximo alocado por evento |

---

## 4. Resultados Empíricos (Backtest Completo)

O laboratório de testes paralelos foi executado no período de **2026-05-04** a **2026-05-23** com o banco local de 3.307.185 ticks. A divisão dos dados seguiu estritamente o critério de split cronológico **60% Treino / 20% Validação / 20% Holdout**. As taxas takers foram calculadas de forma realista via `polymarketFees.js`.

### Desempenho Consolidado (Período Completo)

| Variante | Entradas | WR | PnL Bruto | Fees Taker | PnL Líquido | PF | Max DD | ROI/Trade |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **obitp-robust** | 1.345 | 65.4% | +1612.53 | 526.85 | **+1085.68** | 1.16 | 261.17 | +5.72% |
| obitp-base | 2.201 | 64.2% | +1953.80 | 862.58 | **+1091.22** | 1.10 | 397.61 | +3.50% |
| *baseline-random* | 2.559 | 61.4% | +387.48 | 1005.94 | **-618.46** | 0.96 | 1085.37 | -1.69% |
| tdvd-robust | 3.088 | 62.7% | +440.75 | 1161.84 | **-721.09** | 0.96 | 1146.64 | -1.64% |
| tdvd-base | 3.221 | 62.0% | +507.36 | 1241.91 | **-734.55** | 0.96 | 1262.82 | -1.60% |

### Análise por Splits (60 / 20 / 20)

#### Variante `obitp-robust` (Principal)
* **Treino (60%):** 804 trades | WR: **66.4%** | PnL Líquido: **+$846.20** | PF: **1.22**
* **Validação (20%):** 250 trades | WR: **66.0%** | PnL Líquido: **+$237.56** | PF: **1.19**
* **Holdout (20%):** 291 trades | WR: **62.2%** | PnL Líquido: **+$1.92** | PF: **1.00**

#### Variante `obitp-base` (Padrão)
* **Treino (60%):** 1.311 trades | WR: **64.8%** | PnL Líquido: **+$865.07** | PF: **1.13**
* **Validação (20%):** 444 trades | WR: **64.2%** | PnL Líquido: **+$239.97** | PF: **1.10**
* **Holdout (20%):** 446 trades | WR: **62.6%** | PnL Líquido: **-$13.81** | PF: **0.99**

### Desempenho Recente (Últimas Janelas de Mercado)

| Janela | obitp-robust | baseline-random | baseline-edge-sniper-v1 |
|---|---:|---:|---:|
| **Últimas 72h** | **-$80.07** | +$2.61 | **+$69.85** |
| **Últimas 24h** | **-$135.97** | -$59.11 | **+$7.07** |

---

## 5. Por Que a Teoria Falhou?

Apesar do PnL líquido total acumulado de **+$1.085,68** parecer extremamente vencedor em termos históricos absolutos, a estratégia foi rigorosamente classificada como **rejeitada** devido aos seguintes fatos quantitativos:

1. **Colapso do Edge no Holdout (Deterioração Temporal):**
   * O PnL líquido no Holdout (últimos 20% do tempo) colapsou para **+$1,92** na variante robusta e ficou negativo (**-$13,81**) na variante padrão.
   * O **Profit Factor líquido no holdout despencou para 1.00** em `obitp-robust` (muito abaixo do limiar aceitável de **2.0**).
   * O win rate caiu de **66.4%** no treino para **62.2%** no holdout, sugerindo que o desbalanceamento de livro foi arbitrado por outros agentes ou sofreu com regimes de mercado desfavoráveis no final de Maio.
2. **Sensibilidade Extrema ao Custo Operacional (Fee Drag):**
   * Em `obitp-robust`, as fees taker pagas totalizaram **$526.85**, o que representa um peso avassalador de **32.6% do PnL Bruto** ($1.612,53).
   * Quando o win rate bruto cai ligeiramente de 66% para 62% (redução de apenas 4 pp), as taxas taker absorvem 100% da margem bruta de ganho. A estratégia opera sob fio de navalha estatístico.
3. **Instabilidade Recente (72h / 24h Negativas):**
   * As últimas 72 e 24 horas exibiram fortes perdas líquidas (-$80.07 e -$135.97). O desbalanceamento do livro gerou muitos falsos sinais de rompimento devido a micro-drifts curtos do BTC que reverteram rapidamente na barreira, ativando liquidações.
4. **Fracasso Absoluto da Variante TDVD:**
   * A hipótese de velocidade física instantânea do BTC demonstrou ruído extremo, gerando perdas líquidas severas (-$721.09) impulsionadas por turnover excessivo que inflou o fee drag para patamares insustentáveis.

---

## 6. Limitações e Riscos

1. **Risco de Falsos Rompimentos (Gama Terminal):** O desbalanceamento profunda do livro é suscetível a "spoofing" (ordens falsas que são canceladas antes da execução) ou a ordens de baleias que reagem tarde ao BTC físico.
2. **Inércia de Liquidez:** Fills parciais degradam fortemente o edge. Se parte da ordem for executada a um preço pior com slippage, o edge líquido restante é destruído pelas taxas.
3. **Turnover Excessivo:** A OBITP gera em média 70 trades por dia. Com tamanho turnover, qualquer variação negativa no spread médio ou alteração no regime de volatilidade causa perdas líquidas imediatas.

---

## 7. Conclusão e Veredito

A **OBITP V1** documentou um fenômeno de microestrutura real (inércia e pressão de fluxo do livro) que gerou resultados espetaculares no conjunto de Treino e Validação. Contudo, ela **não demonstrou robustez temporal** ao passar pelo teste cego de Holdout, falhando em manter o edge de sobrevivência líquida pós-fees taker e demonstrando fragilidade extrema nas últimas 72 horas.

A teoria **não sobrevive às condições realistas e estritas** do mercado do mundo real da Polymarket.

### Ações de Arquivamento
* O script de laboratório `scripts/lab-obitp.js` será mantido no repositório exclusivamente para fins acadêmicos e preservação histórica de microestrutura profunda.
* O comando npm no `package.json` será mantido para possibilitar revalidações caso ocorra corte nas taxas Polymarket.
* **Nenhum deploy para ambiente de produção será realizado.**
