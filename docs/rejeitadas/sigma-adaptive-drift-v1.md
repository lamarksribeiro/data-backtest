# Sigma Adaptive Drift V1

## Status: ❌ REJEITADA — Hipótese não sobreviveu ao holdout

A **Sigma Adaptive Drift V1** foi uma tentativa de criar uma teoria quantitativa nova para o mercado BTC Up/Down 5 minutos na Polymarket. A hipótese central era que o mercado usa spread fixo (~0.01) independente do regime de volatilidade do BTC, e que calibrar os thresholds de entrada por hora do dia geraria vantagem estatística.

---

## Hipótese

O mercado precifica contratos binários com base na distância BTC-PTB e tempo restante, mas **não ajusta o spread nem a velocidade de reprecificação conforme a volatilidade ambiente**. Em horas de baixa volatilidade (ex: UTC 0-4, madrugada), uma distância de $20 é muito mais informativa que em horas de alta volatilidade (ex: UTC 10-13, abertura europeia/americana).

A hipótese previa que, ao reduzir o threshold de entrada em horas calmas e aumentá-lo em horas voláteis, capturaríamos mais entradas vencedoras sem aumentar a taxa de erro.

---

## Matemática

### 1. Calibração de volatilidade por hora

```
medianDist[h] = mediana(|BTC - PTB|) para todos os ticks na hora h
globalMedian = mediana de medianDist[0..23]
volRatio[h] = medianDist[h] / globalMedian
```

Exemplo real (range 2026-05-04 a 2026-05-18):

| Hora (UTC) | MedianDist | VolRatio |
|---|---:|---:|
| 02h | 18.2 | 0.84 |
| 10h | 33.4 | 1.55 |
| 11h | 37.1 | 1.72 |
| 20h | 19.3 | 0.89 |

### 2. Threshold adaptativo

```
adaptiveDist = clamp(baseDist × volRatio^α, minDist, maxDist)
adaptiveSigma = clamp(baseSigma × volRatio^β, minSigma, maxSigma)
```

Onde `α = 0.5` (distância escala com raiz quadrada do volRatio) e `β = 0.7` (sigma escala um pouco mais).

### 3. Modelo de probabilidade

```
X_t = side × (BTC - PTB)
τ = segundos até expiração
σ_τ = max(adaptiveSigma, realizedVol × √τ × 1.2)
drift = momentum rápido × 0.6 + momentum lento × 0.25
driftComponent = clamp(drift × τ × 0.30, -σ_τ × 0.50, +σ_τ × 0.50)
z = (X_t + driftComponent) / σ_τ
p_side = Φ(z)
```

### 4. Condição de entrada

- `|X_t| > adaptiveDist`
- `p_side > ask + 0.06`
- Janela: 120s a 10s antes da expiração
- `ask ∈ [0.06, 0.55]`
- `spread < 0.10`
- `oddsSum ∈ [0.85, 1.18]`

### 5. Saída

- Stop loss: se BTC cruzar $3 contra a posição, vender no bid
- Senão, hold to settlement

---

## Resultados Empíricos

Range: **2026-05-04T15:00:00.000Z → 2026-05-18T12:04:30.386Z**  
Ticks: 2,387,311 | Eventos: ~3,982  
Split: Train 60% | Validation 20% | Holdout 20%

### Melhores variantes (ordenadas por Holdout PnL)

| Variante | Entradas | Win Rate | PnL Total | PF Total | PF Holdout | Max DD |
|---|---:|---:|---:|---:|---:|---:|
| `sad-full-d20` (adaptativo) | 433 | 52.0% | +1,668 | 1.82 | **1.32** | 129.33 |
| `sad-full-d15` (adaptativo) | 616 | 49.4% | +1,918 | 1.66 | **1.22** | 96.94 |
| `sad-wide` (adaptativo) | 390 | 53.8% | +1,530 | 1.89 | **1.35** | 113.76 |
| `sad-fixed-25` (baseline) | 302 | 54.3% | +1,296 | 1.89 | **1.37** | 90.53 |
| `sad-fixed-35` | 142 | 61.3% | +976 | 2.63 | — | 63.11 |

### Comparação com estratégias existentes (mesmo range aproximado)

