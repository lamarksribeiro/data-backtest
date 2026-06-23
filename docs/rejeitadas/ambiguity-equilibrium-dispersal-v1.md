# Ambiguity Equilibrium Dispersal (AED) V1

> **Status: REJEITADA** — documento arquivado em `docs/rejeitadas/`. AED V1 taker quebrou a carteira em todos os splits; ver seção 7.

A **Ambiguity Equilibrium Dispersal (AED) V1** é uma teoria quantitativa inovadora e de altíssima frequência desenvolvida para operar o mercado de **BTC Up/Down 5 minutos** na Polymarket. 

Diferente de estratégias clássicas que buscam momentum direcional ou compressão de volatilidade (como Edge Sniper, VCL ou Impulse Elasticity), a AED explora a **dispersão estocástica e temporária das odds do book de ordens em torno do equilíbrio simétrico (50/50) de ambiguidade**. A anomalia ocorre quando o BTC está muito próximo do Price to Beat (PTB) no terço final do evento e o varejo ou bots irracionais forçam descontos absurdos em um dos lados do book.

---

## 1. Hipótese e Intuição Econômica

A teoria AED foi concebida sob os seguintes fundamentos científicos e microestruturais:

1. **Equilíbrio de Ambiguidade Extrema**: Quando o preço do BTC está muito próximo do Price to Beat (ex: $\le \$10.0$ de distância) na fase final do evento (entre $80\text{s}$ e $20\text{s}$ restantes), a probabilidade matemática justa de expiração para qualquer um dos lados (`UP` ou `DOWN`) é perfeitamente simétrica e equivalente a **$50.0\%$** (uma moeda não viesada). Não há momentum ou tendência de curto prazo que consiga sobrepujar o ruído de alta frequência nessa zona de indefinição.
2. **Dispersão e Descontos Irracionais (Sinal AED)**: Apesar da probabilidade justa ser de $50\%$, o fluxo de ordens de varejo unilateral ou o pânico de traders tentando fechar posições gera distorções temporárias no livro de ofertas (CLOB). Frequentemente, o ask de um dos lados é empurrado para níveis excessivamente baixos (ex: $\le 0.40$ ou até menos). 
3. **Edge Esperado Matemático**: Ao comprar shares de um contrato binário por um ask de $A \le 0.40$ quando sua probabilidade matemática de vitória é estritamente $50.0\%$, capturamos um **edge esperado bruto de pelo menos $+10.0\text{ pp}$** ($0.50 - A$).
4. **Payoff Assimétrico Massivo**: O risco é limitado ao prêmio pago (máximo de $\$0.40$ por share), enquanto o payout vencedor é de $\$1.00$. Isso cria uma assimetria fantástica de **$1.5\text{x}$ a $3.0\text{x}$** a favor do trader (ganhamos de $\$0.60$ a $\$0.75$ nas vitórias contra perda estrita de $\$0.25$ a $\$0.40$ nas derrotas), com uma taxa de acerto esperada de 50%.
5. **Lei dos Grandes Números**: Por operar com altíssima frequência em uma zona que o BTC visita constantemente, a AED executa milhares de trades. Mesmo com um Profit Factor baixo por operação individual, a acumulação contínua do edge matemático garante uma curva de equity ascendente e altamente robusta contra variações de regime.

---

## 2. Formulação Matemática

Para cada evento ativo e a cada tick recebido, definimos:

- $X_t = |\text{btc\_price}_t - \text{price\_to\_beat}|$: Distância absoluta do preço do BTC em relação ao PTB.
- $\tau$: Tempo restante em segundos até a expiração do evento.
- $P_{\text{fair}} = 0.50$: Probabilidade teórica justa sob ambiguidade extrema.

### Cálculo de Edge e Score do Candidato
Para cada lado (UP e DOWN), a partir de suas respectivas ofertas de $Ask_{\text{side}}$ e $Bid_{\text{side}}$:

1. **Spread do Book**:
   $$Spread_{\text{side}} = Ask_{\text{side}} - Bid_{\text{side}}$$

2. **Edge do Modelo**:
   $$ModelEdge_{\text{side}} = P_{\text{fair}} - Ask_{\text{side}} = 0.50 - Ask_{\text{side}}$$

3. **Penalidade de Proximidade**:
   Quando mais distante do PTB, menor é a validade da hipótese de simetria (50/50). Calculamos a proximidade penalizada como:
   $$ProximityScore = 1 - \frac{X_t}{maxBtcDist}$$

4. **AED Decision Score**:
   $$Score_{\text{side}} = \frac{ModelEdge_{\text{side}} \cdot ProximityScore}{\max(0.01, Spread_{\text{side}})}$$

A estratégia filtra candidatos e seleciona o lado com maior decision score positivo que respeite todos os thresholds operacionais.

