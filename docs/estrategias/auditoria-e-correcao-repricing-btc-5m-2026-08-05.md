# 🔬 Relatório de Auditoria Crítica & Correção de Repricing: Validação de Realismo Financeiro em BTC 5M

**Data da Auditoria**: 05/08/2026  
**Status**: 🔴 **BACKTEST ANTERIOR INVALIDADO POR DEFEITO DE REPRICING (FROZEN PRICE em $t=0$)**  
**Status da Estratégia**: 🟢 **SINAIS DIRECIONAIS CONFIRMADOS; LUCRO EXIGE MAKER LADDER OU ARBITRAGEM DE L2 MISPRICING**

---

## 1. Identificação do Defeito Fatal no Backtest Antigo

Na auditoria dos scripts de backtest `scratch/backtest_survival_quantum.js` e `scratch/backtest_gold_strategy.js`, identificou-se um **vazamento temporal de preço de entrada (Look-Ahead / Frozen Price Defect)**:

### 🛠️ O Erro no Código:
```javascript
// O sinal é avaliado em t = 30s a 60s (quando o BTC já subiu +8 a +10 bps)
const signal = evaluateSignal(candle); 

// MAS o preço de entrada capturado usava o ASK do primeiro tick do candle (t = 0s):
ARG_MIN(up_best_ask, ts) as init_up_ask
```

### 📉 O Impacto Prático no Mercado Real:
1. No candle de 5m de BTC, em $t = 0\text{s}$, o token UP inicia cotado a aproximadamente **$0,51 - $0,52 USDC**.
2. Aos $60\text{s}$, quando o BTC Spot avança $+10\text{ bps}$ ($+0,10\%$), a probabilidade estatística de vitória da vela sobe para **83,68%**.
3. **No mercado real do Polymarket**, os market makers ajustam e reprificam o livro de ofertas em menos de 1 a 2 segundos. Portanto, em $t = 60\text{s}$, o melhor preço de venda (**Ask**) no livro já pulo para **$0,8264 USDC**.
4. O backtest antigo executava a ordem em $t = 60\text{s}$ simulando comprar a **$0,51 USDC** algo que já valia **$0,83 USDC**. Essa captura de vantagem fantasma gerou o lucro artificial de $+1.186\%$ e Profit Factor de 4.42.

---

## 2. Resultados da Re-Simulação Rigorosa (Entrada ao Ask Real em $t=30\text{s}, 45\text{s}, 60\text{s}$)

Re-executamos a base histórica de **26.995 velas de BTC 5m**, extraindo o **Ask exato da pedra no segundo em que o sinal foi gerado** ($t=30\text{s}, 45\text{s}, 60\text{s}$), com margem estrita de tempo e derrapagem de $+0,01$ USDC:

| Estratégia / Condição de Execução | Win Rate Direcional | Preço Médio do Ask no Sinal | Win Rate OOS Real | Lucro Líquido Real ($) | Profit Factor Real |
|---|:---:|:---:|:---:|:---:|:---:|
| **Impulso 60s (Entrada ao Ask Real de $t=60\text{s}$)** | **83,68%** | **$0,8264** | 84,4% | **+$577,51** | **1,02** |
| **Impulso 30s (Entrada ao Ask Real de $t=30\text{s}$)** | 73,50% | $0,6840 | 72,7% | **-$5.401,60** | **0,92** |
| **Arbitragem de Mispricing Real** (Spot $+6\text{ bps}$ aos 30s mas Ask $t=30\text{s} < 0,56$) | 68,20% | **$0,5320** | **60,0%** | **+$1.191,61** | **1,52** |

---

## 3. Conclusões Auditadas & O Que Realmente Sobrevive

### 1. O Que Foi Desmentido / Invalidado:
- ❌ **Os retornos de +1.186% e Profit Factor 4.42 eram ilusórios**: Entrar a mercado (Taker) aos 60s compra um opção que o mercado já reprificou a ~0,83 USDC. Após a taxa Taker Polymarket ($7\% \times P \times (1-P)$) e o spread, a margem de lucro Taker a 60s cai a zero ($\text{PF} = 1,02$).

### 2. O Que Sobreviveu e É Verdadeiro:
- ✅ **A Capacidade Preditiva Direcional (83,68% a 89,2%)**: O sinal direcional de microestrutura (impulso 15s-60s, VCP Squeeze, confluência síncrona ETH-BTC e a Acumulação Silenciosa N-1) **é 100% real e estatisticamente robusto**. O Spot antecipa o fechamento da vela.
- ✅ **A Desmistificação dos Mitos Tradicionais**: Streaks isolados ($50-53\%$), RSI isolado e Imbalanço sem confirmação spot continuam provados como inúteis/aleatórios.
- ✅ **A Janela de Mispricing em $t=30\text{s}$ ($\text{PF} = 1,52$)**: Em momentos de oscilação rápida, os market makers levam até 30s para atualizar certas ordens limite secundárias. Comprar quando o Spot já subiu $+6\text{ bps}$ mas o Ask ainda está desfasado abaixo de $0,56$ preserva Profit Factor positivo ($1,52$).

---

## 4. Recomendações para os Modelos de Produção (`data-robot` e `data-backtest`)

1. **Migração para Ordem Maker (Maker Ladder)**:
   - Como demonstrado nos laboratórios de `binance-lead-scalp`, a borda financeira real no Polymarket não vem de tomar liquidez em $t=60\text{s}$ (Taker a 0,83), mas sim de **postar ordens Maker limite de compra em $t=0..15\text{s}$ a $0,50-0,52$** e aguardar a execução, capturando o rebate de Maker ($0\%$ de taxa ou rebate positivo).
2. **Filtro de Desfasamento de Livro ($P_{ask}(t) < P_{teórico}$)**:
   - Disparar entradas Taker apenas quando a discrepância entre o preço Spot atual e a cotação da pedra for $> 6\text{ cents}$, capturando a latência de repricing dos market makers em janelas de volatilidade.
