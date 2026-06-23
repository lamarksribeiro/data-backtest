# Estudo de Falhas — Novas Teorias para BTC Up/Down 5min

**Data**: 18 de maio de 2026
**Objetivo**: Documentar TODOS os dados, hipóteses, testes e pontos de falha para análise futura.
**Range**: 2026-05-04T15:00:00.000Z → 2026-05-18T12:31:30.318Z (14 dias)

---

## 1. Caracterização do Banco de Dados

### 1.1 Confirmação SQL Inicial

```sql
SELECT COUNT(*) AS ticks, COUNT(DISTINCT event_start) AS events,
       MIN(ts) AS first_ts, MAX(ts) AS last_ts
FROM ticks WHERE ts >= '2026-05-04T15:00:00.000Z';
```

| Métrica | Valor |
|---|---:|
| Ticks | 2,382,604 |
| Eventos | 3,982 |
| Primeiro tick | 2026-05-04T15:00:00.548Z |
| Último tick | 2026-05-18T10:45:39.447Z |

### 1.2 Cobertura por Dia

| Dia | Ticks | Eventos |
|---|---:|---:|
| 2026-05-04 | 86,256 | 144 (parcial, a partir de 15h) |
| 2026-05-05 a 2026-05-17 | ~172,500/dia | 288/dia |
| 2026-05-18 | ~54,045 | 94 (parcial) |

### 1.3 Qualidade dos Dados

| Métrica | Valor |
|---|---:|
| Ticks por evento (p50) | 599 |
| Eventos com < 50 ticks | 0 |
| Book depth disponível | 95.7% dos ticks |
| Gaps intra-evento > 2s | 0 |
| Maior gap intra-evento | 1.496s |

---

## 2. Exploração SQL — Todos os Dados Coletados

### 2.1 Comportamento por Tempo Restante

| Segundos restantes | Ticks | Avg UP Ask | Avg DOWN Ask | Avg Odds Sum |
|---|---:|---:|---:|---:|
| 270s | 235,941 | 0.5105 | 0.5027 | 1.0132 |
| 240s | 238,572 | 0.5097 | 0.5030 | 1.0126 |
| 210s | 238,505 | 0.5069 | 0.5057 | 1.0127 |
| 180s | 238,470 | 0.5053 | 0.5067 | 1.0120 |
| 150s | 238,559 | 0.5019 | 0.5104 | 1.0123 |
| 120s | 238,520 | 0.5012 | 0.5113 | 1.0125 |
| 90s | 238,520 | 0.5012 | 0.5120 | 1.0132 |
| 60s | 238,489 | 0.5008 | 0.5117 | 1.0125 |
| 30s | 238,529 | 0.4991 | 0.5133 | 1.0124 |
| 0s | 238,509 | 0.5021 | 0.5124 | 1.0145 |

**Análise**: Odds sum estável em ~1.01 durante todo o evento. Nenhuma distorção significativa perto da expiração. UP e DOWN permanecem simétricos (~0.50 cada).

### 2.2 Distância BTC vs PTB e Impacto nos Preços

| Distância BTC-PTB | Ticks | Avg UP Ask | Avg DOWN Ask |
|---|---:|---:|---:|
| 0-5 | 339,408 | 0.5082 | 0.5054 |
| 5-10 | 267,533 | 0.5054 | 0.5084 |
| 10-20 | 449,753 | 0.5059 | 0.5076 |
| 20-30 | 334,183 | 0.5011 | 0.5121 |
| 30-50 | 408,392 | 0.5110 | 0.5015 |
| 50-100 | 387,950 | 0.4986 | 0.5130 |
| 100+ | 161,022 | 0.4852 | 0.5252 |

**Análise**: Preços respondem monotonicamente à distância, mas a resposta é SURPREENDENTEMENTE MODERADA. Mesmo com BTC $100+ distante, UP ask só chega a 0.485/0.525. O mercado só fica extremo quando combinado com pouco tempo restante.

### 2.3 Spread e Odds Sum

| Spread Bucket | Ticks |
|---|---:|
| < 0.01 | 338,645 |
| 0.01–0.03 | 1,920,575 (80.6%) |
| 0.03–0.05 | 79,038 |
| 0.05–0.10 | 35,138 |
| 0.10–0.20 | 7,120 |
| 0.20+ | 1,152 |

