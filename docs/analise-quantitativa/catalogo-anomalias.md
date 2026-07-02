# Catálogo de Anomalias Quantitativas (BTC 5m)

Este arquivo é o registro central do loop contínuo de formulação, mineração estatística e testes de laboratório do ecossistema GoldenLens.

> **Regra de exclusão:** anomalias que reproduzem mecanismos já cobertos por estratégias **implementadas** (`labs/strategies/`, GLS, library-runners) ou **backlog** (`port-catalog.json` → `backlog`) não podem ser promovidas como descobertas novas. Devem ser marcadas como `Descartado — duplicata` e o loop avança para padrões genuinamente inéditos.

---

### ANOM-01: Defesa de Barreira (Barrier Wall Defense)
* **Status**: Rejeitado
* **Fórmula do Sinal**:
  - Distância absoluta do spot do BTC para a barreira: $dist = |BTC - PTB| \le 30$ USD.
  - Tempo restante para expiração do evento: $15 \le \tau \le 90$ segundos.
  - Variação do ask de odds do lado não-favorito nos últimos 15 segundos: $AskChange_{non\_fav} \le -0.05$ (probabilidade implícita do não-favorito subiu abruptamente).
  - Compra taker simulada de $10.0$ USDC no lado não-favorito (`non_fav`) buscando capturar a rejeição do spot na barreira.
* **Espaço-Temporal**: Ticks finais ($15 \le \tau \le 90$s) e preço spot a $\le 30$ USD da barreira física do strike.
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Sinais Disparados**: 6363
  - **Win Rate Bruto**: 27.82% (1770 W / 4593 L)
  - **PnL Líquido Simulado**: $-17559.70 USDC
  - **Expectativa Matemática**: $-2.7597 USDC por trade
  - **Turnover diário**: 155.20 trades/dia
* **Análise Microestrutural**: 
  A hipótese supunha que o aumento súbito nas odds do não-favorito nos momentos finais indicava uma defesa forte do strike (barreira física). No entanto, os resultados provam que a barreira é violada/atravessada na maioria das vezes sob momentum forte, ou o ajuste das odds de ask do não-favorito é apenas um reajuste de preço tardio. Comprar o não-favorito neste cenário gera uma taxa de acerto extremamente baixa (27.82%), gerando prejuízos severos sob taxas taker de $0.07$ e varredura real do book.

---

### ANOM-02A: Exaustão de Preço com Odds Atrasadas (Price-Odds Exhaustion - Trend)
* **Status**: Rejeitado
* **Fórmula do Sinal**:
  - Movimento rápido do spot do BTC nos últimos 15 segundos: $|\Delta BTC_{15s}| \ge 40$ USD.
  - Odds do favorito na direção do movimento ficaram flat/defasadas: $\Delta Ask_{direction} \ge -0.01$ (o preço do ask correspondente não diminuiu ou subiu, indicando inércia nas odds do favorito).
  - Compra taker simulada de $10.0$ USDC na direção do movimento do spot (comprando o favorito a um preço supostamente "defasado/barato").
* **Espaço-Temporal**: Ticks intermediários e finais ($15 \le \tau \le 240$s).
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Sinais Disparados**: 4649
  - **Win Rate Bruto**: 72.34% (3363 W / 1286 L)
  - **PnL Líquido Simulado**: $-3546.98 USDC
  - **Expectativa Matemática**: $-0.7630 USDC por trade
  - **Turnover diário**: 113.39 trades/dia
* **Análise Microestrutural**:
  Embora o sinal apresente um Win Rate bruto muito elevado (72.34%), a expectativa matemática permanece negativa. Isso ocorre porque o preço do ask pago no book real na entrada da operação é alto, e quando o sinal falha (27.66% das vezes), a perda total do capital por trade supera amplamente o lucro médio das operações vencedoras de payoff de $1.00$. 
  
  O refino de parâmetros (max_ask) provou que impor limites menores para o ask de compra (ex: ask $\le 0.65$ até $\le 0.25$) destrói o Win Rate proporcionalmente (caindo para 37.10% e 11.52% respectivamente) e agrava as perdas. Isso ocorre porque as odds baixas refletem corretamente a distância física do spot para o strike: a inércia do market maker não é uma ineficiência, mas sim uma precificação probabilística precisa baseada no tempo restante para ultrapassar a barreira física.

---

### ANOM-02B: Exaustão de Preço com Reversão de Spot (Price-Odds Exhaustion - Counter-Trend)
* **Status**: Rejeitado
* **Fórmula do Sinal**:
  - Movimento rápido do spot do BTC nos últimos 15 segundos: $|\Delta BTC_{15s}| \ge 40$ USD.
  - Odds do favorito na direção do movimento ficaram flat/defasadas: $\Delta Ask_{direction} \ge -0.01$.
  - Compra taker simulada de $10.0$ USDC no lado oposto ao movimento do spot (apostando na reversão/fadiga do spot).
* **Espaço-Temporal**: Ticks intermediários e finais ($15 \le \tau \le 240$s).
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Sinais Disparados**: 4808
  - **Win Rate Bruto**: 26.29% (1264 W / 3544 L)
  - **PnL Líquido Simulado**: $-19091.72 USDC
  - **Expectativa Matemática**: $-3.9708 USDC por trade
  - **Turnover diário**: 117.27 trades/dia
* **Análise Microestrutural**:
  Comprovação empírica de que a inércia do book de odds não sinaliza reversão iminente do spot do BTC. O Win Rate de apenas 26.29% confirma que ir contra movimentos fortes do spot nos minutos finais acarreta perdas consistentes, com expectativa matemática negativa severa de $-3.97$ USDC por trade.

---

### ANOM-03A: Decaimento Temporal Anômalo (Theta Decay - Carregar)
* **Status**: Rejeitado
* **Fórmula do Sinal**:
  - Preço spot do BTC flat nos últimos 30 segundos: $|\Delta BTC_{30s}| \le 5$ USD.
  - Choque anômalo nas odds: o ask de UP ou DOWN subiu $\ge 0.06$ em 15 segundos sem movimentação do spot.
  - Compra taker de $10.0$ USDC no lado desvalorizado (onde o ask subiu) carregada até a expiração final.
* **Espaço-Temporal**: Ticks intermediários e finais ($15 \le \tau \le 270$s).
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Sinais Disparados**: 10989
  - **Win Rate Bruto**: 54.42% (5980 W / 5009 L)
  - **PnL Líquido Simulado**: $-13894.17 USDC
  - **Expectativa Matemática**: $-1.2644 USDC por trade
  - **Turnover diário**: 268.02 trades/dia
