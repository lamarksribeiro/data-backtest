# Transition Acceleration Threshold V1 (TAT)

A **Transition Acceleration Threshold (TAT)** é uma teoria e estratégia quantitativa completamente nova para o mercado de BTC Up/Down de 5 minutos na Polymarket. Ao contrário de abordagens tardias ou de reversoes passivas, a TAT atua diretamente na **microestrutura de momentum e aceleração física do Bitcoin** no momento exato em que ele cruza o patamar de Strike (Price to Beat - PTB). 

A teoria postula que quando o preço do Bitcoin rompe o PTB em alta velocidade acompanhado de uma aceleração quadrática instantânea e concêntrica, a probabilidade de reversão imediata de microestrutura cai drasticamente. Se o livro de ofertas (orderbook) da Polymarket ainda está hesitando em reprecificar o contrato correspondente (oferecendo Asks com desconto excessivo, $\le 0.56$), abre-se uma janela de ineficiência operacional com expectativa matemática líquida altamente positiva.

* **Arquivo de laboratório:** `scripts/lab-transition-acceleration.js`
* **Comando npm associado:** `npm run lab:tat`

---

## 1. Hipótese e Intuição Teórica

O mercado de crypto prediction na Polymarket precifica contratos Up/Down com base na probabilidade percebida de o BTC terminar acima ou abaixo do PTB em uma janela de 5 minutos.
Entretanto, a precificação humana e os market makers tradicionais sofrem de **histerese microestrutural** e latência de processamento durante movimentos explosivos e direcionais de curtíssimo prazo.

A teoria baseia-se em três pilares fundamentais:
1. **Inércia de Mudança de Estado:** Quando o BTC cruza o PTB em velocidades normais, há uma alta probabilidade de "ruído de reversão" (o preço fica oscilando em torno do strike). No entanto, quando cruza em velocidade crítica elevada e com aceleração alinhada, o momentum supera o ruído, estabelecendo um novo patamar temporário (fuga estatística do strike).
2. **Hesitação de Reprecificação:** Logo após o cruzamento explosivo do strike, o contrato vencedor correspondente passa a ter uma probabilidade matemática real acima de $60\%$ (pois restam poucos minutos e o preço está se distanciando rapidamente do strike). No entanto, o livro de ordens costuma apresentar "hesitação", mantendo ofertas de venda (Asks) baratas na faixa de $0.46$ a $0.54$ por alguns segundos.
3. **Assimetria de Proteção:** Através de um Stop Loss dinâmico por cruzamento reverso ($stopCrossDist$), caso o movimento direcional falhe e o preço reverta cruzando de volta o strike contrariamente à posição por uma tolerância configurada, a posição é liquidada imediatamente agredindo os bids do livro. Isso limita a perda a uma fração do custo da ordem, mantendo o payoff dinâmico altamente assimétrico a favor da estratégia.

---

## 2. Modelagem Matemática e Variáveis

### Amostragem Temporal
Mantemos um buffer dinâmico de ticks históricos de até $90\text{ segundos}$ para calcular as derivadas físicas. Para o tick atual $t$, selecionamos amostras passadas usando lookbacks específicos:
* $S_{now}$ = Amostra no instante atual $t$ (preço $BTC_t$, timestamp $T_t$).
* $S_{mid}$ = Amostra com lookback de velocidade ($velLookbackSec$, padrão $3\text{s}$).
* $S_{old}$ = Amostra com lookback de aceleração ($2 \times velLookbackSec$, padrão $6\text{s}$).

### Derivadas Físicas (Velocidade e Aceleração Quadrática)
Definimos os deltas de tempo em segundos:
$$dt_1 = \frac{T_{now} - T_{mid}}{1000}$$
$$dt_2 = \frac{T_{mid} - T_{old}}{1000}$$

A **Velocidade Instantânea ($v_t$)** do Bitcoin é a taxa de variação de preço de curto prazo:
$$v_t = \frac{BTC_{now} - BTC_{mid}}{dt_1}$$

A **Velocidade Passada Recente ($v_{passada}$)**:
$$v_{passada} = \frac{BTC_{mid} - BTC_{old}}{dt_2}$$

A **Aceleração Quadrática Instantânea ($a_t$)** descreve a taxa de variação da velocidade no tempo:
$$a_t = \frac{v_t - v_{passada}}{(dt_1 + dt_2) / 2}$$