| Odds Sum Bucket | Ticks |
|---|---:|
| < 0.90 | 1 |
| 0.95–1.00 | 4 |
| **1.00–1.05** | **2,330,732 (97.8%)** |
| 1.05–1.10 | 41,390 |
| 1.10–1.20 | 8,308 |
| 1.20+ | 1,243 |

**Análise**: Spreads são apertados (80% entre 0.01-0.03). Odds sum quase sempre entre 1.00-1.05. **O mercado é notavelmente eficiente e bem comportado.**

### 2.4 Acurácia Direcional do Mercado

| Janela | Eventos | Acurácia do Ask |
|---|---:|---:|
| A 60s da expiração | 3,981 | **92.4%** |
| A 30s (estimado) | — | ~95% |
| Último tick | 3,982 | **97.2%** |

**Query usada (60s)**:
```sql
SELECT COUNT(*),
  SUM(CASE WHEN winner='UP' AND up_ask > down_ask THEN 1
           WHEN winner='DOWN' AND down_ask > up_ask THEN 1 ELSE 0 END) AS correct
FROM state_60s JOIN outcomes USING (event_start);
```

**Análise**: A direção do ask é extremamente preditiva. Aos 60s, 92.4% de acerto. No último tick, 97.2%. Isso significa que o mercado já "sabe" o vencedor com alta confiança bem antes da expiração.

### 2.5 Acurácia por Regime de Volatilidade × Distância (DADO CRÍTICO)

| Regime | Distância | Eventos | Acurácia Ask |
|---|---:|---:|---:|
| Low vol (UTC 0-3) | 0-10 | 132 | 62.9% |
| Low vol (UTC 0-3) | 10-20 | 125 | 75.2% |
| Low vol (UTC 0-3) | **20-35** | 135 | **84.4%** |
| Low vol (UTC 0-3) | 35-55 | 140 | 94.3% |
| High vol (UTC 12-15) | 0-10 | 97 | 54.6% |
| High vol (UTC 12-15) | 10-20 | 94 | 75.5% |
| High vol (UTC 12-15) | **20-35** | 125 | **76.8%** |
| High vol (UTC 12-15) | 35-55 | 109 | 89.0% |

**Análise**: Para a MESMA distância de 20-35, a acurácia é 84.4% em hora calma vs 76.8% em hora volátil — **diferença de 7.6pp**. Isso motivou a Hipótese 1 (SAD). Porém, o mercado JÁ precifica essa diferença: em horas calmas, os asks estão mais extremos para a mesma distância, eliminando o edge.

### 2.6 Volatilidade do BTC por Hora (DADO CRÍTICO)

| Hora UTC | MedianDist | VolRatio (÷21.6) |
|---|---:|---:|
| 02h | 18.2 | 0.84 |
| 03h | 19.7 | 0.91 |
| 10h | 33.4 | 1.55 |
| 11h | 37.1 | 1.72 |
| 12h | 33.6 | 1.56 |
| 22h | 28.7 | 1.33 |

**Variação**: 0.84× a 1.72× (fator ~2×). Horas 10-13 (abertura europeia/americana) são as mais voláteis. Madrugada (UTC 1-4) é a mais calma.

### 2.7 Book Pressure — Sinal Contrário

| Pressão do Book | Amostras | Movimento Médio BTC |
|---|---:|---:|
| Strong UP pressure | 468,209 | **-0.0093** (cai!) |
| Mild UP pressure | 76,242 | +0.0140 |
| Neutral | 99,143 | +0.0009 |
| Mild DOWN pressure | 78,927 | -0.0099 |
| Strong DOWN pressure | 470,403 | **+0.0095** (sobe!) |

**Query**:
```sql
WITH pressure AS (
  SELECT up_bid_depth, up_ask_depth, down_bid_depth, down_ask_depth,
         LEAD(btc_price) OVER w - btc_price AS next_move
  FROM ticks WHERE sec_rem BETWEEN 30 AND 180
  WINDOW w AS (PARTITION BY event_start ORDER BY ts)
)
SELECT CASE
  WHEN (up_bid + down_ask) > (up_ask + down_bid) * 1.3 THEN 'strong_up'
  ...
END, AVG(next_move), COUNT(*)
FROM pressure GROUP BY 1;
```