* **Análise Microestrutural**:
  Com o spot do BTC travado, a probabilidade real de expiração permanece praticamente inalterada (coin flip de 54.42%). Os choques de odds ocorrem devido a ordens pontuais de outros traders ou desbalanceamento momentâneo de livro, mas a taxa taker de $0.07$ inviabiliza qualquer vantagem matemática de arbitragem até a expiração.

---

### ANOM-03B: Decaimento Temporal Anômalo (Theta Decay - Saída Rápida)
* **Status**: Rejeitado
* **Fórmula do Sinal**:
  - Mesma condição de entrada da ANOM-03A (spot flat e choque de odds).
  - Venda taker 30 segundos após a entrada no bid correspondente do book, assumindo custos de bid/ask spread e uma segunda taxa taker de 0.07 (totalizando 0.14 de taxa por share).
* **Espaço-Temporal**: Ticks intermediários e finais ($15 \le \tau \le 270$s).
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Sinais Disparados**: 10989
  - **Win Rate Bruto**: 11.78% (1295 W / 9694 L)
  - **PnL Líquido Simulado**: $-29306.54 USDC
  - **Expectativa Matemática**: $-2.6669 USDC por trade
  - **Turnover diário**: 268.02 trades/dia
* **Análise Microestrutural**:
  O custo de atrito de executar duas ordens taker seguidas (compra e venda com taxas acumuladas de $0.14$ USDC por share) em um intervalo de 30 segundos destrói qualquer possibilidade de lucro em micro-horizontes temporais na Polymarket. A taxa de acerto onde o retorno supera as taxas é de apenas 11.78%.

---

### ANOM-04: Assimetria de Spread na Entrada (Spread Inefficiency Sniper)
* **Status**: Rejeitado
* **Fórmula do Sinal**:
  - Preço spot distante da barreira: $dist = |BTC - PTB| \ge 80$ USD.
  - Tempo restante para expiração do evento: $120 \le \tau \le 270$ segundos.
  - Spread do favorito ultra-baixo: $Ask_{fav} - Bid_{fav} \le 0.02$.
  - Probabilidade implícita do mercado está subestimando a probabilidade estatística teórica baseada em Normal CDF (usando volatilidade empírica dos últimos 60s) em mais de 6%: $P_{fair} - Ask_{fav} \ge 0.06$.
  - Compra taker de $10.0$ USDC no favorito.
* **Espaço-Temporal**: Ticks intermediários ($120 \le \tau \le 270$s) e spot distante da barreira.
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Sinais Disparados**: 2636
  - **Win Rate Bruto**: 83.12% (2191 W / 445 L)
  - **PnL Líquido Simulado**: $-1832.92 USDC
  - **Expectativa Matemática**: $-0.6953 USDC por trade
  - **Turnover diário**: 64.29 trades/dia
* **Análise Microestrutural**:
  Embora o sinal acerte 83.12% das vezes por operar a favor do favorito com o spot muito distante do strike, as odds de entrada já são extremamente caras (geralmente $> 0.85$ USDC por share). O perfil de retorno assimétrico desfavorável (ganhar 0.08 e perder 0.92) sob o peso de $0.07$ de taxa taker por share cria uma barreira matemática que impede a lucratividade líquida. O spread baixo comprova a altíssima eficiência de precificação dos formadores de mercado na Polymarket.

---

### ANOM-05: Rompimento de Barreira com Odds de Cauda (Tail Odds Breakout Sniper)
* **Status**: Rejeitado
* **Fórmula do Sinal**:
  - Restando entre 15 e 60 segundos para a expiração do evento ($15 \le \tau \le 60$).
  - Distância atual da barreira (PTB): $15 \le dist \le 35$ USD.
  - Momentum de aceleração na direção da barreira em 10 segundos: $|\Delta BTC_{10s}| \ge mom\_min$.
  - Odds do não-favorito muito baratas: $non\_fav\_ask \le max\_ask$.
  - Compra de $10.0$ USDC no não-favorito (UP ou DOWN).
* **Espaço-Temporal**: Ticks finais ($15 \le \tau \le 60$s) e spot muito próximo do strike.
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Variante v1 (Mom >= 25, Ask <= 0.20)**: 245 sinais | Win Rate: 17.55% | PnL: $-468.18 USDC | Expectativa: $-1.9110 USDC/trade
  - **Variante v2 (Mom >= 25, Ask <= 0.15)**: 170 sinais | Win Rate: 10.59% | PnL: $-650.53 USDC | Expectativa: $-3.8266 USDC/trade
  - **Variante v3 (Mom >= 30, Ask <= 0.20)**: 157 sinais | Win Rate: 19.11% | PnL: $-200.08 USDC | Expectativa: $-1.2744 USDC/trade
  - **Variante v4 (Mom >= 30, Ask <= 0.15)**: 101 sinais | Win Rate: 10.89% | PnL: $-364.24 USDC | Expectativa: $-3.6063 USDC/trade
  - **Variante v5 (Mom >= 35, Ask <= 0.20)**: 105 sinais | Win Rate: 20.95% | PnL: $-51.15 USDC | Expectativa: $-0.4872 USDC/trade
  - **Variante v6 (Mom >= 35, Ask <= 0.15)**: 68 sinais | Win Rate: 11.76% | PnL: $-223.48 USDC | Expectativa: $-3.2865 USDC/trade
* **Análise Microestrutural**:
  Comprovou-se que comprar odds ultra-baratas ($\le 0.15$ USDC por share) tem uma taxa de acerto extremamente baixa (~10%), insuficiente para gerar retorno positivo. A variante v5 (`Mom >= 35, Ask <= 0.20`) apresentou o melhor desempenho estatístico, elevando o Win Rate para 20.95% e reduzindo as perdas ao mínimo (PnL de apenas $-51.15$ USDC no período todo).
  
  Ainda assim, a expectativa líquida por trade permanece ligeiramente negativa ($-0.48$ USDC por trade). O atrito de $0.07$ USDC de taxa taker representa quase 30% do custo total de cada share comprada a $0.17$ USDC. Esse custo de transação desproporcional nas odds de cauda inviabiliza a lucratividade, mesmo quando o spot do BTC apresenta aceleração direcional forte contra a barreira.

---