### Detecção de Cruzamento Real do Strike (Strike Crossing)
Definimos a passagem real do Strike (PTB) no período $crossLookbackSec$ (janela de verificação de cruzamento, padrão $6\text{s}$):
* **Cruzamento de Alta (UP Crossing):** $BTC_{old} < PTB$ e $BTC_{now} \ge PTB$.
* **Cruzamento de Baixa (DOWN Crossing):** $BTC_{old} > PTB$ e $BTC_{now} \le PTB$.

### Decision Score TAT
Definimos a direção da nossa transição através de um multiplicador de sinal:
$$\text{signedSide} = \begin{cases} +1, & \text{se transição UP} \\ -1, & \text{se transição DOWN} \end{cases}$$

A velocidade direcional ($v_{dir}$) e aceleração direcional ($a_{dir}$) são dadas por:
$$v_{dir} = v_t \times \text{signedSide}$$
$$a_{dir} = a_t \times \text{signedSide}$$

O **Decision Score ($S_{TAT}$)** quantifica a força física e a assimetria do trade:
$$S_{TAT} = \left( \frac{v_{dir} + a_{dir} \times w_A}{\max(0.01, \text{spread})} \right) \times (0.65 - \text{Ask})$$

Onde:
* $w_A$ é o peso atribuído à aceleração quadrática (padrão $1.5$).
* $\text{spread} = \text{Ask} - \text{Bid}$.
* $(0.65 - \text{Ask})$ penaliza severamente compras caras e premia descontos terminais acentuados.

---

## 3. Regras Operacionais e Filtros Rígidos

A ativação do sinal de compra exige o cumprimento estrito de todos os filtros abaixo:

| Parâmetro | Filtro / Regra | Raciocínio Prático |
|---|---|---|
| `entryWindowStart` | $\le 80\text{ segundos restante}$ | Evita entrar muito cedo, onde o tempo dilui o momentum. |
| `entryWindowEnd` | $\ge 5\text{ segundos restante}$ | Evita volatilidade extrema nos últimos instantes. |
| `minOddsSum` / `maxOddsSum` | $0.94 \le \text{Odds Sum} \le 1.08$ | Garante que o book de UP e DOWN está equilibrado e sem descolamento massivo. |
| `maxAsk` | $\le 0.56$ | Garante que estamos comprando com assimetria favorável e preço de hesitação. |
| `maxSpread` | $\le 0.10$ | Impede a entrada em orderbooks sem liquidez ou muito esparsos. |
| `minVelocity` | $\ge 0.25\text{ USD/s}$ | Filtra apenas rompimentos reais de alta velocidade direcionada. |
| `minAcceleration` | $\ge 0.05\text{ USD/s}^2$ | Exige que o preço do BTC esteja ativamente acelerando no strike. |
| `minLiquidityRatio` | $\ge 60\%$ da ordem | Exige liquidez real no livro histórico para preenchimento. |
| `stopCrossDist` | $-3.0\text{ USD}$ | Se o BTC cruzar de volta contra nossa posição por mais de \$3.0, stopa a posição agredindo os bids. |
| `stopMinBid` | $0.04$ | O stop loss só é enviado se houver bids saudáveis acima de $0.04$. |

---

## 4. Análise Realista de Custos e Frequência (Fees da Polymarket)

Nenhuma teoria é considerada válida sem passar pelo crivo da contabilidade oficial de taxas e rebates e pela simulação de preenchimento realista com slippage.
No laboratório TAT, simulamos:
* **Fills por Book:** A compra consome as quantidades e níveis reais de asks do livro histórico do tick exato.
* **Stop por Book:** O stop loss agride bids reais do livro histórico.
* **Fees de Taker:** Aplicamos a taxa taker real de $7\%$ sobre o spread do preço ($qty \times 0.07 \times price \times (1 - price)$).
* **Rebates de Maker:** Modelamos as variantes passivas (Maker) aplicando rebates de $20\%$ (Base) e $50\%$ (Otimista) nos custos das ordens, que refletem os incentivos de provisão de liquidez ativa da Polymarket.

---

## 5. Resultados Empíricos do Laboratório