| Estratégia | PF | Win Rate | Entradas | Holdout |
|---|---:|---:|---:|---:|
| **Sigma Adaptive Drift** (sad-full-d20) | 1.82 | 52.0% | 433 | PF 1.32 |
| Terminal Convexity V1 | 4.02 | 50.0% | 52 | — |
| Edge Sniper V1 | 2.33 | 73.8% | 130 | — |
| Gamma Ladder V1 | 6.15 | 50.7% | 136 | — |
| Impulse Elasticity V1 | 4.01 | 75.7% | 115 | — |

---

## Por que falhou

### 1. A adaptação não gerou diferenciação

As variantes adaptativas (`sad-full`, `sad-dist-a05`, etc.) tiveram performance **idêntica ou pior** que a baseline fixa (`sad-fixed-25`). A diferença de volatilidade entre horas (0.84× a 1.72×) não foi suficiente para alterar significativamente os thresholds de entrada. Na prática, `adaptiveDist` variou entre 18.8 e 26.2 — uma faixa muito estreita para mudar quais eventos eram selecionados.

### 2. O mercado já precifica a diferença de volatilidade

A investigação SQL inicial mostrou que a acurácia do ask a 60s era 84.4% em horas calmas vs 76.8% em horas voláteis (para distância 20-35). Isso significa que o **mercado já é mais preciso nas horas calmas** — o book já desconta a menor incerteza. Não há edge residual para capturar.

### 3. Janela de entrada muito ampla

A janela de 120s a 10s é muito maior que a do Terminal Convexity (15s a 8s). Isso dilui o sinal: entrar cedo significa mais exposição a reversões. O mercado acerta 92.4% aos 60s — ou seja, em 7.6% dos eventos o lado favorecido aos 60s perde. Quanto mais cedo se entra, mais exposição a esse risco.

### 4. Holdout fraco

Nenhuma variante atingiu PF > 2.0 no holdout. O melhor holdout PF foi ~1.37 (`sad-fixed-25`), muito abaixo dos critérios mínimos.

---

## O que aprendemos

1. **Volatilidade por hora é real mas não é explorável**: O efeito GARCH/volatility clustering existe nos dados, mas o mercado de apostas já o precifica corretamente.

2. **Entradas mais frequentes ≠ mais lucro**: As variantes com thresholds mais baixos (`sad-full-d15`, 616 entradas) tiveram MAIS entradas mas PIOR performance. Quantidade não substitui qualidade de sinal.

3. **Modelos mais simples são competitivos**: O `sad-fixed-35` (sem adaptação, sem drift, sem sigma complexo) teve o melhor PF (2.63). A complexidade adicional da calibração por hora não agregou valor.

4. **O mercado de apostas da Polymarket é notavelmente eficiente**: Com 92.4% de acurácia direcional a 60s e 97.2% no último tick, sobra pouco espaço para estratégias baseadas puramente em predição de direção.

---

## Variantes rejeitadas e motivo

| Variante | Motivo da rejeição |
|---|---|
| `sad-full`, `sad-dist-*`, `sad-sig-*` | Performance idêntica à baseline fixa — adaptação não agregou |
| `sad-full-d15` | 616 entradas, PF 1.66, holdout PF 1.22 — quantidade sobre qualidade |
| `sad-nostop` | Sem stop, drawdown explodiu para 153 — risco excessivo |
| `sad-narrow` | Janela 60-15s, apenas 184 entradas — sinal muito restritivo |
| Todas as adaptativas | Holdout PF < 2.0 — não atende critério mínimo |

---

## Comando npm

```bash
npm run lab:sigma-adaptive-drift -- --from 2026-05-04T15:00:00.000Z --mode quick --batch-size 10000
```

Arquivo: `scripts/lab-sigma-adaptive-drift.js`

---

## Limitações

- Range de apenas 14 dias (3,982 eventos)
- Dados de book com ~96% de cobertura (4% sem profundidade)
- Backtest não considera latência real de execução
- Não testado em condições extremas de mercado (flash crashes, alta volatilidade sistêmica)
- A calibração de volatilidade por hora usa o range inteiro (inclui dados futuros do ponto de vista do backtest — look-ahead bias na calibração, embora não nos trades)