### ANOM-06: Arbitragem de Distorção de Odds Sum (Odds Sum Discrepancy Sniper)
* **Status**: Rejeitado
* **Fórmula do Sinal**:
  - Restando entre 30 e 180 segundos para a expiração do evento ($30 \le \tau \le 180$s).
  - Soma das odds de ask de UP e DOWN anomalamente alta: $Ask_{up} + Ask_{down} \ge 1.05$.
  - Calculamos a probabilidade normal teórica $P_{fair}$ (via Normal CDF e volatilidade histórica recente).
  - Compra taker de $10.0$ USDC no contrato que apresenta o maior desconto em relação à probabilidade estatística justa: $P_{fair} - Ask \ge 0.08$.
* **Espaço-Temporal**: Ticks intermediários e finais ($30 \le \tau \le 180$s) e pânico/sobreprecificação de odds.
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Sinais Disparados**: 6362
  - **Win Rate Bruto**: 63.03% (4010 W / 2352 L)
  - **PnL Líquido Simulado**: $-9751.47 USDC
  - **Expectativa Matemática**: $-1.5328 USDC por trade
  - **Turnover diário**: 155.17 trades/dia
* **Análise Microestrutural**:
  O sinal acerta a maior parte das vezes (63.03%) ao comprar o lado com maior desvio favorável, mas o PnL é negativo por causa do peso de $0.07$ de taxa por share. O fato de a soma das odds estar inflada ($Ask_{up} + Ask_{down} \ge 1.05$) indica que ambos os lados estão com spreads de livro muito largos (market maker precificando volatilidade). O preço do ask do contrato que compramos permanece caro, gerando lucros pequenos nas vitórias que não pagam as perdas sob taxa.

---

### ANOM-07: Deflexão de Volatilidade de Expiração (Expiration Volatility Deflection)
* **Status**: Rejeitado
* **Fórmula do Sinal**:
  - Restando entre 60 e 180 segundos para a expiração do evento ($60 \le \tau \le 180$s).
  - Preço spot do BTC muito estável nos últimos 60 segundos: $|\Delta BTC_{60s}| \le 8$ USD.
  - O ask de UP ou DOWN sofre um desvio de preço brusco (ruído de fluxo) e sobe $\ge 0.08$ acima da sua média móvel de 60 segundos.
  - Compra taker de $10.0$ USDC no lado desvalorizado esperando retorno à média.
* **Espaço-Temporal**: Ticks intermediários ($60 \le \tau \le 180$s) sob spot parado.
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Sinais Disparados**: 8144
  - **Win Rate Bruto**: 61.81% (5034 W / 3110 L)
  - **PnL Líquido Simulado**: $-10183.10 USDC
  - **Expectativa Matemática**: $-1.2504 USDC por trade
  - **Turnover diário**: 198.63 trades/dia
* **Análise Microestrutural**:
  As flutuações das odds com spot flat são ruídos temporários provocados por fluxo de ordens e revertem para o valor justo (Win Rate de 61.81%). Porém, a taxa de 0.07 consome totalmente a margem da arbitragem, gerando expectativa matemática negativa líquida consistente.

---

### ANOM-08A: Divergência ODR Book Lead A2 (Raw)
* **Status**: Rejeitado
* **Fórmula do Sinal**:
  - Regime: $BTC > PTB$ (spot acima do strike).
  - Janela operacional: $15 \le \tau \le 180$ segundos, $dist = |BTC - PTB| \le 100$ USD.
  - Divergência em 15s: $\Delta BTC_{15s} \le 0$ (spot caindo/estável) e $\Delta Ask_{UP} > 0$ (odds de UP subindo — book antecipa alta).
  - Compra taker de $10.0$ USDC em **UP** até expiração.
* **Espaço-Temporal**: Ticks intermediários e finais ($15 \le \tau \le 180$s), distância $\le 100$ USD do strike.
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Sinais Disparados**: 4823
  - **Win Rate Bruto**: 74.54% (3595 W / 1228 L)
  - **PnL Líquido Simulado**: $-668.84 USDC
  - **Expectativa Matemática**: $-0.1387 USDC por trade
  - **Turnover diário**: 117.63 trades/dia
* **Análise Microestrutural**:
  O sinal bruto A2 (sem filtros de seletividade) apresenta Win Rate elevado (74.54%), confirmando que o book de odds antecipa movimentos do spot. Porém, a alta frequência de disparos em condições de ask caro ($> 0.70$) e spread largo destrói a margem líquida sob fees reais Polymarket e varredura depth 25. A versão sem filtros não é escalável.

---

### ANOM-08B: Divergência ODR Book Lead A2 Seletivo (Book Front Runner)
* **Status**: Descartado — duplicata (`book-frontrunner` / `BookFrontRunner.gls`)
* **Fórmula do Sinal**:
  - Regime: $BTC > PTB$.
  - Janela operacional: $30 \le \tau \le 150$ segundos, $dist \le 75$ USD.
  - Divergência forte: $\Delta BTC_{15s} \le -20$ USD e $\Delta Ask_{UP} \ge 0.04$.
  - Filtros de qualidade: $Ask_{UP} \le 0.60$, $Spread_{UP} = Ask - Bid \le 0.04$.
  - Compra taker de $10.0$ USDC em **UP** até expiração.
* **Espaço-Temporal**: Ticks finais ($30 \le \tau \le 150$s), distância $\le 75$ USD do strike.
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Sinais Disparados (Minerador)**: 23
  - **Win Rate Bruto**: 60.87% (14 W / 9 L)
  - **PnL Líquido Simulado**: $+15.60 USDC
  - **Expectativa Matemática**: $+0.6784 USDC por trade
  - **Turnover diário**: 0.56 trades/dia
* **Validação GLS (Lab `book-frontrunner` preset `btc-champion`)**:
  - **Entradas**: 70 | **Win Rate**: 58.57% | **PnL Líquido**: $+39.09 USDC
  - **Expectativa**: $+0.5584 USDC/trade | **Profit Factor**: 1.13
* **Análise Microestrutural**:
  Quando o BTC está acima do PTB e o spot cai $\ge \$20$ em 15s, mas o ask de UP sobe $\ge 0.04$, os market makers estão comprando UP agressivamente antes de empurrar o spot. Os filtros de preço máximo ($Ask \le 0.60$) e spread estreito ($\le 0.04$) eliminam entradas onde o payoff assimétrico já foi consumido. Edge confirmado no laboratório GLS com fees taker 0.07 e book depth 25. Frequência baixa (~1.7 trades/dia no lab) limita escalabilidade absoluta, mas a expectativa por trade é a mais alta do catálogo.

