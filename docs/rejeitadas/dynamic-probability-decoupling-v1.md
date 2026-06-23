# Dynamic Probability Decoupling (DPD) V1

> **Status: REJEITADA** — documento arquivado em `docs/rejeitadas/`. DPD V1 taker falhou em holdout e quebrou a carteira; ver seção 7.

A **Dynamic Probability Decoupling (DPD) V1** é uma teoria quantitativa de arbitragem estocástica de micro-derivas de curtíssimo prazo e volatilidade instantânea projetada para o mercado de contratos binários de **BTC Up/Down 5 minutos** na Polymarket. 

Diferente de estratégias clássicas do ecossistema do workspace (como Edge Sniper ou Terminal Convexity), a DPD visa identificar e explorar o desacoplamento transitório de probabilidade entre o preço de tela no livro de ofertas (CLOB) e um preço justo probabilístico gerado em tempo real por movimentos acelerados no subjacente (BTC), filtrados por um modelo dinâmico de taxas taker.

---

## 1. Hipótese e Intuição Econômica

A formulação da DPD V1 se assenta nas seguintes premissas teóricas de microestrutura de mercado:

1. **Latência de Ajuste dos Market Makers**: O formador de mercado na Polygon (onde roda a Polymarket) sofre de uma latência física e computacional insignificante em tempos normais, mas mensurável em momentos de alta aceleração do ativo subjacente (BTC). Durante micro-movimentos rápidos e sequenciais, o book do contrato binário UP ou DOWN demora preciosos segundos para realinhar suas odds ao novo valor justo implícito do BTC.
2. **Micro-Derivas Transitórias por Entropia**: Movimentos do BTC não são perfeitamente brownianos no curtíssimo prazo ($< 15\text{s}$). A aceleração da velocidade direcional do BTC induz um estado temporário de momentum local (micro-deriva transitória), que atua como vetor de entropia de curta duração.
3. **Desacoplamento Estatístico ($D_{decoupling}$)**: Ao calcular dinamicamente a probabilidade justa local através da CDF de desvio Z ajustada por essa micro-deriva e pela volatilidade móvel instantânea do BTC, a teoria mapeia distorções de probabilidade contra o ask de tela da Polymarket.
4. **Filtro de Fee Drag Adaptativo (Inovação Central)**: O maior aniquilador de estratégias em prediction markets de alta frequência é a taxa taker da Polymarket ($7\%$ sobre contracts para Crypto). Como a taxa é proporcional a $Ask \times (1 - Ask)$, ela atinge o pico em $0.50$ ($0.0175$ USDC por share) e decresce quadraticamente em direção às pontas ($0.00$ e $1.00$). A DPD V1 calcula esse arrasto transacional real a cada tick, deduzindo o custo do edge bruto estimado e regulando dinamicamente a barreira de entrada da estratégia ($Edge_{liq} \ge minNetEdge$).

---

## 2. Formulação Matemática

Para cada tick recebido de um evento ativo, definimos:

### Velocidade Direcional e Aceleração do BTC
Calculamos a velocidade de curtíssimo prazo ($v_t$ com lookback de $3\text{s}$) e aceleração instantânea ($a_t$ com lookback de $6\text{s}$):
$$v_t = \frac{BTC_t - BTC_{t-3}}{3}$$
$$v_{passada} = \frac{BTC_{t-3} - BTC_{t-6}}{3}$$
$$a_t = \frac{v_t - v_{passada}}{3}$$

### Micro-Deriva Transitória Ajustada por Entropia ($D_{transient}$)
$$D_{transient} = \text{sign}(v_t) \cdot \ln(1 + |v_t|) \cdot (1 + \tanh(a_t))$$
*Onde a função $\tanh(a_t)$ suaviza e satura a aceleração, e o logaritmo natural amortece picos extremos de volatilidade.*

### Volatilidade Móvel Instantânea ($\sigma_{inst}$)
Calculamos o desvio padrão amostral das mudanças normalizadas de preço do BTC com base no histórico recente de $15\text{s}$ (lookback dinâmico):
$$\sigma_{inst} = \text{std}\left( \frac{BTC_i - BTC_{i-1}}{\sqrt{dt}} \right)$$

### Probabilidade Justa Rápida ($P_{fair}$)
A probabilidade teórica rápida é determinada integrando a distância do preço do BTC em relação ao Price to Beat ($PTB$) e a projeção de micro-deriva temporária na escala do tempo restante em segundos ($\tau$):
$$Z_{DPD} = \frac{\text{sideSign} \cdot (BTC_t - PTB) + \text{clamp}(D_{transient} \cdot \tau \cdot w_{drift}, -v_{clamp}, +v_{clamp})}{\sigma_{inst} \cdot \sqrt{\tau}}$$
$$P_{fair} = \Phi(Z_{DPD})$$
*Onde $\Phi$ representa a CDF normal acumulada padronizada e $\text{sideSign} = +1$ para UP e $-1$ para DOWN.*