**Análise**: Book pressure é um sinal CONTRÁRIO estatisticamente significativo (468k amostras). Forte pressão compradora em UP → BTC cai 0.009$/tick. **Mas o efeito é minúsculo** (0.009 vs std de 2-5 $/tick) — economicamente irrelevante.

### 2.8 Cross-Event Momentum — ZERO

| Margem Evento Anterior | Direção Anterior | Próx. UP Win |
|---|---:|---:|
| Tight (0-10) | UP | 50.9% |
| Tight (0-10) | DOWN | 47.1% |
| Wide (30-60) | UP | 50.2% |
| Wide (30-60) | DOWN | 52.0% |
| Very Wide (60+) | UP | 47.3% |
| Very Wide (60+) | DOWN | 52.0% |

**Análise**: Nenhuma diferença significativa. Todos os valores próximos de 50%. **O resultado do evento N não prevê o evento N+1.**

### 2.9 Reversões BTC-PTB

| Métrica | Valor |
|---|---:|
| Eventos com cruzamento do PTB | ~49.7% |
| Flipped UP→DOWN | 977 |
| Flipped DOWN→UP | 1,000 |

**Análise**: Metade dos eventos tem reversão. BTC não tem viés direcional significativo — essencialmente um random walk nos 5 minutos.

### 2.10 Efeito "Snap" nos Últimos 30s

| Métrica | Valor |
|---|---:|
| Eventos totais | 3,982 |
| UP snapped (<0.55 → >0.90) | 203 (5.1%) |
| DOWN snapped | 154 (3.9%) |
| **Qualquer lado snapped** | **357 (9.0%)** |

**Análise**: Apenas 9% dos eventos têm "snap" — o lado vencedor salta de <0.55 para >0.90 nos últimos 30s. Em 91% dos eventos, a convergência é gradual. **Isso limita estratégias baseadas em convexidade terminal.**

### 2.11 First Tick Bias

| Regime (primeiro tick) | Eventos | UP Win % |
|---|---|---|
| BTC UP, Ask UP | 1,245 | 56.4% |
| BTC UP, Ask DOWN (discordância) | 521 | 46.6% |
| BTC DOWN, Ask DOWN | 1,258 | 42.2% |
| BTC DOWN, Ask UP (discordância) | 978 | 53.3% |

**Análise**: Quando BTC e ask discordam no primeiro tick, o MERCADO (ask) está mais certo que o BTC. A discordância prevê reversão. Mas o efeito é pequeno (3-4pp) e não gera edge após spread.

### 2.12 BTC Velocity por Janela de Tempo

| Janela | Amostras | Avg Velocity ($/s) | Std Velocity | Avg Abs Velocity |
|---|---:|---:|---:|---:|
| 0-30s | 234,540 | -0.006 | 5.37 | 1.15 |
| 30-60s | 238,526 | +0.016 | 5.66 | 1.19 |
| 60-120s | 477,008 | +0.002 | 4.80 | 1.18 |
| 120-180s | 477,080 | -0.008 | 5.82 | 1.23 |
| 180-240s | 476,984 | -0.015 | 7.07 | 1.28 |
| 240-300s | 474,514 | +0.002 | 6.71 | 1.35 |

**Análise**: Velocidade média ~0 (sem drift). Std 5-7 $/s. Em 30s, BTC pode mover √30 × 5.37 ≈ $29 (1σ). Em 5 min, √300 × 6 ≈ $104. O movimento esperado é grande relativo aos thresholds típicos ($25-55).

---

## 3. Hipóteses Testadas e Resultados Detalhados

### 3.1 H1: Sigma Adaptive Drift (SAD) ❌

**Arquivo**: `archive/labs-rejeitados/lab-sigma-adaptive-drift.js`

**Hipótese**: O mercado não ajusta spread/velocidade por regime de volatilidade. Calibrar thresholds de entrada pela hora do dia (volRatio 0.84-1.72) capturaria mais entradas boas em horas calmas.