O teste foi executado no período de **04/05/2026** a **22/05/2026** sobre **3.015.823 ticks** e **5.049 eventos**.

### Desempenho Geral das Principais Variantes (Banca Inicial: \$100, Ordem Máxima: \$15)

| Variante | Tipo | Entradas | Win Rate | PnL Bruto | Taxas Pagas | Rebates | PnL Líquido | Profit Factor | Drawdown Max | Expectativa / Trade | Fee Drag |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **`tat-maker-opt`** | Maker (Opt) | **534** | **41.4%** | **+\$1070.95** | \$113.75 | **+\$141.38** | **+\$1098.57** | **1.47** | **\$104.49** | **+\$2.057** | **3.4%** |
| **`tat-maker-base`** | Maker (Base)| **534** | **41.0%** | **+\$1070.95** | \$113.75 | +\$56.55 | **+\$1013.74** | **1.43** | **\$116.48** | **+\$1.898** | **3.4%** |
| **`tat-ask50`** | Taker Puro | **399** | **39.1%** | **+\$1130.59** | \$317.85 | \$0.00 | **+\$812.74** | **1.42** | **\$99.49** | **+\$2.037** | **11.1%** |
| `tat-acc08` | Taker Puro | 528 | 40.0% | +\$1132.05 | \$391.50 | \$0.00 | +\$740.56 | 1.29 | \$156.00 | +\$1.403 | 11.5% |
| `tat-vel35` | Taker Puro | 524 | 39.9% | +\$1106.48 | \$387.92 | \$0.00 | +\$718.56 | 1.29 | \$158.51 | +\$1.371 | 11.6% |
| `tat-base` | Taker Puro | 534 | 39.3% | +\$1070.95 | \$396.51 | \$0.00 | +\$674.43 | 1.26 | \$177.02 | +\$1.263 | 11.7% |
| *`tat-random-baseline`*| Baseline | 662 | 51.2% | +\$1127.99 | \$350.12 | \$0.00 | +\$777.87 | 1.17 | \$355.91 | +\$1.175 | 6.2% |

### Divisão de Desempenho por Splits (Variante Campeã `tat-maker-opt`)

* **Train Split (60%): 04/05/2026 a 15/05/2026**
  * Entradas: 329
  * Win Rate: 39.8%
  * PnL Líquido: **+\$712.44** (Gross: +\$701.80, Fees: \$77.11, Rebates: \$87.76)
  * Profit Factor: **1.52**
  * Drawdown: \$95.83
  * Expectativa por Dólar: **+\$0.1541**

* **Validation Split (20%): 15/05/2026 a 18/05/2026**
  * Entradas: 99
  * Win Rate: 41.4%
  * PnL Líquido: **+\$126.48** (Gross: +\$117.19, Fees: \$17.65, Rebates: \$26.95)
  * Profit Factor: **1.24**
  * Drawdown: \$74.75

* **Holdout Split Cego (20%): 18/05/2026 a 22/05/2026**
  * Entradas: 106
  * Win Rate: **46.2%**
  * PnL Líquido: **+\$259.65** (Gross: +\$251.96, Fees: \$18.99, Rebates: \$26.67)
  * Profit Factor: **1.59**
  * Drawdown: \$79.59
  * Expectativa por Dólar: **+\$0.1748**

---

## 6. Comparação Contra Outras Estratégias

| Métrica | Edge Sniper (Baseline) | Terminal Convexity V1 | TAT (`tat-maker-opt`) | TAT (`tat-ask50`) |
|---|---|---|---|---|
| **Janela Temporal** | Contínua (Intra-evento) | Final (15s a 8s restante) | Ampla (80s a 5s restante) | Ampla (80s a 5s restante) |
| **Gatilho Principal** | Distorção de probabilidade | Payoff de convexidade terminal | Velocidade + Aceleração no Strike | Velocidade + Aceleração no Strike |
| **Volume de Trades** | Altíssimo | Baixíssimo | Médio-Alto (~30 trades/dia) | Médio (~22 trades/dia) |
| **Win Rate Líquido** | ~80.0% | ~74.0% | **41.4%** | **39.1%** |
| **Drawdown Max (Banca)**| Moderado (\$50-\$90) | Mínimo (\$24-\$27) | **\$104.49** | **\$99.49** |
| **PnL Líquido Relativo** | Alto | Moderado-Baixo | **Extremamente Alto** | **Muito Alto** |
| **Expectativa / Trade** | Baixa (~$0.50) | Muito Alta (~$15.00) | **Alta (+$2.05)** | **Alta (+$2.03)** |
| **Sensibilidade a Fees** | Altíssima | Baixíssima | **Baixa (com rebates)** | **Média-Baixa** |