### Cálculo de Desacoplamento e Filtro de Fee Drag Adaptativo
1. **Desacoplamento do Book**:
   $$D_{decoupling, side} = P_{fair, side} - Ask_{side}$$
2. **Cálculo da Taker Fee Real (via `polymarketFees.js`)**:
   $$Fee_{est} = calculatePolymarketTakerFee(\text{shares}=1.0, \text{price}=Ask_{side})$$
3. **Critério de Entrada por Edge Líquido**:
   $$Edge_{liq} = D_{decoupling, side} - Fee_{est} \ge minNetEdge$$

---

## 3. Regra Operacional do Laboratório

O script do laboratório independente `scripts/lab-dpd.js` foi desenhado sob os seguintes parâmetros e limites de risco do workspace para proteção contra ruína:

* **Tamanho da Carteira**: $\$100.00$ USDC (capital inicial).
* **Lote Máximo por Operação**: Máximo de $\$15.00$ USDC ou o saldo disponível (`maxOrderValue=15`).
* **Volume Mínimo**: 5 shares.
* **Quantidade Mínima de Entrada**: Pelo menos 1 entrada por evento para evitar sobreposição excessiva de risco e ruína acelerada.
* **Janela Temporal Operacional**: Busca ativa de desvios entre $120\text{s}$ (2 minutos) e $10\text{s}$ restantes para a expiração do evento.
* **Fills Reais e Slippage**: Execução simulada com consumo estrito de níveis de liquidez históricos salvos no book real (`up_book_asks`, `down_book_asks`). Proibido preenchimento mágico em preço ideal de tela.

O laboratório roda com suporte nativo a **Worker Threads** concorrentes para exploração quantitativa.

---

## 4. Metodologia de Auditoria e Validação Científica

### A. Auditoria Rígida do Banco de Dados Local
Antes de submeter os modelos ao processamento de backtest, o banco de dados local foi auditado a partir do corte cronológico obrigatório de **`2026-05-04T15:00:00.000Z`** até o último timestamp disponível, com os seguintes resultados:
* **Ticks Históricos**: `3.017.492` ticks de dados integrados.
* **Eventos Analisados**: `5.056` eventos granulares de 5 minutos.
* **Cobertura Diária**: Exatamente `288` eventos diários mapeados (100% de consistência de gravação).
* **Integridade dos Dados**: Apenas um único gap de tempo detectado acima de 30 segundos (`119` segundos no dia `13/05/2026`). Apenas 4.3% dos ticks totais possuíam books nulos ou vazios (tratados robustamente pelo modelo com bids/asks de fallback).

### B. Divisão Temporal de Amostragem (60/20/20)
Os dados foram segmentados de forma puramente cronológica para evitar vazamento de informação (*lookahead bias*):
1. **Treino (60%)**: `2026-05-04T15:00:00.000Z` até `2026-05-15T03:45:06.000Z`
2. **Validação (20%)**: `2026-05-15T03:45:06.000Z` até `2026-05-18T16:00:08.000Z`
3. **Holdout (20%)**: `2026-05-18T16:00:08.000Z` até `2026-05-22T04:15:10.000Z`

---

## 5. Resultados Empíricos do Backtest

Os testes estatísticos aplicaram o cálculo taker oficial de `polymarketFees.js` ($0.07$ de tarifa taker de agressores de book em Crypto).

Os resultados revelaram um cenário de **destruição massiva e ruína financeira inevitável para todas as variantes da DPD V1** no workspace local. A carteira de teste quebrou de forma acelerada ainda nos primeiros dois dias do split de Treino, impedindo qualquer trading subsequente nas fases de Validação e Holdout por insolvência de saldo operacional (banca zerada).

### Resumo das Variantes (Ordenado por PnL Líquido do Holdout)

| Variante | Entradas (Train) | Win Rate | PnL Bruto ($) | Taxas Pagas ($) | PnL Líquido ($) | Profit Factor | Max DD ($) | Max Loss ($) | Status de Validação |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **`dpd-loose`** | 64 | 29.7% | -61.52 | 38.38 | **-$99.90** | 0.83 | 177.94 | -15.42 | **REJEITADA (Falência)** |
| **`dpd-random-baseline`** | 33 | 18.2% | -80.48 | 19.42 | **-$99.90** | 0.67 | 185.25 | -15.26 | **REJEITADA (Falência)** |
| **`dpd-fast`** | 45 | 28.9% | -70.77 | 29.13 | **-$99.90** | 0.76 | 212.25 | -15.86 | **REJEITADA (Falência)** |
| **`dpd-base`** | 46 | 28.3% | -70.34 | 29.56 | **-$99.90** | 0.77 | 221.74 | -15.86 | **REJEITADA (Falência)** |
| **`dpd-slow`** | 43 | 27.9% | -71.74 | 28.17 | **-$99.91** | 0.76 | 205.90 | -15.86 | **REJEITADA (Falência)** |
| **`dpd-edge20`** | 37 | 35.1% | -81.57 | 18.36 | **-$99.93** | 0.62 | 117.48 | -14.99 | **REJEITADA (Falência)** |
| **`dpd-tight`** | 33 | 33.3% | -82.35 | 17.62 | **-$99.97** | 0.63 | 114.44 | -15.44 | **REJEITADA (Falência)** |
| **`dpd-high-freq`** | 22 | 27.3% | -88.59 | 11.40 | **-$99.99** | 0.52 | 181.74 | -15.01 | **REJEITADA (Falência)** |

