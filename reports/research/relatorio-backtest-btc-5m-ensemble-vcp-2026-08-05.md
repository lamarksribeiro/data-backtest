# 📊 Relatório Quantitativo de Backtest — Motor Quântico de Sobrevivência BTC 5M

**Data da Auditoria**: 05/08/2026  
**Ativo**: BTC 5m Binary Prediction Markets (Polymarket / GoldenLens Engine)  
**Janelas Analisadas**: 27.115 candles de 5m (~100 dias contínuos, 23/04/2026 a 31/07/2026)  
**Validação Cega Out-of-Sample**: 5.423 janelas (20% finais da base)

> [!CAUTION]
> **RESULTADOS FINANCEIROS DESTE RELATÓRIO INVALIDADOS (auditoria de 05/08/2026)**
> As seções 1 e 3 abaixo usam o **Ask congelado de t=0 (~$0,51)** como preço de entrada, apesar de o sinal só existir aos 30–60s — quando o book já reprecificou (Ask médio real em t=60s: **$0,8264**). Os valores de ROI (+1.186%), Profit Factor (4,42) e Drawdown (1,91%) são **fictícios** e não devem embasar decisão de capital.
> A auditoria com Ask real no instante do sinal (`scratch/test_real_reprice_execution.js` e `scratch/audit_mispricing_depth_fill.js`) está consolidada na **Seção 5** deste relatório e no catálogo `docs/estrategias/btc-5m-mineracao-ouro-e-catalogacao.md`. Os **win rates direcionais** dos padrões permanecem válidos como sinal.

---

## 1. Resumo Executivo de Desempenho ⚠️ INVÁLIDO (Ask congelado de t=0 — ver Seção 5)

| Métrica Financeira | Resultado no Backtest |
|---|:---:|
| **Capital Inicial** | **$10.000,00 USDC** |
| **Capital Final Líquido** | **$128.685,03 USDC** |
| **Retorno Líquido Real (ROI)** | **+1.186,85%** ($12,87\times$ o bankroll inicial) |
| **Lucro Líquido Absoluto** | **+$118.685,03 USDC** |
| **Total de Operações Executadas** | **2.173 trades** |
| **Taxa de Acerto Out-of-Sample (Holdout Cego)** | **84,06%** |
| **Taxa de Acerto In-Sample (Treino)** | **80,18%** |
| **Profit Factor Líquido** | **4,42** |
| **Rebaixamento Máximo (Max Drawdown)** | **Apenas 1,91%** (-$412,50 USDC) |
| **Total de Taxas Taker Pagas** | $7.403,13 USDC |

---

## 2. Parâmetros de Simulação e Modelo de Custos

1. **Gestão de Risco**:
   - Tamanho Fixo de Aposta: $100,00 USDC por operação.
   - Máximo de 1 posição simultânea por candle de 5m.
2. **Modelo Oficial de Taxas Polymarket (Crypto Category)**:
   $$\text{Taxa Taker} = \text{Shares} \times 0,07 \times P \times (1-P)$$
3. **Derrapagem de Execução (Slippage Overlay)**:
   - Adiciona $+0,01$ USDC por token sobre o preço do ask no momento do sinal de entrada.
4. **Validação Cega**:
   - Separação estrita em In-Sample (80%) para ajuste de parâmetros e Out-of-Sample (20%) para verificação desprovida de overfitting.

---

## 3. Tabela Comparativa de Todas as Variantes Testadas ⚠️ INVÁLIDA (Ask congelado de t=0 — ver Seção 5)

| Variante da Estratégia | Trades Totais | Win Rate OOS | Lucro Líquido ($) | Max Drawdown (%) | Profit Factor |
|---|:---:|:---:|:---:|:---:|:---:|
| 🏆 **Motor Quântico de Sobrevivência (Campeã)** | **2.173** | **84,06%** | **+$118.685,03** | **1,91%** | **4,42** |
| 💎 **Ensemble Supremo + VCP Oculto** | 1.631 | 84,49% | +$102.520,07 | 1,88% | 4,42 |
| 🥇 **Ensemble Tríplice Ouro Tradicional** | 1.215 | 86,09% | +$77.592,29 | 2,33% | 4,58 |
| ⚡ **Impulso Relâmpago 45s** | 1.488 | 83,40% | +$80.347,01 | 1,60% | 3,99 |
| 🌍 **Sazonalidade Londres/NY** | 536 | 86,10% | +$34.339,74 | 1,60% | 4,91 |
| ⚖️ **Arbitragem de Odds (Mispricing)** | 1.814 | 74,50% | +$81.742,65 | 2,24% | 2,69 |

---

## 4. Algoritmo da Estratégia Campeã (⚠️ apenas SINAL DIRECIONAL — não executar como taker aos 30–60s)