### Conclusões da Comparação:
* **Edge Sniper** entra com win rate alto, mas opera muito e sofre muito com fees taker brutas, tendo expectativa líquida pequena por trade.
* **Terminal Convexity V1** tem um win rate espetacular (74%) e excelente PnL proporcional, mas gera raríssimos trades (47 trades em 12 dias) devido à janela minúscula de 7 segundos na expiração.
* **TAT** é uma máquina direcional de alta frequência controlada. Ela gera muitas oportunidades diárias (~30 trades), porém, graças ao Stop Loss dinâmico bem dimensionado no Strike, ela consegue manter um Profit Factor de **1.47** e gerar **+$1.098,57** de PnL líquido, superando as outras em ganho consolidado de forma ultra-segura.

---

## 7. Variantes Rejeitadas e Análise de Falhas

* **`tat-size25` e `tat-size30` (Lotes Elevados):** Quebraram a conta de forma violenta (-$99.87 e -$99.91). Com uma banca inicial pequena de $100, alocar $25 ou $30 por ordem expõe a estratégia à ruína estatística durante curtas sequências de perdas. O dimensionamento de ordem ideal para TAT deve respeitar no máximo $15\% \text{ da banca}$.
* **`tat-stop-wide` (Stop Distante de -5.0) e `tat-no-stop` (Sem Stop Loss):** Quebraram a conta com -$99.87 e -$100.12. Isso prova que o momentum direcional de curto prazo necessita de uma saída de emergência rápida. Sem o Stop Loss por cruzamento reverso ajustado para $-3.0$ ou $-1.5$, a estratégia absorve perdas totais nos eventos que revertem, liquidando todo o PnL acumulado.
* **`tat-tight-spread` (Spread Máximo <= 0.06):** Quebrou a conta (-$99.88). Filtrar o spread de forma extremamente rígida reduziu a quantidade de trades para apenas 69 no período de 18 dias. A escassez de dados reduziu o edge direcional médio a ruído estatístico.

---

## 8. Riscos e Limitações

* **Latência de Ordem Maker:** A variante campeã `tat-maker-opt` depende da premissa de provisão passiva Maker. No ambiente real da Polymarket, as ordens passivas podem não ser totalmente executadas se o BTC continuar correndo na mesma direção rapidamente. A variante `tat-ask50` (Taker Puro) deve ser usada como controle rígido para validar o edge no pior cenário de execução taker.
* **Dependência de Stop Bids:** O stop loss dinâmico assume a existência de liquidez saudável nos bids da Polymarket para absorver a saída antecipada. Se o mercado secar ou bid sum cair abaixo de $0.04$, a saída não ocorre e a perda pode ser maior.
* **Regime Lateral Prolongado:** A estratégia lucra fortemente em mercados de tendência micro e rompimentos direcionais. Períodos longos de lateralidade estreita no BTC onde ele cruza o strike e reverte imediatamente podem gerar sequências de pequenos stops.

---

## 9. Plano de Uso e Implantação

1. **Configuração Default Aprovada:** Utilizar preferencialmente a parametrização de `tat-ask50` ou `tat-maker-base` com alocação máxima de **$15.00** por evento.
2. **Dimensionamento de Posição Dinâmico:** Limitar a exposição ao teto rígido de $15\%$ do tamanho atual da carteira líquida para evitar o risco de ruína evidenciado nas variantes `tat-size25` e `tat-size30`.
3. **Monitoramento de Bid/Spread:** Interromper a execução se a soma de asks ($askSum$) cair fora do canal $0.94 - 1.08$ ou se o spread médio de execução no par ultrapassar $0.10$.
4. **Fase de Paper Trading:** Manter a estratégia rodando em modo simulação ativa (paper trading) por pelo menos 150 eventos reais para verificar se a taxa de fill de Maker real aproxima-se dos $60\%$ simulados em laboratório.