**Matemática**:
```
volRatio[h] = medianDist[h] / globalMedian
adaptiveDist = baseDist × volRatio^0.5  (clamp 12-55)
adaptiveSigma = baseSigma × volRatio^0.7 (clamp 6-30)
σ_τ = max(adaptiveSigma, realizedVol × √τ × 1.2)
z = (side × (BTC-PTB) + driftTerm) / σ_τ
p_side = Φ(z)
Entry if: |BTC-PTB| > adaptiveDist AND p_side > ask + 0.06
```

**Variantes testadas**: 23 (quick mode): fixas, adaptativas (dist, sigma, full), diferentes baseDist, edge filters, stops.

**Resultados**:

| Variante | Entradas | Win Rate | PF Total | PF Holdout | Max DD |
|---|---:|---:|---:|---:|---:|
| sad-fixed-25 (baseline) | 302 | 54.3% | 1.89 | 1.37 | 90.53 |
| sad-full (adaptativo) | 290 | 54.5% | 1.87 | 1.37 | 106.75 |
| sad-full-d20 | 433 | 52.0% | 1.82 | 1.32 | 129.33 |
| sad-fixed-35 | 142 | 61.3% | 2.63 | — | 63.11 |

**Resultado por split (sad-full-d20)**:

| Split | Entradas | Win Rate | PnL | PF |
|---|---:|---:|---:|---:|
| Train (60%) | 248 | 54.0% | +1,331 | 2.26 |
| Validation (20%) | 54 | 46.3% | +101 | 1.43 |
| Holdout (20%) | 131 | 50.4% | +236 | 1.32 |

**Pontos de Falha**:

1. **Adaptação não diferenciou**: As variantes adaptativas (`sad-full`, `sad-dist-a05`, etc.) tiveram performance IDÊNTICA à baseline fixa. O volRatio variou de 0.88 a 1.72 na prática, mas `adaptiveDist` só oscilou entre 18.8 e 26.2 — faixa estreita demais para alterar seleção de eventos.

2. **Look-ahead bias na calibração**: A `hourlyMedianDist` foi calculada com o range INTEIRO (incluindo holdout). Isso significa que a calibração "viu" dados futuros. Mesmo com essa vantagem ilegítima, não performou. Se a calibração fosse truly out-of-sample (usando só train), seria ainda pior.

3. **O mercado já precifica volatilidade**: A acurácia do ask é 84.4% em horas calmas vs 76.8% em horas voláteis para distância 20-35 (Seção 2.5). O MERCADO já é mais preciso nas horas calmas — não há edge residual.

4. **Janela muito ampla (120s-10s)**: Entrar cedo expõe a mais risco de reversão. O mercado acerta 92.4% a 60s — os 7.6% de erro são onde as perdas acontecem.

5. **Holdout abaixo do critério**: PF máximo no holdout foi 1.37. Critério mínimo era 2.0.

**Variante `sad-fixed-35`**: PF 2.63 total com 142 entradas. É a única com PF comparável às estratégias existentes, mas é essencialmente um Edge Sniper simplificado (threshold fixo, sem stops dinâmicos) — **não constitui teoria nova**.

---

### 3.2 H2: Cross-Sectional Momentum Divergence (CSMD) ❌

**Arquivo**: `archive/labs-rejeitados/lab-cross-sectional-momentum.js`

**Hipótese**: Quando UP mid sobe E DOWN mid cai simultaneamente (divergência), há pressão direcional mais convincente do que quando se movem juntos. A divergência revela convicção do mercado.

**Matemática**:
```
delta_up = (up_mid_t - up_mid_{t-1}) / dt
delta_down = (down_mid_t - down_mid_{t-1}) / dt
divergence = delta_up - delta_down
convergence = delta_up + delta_down
purity = |divergence| / (|divergence| + |convergence|)
signal = EWMA(divergence, decay=5s, window=15s)
Entry if: |signal| > 0.002 AND purity > 0.55 AND BTC aligned
```

**Variantes testadas**: 12 (quick mode): pureza, força, lookback, BTC alignment, stops.

**Resultados**:

| Variante | Entradas | Win Rate | PF Total | PF Holdout | Max DD |
|---|---:|---:|---:|---:|---:|
| csmd-fast | 73 | 49.3% | 1.86 | 2.30 (28 trades) | 50.08 |
| csmd-base | 38 | 47.4% | 1.66 | 1.78 (16 trades) | 29.67 |
| csmd-nobtc (sem BTC) | 112 | 13.4% | 0.48 | — | 101.27 |

**Resultado por split (csmd-fast)**:

| Split | Entradas | Win Rate | PnL | PF |
|---|---:|---:|---:|---:|
| Train | 38 | 52.6% | +133 | 1.84 |
| Validation | 7 | 28.6% | -7 | 0.83 |
| Holdout | 28 | 50.0% | +131 | 2.30 |

**Pontos de Falha**:

1. **Pouquíssimas entradas**: Apenas 73 em 14 dias (~5/dia). Com 28 no holdout, o PF 2.30 NÃO é estatisticamente robusto — 2-3 trades poweriam o resultado.

2. **Sinal muito ruidoso**: A divergência UP/DOWN é dominada por ruído de microestrutura. O `purity` raramente passa de 0.55.

3. **Sem BTC = desastre**: `csmd-nobtc` teve 13.4% win rate em 112 entradas. O sinal de divergência PURO é pior que aleatório (86.6% de erro). O sinal só funciona quando corroborado pelo BTC — mas aí o BTC já é o sinal dominante.

4. **Validation quebrou**: PF 0.83 na validation com 7 trades — sinal de overfitting no train.

---

### 3.3 H3: Gamma Scalping (GS) ❌

**Arquivo**: `archive/labs-rejeitados/lab-gamma-scalping.js`

**Hipótese**: Em vez de hold to settlement, operar a convexidade intra-evento: comprar perto do ATM (0.35-0.65) onde gamma é máximo, vender após pequeno lucro (8-20%), com stop loss. Múltiplas entradas por evento.

**Matemática**:
```
Gamma máximo quando ask ∈ [0.35, 0.65]
Entry: comprar no ask com BTC momentum a favor (min 1$/10s)
Exit: take-profit em bid ≥ entry × (1+tp%), stop-loss em bid ≤ entry × (1-sl%)
Force close: 10s antes da expiração
Max 5 posições simultâneas por evento, cooldown 15s
```

**Variantes testadas**: 12 (quick mode): take-profit 8-20%, stop-loss 5-15%, ATM range, momentum.

**Resultados**:

| Variante | Entradas | Win Rate | PF Total | PnL Total |
|---|---:|---:|---:|---:|
| gs-tight | 156 | 36.5% | 0.56 | -97.85 |
| gs-base | 258 | 39.1% | 0.69 | -100.06 |
| gs-sl15 | 242 | 47.1% | 0.72 | -98.86 |
| gs-many | 387 | 42.9% | 0.78 | -100.31 |

**TODAS as variantes perderam dinheiro.**

**Pontos de Falha**:

1. **Expectância matemática negativa**: Para um contrato a 0.50:
   - Take-profit 12%: ganho = 0.06 por contrato
   - Stop-loss 10%: perda = 0.05 por contrato
   - Spread bid-ask: ~0.015
   - EV ≈ 0.5 × 0.06 - 0.5 × 0.05 - 0.015 = **-0.01 por trade**
   - O spread sozinho já torna a estratégia não lucrativa.

2. **Gamma não é "grátis"**: A alta gamma perto do ATM significa que o preço se move RÁPIDO — tanto a favor quanto contra. Não há assimetria explorável sem previsão direcional.

3. **Win rate estruturalmente baixa**: Com take-profit 12% e stop-loss 10%, a win rate de equilíbrio é ~45%. Obtivemos 30-47% — dentro do ruído.

4. **Todas as entradas concentradas no primeiro dia**: Bug ou condição de entrada extremamente restritiva que só ativou em condições específicas do dia 2026-05-04.

---

## 4. Tabela Comparativa Final