> [!CAUTION]
> **FEE DRAG COMO ANIQUILADOR DE EDGE**:
> Em todas as variantes da teoria, o arrasto transacional real de taxas taker devorou impiedosamente o capital. Na variante default `dpd-base`, a estratégia pagou **$29.56 de taxas** em 46 trades para gerar uma perda bruta de **-$70.34**, totalizando um prejuízo líquido imediato de **-$99.90** e quebrando a carteira.
> Sob alta frequência taker na Polymarket, taxas no espectro do meio do book ($0.30$ a $0.70$) consomem entre **9% e 11%** do valor acumulado de giro.

---

## 6. Rationale Científico da Falha

A ruína rápida da DPD V1 decorre de duas falhas conceituais graves no modelo estocástico:

1. **Instabilidade do Drift Transitório em Janelas Longas**: O modelo assume que desvios rápidos de $3\text{s}$ ou $6\text{s}$ na velocidade do BTC criam micro-tendências locais de tempo de expiração previsíveis. No entanto, no início do evento ($\tau \approx 120\text{s}$), a variância estocástica do BTC nos minutos seguintes apaga inteiramente o momentum de altíssima frequência. A micro-deriva calculada no início do evento age apenas como um sinal gerador de ruído aleatório, forçando a estratégia a comprar shares desvantajosos em books desfavoráveis.
2. **Execution-Slippage e Custos Freqüentes Taker**: Agredir o CLOB a mercado (Taker) de forma consecutiva com expectativa matemática unitária marginalmente próxima de zero é estatisticamente insustentável. O spread do book de prediction combinou-se com as taxas reais de agressores para deprimir o Profit Factor líquido das variantes para o intervalo de $0.52$ a $0.83$ (onde o mínimo para a sobrevivência em carteira seria $> 1.0$, e o exigido pelo laboratório seria $\ge 2.0$).
3. **Ineficácia da Baseline Aleatória**: A baseline aleatória `dpd-random-baseline` gerou 33 trades com Win Rate pífio de 18.2%, sofrendo um arrasto acumulado de taxas de **$19.42** e confirmando a falência em -$99.90. Isso atesta que operar o book de forma desorganizada ou impulsiva sob taxas reais gera ruína garantida e rápida no ambiente CLOB da Polymarket.

---

## 7. Decisão e Roteiro Futuro

### ❌ REJEIÇÃO DA TEORIA DPD V1
A teoria **Dynamic Probability Decoupling (DPD) V1** em execução estritamente Taker foi **explicitamente REJEITADA** e arquivada pela mesa de trading quantitativa. Não há fundamentação líquida pós-taxas reais que justifique o uso live desse modelo.

### 📌 Diretrizes de Correção para Próximas Teorias (Modelo Maker)
Qualquer teoria futura no mercado BTC 5 minutos que opere com alto turnover ou alta frequência de ordens deve, obrigatoriamente, ser redesenhada sob uma **arquitetura de execução passiva (Maker)**:
* **Execução por Limites**: Colocação de ordens limitadas de compra (bids) e venda (asks) em níveis de pechincha no book de ordens, aguardando agressões de outros agentes.
* **Eliminação de Custos**: O regime Maker na Polymarket elimina a taxa agressor de 7% de Crypto, transformando a desvantagem das taxas em vantagem.
* **Captura de Rebates**: A estratégia Maker se beneficia de rebates sobre taxas transacionais gerados pelo volume aportado ao mercado, atuando como um rendimento contínuo de rebate para compensar perdas de seleção adversa (*adverse selection*).

---

## 8. Comandos de Reprodução do Teste

Para executar de forma independente o laboratório e reproduzir os resultados de ruína em paralelo das 8 variantes no range exato e estrito do banco de dados local:

```bash
# Rodar o laboratório DPD no range completo de dados
npm run lab:dpd -- --from "2026-05-04T15:00:00.000Z" --to "2026-05-22T04:15:10.000Z" --mode quick
```
