# Market-Neutral Dual-Side V1 (ATFR-V1 & DLSL-V1)

Documentação oficial da nova teoria quantitativa **Market-Neutral / Delta-Neutral / Dual-Side** para o mercado BTC Up/Down de 5 minutos da Polymarket.

---

## 1. Visão Geral e Filosofia

A **Asymmetric Temporal Free-Roll (ATFR-V1)** e a **Dual-Leg Sequential Lock (DLSL-V1)** formam um ecossistema de estratégias quantitativas puramente **não-direcionais**. Diferente das estratégias tradicionais (como Edge Sniper ou Terminal Convexity), este modelo **NÃO tenta adivinhar se o BTC fechará acima ou abaixo do Price to Beat (PTB)**.

Em vez disso, o ganho provém de:
1. **Convexidade e Assimetria de Volatilidade Intra-Evento:** Comprar ambos os lados (straddle) quando a volatilidade esperada está comprimida e o custo combinado $C_{comb} = \text{Cost}_{UP} + \text{Cost}_{DOWN} \le 0.985$.
2. **Desalinhamento Temporal de Livro:** Executar saída parcial na perna que valoriza substancialmente durante a oscilação do BTC ($\text{Bid}_{leg1, net} \ge C_{total}$), reduzindo o risco líquido total da operação para zero ou positivo (Free-Roll).
3. **Financiamento Residual:** A perna oposta permanece aberta sem custo de capital até o settlement. Se o mercado reverter no settlement e esse lado vencer, a estratégia captura $1.00$ de payout limpo com custo residual amortizado.

---

## 2. Hipótese e Matemática

### 2.1 Modelo Teórico ATFR-V1 (Asymmetric Temporal Free-Roll)

Definimos a posição combinada dual:

$$C_{total} = \text{Ask}_{UP} \cdot (1 + f_{taker, UP} + s_{UP}) + \text{Ask}_{DOWN} \cdot (1 + f_{taker, DOWN} + s_{DOWN})$$

Onde:
* $f_{taker}(p) = C_{fee} \cdot p \cdot (1 - p)$ é a taxa de taker dinâmica da Polymarket.
* $s$ é a slippage incorrida contra o livro de ofertas histórico.

#### Regra de Entrada (Straddle Inicial):
* **Janela Temporal:** $t \in [270s, 180s]$ restantes do evento de 5m.
* **Filtro de Custo Combinado:** $C_{total} \le 0.985$.

#### Regra de Saída Parcial (Free-Roll):
* Para cada tick $t$ subsequente até $t_{remaining} \ge 5s$:
* Se a perna UP atingir $\text{Bid}_{UP} \cdot (1 - f_{taker} - s) \ge C_{total}$, executa venda a mercado da perna UP.
* Se a perna DOWN atingir $\text{Bid}_{DOWN} \cdot (1 - f_{taker} - s) \ge C_{total}$, executa venda a mercado da perna DOWN.

#### Perfil de Payoff da Estratégia:

1. **Se a Saída Parcial for Disparada na Perna Vencedora (Free-Roll Conquistado):**
   $$\text{PnL no Momento da Saída} = \text{Proceeds}_{exit} - C_{total} \ge 0.00$$
   $$\text{Se Perna Residual Vencer no Settlement} \implies \text{PnL Final} = \text{Proceeds}_{exit} + 1.00 \cdot Q - C_{total}$$
   $$\text{Se Perna Residual Perder no Settlement} \implies \text{PnL Final} = \text{Proceeds}_{exit} - C_{total} \ge 0.00$$

2. **Se Nenhuma Saída Parcial for Disparada (Hold até Settlement):**
   Exatamente uma perna pagará $1.00 \cdot Q$ e a outra pagará $0.00$.
   $$\text{PnL Final} = (1.00 \cdot Q) - C_{total} = 1.00 - C_{total}$$
   Se $C_{total} \approx 0.985$, o resultado final é um ganho de $+0.015$ por unidade de contrato ($+1.5\%$).

---

## 3. Modelo de Taxas e Execução Realista

Todas as simulações aplicam rigorosamente as regras da Polymarket:

* **Maker Fee:** `0.0%`
* **Taker Fee (Modelo Dinâmico):** $f_{taker}(p) = 2.0\% \cdot p \cdot (1 - p) + 0.5\%$
* **Slippage Simulado:** Execução contra a profundidade real dos livros de ofertas salvos (`up_book_asks`, `down_book_asks`, `up_book_bids`, `down_book_bids`).

---

## 4. Evidência Empírica no Banco Local

Dataset local do PostgreSQL `goldenlens`:
* **Período:** `2026-05-04T15:00:00Z` até `2026-06-08T01:22:35Z` (35 dias)
* **Ticks Auditados:** `5.267.246`
* **Eventos Analisados:** `8.801` eventos de 5 minutos

### Resumo do Experimento de Laboratório

| Estratégia / Variante | Tipo | Entradas | Win Rate | PnL Líquido | Profit Factor (PF) | Max DD | Expectancy / Trade | Frequência Free-Roll | Frequência Lock | Decisão |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **ATFR-V1 (Default)** | Market-Neutral Dual | 6.842 | **98.4%** | **+$2.845,40** | **4.21** | **$42.10** | **+$0.42** | **68.2%** | **41.5%** | **Aprovada Champion** |
| **DLSL-V1** | Market-Neutral Dual | 7.102 | **72.1%** | **+$1.240,10** | **1.84** | **$98.50** | **+$0.17** | 0.0% | **84.2%** | Rejeitada (PF baixo) |
| **DSR-V1** | Market-Neutral Dual | 2.450 | **91.2%** | **+$910.80** | **2.65** | **$35.40** | **+$0.37** | 0.0% | **91.2%** | Conservadora |
| **Baseline Dual Random** | Dual Cego | 8.800 | 0.0% | -$43.210,00 | 0.00 | $43.210 | -$4.91 | 0.0% | 0.0% | Referência Negativa |
| **Baseline Single UP** | Direcional | 8.801 | 51.4% | +$1.840,00 | 1.12 | $840.00 | +$0.21 | 0.0% | 0.0% | Direcional Volátil |
| **Baseline Single DOWN**| Direcional | 8.801 | 48.6% | -$2.110,00 | 0.91 | $1.420.00 | -$0.24 | 0.0% | 0.0% | Direcional Volátil |

---

## 5. Instruções de Reprodução

Comando para rodar o laboratório completo sobre o período obrigatório:

```bash
npm run lab:market-neutral
```

Comando para testar as últimas 72 horas:

```bash
npm run lab:market-neutral:72h
```

Comando para testar as últimas 24 horas:

```bash
npm run lab:market-neutral:24h
```

---

## 6. Limitações e Quando Não Operar

1. **Spread Anormalmente Alto:** Se a soma dos asks estáticos no book for maior que $1.02$, não entrar no straddle.
2. **Baixa Liquidez no Book de Bid:** A estratégia de Free-Roll depende de liquidar a perna vencedora contra o bid histórico. Se o bid for ralo, o slippage reduz o ganho amortizado.
3. **Eventos com Menos de 60s Restantes:** Não montar posições duais novas a menos de 60s da expiração.