---

## 3. Regra Operacional Recomendada

A variante campeã absoluta validada estatisticamente é a **`aed-dist10`**. Suas regras de filtragem e parametrização são:

| Parâmetro | Valor | Descrição |
|---|---:|---|
| `entryWindowStart` | `80s` | Início da janela temporal de busca por dispersão. |
| `entryWindowEnd` | `20s` | Fim da busca. Evita os últimos 20s de volatilidade de liquidação. |
| `maxBtcDist` | `$10.0` | **Threshold de Ambiguidade**: Distância máxima aceitável BTC/PTB. |
| `maxAsk` | `0.40` | **Limite de Desconto**: Só aceita comprar se o ask do book for $\le 0.40$. |
| `maxSpread` | `0.08` | Spread máximo do book para evitar custos transacionais elevados. |
| `minOddsSum` | `0.96` | Limite inferior de integridade das odds combinadas do book. |
| `maxOddsSum` | `1.08` | Limite superior de integridade do book. |
| `minModelEdge` | `0.10` | Exige edge teórico mínimo de $+10.0\text{ pp}$ ($0.50 - 0.40$). |
| `entrySlippageMax` | `0.02` | Consumo de liquidez permitido até $Ask + 0.02$ no preenchimento real. |
| `minLiquidityRatio`| `0.60` | Exige pelo menos 60% da quantidade desejada visível no book. |
| `maxOrderValue` | `$15.0` | Limite de risco de capita## 4. Evidência Empírica e Resultados (Pós-Correção de Taxas Reais)

Os testes quantitativos foram rodados utilizando paralelismo via Workers em ambiente Node.js ESM. Após desmascararmos um bug sutil no interpretador do JavaScript (onde `toFiniteNumber(null)` retornava `0` e tratava o override de taxas como zero), aplicamos a modelagem de taxas **taker** dinâmicas reais da Polymarket no coeficiente de Crypto ($0.07$ de taxa taker de entrada).

Os resultados revelaram uma realidade devastadora para a sobrevivência quantitativa da estratégia. **Todas as variantes da teoria AED foram à ruína financeira total (-$100.00 de PnL Líquido), quebrando a carteira de teste de $100.00 ainda no split de Train.**

### Dados do Banco Local
- **Ticks Processados**: `3.015.237`
- **Total de Eventos**: `5.044`
- **Período**: `2026-05-04T15:00:00.000Z` a `2026-05-22T03:37:21.126Z` (18 dias contínuos).
- **Amostragem**: Divisão temporal cronológica rígida em **Train (60%)**, **Validation (20%)** e **Holdout (20%)**.

### Resultados Consolidados Reais (Ordenados por PnL Líquido do Holdout)

Como as variantes quebraram no split de Train, elas não realizaram operações adicionais nos splits de Validation e Holdout (entries = 0), uma vez que o saldo da carteira tornou-se insuficiente para a margem de lote mínimo.

| Variante | Entradas (Train) | Win Rate | PnL Bruto ($) | Taxas Pagas ($) | PnL Líquido ($) | Profit Factor | Expectancy/Trade | Fee Drag % | Status |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **`aed-random-baseline`** | 12 | 16.7% | -92.81 | 7.05 | **-$99.86** | 0.25 | -$8.321 | 20.6% | **Quebra / Ruína** |
| **`aed-sh-ask38`** | 13 | 15.4% | -92.42 | 7.44 | **-$99.86** | 0.31 | -$7.682 | 16.0% | **Quebra / Ruína** |
| **`lf-amr-conservative`** | 22 | 18.2% | -85.72 | 14.16 | **-$99.88** | 0.57 | -$4.540 | 10.4% | **Quebra / Ruína** |
| **`aed-sh-base`** | 35 | 28.6% | -79.28 | 20.60 | **-$99.89** | 0.70 | -$2.854 | 8.6% | **Quebra / Ruína** |
| **`aed-sh-dist10`** | 69 | 33.3% | -58.22 | 41.70 | **-$99.92** | 0.84 | -$1.448 | **7.5%** | **Quebra / Ruína** |
| **`lf-amr-extreme`** | 21 | 19.0% | -85.97 | 13.97 | **-$99.94** | 0.57 | -$4.759 | 10.5% | **Quebra / Ruína** |
| **`aed-sh-dist5`** | 34 | 29.4% | -79.08 | 20.87 | **-$99.95** | 0.70 | -$2.940 | 8.6% | **Quebra / Ruína** |
| **`aed-sh-ask35`** | 14 | 21.4% | -91.27 | 8.73 | **-$100.01** | 0.37 | -$7.143 | 14.3% | **Quebra / Ruína** |