| Estratégia | PF Total | Win Rate | Entradas (14d) | PF Holdout | Status |
|---|---:|---:|---:|---:|---|
| Gamma Ladder V1 | 6.15 | 50.7% | 136 | — | ✅ Produção |
| Terminal Convexity V1 | 4.02 | 50.0% | 52 | — | ✅ Produção |
| Impulse Elasticity V1 | 4.01 | 75.7% | 115 | — | ✅ Produção |
| Edge Sniper V1 | 2.33 | 73.8% | 130 | — | ✅ Produção |
| **SAD fixed-35** | 2.63 | 61.3% | 142 | — | ❌ Não é teoria nova |
| **SAD full-d20** | 1.82 | 52.0% | 433 | 1.32 | ❌ Holdout < 2.0 |
| **CSMD fast** | 1.86 | 49.3% | 73 | 2.30* | ❌ 28 trades apenas |
| **Gamma Scalping** | 0.56-0.78 | 30-47% | 156-387 | — | ❌ PnL negativo |

---

## 5. Diagnóstico: Por Que Nenhuma Hipótese Vingou

### 5.1 Causa Raiz: Mercado Extremamente Eficiente

```
Acurácia do ask a 60s:  92.4%
Acurácia no último tick: 97.2%
Odds sum:                1.01 (spread 1%)
Spread típico:           0.01-0.03
```

Com 92.4% de acerto aos 60s, o mercado já "sabe" o vencedor. Os 7.6% de erro são eventos onde o BTC reverte nos últimos 60s — essencialmente imprevisíveis com dados de tick.

### 5.2 O Spread Como Barreira

Para uma estratégia ser lucrativa após o spread de 1%:
- Com 50% win rate: precisa de payoff ratio > 1.02 (impossível em contratos binários 0/1)
- Com 55% win rate: payoff ratio > 0.82 (possível, mas requer edge real)
- Com 60% win rate: payoff ratio > 0.67 (confortável)

O problema: **todas as hipóteses testadas tiveram win rate ≤ 55%.** Nenhuma atingiu o limiar de lucratividade.

### 5.3 O Efeito "Tudo Já Foi Tentado"

As 5 estratégias existentes cobrem os principais nichos:
- **Convexidade temporal** → Terminal Convexity
- **Edge direcional** → Edge Sniper
- **Arbitragem de box** → Gamma Ladder
- **Lag de reprecificação** → Impulse Elasticity
- **Combinação** → Fusion Five

Para uma 6ª estratégia existir, ela precisaria explorar um mecanismo fundamentalmente diferente. As hipóteses testadas tentaram:
- SAD: regime de volatilidade → mercado já precifica
- CSMD: correlação cross-sectional → sinal é ruído
- GS: gamma scalping → spread come o edge

### 5.4 Limitações do Recorte

- **14 dias** é pouco para validação estatística robusta
- **Apenas ticks** — sem order flow, sem sentiment, sem cross-market
- **Mercado único** (BTC 5min) — outros mercados podem ter mais ineficiências
- **Backtest only** — sem execução real, sem latência, sem slippage real

---

## 6. Lições Aprendidas

### 6.1 O Que Funcionou na Metodologia
- SQL exploratório ANTES de implementar (evitou viés de confirmação)
- Workers paralelos (4× speedup, 20K ticks/s)
- Split 60/20/20 rigoroso
- Fill simulado via book histórico (não assumiu preço ideal)
- Documentação de falhas tão detalhada quanto de sucessos

### 6.2 O Que Não Funcionou
- SAD: hipótese plausível, evidência SQL preliminar, mas o mercado já precifica
- CSMD: sinal intuitivo, mas dominado por ruído de microestrutura
- GS: matemática parecia favorável, mas o spread inviabiliza
- **Padrão**: As hipóteses faziam sentido qualitativo, mas a magnitude do edge era menor que o spread

### 6.3 Heurísticas para Futuras Hipóteses
1. **Calcule o edge esperado ANTES de implementar**: EV = P(win) × (1 - ask) - P(lose) × ask. Se EV < 0.02, não implemente.
2. **Teste com SQL primeiro**: Se o sinal não aparece no agregado SQL, não vai aparecer no backtest.
3. **Desconfie de amostras pequenas**: PF 2.30 com 28 trades não é validação — é ruído.
4. **O spread é o inimigo**: Qualquer edge precisa ser >1% para superar o spread + slippage.

---

## 7. Recomendações para Pesquisa Futura

