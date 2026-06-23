# Boundary Coherence Entropy Deviation V1 (BCED)

A **Boundary Coherence Entropy Deviation (BCED)** é uma teoria quantitativa e estratégia estatística completamente inovadora desenvolvida para operar os contratos de BTC Up/Down de 5 minutos na Polymarket. Em vez de focar no momentum de curto prazo do BTC ou em saídas antecipadas caras, a BCED explora o **pânico e a falha de hedge temporária dos formadores de mercado (market makers)** que se manifestam como distorções de entropia no livro de ordens quando o preço do Bitcoin se aproxima ou cruza patamares críticos.

* **Arquivo de laboratório:** `scripts/lab-bced.js`
* **Comando npm associado:** `npm run lab:bced`

---

## 1. Hipótese e Intuição Teórica

Os mercados preditivos da Polymarket precificam os contratos binários UP/DOWN com base na probabilidade do Bitcoin terminar acima ou abaixo do Strike (Price to Beat - PTB). 
A teoria baseia-se nos seguintes princípios microestruturais:

1. **Vácuo de Coerência (Book Entropy):** Em momentos normais, os formadores de mercado operam em equilíbrio, mantendo a soma das odds implícitas ($Ask_{UP} + Ask_{DOWN}$) muito próxima de $1.01$ (spread de $1\%$). No entanto, saltos repentinos de preço do BTC ou a proximidade de zonas de incerteza forçam os market makers a alargar os spreads e criar desequilíbrios artificiais de preços para evitar a seleção adversa. O book entra em um estado de **dispersão entrópica**, elevando ou derrubando a soma das odds implícitas significativamente.
2. **Hesitação no Ajuste do Favorito:** Durante esse vácuo de coerência, há uma hesitação estrutural em precificar o favorito de forma justa. Quando o BTC corre em direção ao strike ou se afasta dele na janela intermediária ($120\text{s}$ a $45\text{s}$ antes da expiração), a probabilidade real baseada em volatilidade física avança muito mais rápido do que o preço do ask do favorito, gerando um desconto teórico no ask que pode ser explorado por compras rápidas.
3. **Imunidade a Fees por Hold to Settlement:** A maioria das estratégias de alta frequência falha após a aplicação das taxas taker reais de $7\%$ (imposto taker Polymarket em crypto). Ao adotar uma política estrita de **Hold to Settlement** (manter a posição até o final do evento de 5 min), a BCED elimina completamente a taxa taker de saída e os spreads de venda no bid, permitindo que a expectativa matemática de edge estatístico de entrada sobreviva com facilidade ao ambiente operacional real.

---

## 2. Modelagem Matemática e Variáveis

### Entropia de Coerência do Book ($\mathcal{H}_{book}$)
A entropia de coerência do livro quantifica o desvio do equilíbrio eficiente de precificação:
$$\mathcal{H}_{book} = | (Ask_{UP} + Ask_{DOWN}) - 1.0 |$$

### Volatilidade Adaptativa de Cauda ($\sigma_{tail}$)
Em vez de desvio padrão ordinário (que inclui ruído de curtíssimo prazo), calculamos a volatilidade realizada focando em movimentos que excedem $1.5$ desvios padrão do histórico de 60 segundos, representando as variações direcionais reais (retornos de cauda):
$$\sigma_{tail} = \text{std}(\{ r_i \mid |r_i| > 1.5 \times \text{std}(r) \})$$

Onde $r_i$ é o retorno normalizado do BTC no tempo:
$$r_i = \frac{BTC_i - BTC_{i-1}}{\sqrt{dt_i}}$$

### Probabilidade Teórica Física baseada em Cauda ($\mathcal{P}_{tail}$)
A probabilidade estatística de fechamento acima do PTB, dada a volatilidade de cauda $\sigma_{tail}$ e o tempo restante $\tau$ em segundos:
$$\mathcal{P}_{tail} = \Phi\left( \frac{BTC_t - PTB}{\sigma_{tail} \sqrt{\tau}} \right)$$

Onde $\Phi$ representa a função de distribuição cumulativa normal padrão.

### Desvio de Coerência de Limite (Edge Bruto $D_{BCED}$)
O desalinhamento e desconto de precificação do favorito:
$$D_{BCED} = \begin{cases} \mathcal{P}_{tail} - Ask_{UP}, & \text{se } BTC_t > PTB \text{ (Favorito é UP)} \\ (1 - \mathcal{P}_{tail}) - Ask_{DOWN}, & \text{se } BTC_t \le PTB \text{ (Favorito é DOWN)} \end{cases}$$

---

## 3. Regras Operacionais e Filtros Rígidos

A estratégia opera de forma extremamente seletiva através de filtros rígidos:

| Parâmetro | Regra Operacional | Racionalidade Quantitativa |
|---|---|---|
| **Janela Temporal ($\tau$)** | $45\text{s} \le \tau \le 120\text{s}$ | Janela ótima de ineficiência de book e decaimento temporal. |
| **Incoerência de Book ($\mathcal{H}_{book}$)** | $\mathcal{H}_{min} \ge 0.02$ | Garante que o book está em desequilíbrio entrópico explorável. |
| **Edge Mínimo ($D_{BCED}$)** | $\ge 0.08$ | Margem de segurança estatística bruta confortável. |
| **Odds Sum Aceitável** | $0.94 \le Ask_{UP} + Ask_{DOWN} \le 1.08$ | Evita books quebrados ou arbitrários de liquidez morta. |
| **Spread de Entrada** | $\le 0.04$ | Evita slippage catastrófico na execução taker imediata. |
| **Distância Mínima ($|BTC - PTB|$)** | $\ge 25\text{ USD}$ | Garante que o favorito tem vantagem estatística material. |
| **Preço Máximo de Entrada** | $Ask_{fav} \le 0.45$ | Garante que estamos comprando o favorito com desconto expressivo. |
| **Saída da Posição** | **Hold to Settlement** | Mitiga completamente o fee drag de saídas e spread de venda. |

---

## 4. Resultados Empíricos do Laboratório

O experimento foi executado sobre a base histórica completa de **04/05/2026 a 22/05/2026** contendo **3.170.537 ticks** e **5.294 eventos**.
A simulação usou fills de book histórico real e a aplicação das taxas taker Polymarket oficiais (crypto - $7\%$) via `polymarketFees.js`.

### Desempenho Consolidado da Variante Campeã `bced-dist25`
* **Banca Inicial:** $100.00
* **Ordem Máxima:** $15.00
* **Entradas Realizadas:** 79 trades em 18 dias
* **Win Rate Líquido:** **62.0%** (49 vitórias, 30 derrotas)
* **PnL Bruto consolidado:** **+$1.100,29**
* **Taxas Totais Pagas:** $46.90
* **PnL Líquido consolidado:** **+$1.053,39**
* **Profit Factor Líquido:** **3.40**
* **Max Drawdown:** **$70.42**
* **Fee Drag acumulado:** **4.3%**

### Desempenho out-of-sample por Splits (Campeã `bced-dist25`)

* **Train Split (60%): 04/05/2026 a 15/05/2026**
  * Entradas: 34
  * Win Rate: 52.9%
  * PnL Líquido: **+$369.14** (Taxas: $20.05)
  * Profit Factor: **2.58**
  
* **Validation Split (20%): 15/05/2026 a 19/05/2026**
  * Entradas: 35
  * Win Rate: 60.0%
  * PnL Líquido: **+$217.16** (Taxas: $20.61)
  * Profit Factor: **2.06**

* **Holdout Split Cego (20%): 19/05/2026 a 22/05/2026**
  * Entradas: 10
  * Win Rate: **100.0%** (10 vitórias, 0 derrotas)
  * PnL Líquido: **+$467.08** (Taxas: $6.24)
  * Profit Factor: **INF**

---

## 5. Comparação Estatística com Outras Estratégias

| Métrica | Terminal Convexity V1 | Edge Sniper V1 | BCED (`bced-dist25`) |
|---|---|---|---|
| **Janela Operacional** | Final ($15\text{s}$ a $8\text{s}$) | Contínua (Intra-evento) | Intermediária ($120\text{s}$ a $45\text{s}$) |
| **Gatilho de Entrada** | Payoff de convexidade | Distorção de probabilidade | Entropia e Vácuo de Coerência |
| **Frequência Operacional** | Baixíssima (~3 trades/semana) | Altíssima (~50 trades/dia) | Moderada (~4-5 trades/dia) |
| **Win Rate Líquido** | ~74.0% | ~80.0% | **62.0%** (Holdout: **100.0%**) |
| **Expectativa / Trade** | Muito Alta (~$15.00) | Baixa (~$0.50) | **Alta (+$13.33)** |
| **Sensibilidade a Fees** | Baixíssima | Altíssima | **Extremamente Baixa (4.3% drag)** |
| **Profit Factor Líquido**| ~4.02 | ~2.33 | **3.40** (Holdout: **INF**) |
| **PnL Líquido Consolidado**| Moderado-Baixo | Alto | **Muito Alto (+$1.053,39)** |

---

## 6. Riscos e Limitações

1. **Janela Sem Trades (Low Volatility):** Em regimes prolongados de baixíssima volatilidade no BTC, o book raramente atinge distorções de incoerência $\mathcal{H}_{book} \ge 0.02$, fazendo a estratégia passar dias sem realizar nenhuma entrada.
2. **Dependência do Settlement:** Como a estratégia não possui stop loss dinâmico (pois sair antes a mercado destrói o edge em taxas e spreads), estamos expostos à volatilidade de cauda até o último segundo. Mudanças repentinas de direção do BTC nos últimos 5 segundos podem converter um trade vencedor em perdedor na liquidação.
3. **Assimetria de Sizing:** Como o win rate é alto e o payout é binário (0 ou 1), sequências curtas de perdas (drawdown) podem machucar contas pequenas se o sizing ultrapassar $15\%$ da carteira líquida.

---

## 7. Comandos de Reprodução

Rode o laboratório diretamente via terminal:
```bash
npm run lab:bced
```
Para realizar a varredura e testes estatísticos completos sobre todas as combinações de parâmetros:
```bash
npm run lab:bced:full
```