---

### ANOM-08C: Divergência ODR Book Lead B2 Seletivo (Simétrico)
* **Status**: Rejeitado
* **Fórmula do Sinal**:
  - Regime: $BTC < PTB$ (espelho do A2).
  - Janela operacional: $30 \le \tau \le 150$ segundos, $dist \le 75$ USD.
  - Divergência forte: $\Delta BTC_{15s} \ge +20$ USD e $\Delta Ask_{DOWN} \ge 0.04$.
  - Filtros: $Ask_{DOWN} \le 0.60$, $Spread_{DOWN} \le 0.04$.
  - Compra taker de $10.0$ USDC em **DOWN** até expiração.
* **Espaço-Temporal**: Ticks finais ($30 \le \tau \le 150$s), distância $\le 75$ USD do strike.
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Sinais Disparados**: 24
  - **Win Rate Bruto**: 58.33% (14 W / 10 L)
  - **PnL Líquido Simulado**: $-8.32 USDC
  - **Expectativa Matemática**: $-0.3465 USDC por trade
  - **Turnover diário**: 0.59 trades/dia
* **Análise Microestrutural**:
  O padrão microestrutural é simétrico ao A2 (book antecipa movimento), mas abaixo do PTB os spreads são ligeiramente piores e o payoff assimétrico desfavorável gera expectativa negativa mesmo com Win Rate de 58.33%. Confirmado na documentação ODR original (B2: -$0.1169/trade sem filtros).

---

### ANOM-09: Lead Inertia Mispricing (LIM)
* **Status**: Descartado — duplicata (`lead-inertia-v1` / `LEAD_INERTIA_V1`)
* **Fórmula do Sinal**:
  - Janela temporal inicial/meio: $180 \le \tau \le 290$ segundos (início do evento, não o final).
  - Distância do strike: $dist = |BTC - PTB| \ge 60$ USD.
  - Probabilidade Browniana com vol realizada (90s): $P_{fair} = \Phi\left(\frac{BTC - PTB}{\sigma_{real} \sqrt{\tau}}\right)$.
  - Mispricing: $P_{fair} - Ask_{leader} \ge 0.08$ e $Ask_{leader} \le 0.88$.
  - Compra taker de $10.0$ USDC no lado líder (UP se $BTC > PTB$, DOWN se $BTC < PTB$).
* **Espaço-Temporal**: Ticks iniciais ($180 \le \tau \le 290$s), distância $\ge 60$ USD do strike.
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Sinais Disparados (Minerador)**: 2535
  - **Win Rate Bruto**: 79.49% (2015 W / 520 L)
  - **PnL Líquido Simulado**: $+54.44 USDC
  - **Expectativa Matemática**: $+0.0215 USDC por trade
  - **Turnover diário**: 61.83 trades/dia
* **Validação GLS (Lab `lead-inertia-v1` preset `v1`)**:
  - **Entradas**: 1063 | **Win Rate**: 86.83% | **PnL Líquido**: $+101.49 USDC
  - **Expectativa**: $+0.0955 USDC/trade | **Profit Factor**: 1.05
* **Análise Microestrutural**:
  No início/meio do evento 5m, quando o BTC já se deslocou significativamente do strike ($\ge \$60$), os market makers mantêm o ask do lado líder artificialmente baixo devido à inércia de repricing e à restrição odds-sum. A probabilidade Browniana de settlement já é $\ge 85\%$, mas o ask permanece em 0.62–0.88, criando um edge de 5–30 pontos percentuais. Com fees taker 0.07 e depth 25, a expectativa permanece positiva com alta frequência (~26 trades/dia no lab), tornando esta a **anomalia campeã de escalabilidade** do ciclo 5.

---

### ANOM-10: Strike Boundary Repricing Inelasticity (SBRI)
* **Status**: Descartado — duplicata (backlog `strike-boundary-repricing-inelasticity-v1`)
* **Fórmula do Sinal**:
  - Cruzamento recente do PTB: $\text{sgn}(BTC_t - PTB) \neq \text{sgn}(BTC_{t-10s} - PTB)$.
  - Janela operacional: $40 \le \tau \le 100$ segundos.
  - Confirmação física: $dist = |BTC - PTB| \ge 15$ USD.
  - Probabilidade física terminal: $\mathcal{P}_{phys} = \Phi\left(\frac{BTC - PTB}{\sigma_{real}\sqrt{\tau}}\right)$ para o novo favorito.
  - Desconto inelástico: $\mathcal{P}_{phys} - Ask_{fav} \ge 0.10$.
  - Filtros: $Ask_{fav} \le 0.48$, $Spread \le 0.035$, $0.96 \le Ask_{UP}+Ask_{DOWN} \le 1.06$.
  - Compra taker de $10.0$ USDC no novo favorito, **hold to settlement** (sem taxa de saída).
* **Espaço-Temporal**: Ticks intermediários-finais ($40 \le \tau \le 100$s), imediatamente após cruzamento do strike.
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Variante base (Minerador)**: 293 sinais | WR: 53.58% | PnL: $+1390.76 | Expectativa: $+4.75/trade | Turnover: 7.15/dia
  - **Variante tight (Minerador)**: 90 sinais | WR: 62.2% | PnL: $+1508.43 | Expectativa: $+16.76/trade | Turnover: 2.20/dia
* **Validação GLS (Lab `strike-boundary-sbri` preset `btc-champion-tight`)**:
  - **Período completo**: 68 entradas | WR: 61.76% | PnL: **$+1208.76** | Expectativa: **$+17.78/trade** | PF: **5.90** | Max DD: $38.65
  - **Holdout GLS (2026-05-25 → 2026-06-13)**: 47 entradas | WR: 55.32% | PnL: **$+927.05** | Expectativa: **$+19.72/trade** | PF: **5.63**
* **Análise Microestrutural**:
  Padrão **completamente distinto** de LIM (inércia no início do evento) e ODR (book antecipa spot nos segundos finais). A SBRI explora o **vácuo de repricing** nos 40–100 segundos após o BTC cruzar o PTB: market makers hesitam em assumir posição direcional imediata (medo de whipsaw/seleção adversa), mantendo o ask do novo favorito artificialmente barato ($\le 0.48$) enquanto a probabilidade física de settlement já saltou para $\ge 60\%$. Hold to settlement elimina 100% da taxa taker de saída — crítico para viabilidade líquida. Fee drag de apenas 2.4% no lab GLS.

