# 🏆 Catálogo Mestre & Auditoria de Repricing de Padrões BTC 5M

Este documento é a **compilação quantitativa auditada** da **Mineração de Padrões e Auditoria de Repricing** realizada no histórico de **27.115 janelas de 5m de BTC e ETH** (abril a julho de 2026).

> [!WARNING]
> **AUDITORIA DE CRITÉRIO DE EXECUÇÃO (05/08/2026)**:
> Os sinais direcionais minerados neste catálogo (ex: Acumulação Silenciosa 89.2%, VCP Breakout 89.1%, Impulso 60s 83.68%) são **estatisticamente verdadeiros no sinal de direção da vela**.
> Contudo, nos backtests financeiros, a entrada em $t=60\text{s}$ usando o Ask inicial congelado de $t=0$ ($\approx \$0,51$) produzia retornos fictícios de $+1.186\%$.
> Na execução real em $t=60\text{s}$, o Ask na pedra do Polymarket já foi reprificado para **$\$0,8264$**. Executar a mercado (Taker) aos 60s reduz o Profit Factor líquido a **$1,02$** (breakeven); taker aos 30s dá prejuízo ($\text{PF} = 0,92$).
> A **Arbitragem de Mispricing** (Ask atrasado $< 0,56$ em $t=30\text{s}$) foi reauditada com fill limitado à profundidade real do book (`scratch/audit_mispricing_depth_fill.js`): gera apenas **56 trades em 94 dias** (~0,6/dia), OOS com **10 trades** (60% WR), $\text{PF} = 1,37$ e +$841 líquidos — EV positivo, porém **sem significância estatística** e sem modelar competição de latência pelo fill. Não promover como estratégia standalone.
> Para capturar a borda direcional em produção, o caminho validado continua sendo **Maker Ladder em $t=0..15\text{s}$** (abordagem do `binance-lead-scalp`); os padrões deste catálogo servem como filtros/confirmações daquele engine.

---

## 📌 1. Visão Geral da Base de Dados & Metodologia

- **Total de Janelas de 5m**: 27.115 candles (~100 dias contínuos de ticks e orderbook depth 25).
- **Separação Cega Anti-Overfitting**:
  - **In-Sample (Treino / Descoberta)**: 21.692 janelas (80% da base, 23/04/2026 a 11/07/2026)
  - **Out-of-Sample (Holdout / Teste Cego)**: 5.423 janelas (20% da base, 12/07/2026 a 31/07/2026)

---

## 📊 2. Tabela Comparativa Auditada (Repricing em $t=30\text{s}, 45\text{s}, 60\text{s}$)

| Condição de Execução | Win Rate Direcional | Preço Médio do Ask no Sinal | Win Rate OOS Real | Lucro Líquido Real ($) | Profit Factor Real |
|---|:---:|:---:|:---:|:---:|:---:|
| **Impulso 60s (Entrada ao Ask Real de $t=60\text{s}$)** | **83,68%** | **$0,8264** | 84,4% | **+$577,51** | **1,02** |
| **Impulso 30s (Entrada ao Ask Real de $t=30\text{s}$)** | 73,50% | $0,6840 | 72,7% | **-$5.401,60** | **0,92** |
| **Arbitragem de Mispricing Real** (Spot $\pm 6\text{ bps}$ aos 30s mas Ask $t=30\text{s} < 0,56$, fill depth-aware, $N=56$ / OOS $N=10$) | 60,7% | **$0,4716** | **60,0%** | **+$841,48** | **1,37** |

---

## 🥇 3. Catálogo Mestre de Padrões Direcionais Minerados

### 🥇 Classe Ouro Superior ($\text{Win Rate OOS Direcional} \ge 85\%$)

| ID | Nome do Padrão / Condição | Lado | Win Rate IS (N) | Win Rate OOS (N) | Estabilidade OOS | Significado de Mercado |
|---|---|:---:|:---:|:---:|:---:|---|
| **Q-3** | **Confluência Dupla ETH+BTC em 30s ($\text{ETH } 30\text{s} \ge +10\text{ bps}$ & $\text{BTC } 30\text{s} \ge +8\text{ bps}$)** | **UP** | 74.8% ($N=321$) | **90.9% ($N=22$)** | +16.1% | Compra síncrona nos 2 maiores ativos |
| **G-1** | Sessão de Londres (08-11 UTC) + Retorno 60s (+0.08%) -> UP | **UP** | 90.9% ($N=154$) | **100.0% ($N=15$)** | +9.1% | Abertura europeia com fluxo forte |
| **G-2** | Impulso 15s Ultra-Rápido (+0.10%) -> UP | **UP** | 82.3% ($N=266$) | **90.0% ($N=20$)** | +7.7% | Reação rápida de alta frequência |
| **N-1** | **Acumulação Silenciosa ($10\text{s} \le +0.005\%$ & $90\text{s} \ge +0.071\%$)** | **UP** | 85.4% ($N=828$) | **89.2% ($N=158$)** | +3.8% | Acumulação institucional progressiva |
| **H-4** | **VCP Squeeze Breakout (Compressão Extrema 3-Velas + Breakout 45s)** | **UP** | 87.3% ($N=165$) | **89.1% ($N=46$)** | +1.9% | Rompimento após squeeze de volatilidade |
| **G-3** | ENSEMBLE OURO DOWN: EMA 5<20 + Ret 60s <= -0.08% + Aceleração < 0 | **DOWN** | 83.8% ($N=628$) | **88.8% ($N=80$)** | +5.0% | Queda continuada em tendência |

---

### ⚠️ 4. Desmistificação de "Mitos" do Mercado (Confirmados)

1. **Streaks Isolados de Candles (3, 4 ou 5 velas consecutivas da mesma cor)**:
   - Win Rate estatístico de apenas **50,1% a 53,5%** (aleatório).
2. **RSI Extremo Isolado ($\text{RSI} < 25$ ou $> 75$)**:
   - Win Rate de apenas **51,3% a 54,1%** no teste cego.
3. **Imbalanço Simples de Livro sem Confirmação Spot**:
   - Apresenta armadilhas de liquidez falsa (*spoofing*).