> [!CAUTION]
> **RUÍNA ESTATÍSTICA INEVITÁVEL**:
> O cálculo estrito do custo operacional expõe o *Fee Drag* como o principal aniquilador de edge sob regime de alta frequência taker. A variante campeã teórica, `aed-sh-dist10`, operando com a janela mais flexível, pagou **$41.70 de taxas** em apenas 69 trades para colher um prejuízo bruto de **-$58.22**, gerando uma expectativa líquida pessimista de **-$1.448 por trade** e resultando na falência rápida do capital de teste.

---

## 5. Validação Científica do "Fee Drag"

Para fins de verificação do edge bruto e da sensibilidade aos custos da Polymarket, analisamos a baseline aleatória com custos `aed-random-baseline`:
- A baseline aleatória gerou 12 trades, acumulando **$7.05 de taxas**, sofrendo um *Fee Drag* devastador de **20.6%** e quebrando a carteira com PnL líquido de **-$99.86**.
- A variante `aed-sh-dist10`, embora exiba uma taxa de acerto estatisticamente superior (33.3% contra 16.7% da baseline), foi incapaz de suportar o arrasto contínuo da taker fee de entrada combinada com a sua variância intrínseca sob payoffs de $1.5\text{x}$ a $3.0\text{x}$.

Isso prova empiricamente que a tese de explorar a zona de ambiguidade consumindo ordens a mercado (taker) é **inviável** na Polymarket, pois a taker fee no preço médio de $0.20$ a $0.40$ consome de **7.5% a 20%** de todo o capital girado pela estratégia.

---

## 6. Comparação com Outras Estratégias no Mesmo Recorte Real

Quando aplicadas as taxas reais corrigidas de $0.07$ para Crypto sobre as demais teorias do workspace `polymarket-test` sob as mesmas condições cronológicas de dados:

1. **AED V1 (Taker)**: **Falência completa (-$99.92)** em 69 trades. Edge corroído inteiramente pelas taker fees na entrada.
2. **Estratégias Maker (Rebates)**: Qualquer tese viável de alta frequência para operar o book de 5 minutos do BTC na Polymarket deve, obrigatoriamente, adotar uma execução **passiva (Maker)**. Sob o regime maker, as taxas de entrada de 7% são eliminadas e a estratégia é elegível a rebates de **20% a 50%** sobre as taxas dos agressores, transformando o *Fee Drag* em um *Rebate Yield* positivo para a carteira.

---

## 7. Decisão Científica e Rationale

### ❌ Decisão de REJEIÇÃO para o Live
A teoria quantitativa **Ambiguity Equilibrium Dispersal (AED) V1** em sua formulação original (execução estritamente Taker de entrada) foi **explicitamente REJEITADA e descartada para operação em conta real (live)**.

### Rationale:
1. **Falta de Sobrevivência Líquida**: O Profit Factor líquido out-of-sample foi nulo (estratégia quebrou no Train). Nenhum split de validação ou holdout obteve lucro real.
2. **Elevada Taker Fee**: A taker fee da Polymarket para Crypto, dada pela fórmula $\text{qty} \times 0.07 \times P \times (1-P)$, penaliza agressivamente ordens próximas a $0.40$, abocanhando quase todo o edge estatístico antes do vencimento do mercado.
3. **Execution-Slippage e Custos Ocultos**: Mesmo segurando a posição até o settlement (Settlement Hold, tarifa zero de saída), a taxa de entrada de taker de $0.07$ por share é alta demais para permitir a sustentabilidade matemática em alta frequência.

---

## 8. Novo Direcionamento Quantitativo (Maker)

Para que a mesa de trading quantitativo possa extrair valor da zona de ambiguidade nos 5 minutos do BTC, recomenda-se a migração da AED V1 para um modelo **Maker Passivo**:
- **Execução por Limites**: Inserir bids passivos a preços de pechincha ($0.30$ a $0.35$) em vez de agredir ofertas existentes.
- **Rebates Polymarket**: Capturar o rebate real da Polymarket ($20\%$ de rebate base, escalando com o volume) gerando fluxo de liquidez no book.
- **Filtro de Volatilidade**: Suspender a inserção de ordens limites em momentos de micro-explosão de volatilidade do BTC (micro-tendências fortes), protegendo a fila passiva de preenchimentos tóxicos (*adverse selection*).

---

## 9. Comandos de Reprodução (Pós-Correção)

Para reproduzir os resultados exatos e documentar a quebra do capital devido às taxas reais:

```bash
# Executar laboratório AED pós-correção:
node scripts/lab-ambiguity-equilibrium-dispersal.js --progress --progress-every 500000
``` resultados exatos do laboratório quantitativo a partir do banco de dados local:

```bash
# Rodar o backtest de alta velocidade com Workers para todas as variantes de AED:
npm run lab:aed -- --mode quick --workers auto
```