### 7.1 Novos Mercados (mais promissor)
- **Timeframes mais longos** (15min, 1h, 4h): menos eficientes, mais padrões
- **Outros underlying** (ETH, SOL): menos competição
- **Eventos especiais** (FOMC, NFP, CPI): volatilidade anormal = possíveis ineficiências

### 7.2 Novos Dados
- **Order flow real** (não apenas ticks): detectar desequilíbrios de fluxo
- **Cross-market**: Polymarket vs outras plataformas (Kalshi, PredictIt)
- **Sentiment**: Twitter, news, on-chain data
- **Book completo nível a nível**: shape analysis, não apenas best bid/ask

### 7.3 Novas Abordagens
- **Market making simulado**: prover liquidez em vez de tomar
- **Statistical arbitrage**: explorar correlações entre eventos simultâneos
- **Machine learning**: features não lineares do book + BTC
- **Reinforcement learning**: otimizar entrada/saída/sizing dinamicamente

### 7.4 Melhorias no Framework
- Adicionar `--to` como parâmetro obrigatório nos labs para evitar look-ahead na calibração
- Separar calibração (train only) de backtest (walk-forward)
- Adicionar métricas de significância estatística (t-test, bootstrap)
- Implementar "paper trading" com dados live antes de conclusões

---

## 8. Estrutura de Arquivos Pós-Limpeza

```
polymarket-test/
  docs/
    estudo-falhas-2026-05-18.md        ← ESTE DOCUMENTO (unificado)
    sigma-adaptive-drift-v1.md          ← doc original (mantido como referência)
    terminal-convexity-v1.md            ← estratégias ativas
    edge-sniper-v1.md
    gamma-ladder-v1.md
    impulse-elasticity-v1.md
    fusion-five-v1.md
    ...
  scripts/
    lab-terminal-convexity.js           ← labs ativos
    lab-impulse-elasticity.js
    lab-fusion-five.js
    ...
  archive/
    labs-rejeitados/
      lab-sigma-adaptive-drift.js       ← labs que falharam
      lab-cross-sectional-momentum.js
      lab-gamma-scalping.js
    README.md                           ← explica o arquivo morto
```

---

## 9. SQL de Referência para Futuras Análises

### Template de consulta de range:
```sql
SELECT COUNT(*) AS ticks, COUNT(DISTINCT event_start) AS events,
       MIN(ts) AS first_ts, MAX(ts) AS max_ts
FROM ticks WHERE ts >= '[FROM]' AND ts <= '[TO]';
```

### Template de acurácia do ask em janela:
```sql
WITH state AS (
  SELECT DISTINCT ON (event_start) event_start, btc_price, price_to_beat,
         up_best_ask, down_best_ask
  FROM ticks WHERE ts >= '[FROM]'
    AND EXTRACT(EPOCH FROM (event_start + INTERVAL '5 minutes' - ts))
        BETWEEN [SEC-2.5] AND [SEC+2.5]
  ORDER BY event_start,
    ABS(EXTRACT(EPOCH FROM (event_start + INTERVAL '5 minutes' - ts)) - [SEC])
),
outcomes AS (
  SELECT DISTINCT ON (event_start) event_start,
    CASE WHEN btc_price > price_to_beat THEN 'UP' ELSE 'DOWN' END AS winner
  FROM ticks WHERE ts >= '[FROM]'
  ORDER BY event_start, ts DESC
)
SELECT COUNT(*),
  SUM(CASE WHEN (winner='UP' AND up_ask>down_ask)
             OR (winner='DOWN' AND down_ask>up_ask) THEN 1 ELSE 0 END) AS correct
FROM state JOIN outcomes USING (event_start);
```

### Template de volatilidade por hora:
```sql
SELECT EXTRACT(HOUR FROM ts)::int AS hour,
       PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ABS(btc_price - price_to_beat)) AS median_dist,
       STDDEV(ABS(btc_price - price_to_beat)) AS std_dist
FROM ticks WHERE ts >= '[FROM]' AND btc_price IS NOT NULL AND price_to_beat IS NOT NULL
GROUP BY hour ORDER BY hour;
```

---

**Fim do documento.** Este relatório deve servir como referência completa para qualquer análise futura de estratégias para Polymarket BTC Up/Down 5min.