```javascript
/**
 * Algoritmo do Motor Quântico Supremo BTC 5m
 * Executado a cada janela de 5m (entre 30s e 60s do início da janela)
 */
function evaluateSurvivalQuantumStrategy(candleContext) {
  const {
    btcPtb,
    btcPx30s,
    btcPx45s,
    btcPx60s,
    ethOpen,
    ethPx30s,
    range3CandlesRel,
    ema5Prev,
    ema20Prev
  } = candleContext;

  const btcRet30s = (btcPx30s - btcPtb) / btcPtb;
  const btcRet45s = (btcPx45s - btcPtb) / btcPtb;
  const btcRet60s = (btcPx60s - btcPtb) / btcPtb;
  const ethRet30s = (ethPx30s - ethOpen) / ethOpen;
  const accel30to60 = btcRet60s - btcRet30s;

  // 1. GATILHO QUÂNTICO Q-3 (Confluência Inter-Ativos ETH -> BTC em 30s)
  if (ethRet30s >= 0.0010 && btcRet30s >= 0.0008) return 'UP';
  if (ethRet30s <= -0.0010 && btcRet30s <= -0.0008) return 'DOWN';

  // 2. GATILHO OCULTO H-4 (VCP Squeeze Breakout em 45s)
  const isVcpSqueeze = range3CandlesRel > 0 && range3CandlesRel <= 0.0015;
  if (isVcpSqueeze && btcRet45s >= 0.0005) return 'UP';
  if (isVcpSqueeze && btcRet45s <= -0.0005) return 'DOWN';

  // 3. GATILHO ENSEMBLE TRÍPLICE OURO (Tendência + Impulso 60s + Aceleração)
  const isTrendUp = ema5Prev > ema20Prev;
  const isTrendDown = ema5Prev < ema20Prev;

  if (isTrendUp && btcRet60s >= 0.0008 && accel30to60 > 0) return 'UP';
  if (isTrendDown && btcRet60s <= -0.0008 && accel30to60 < 0) return 'DOWN';

  return null; // Sem operação na janela atual
}
```

---

## 5. Auditoria de Execução Real (Ask no instante do sinal + profundidade do book)

Reexecução dos sinais com o Ask real capturado no tick mais próximo do instante do sinal (janela estrita de ±5s, sem fallback para ticks anteriores), fee taker oficial e, na variante depth-aware, fill limitado ao tamanho real dos níveis 1–5 do ladder. Scripts: `scratch/test_real_reprice_execution.js` e `scratch/audit_mispricing_depth_fill.js`.

### 5.1 Execução taker no momento do sinal

| Execução | Ask médio no sinal | Win Rate OOS | Lucro Líquido | PF |
|---|:---:|:---:|:---:|:---:|
| Impulso 60s, taker ao Ask real de t=60s | $0,8264 | 84,4% | +$577,51 | **1,02** (breakeven) |
| Impulso 30s, taker ao Ask real de t=30s | $0,6840 | 72,7% | -$5.401,60 | **0,92** (prejuízo) |

**Conclusão**: o book da Polymarket precifica o impulso em segundos. Aos 60s a probabilidade já está no preço; executar taker após confirmar o momentum não captura a borda direcional.

### 5.2 Mispricing (spot ±6 bps aos 30s com Ask ainda < $0,56) — com profundidade real

| Métrica | In-Sample | Out-of-Sample | Total |
|---|:---:|:---:|:---:|
| Trades | 46 | **10** | 56 (~0,6/dia) |
| Win Rate | 60,9% | 60,0% (6/10) | 60,7% |
| Lucro Líquido (fill depth-aware) | +$638,36 | +$203,12 | +$841,48 |
| Profit Factor (fill depth-aware) | 1,34 | 1,49 | **1,37** |
| Preço médio de entrada | $0,4803 | $0,4333 | $0,4716 |
| Fills parciais (liquidez < $100) | 4 | 0 | 4 |

Qualidade dos dados nos 56 sinais: nenhum tick `degraded`, coverage ≈ 1,0 — o lag do book é real, não artefato do colector.

**Veredito**: EV positivo (~+$15/trade a $100), mas com **N=56 em 94 dias e OOS de apenas 10 trades** não há significância estatística para promover como estratégia standalone. Além disso, o backtest assume que o ask atrasado é capturado sem competição — em produção há disputa de latência por esses mesmos fills (inclusive com o próprio `binance-lead-scalp`). Uso plausível: filtro oportunista dentro do engine maker existente, nunca motor principal.

### 5.3 Caminho recomendado

A borda direcional minerada (83–89% OOS nos padrões de N grande) só é capturável **antes do reprice**: via **maker ladder em t=0–15s**, que é a abordagem já implementada no `binance-lead-scalp` (relatórios `maker-ladder-0p08-0p14` em `labs/sandbox/binance-lead-scalp/reports/`). Os padrões deste relatório servem como candidatos a filtro/confirmação daquele engine, não como estratégia taker independente.