---

### ANOM-11: Kinetic Probability Lag (KPLT)
* **Status**: Descartado — duplicata (backlog `kinetic-probability-lag-theory-v1`)
* **Fórmula do Sinal**:
  - Índice de lag cinético: $KLI = \frac{\Delta d_8 \times \text{sgn}(d)}{\max(\tau, 1)} \ge 0.05$.
  - Expansão física: $\Delta d_8 \times \text{sgn}(d) > 2.5$ USD em 8 segundos.
  - Inércia do book: $\Delta Ask_{fav} < 0.018$ e $\sigma_{ask,15} < 0.012$.
  - Janela: $55 \le \tau \le 170$s, $5 \le |d| \le 32$ USD, $0.50 \le Ask_{fav} \le 0.66$.
* **Espaço-Temporal**: Zona média-tardia do evento, distâncias moderadas.
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Sinais Disparados**: 979
  - **Win Rate Bruto**: 61.80% (605 W / 374 L)
  - **PnL Líquido Simulado**: $+71.15 USDC
  - **Expectativa Matemática**: $+0.0727 USDC por trade
  - **Turnover diário**: 23.88 trades/dia
* **Análise Microestrutural**:
  O spot expande a distância do strike rapidamente, mas o ask do favorito permanece pegajoso (sticky). Edge positivo mas diluído pela frequência — melhor como complemento de SBRI.

---

### ANOM-12: Transition Acceleration Threshold (TAT)
* **Status**: Descartado — duplicata (backlog `transition-acceleration-threshold-v1`)
* **Fórmula do Sinal**:
  - Cruzamento do PTB com velocidade $v \ge 0.25$ USD/s e aceleração alinhada $\ge 0$.
  - Janela: $5 \le \tau \le 80$ segundos.
  - Ask do lado do cruzamento $\le 0.56$, spread $\le 0.10$.
* **Espaço-Temporal**: Momento exato do rompimento explosivo do strike.
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Sinais Disparados**: 1319
  - **Win Rate Bruto**: 52.16% (688 W / 631 L)
  - **PnL Líquido Simulado**: $+2072.40 USDC
  - **Expectativa Matemática**: $+1.5712 USDC por trade
  - **Turnover diário**: 32.17 trades/dia
* **Validação Split**:
  - Train: 674 sinais | PnL: $+720.79 | Exp: $+1.07/trade
  - Holdout: 645 sinais | PnL: $+1351.61 | Exp: $+2.10/trade
* **Análise Microestrutural**:
  Rompimentos com aceleração física superam ruído de reversão; o book hesita em reprecificar ($Ask \le 0.56$). Padrão distinto de SBRI (foco em aceleração, não inelasticidade pós-cruzamento). Validado positivo em ambos splits.

---

### ANOM-13: Settlement Lock — Favorito barato τ≤30s
* **Status**: Rejeitado (falso positivo no minerador; falha no split)
* **Fórmula do Sinal**:
  - $8 \le \tau \le 30$s, $dist \ge 25$ USD, $Ask_{fav} \le 0.82$, $Spread \le 0.03$.
* **Estatísticas de Backtest**:
  - Minerador full: 932 sinais, WR 74%, PnL $+5495 — **descartado** por inconsistência com split (WR ~50%, PnL negativo em validação cruzada).
* **Análise Microestrutural**:
  Resultado do minerador foi artefato de agregação; o padrão não sobrevive validação holdout. Provavelmente sobreposição com ruído de ticks finais sem edge real após fees.

---

### ANOM-14: Book Depth Imbalance Lead
* **Status**: Rejeitado
* **Fórmula do Sinal**:
  - Razão de profundidade ask (top 5 níveis): $\frac{\sum AskSz_{UP}}{\sum AskSz_{DOWN}} \ge 2.5$ com spot abaixo do PTB → compra UP (e vice-versa).
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Sinais Disparados**: 5156
  - **Win Rate Bruto**: 47.36% (2442 W / 2714 L)
  - **PnL Líquido Simulado**: $-6949.74 USDC
  - **Expectativa Matemática**: $-1.3479 USDC por trade
  - **Turnover diário**: 125.76 trades/dia
* **Análise Microestrutural**:
  Desequilíbrio de profundidade do book não é preditivo da direção do spot — win rate abaixo de 50% com alta frequência destrói capital via fees.

---

### ANOM-15: Stale Quote (ask parado, spot moveu)
* **Status**: Descartado — duplicata (backlog `repricing-inertia-index-v1` / `kinetic-probability-lag-theory-v1`)
* **Fórmula do Sinal**:
  - $\sigma_{ask,20} \le 0.008$ (ask do favorito estável ~20s).
  - Spot moveu $\ge 22$ USD na direção do favorito em 20s, mas $|Ask_{fav} - Ask_{fav,20s}| \le 0.015$.
  - $60 \le \tau \le 220$s, $dist \ge 20$ USD, $Ask_{fav} \le 0.72$, $Spread \le 0.04$.
* **Estatísticas de Backtest** (Período: 2026-05-04 a 2026-06-13, 41 dias):
  - **Sinais**: 81 | **WR**: 70.37% | **PnL**: $+729.08 | **Expectativa**: $+9.00/trade | **Turnover**: 1.98/dia
* **Validação Holdout**:
  - Train: 32 sinais | PnL: $+64.83 | Exp: $+2.03/trade
  - Holdout: 40 sinais | PnL: $+584.34 | Exp: $+14.61/trade
* **Análise**: Mecanismo equivalente à inércia de repricing já documentada no backlog (IRI/KPLT). Não é descoberta nova.

---

### ANOM-16: PTB Magnet Break (consolidação + rompimento)
* **Status**: Rejeitado
* **Fórmula do Sinal**:
  - $\ge 75\%$ dos ticks em 45s com $|BTC - PTB| \le 8$ USD (ímã no strike).
  - Rompimento: $|\Delta BTC_{10s}| \ge 18$ USD.
  - $50 \le \tau \le 200$s, $Ask \le 0.58$, $Spread \le 0.05$.
* **Estatísticas de Backtest** (Período completo):
  - **Sinais**: 103 | **WR**: 64.08% | **PnL**: $+188.15 | **Expectativa**: $+1.83/trade
* **Validação Holdout**:
  - Train: 50 sinais | PnL: $+198.73 | Exp: $+3.97/trade
  - Holdout: 53 sinais | PnL: $-10.58 | Exp: $-0.20/trade
