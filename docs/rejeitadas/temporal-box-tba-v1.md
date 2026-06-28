# Temporal Box TBA V1 (Rejeitada)

A teoria quantitativa **Temporal Box TBA V1** (Time-Bounded Anomaly) foi desenvolvida para operar contratos BTC Up/Down de 5 minutos na Polymarket, explorando desvios de odds em uma caixa espaço-temporal próxima ao strike (PTB). 

Após extensivos testes empíricos e simulações com book depth 25 e taker fees reais, a estratégia foi **rejeitada** devido à falta de edge estatístico e destruição de valor pelo fee drag e spread.

---

## 1. Hipótese Original

A hipótese baseava-se na suposição de que market makers ajustavam as odds com atraso estrutural em relação a movimentos rápidos do spot perto da barreira de strike nos minutos finais ($180\text{s} \ge \tau \ge 45\text{s}$). Esperava-se capturar esse mispricing comparando o preço do book com uma probabilidade teórica de Ponte Browniana com drift adaptativo local.

---

## 2. Resultados Empíricos do Backtest

### 2.1 Teste de Fumaça (Smoke Test - Treino Curto)
* **Período:** 2026-05-04 a 2026-05-06 (3 dias)
* **Parâmetros padrão:** `minNetEdge` = 0.08, `maxBoxDistance` = 75
* **Resultado:**
  * PnL líquido: **+$192.04 USD**
  * Trades: 531 (alta frequência de turnover)
  * Profit Factor: 1.055
  * Fees pagas: **$247.60 USD** (Drag severo, superando o próprio lucro líquido)

### 2.2 Validação de Range Completo (Baseline)
* **Período:** 2026-05-04 a 2026-06-24 (52 dias)
* **Parâmetros padrão:** `minNetEdge` = 0.08, `maxBoxDistance` = 75
* **Resultado:**
  * PnL líquido: **-$3,263.65 USD** (Falha catastrófica)
  * Trades: 6,690
  * Profit Factor: 0.9292
  * Taxa de Acerto: 52.01%

### 2.3 Sweep de Hipóteses (Otimização no Período de Treino)
Realizamos uma varredura de grade (grid search) com 288 variantes no período de `2026-05-04` a `2026-05-18` (15 dias). O refinamento buscou aumentar a seletividade (`minNetEdge` de 18% e caixa estreita de `maxBoxDistance` de 20 USD) para combater o fee drag.
* **Melhor Variante (v0058):**
  * PnL no Treino: **+$630.89 USD**
  * Trades: 1,171
  * Profit Factor: 1.0764
  * Taxa de Acerto: 51.40%
  * Fees pagas: **$580.03 USD**

### 2.4 Validação do Preset Campeão (Range Completo / Holdout)
Ao aplicar a variante refinada `v0058` em todo o range de 52 dias (incluindo holdout):
* **Resultado:**
  * PnL líquido consolidado: **-$1,122.07 USD** (Fracasso após custos)
  * Score consolidado: -1122.07
  * Taxa de acerto consolidada: ~50.6% a 52.0%

---

## 3. Análise da Falha e Aprendizados

A estratégia falhou em gerar expectativa matemática positiva devido a três fatores principais:

1. **Eficiência de Preço do Consenso:** O BTC 5m na Polymarket é extremamente eficiente. O drift de curtíssimo prazo estimado pelos sinais de momentum local de 15 segundos não possui poder preditivo sustentável para o settlement em 5 minutos. O BTC frequentemente reverte e cruza de volta, anulando o edge teórico calculado.
2. **Impacto Devastador das Fees e Spread:** A taker fee fixa de $0.07$ da Polymarket aliada ao spread de bid-ask nos books reais (depth 25) cobram um pedágio intransponível para uma taxa de acerto de 51%-53%. A expectativa matemática líquida por trade é sistematicamente negativa:
   $$\mathbb{E}[\text{PnL}_{\text{líquido}}] = \mathbb{E}[\text{PnL}_{\text{bruto}}] - \text{Fee}_{\text{taker}} - \text{Slippage} < 0$$
3. **Overfitting de Parâmetros:** A lucratividade aparente de $630 USD no período de treino foi fruto de sobreajuste de parâmetros temporários da volatilidade de maio. No período de holdout de junho, a performance deteriorou rapidamente.

---

## 4. Conclusão

A teoria **Temporal Box TBA V1** está oficialmente **rejeitada** e arquivada. Não deve ser promovida para ambiente produtivo ou integrada ao Brutus.
O experimento prova que estratégias que dependem de micro-movimentos e alta frequência sofrem de deterioração irreparável sob as fees reais taker da Polymarket.
Estratégias futuras devem focar em baixíssima frequência (turnover muito menor), maior tempo de carregamento ou edges macro-estruturais robustos.