* **Análise**: Edge não generaliza no holdout — rejeitado.

---

### ANOM-17: Favorito Forte + Cauda Perdedor Colapsada
* **Status**: Rejeitado (amostra insuficiente)
* **Sinais**: 1 | PnL: $+2.78 — filtros ($dist \ge 45$, $Ask_{loser} \le 0.12$) raros demais.

---

### ANOM-18: Odds Sum Depression ($Ask_{UP}+Ask_{DOWN} \le 0.94$)
* **Status**: Rejeitado (amostra insuficiente)
* **Sinais**: 1 | PnL: $+9.70 — condição quase nunca ocorre com $dist \ge 30$.

---

### ANOM-19: Bid Surge Lead (bid sobe, ask flat, spot flat)
* **Status**: Rejeitado
* **Sinais**: 650 | **WR**: 40.77% | **PnL**: $-458.02 | **Expectativa**: $-0.70/trade
* **Análise**: Surto no bid sem repricing do ask não prediz settlement — WR abaixo de 41%.

---

## Ciclo 8 — Padrões inéditos (fora de implementadas + backlog)

### ANOM-20: Spread Collapse | **Rejeitado** (holdout exp $-0.04)
### ANOM-21: Frozen Book Breakout | **Rejeitado** (WR 16%, exp $-1.56)

### ANOM-22: Whipsaw Lock — **CAMPEÃO**
* **Status**: **Promovido**
* **Fórmula** (`ws-spread25`, refinado ciclo 9): $\ge 3$ flips do PTB em 60s → spot estável ($|\Delta BTC_{20s}| \le 5$) → $dist \ge 22$ → $Ask_{fav} \le 0.57$, $Spread \le 0.025$, $35 \le \tau \le 160$s.
* **FULL (41d)**: 46 sinais | WR 63.0% | PnL **$+625.40** | exp **$+13.60/trade**
* **Holdout (20d)**: 34 sinais | WR 61.8% | PnL **$+560.39** | exp **$+16.48/trade**
* **GLS validado** (2026-05-04→2026-06-14): 44 entradas | WR 63.6% | exp **$+9.82/trade** | holdout 32 entradas exp **$+11.50/trade**
* **Lab / Studio**: `labs/strategies/microstructure/whipsaw-lock` · doc `docs/estrategias/implementadas/whipsaw-lock-v1.md` · GLS `WhipsawLock.gls` · signal `ptbFlipCount`
* **Análise**: Pós-ziguezague no strike, favorito definido mas ask ainda barato — padrão inédito, fora de ODR/LIM/SBRI/SCH/backlog. Refinamento ANOM-33 (spread $\le 0.025$) supera baseline ws-dist22 no holdout mantendo frequência similar.

### ANOM-23: Loser Panic Confirm | **Rejeitado** (holdout exp $-0.10)
### ANOM-24: Bid-Ask Divergence | **Rejeitado** (holdout exp $-0.58)
### ANOM-25: Mid-Event Vacuum | Sob Análise (holdout +$4.15/trade, train fraco)

### ANOM-26: Late Drift Confirm — **RUNNER-UP**
* **Status**: **Promovido** (escala)
* **Fórmula** (`ld-tight`): drift spot $\ge 12$ USD + $Ask_{fav}$ cai $\ge 0.04$ em 12s, $25 \le \tau \le 75$s.
* **Holdout**: 116 sinais | WR 63.8% | PnL **$+1138.08** | exp **$+9.81/trade**

---

## Ciclo 9 — Refinamento do campeão

| ID | Padrão | Holdout exp | Holdout n | Veredicto |
|:---|:---|:---|:---|:---|
| **ANOM-33** | Spread Tight Post-Whipsaw ($Spread \le 0.025$) | **$+16.48** | 34 | **Melhor refinamento** — promovido como variante final do campeão |
| ANOM-22 baseline | ws-dist22 ($Spread \le 0.035$) | $+16.25 | 35 | Baseline original |
| ANOM-32 | Momentum Lock (+10 USD em 10s) | $+35.73 | 19 | Rejeitado — train exp $-10.00, inconsistente |
| ANOM-31 | Terminal Whipsaw ($\tau$ 20–55s) | $+141.07 | 10 | Rejeitado — amostra insuficiente + outliers, train negativo |
| ANOM-29 | Ultra-Tight (4 flips, ask$\le$0.54) | $+44.35 | 11 | Rejeitado — WR 36%, depende de cauda |
| ANOM-27/28/30 | variantes | — | — | Rejeitado |

**Conclusão do loop:** melhor anomalia inédita e robusta = **ANOM-22/33 Whipsaw Lock (`ws-spread25`)**. Para escala de frequência, **ANOM-26 Late Drift** permanece runner-up.

---

## Ciclo 10 — Mineração direta em cubo de features (Parquets locais)

Fonte: `backtest_ticks` local BTC 5m depth 25, `2026-05-04` → `2026-06-14`, 7.815.299 ticks, 11.697 eventos. Minerador: `scratch/mine-anomaly-cube.js`, com uma entrada por evento/regra, cadência de 5s, hold-to-settlement, orçamento $10.0 e fee taker $0.07 adicionada ao preço varrido do book.

### ANOM-34: Terminal Pin Favorite Lock
* **Status**: Sob Análise — candidato campeão do ciclo 10 (pendente GLS)
* **Fórmula do Sinal**:
  - Compra taker no favorito atual (`fav = UP` se `BTC > PTB`, senão `DOWN`).
  - Janela terminal: `tau < 20s`.
  - Spot praticamente pinado no strike: `dist = |BTC - PTB| < 8 USD`.
  - Preço efetivo médio de entrada após varredura depth 25 e fee: `0.50 <= avgFillWithFee < 0.62`.
  - Spread do favorito ultra-tight: `Ask_fav - Bid_fav < 0.015`.
  - Micro-whipsaw moderado: `1 <= flips_60s <= 2` (cruzamentos do PTB nos últimos 60s), explicitamente fora de Whipsaw Lock (`>=3 flips`, `35 <= tau <= 160s`, `dist >= 22`).
  - Odds sum normal: `1.00 <= Ask_UP + Ask_DOWN < 1.04` na variante equivalente filtrada.
* **Espaço-Temporal**: últimos segundos do evento, preço colado no PTB, mas com favorito definido e book ainda líquido/tight.
* **Estatísticas de Backtest**:
  - **FULL (41d)**: 125 sinais | WR 65.60% (82 W / 43 L) | PnL **+196.64 USDC** | exp **+1.5731/trade** | turnover **2.98/dia**.
  - **Train (< 2026-05-25)**: 55 sinais | WR 65.45% | PnL **+86.08** | exp **+1.5651/trade**.
  - **Holdout (>= 2026-05-25)**: 70 sinais | WR 65.71% | PnL **+110.56** | exp **+1.5795/trade**.
* **Análise Microestrutural**:
  O mercado terminal perto do PTB costuma ser evitado por estratégias anteriores por parecer coin flip. O cubo mostra uma subclasse distinta: após apenas 1-2 cruzamentos recentes, o favorito fica definido por poucos dólares, mas o book permanece tight e precificado perto de 50/50. A assimetria vem da combinação entre preço efetivo ainda moderado (`0.50-0.62`) e probabilidade empírica de settlement ~65%, suficiente para superar a fee. Não é Terminal Convexity, que exige distância terminal maior (`25-55 USD`) e ask mais barato (`<=0.45`), nem Whipsaw Lock, que exige ziguezague mais intenso e janela anterior.

### ANOM-35: Early Bid-Wall Favorite Discount
* **Status**: Sob Análise (amostra menor; não promovido)
* **Fórmula do Sinal**: favorito, `160 <= tau < 230s`, `8 <= dist < 16`, `0.38 <= avgFillWithFee < 0.50`, `spread < 0.015`, profundidade bid relativa do favorito `>= 2.5x` a do lado oposto.
* **Estatísticas de Backtest**: 56 sinais | WR 60.71% | PnL **+198.34** | exp **+3.5418/trade**; train 35 sinais exp **+1.7828**, holdout 21 sinais exp **+6.4734**.
* **Análise**: cluster forte, mas ainda com n baixo no holdout. Mecanismo de suporte por bid wall é diferente da ANOM-14 (ask-depth imbalance rejeitado), porém precisa de validação GLS e refinamento de liquidez antes de promoção.

### ANOM-36: Mid-Event Ladder Favorite
* **Status**: Rejeitado — holdout fraco
* **Fórmula do Sinal**: favorito, `160 <= tau < 230s`, `28 <= dist < 45`, `0.50 <= avgFillWithFee < 0.62`, `spread < 0.015`, ladder de ask íngreme (`Ask_px5 - Ask_px1` entre 0.035 e 0.07).
* **Estatísticas de Backtest**: 201 sinais | WR 65.17% | PnL **+249.17** | exp **+1.2397/trade**; train 91 sinais exp **+2.2668**, holdout 110 sinais exp apenas **+0.3900**.
* **Análise**: padrão parece uma versão genérica de favorito intermediário com book organizado, mas a degradação no holdout indica edge instável e potencial sobreposição com mecanismos já documentados de carry/repricing.

---

## Ciclo 11 — Cubo versionado (`labs/mining/`) com labels validados

Fonte: cubo de features `labs/mining/cube/` (builder `labs/mining/build-cube.js`), BTC 5m depth 25,
`2026-04-27` → `2026-06-27` (62 dias úteis, 860.531 pontos de decisão a 5s, 16.172 eventos).
Novidades metodológicas deste ciclo:

- **Labels validados contra o consenso do mercado** (`mkt_agree`): o vencedor inferido por
  `spot > PTB` no último tick com book válido precisa concordar com o mid do book no fim do
  evento (mid do vencedor > 0.5). ~6% dos eventos foram descartados por discordância —
  auditados casos de **feed de spot stale intercalado** (ex.: 2026-05-29 12:52, spot congelado
  em tick sem book gerando flips fictícios) que inflavam sinais de whipsaw.
- Ticks sem book não alimentam janelas de features (momentum/flips/vol).
- Splits: train `< 2026-06-01`, holdout `>= 2026-06-01`, fresh `>= 2026-06-15` (janela nunca
  minerada por nenhum ciclo anterior).
- Custos: varredura depth 25 + fee `0.07·p·(1−p)` por share, $10/trade, hold-to-settlement,
  1 entrada por evento.

### Revalidação dos campeões no cubo limpo (destaques)

| Padrão | FULL | Holdout | Fresh | Veredicto |
|:---|:---|:---|:---|:---|
| Whipsaw Lock ws-spread25 | 18 trades, +$56 | +$19 | −$3 (n=2) | Sinal raro após limpeza de flips fictícios; edge menor que o catalogado |
| SBRI tight | 29 trades, +$335, exp +$11.5 | exp +$12.7 | +$36 (n=2) | Confirma, mas frequência baixíssima (0.5/dia) |
| TAT | 1521 trades, +$416 | exp −$0.02 | exp −$0.22 | **Degradou** fora do train — não usar sozinho |
| ANOM-34 terminal-pin | 181 trades | exp +$0.07 | exp −$1.22 | Recorte estreito não generaliza (ver ANOM-37) |
| ANOM-26 late-drift | 930 trades | exp −$0.22 | exp −$0.25 | **Rejeitado** no cubo limpo |
| LIM (amplo) | 1317 trades, exp +$0.23 | +$0.17 | +$0.28 | Positivo mas diluído (ver ANOM-39) |
| ANOM-15 stale-quote | 55 trades, exp +$3.06 | +$6.18 | +$4.76 | Confirma; mecanismo = ANOM-38 |

### ANOM-37: Terminal Favorite Carry (TFC) — **CAMPEÃO do ciclo 11**
* **Status**: **Promovido — validado no lab GLS** (`tfc-v1`, preset `btc-champion`)
* **Fórmula do Sinal (variante `core`)**:
  - Janela terminal: $5 \le \tau < 30$ s.
  - Spot perto do strike: $|dist| < 20$ USD.
  - Preço efetivo de entrada (varredura depth 25 + fee, $10): $0.55 \le fill < 0.80$ no favorito.
  - Book saudável: $Spread_{fav} \le 0.03$, $0.98 \le Ask_{UP}+Ask_{DOWN} \le 1.06$.
  - Compra taker no favorito, hold-to-settlement.
* **Estatísticas de Backtest** (62 dias):
  - **FULL**: 2.643 sinais | WR 72,4% | PnL **+$1.417,67** | exp **+$0,536/trade** | 42,6 trades/dia
  - **Train (<06-01)**: 1.403 | WR 72,3% | exp +$0,493
  - **Holdout (>=06-01)**: 1.240 | WR 72,6% | exp **+$0,586**
  - **Fresh (>=06-15)**: 615 | WR 71,1% | exp **+$0,346**
  - maxDD $210 | 73% dias positivos | 9 de 11 semanas positivas | Sharpe diário anualizado ≈ 9,2
* **Sensibilidade**: exp positiva em todas as 12 perturbações de ±20% dos cortes; `tauMax 24`
  melhora (exp train 0.90 / hold 0.80) — plateau, não pico.
* **Validação GLS** (lab `labs/strategies/terminal/tfc-v1`, motor `compiled-soa`, fills e fees
  oficiais, 62 dias): **4.062 entradas | WR 72,0% | PnL +$1.874,12 | exp +$0,46/trade |
  PF 1,17 | maxDD $122** | train exp +$0,50 | holdout exp +$0,41 | fresh exp **+$0,56** |
  45/62 dias positivos. Sweep 54 variantes no train: melhores variantes (`tauMax 24`,
  `maxAsk 0.83`) não superaram os defaults no holdout — defaults mantidos como campeão.
* **Studio**: semeada como `tfc-v1` v1 (preset `btc-champion`). Smoke via `backtest:run`
  na janela fresh (06-15→06-27) reproduziu o lab **ao centavo**: 917 entradas, +$511,68.
* **Análise Microestrutural**:
  Generalização robusta da ANOM-34: nos últimos 30 segundos com o spot a menos de $20 do
  strike, o mercado precifica o favorito como se o evento ainda fosse ~50/65% quando a
  probabilidade empírica de o líder segurar é ~72%. O recorte estreito da ANOM-34 (dist<8,
  fill 0.50–0.62, flips 1–2) era uma célula sobreajustada dentro deste platô; o platô inteiro
  (fill 0.55–0.80, sem condição de flips) sobrevive holdout e fresh. O risco por trade é
  limitado (perde o custo), o payoff médio por vitória (~$4.4) cobre as perdas na cadência.

### ANOM-38: Repricing Lag Strong (LAG)
* **Status**: **Rejeitado no lab GLS** — edge do minerador não sobreviveu ao motor oficial
* **Fórmula do Sinal**: $40 \le \tau \le 240$s, $|dist| \ge 12$, spot moveu $\ge 40$ USD em 20s
  **a favor** do favorito, ask do favorito ficou parado ($|\Delta Ask_{fav,15s}| < 0.02$),
  $0.62 \le Ask_{fav} < 0.74$. Compra taker no favorito, hold.
* **Estatísticas**: FULL 120 sinais | WR 82,5% | PnL **+$230,97** | exp **+$1,92/trade** |
  1,9/dia | train +$1,19 | holdout **+$2,19** | fresh **+$4,45** (17/17 wins) | maxDD $41.
* **Análise**: mesma família de inércia de repricing da ANOM-15/IRI/KPLT, mas com gatilho de
  movimento físico forte (≥$40) e ask médio-caro — o book não acompanha um deslocamento grande
  e recente do spot; a probabilidade real já é ~0.85+ e o ask ainda oferece 0.62–0.74.
* **Validação GLS** (lab `labs/strategies/microstructure/lag-strong-v1`): 598 entradas
  (5× mais que o minerador — avaliação por tick captura gatilhos transientes que a cadência
  de 5s filtrava), PnL +$89, PF 1,05, **holdout −$16 e fresh −$36**. O edge era artefato da
  cadência de amostragem do minerador, não do mecanismo. Lab mantido como registro.

### ANOM-39: LIM Prime (refinamento validado do LIM)
* **Status**: **Promovido (minerador)** — perna de início de evento
* **Fórmula do Sinal**: $150 \le \tau \le 295$s, $60 \le |dist| < 100$, edge browniano
  $P_{phys} - Ask_{fav} \ge 0.15$, $0.50 \le Ask_{fav} < 0.65$, $Spread \le 0.011$. Compra
  taker no favorito, hold.
* **Estatísticas**: FULL 87 sinais | WR 78,2% | PnL **+$281,44** | exp **+$3,23/trade** |
  1,4/dia | train +$3,94 | holdout +$2,41 | fresh +$3,02 | maxDD $30 | 88% dias positivos.
* **Análise**: recorte de alta seletividade do LIM: exige mispricing grande (≥15 p.p.) com ask
  em zona média (0.50–0.65) e spread mínimo. Elimina as células caras (ask>0.75) do LIM amplo,
  que degradam no holdout.
* **Validação GLS** (lab `labs/strategies/structural/lim-prime-v1`, σ via 3 incrementos de
  30s): 474 entradas | WR 64,6% | PnL **+$266,48** | PF 1,17 | maxDD $108 | train exp +$0,87 |
  holdout exp +$0,34 | fresh exp +$0,48. Positivo em todos os splits, mas diluído vs
  minerador (mais entradas por avaliação por tick). **Confirmado como perna complementar**;
  status `candidate`.
* **Studio**: semeada como `lim-prime-v1` v1 (preset `btc-v1`). Smoke via `backtest:run`
  na janela fresh reproduziu o lab ao centavo: 70 entradas, +$33,37.

### Portfólio Ciclo 11 (TFC-core + LAG + LIM-prime, janelas de τ disjuntas)
* **FULL (minerador)**: 2.850 trades | WR 73,0% | PnL **+$1.930** | exp +$0,68/trade | ~46 trades/dia
* **Train** +$914 | **Holdout** +$1.016 (exp +$0,74) | **Fresh** +$312 (exp +$0,49)
* **Risco**: maxDD trade-a-trade $199 | maxDD diário $114 | pior dia −$94 | 74% dias positivos
  | média +$31/dia | Sharpe diário anualizado ≈ 11,6
* **Correlação diária entre pernas**: ≈ 0 (TFC × LAG −0,00; TFC × LIM +0,03; LAG × LIM +0,30)
* **Pós-validação GLS (2026-07-02)**: a perna LAG foi **rejeitada** no motor oficial; o
  portfólio vigente é **TFC (`tfc-v1`) + LIM Prime (`lim-prime-v1`)**: GLS combinado
  ≈ +$2.140 em 62 dias, com o TFC como motor principal e o LIM Prime como perna
  descorrelacionada de início de evento.
* **Observações de execução**: $10/trade taker; escalar orçamento exige re-simular sweep
  (labels do cubo assumem $10). TFC entra a segundos do settlement — medir latência de
  execução real do robô na janela τ < 15s antes de produção.

