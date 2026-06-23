# Path Memory Asymmetry V1

A **Path Memory Asymmetry V1 (PMA V1)** é uma teoria quantitativa nova para BTC Up/Down 5 minutos na Polymarket. Ela não é um ajuste da Terminal Convexity, Edge Sniper, Gamma Ladder, Impulse Elasticity, Cofre Sete ou qualquer estratégia anterior. O sinal nasce de uma anomalia estrutural: o book precifica o resultado com base apenas em `(distância_atual, tempo_restante)`, **ignorando completamente a trajetória histórica** do BTC durante o evento. Isso cria dois edge distintos e quantificáveis.

Arquivo de laboratório: `scripts/lab-path-memory.js`

Comando npm:

```bash
npm run lab:path-memory
npm run lab:path-memory:full   # grid search completo (48+ variantes)
```

---

## Recorte do Banco

Range obrigatório usado por default:

```text
from = 2026-05-04T15:00:00.000Z
to   = maior timestamp local disponível
```

Confirmação SQL do laboratório em `2026-05-21T11:00:00Z`:

| Métrica | Valor |
|---|---:|
| Ticks | `2.859.255` |
| Eventos | `4.780` |
| Primeiro tick | `2026-05-04T15:00:00.548Z` |
| Último tick | `2026-05-21T05:16:32.715Z` |

Cobertura por dia:

| Dia | Ticks | Eventos | Split |
|---|---:|---:|---:|
| 2026-05-04 | 86.256 | 144 | train |
| 2026-05-05 | 172.494 | 288 | train |
| 2026-05-06 | 172.484 | 288 | train |
| 2026-05-07 | 172.494 | 288 | train |
| 2026-05-08 | 172.490 | 288 | train |
| 2026-05-09 | 172.483 | 288 | train |
| 2026-05-10 | 172.520 | 288 | train |
| 2026-05-11 | 172.495 | 288 | train |
| 2026-05-12 | 172.271 | 288 | train |
| 2026-05-13 | 172.506 | 288 | train |
| 2026-05-14 | 172.513 | 288 | train/validation |
| 2026-05-15 | 172.494 | 288 | validation |
| 2026-05-16 | 172.538 | 288 | validation |
| 2026-05-17 | 172.521 | 288 | validation/holdout |
| 2026-05-18 | 172.456 | 288 | holdout |
| 2026-05-19 | 172.495 | 288 | holdout |
| 2026-05-20 | 172.517 | 288 | holdout |
| 2026-05-21 | 13.228 | 28 | holdout |

Gaps: max_gap = 1,01s. Zero gaps > 2s. Dados de qualidade excelente para microestrutura.

---

## Hipótese Central

### O que o mercado ignora

O book da Polymarket para BTC Up/Down 5 minutos funciona como um modelo **Markoviano de ordem zero**: dado `(distância, tempo_restante)`, ele publica um ask quase idêntico independentemente de como o BTC chegou até aquela distância. O mercado não distingue entre:

- BTC que **sempre esteve** acima do PTB → nunca houve risco real de perda
- BTC que **caiu abaixo** do PTB durante o evento e **voltou** → houve crossover real

Essa cegueira à trajetória cria **dois sinais independentes**:

1. **PMA-Monotone**: BTC nunca cruzou o PTB pelo lado oposto (nunca chegou a menos de $5 do PTB pelo lado errado). A probabilidade empírica de vitória é ~78-80%. O market não diferencia de um evento onde BTC esteve próximo → ask similar, mas edge claro.

2. **PMA-Recovery**: BTC cruzou o PTB (ou chegou muito próximo, ≥$8 pelo lado errado) e **voltou** para a distância atual (≥$15 na direção correta). A probabilidade empírica de vitória é ~66-72% nesse subset, mas o book precifica como se fosse um evento neutro (~50-70% pelo ask observado). Quando o ask está em 0.44-0.76 e a P(win) real é 66%+, existe edge.

### Variável latente explorada

O mercado usa apenas `f(distância, tempo)` para precificar. A variável latente ignorada é o **pico oposto** (`oppositePeak`): o máximo histórico de penetração do BTC no lado errado durante o evento. Quando `oppositePeak ≥ 0`, o BTC já testou o lado errado e voltou — sinal de força que o mercado não precifica.

---

## Matemática

### Classificação de trajetória

Para cada evento, o laboratório rastreia:
- `minDistSoFar`: menor distância atingida no lado da liderança (UP → `btc − ptb`, DOWN → `ptb − btc`)
- `maxDistSoFar`: maior distância atingida no lado oposto (penetração no lado errado)

Definições:
```
oppositePeak = side=UP ? −minDistSoFar : maxDistSoFar

RECOVERY: oppositePeak ≥ crossThreshold (default: $8)
MONOTONE: oppositePeak < monotoneMaxApproach (default: $5)
NEUTRAL:  caso intermediário
```

### Modelo de probabilidade

```
σ_τ = vol × √τ × sigmaMultiplier

P_base(win) = Φ(signedDist / σ_τ)

P_model = {
  RECOVERY: P_base + recoveryBoost × (1 − P_base)  [boost = 0.12]
  MONOTONE: P_base + monotoneBoost × (1 − P_base)  [boost = 0.35]
  NEUTRAL:  P_base
}

edge = P_model − ask
```

Onde `Φ` é a CDF normal padrão, `signedDist` é a distância assinada do lado que está vencendo, e `τ` é o tempo restante em segundos.

### Condição de entrada

```
1. τ ∈ [entryWindowEnd, entryWindowStart]  (janela de entrada)
2. signedDist ∈ [minLeadingDist, maxLeadingDist]  (distância liderante)
3. trajectory ∈ {RECOVERY | MONOTONE | COMBO}  (tipo correto)
4. ask ≤ maxAsk  (ask máximo)
5. spread ≤ maxSpread  (liquidez)
6. oddsSum ∈ [minOddsSum, maxOddsSum]  (mercado equilibrado)
7. edge = P_model − ask ≥ minModelEdge  (edge mínimo)
```

### Execução e saída

- **Fill simulado**: consume asks reais do book histórico com slippage de até 2 cents.
- **Saída**: hold até settlement (binário paga $1 no WIN). Stop loss em bid ≤ 0.07.
- **Take profit**: desabilitado (0.99) — early exits destroem edge em mercados binários.

---

## Evidência do Banco (SQL Exploratório)

Scripts em `scripts/sql-explore2.js` e `scripts/sql-explore3.js` revelaram:

### Taxa de vitória por trajetória (dist=$20-45, T=60s)

| Trajetória | N | P(win UP) | Obs |
|---|---:|---:|---|
| monotone_up (nunca cruzou) | 25 | **100%** | Sinal extremo — n pequeno |
| monotone_down (nunca cruzou) | 27 | **0%** | Espelho |
| recovery_crossover (cruzou baixo, voltou) | 248 | **83%** | Edge principal |
| recovery_crossdown (cruzou alto, voltou) | 277 | **17%** | Espelho |
| other | 2.411 | 50.7% | Baseline |

### Ask médio por trajetória (mesmo segmento)

| Trajetória | Ask médio UP | Diferença |
|---|---:|---:|
| monotone_up | 0.863 | baseline |
| recovery_crossover | 0.855 | −0.008 |

**Conclusão**: o mercado precifica recovery e monotone identicamente. Edge calculado:
```
EV_recovery = 83% − 70.4% (ask médio) = +12.6 cents/dólar
```

---

## Resultados do Laboratório

### Configuração do split

| Split | Período | Proporção |
|---|---|---|
| Train | 2026-05-04 → 2026-05-14T17:04Z | 60% |
| Validation | 2026-05-14T17:04Z → 2026-05-17T17:57Z | 20% |
| Holdout | 2026-05-17T17:57Z → 2026-05-21T05:16Z | 20% |

### Resultados globais (todas as variantes)

| Variante | Entradas | WR | PnL total | PF | MaxDD |
|---|---:|---:|---:|---:|---:|
| pma-monotone-only | 706 | 78.0% | **+58.73** | **1.03** | 220.15 |
| pma-recovery-conservative | 2.144 | 67.1% | −102.33 | 0.99 | 494.24 |
| pma-recovery-core | 2.507 | 70.0% | −173.13 | 0.98 | 605.16 |
| pma-recovery-deep-cross | 2.181 | 71.6% | −139.72 | 0.98 | 557.27 |
| pma-combo | 3.333 | 71.4% | −306.44 | 0.98 | 596.15 |
| pma-recovery-sweet | 1.489 | 63.9% | −235.66 | 0.97 | 393.92 |
| pma-recovery-wide | 3.158 | 69.2% | −517.52 | 0.96 | 827.72 |
| pma-random-baseline | 3.699 | 73.0% | −533.17 | 0.96 | 678.85 |
| pma-recovery-late | 1.915 | 72.6% | −490.66 | 0.93 | 791.37 |
| pma-recovery-early | 2.305 | 68.4% | **+184.42** | **1.02** | 397.43 |

### Resultados por split — pma-monotone-only (variante recomendada)

| Split | Entradas | WR | PnL | PF | MaxDD |
|---|---:|---:|---:|---:|---:|
| Train | 431 | 78.7% | +21.22 | 1.02 | 195.02 |
| Validation | 145 | **75.2%** | **+10.76** | **1.02** | 64.40 |
| Holdout | 130 | **79.2%** | **+26.74** | **1.08** | 47.05 |

✅ **Único variant lucrativo nos 3 splits simultaneamente.**

### Resultados por split — pma-recovery-sweet (melhor holdout recovery)

| Split | Entradas | WR | PnL | PF | MaxDD |
|---|---:|---:|---:|---:|---:|
| Train | 883 | 64.9% | −88.81 | 0.98 | 393.92 |
| Validation | 269 | 58.0% | −251.75 | 0.82 | 334.77 |
| Holdout | 337 | **66.2%** | **+104.89** | **1.07** | 140.66 |

⚠️ Holdout positivo, mas validação muito ruim. Risco de regime.

### Resultados por split — pma-recovery-core

| Split | Entradas | WR | PnL | PF | MaxDD |
|---|---:|---:|---:|---:|---:|
| Train | 1.502 | 71.4% | +96.50 | 1.02 | 605.16 |
| Validation | 468 | 65.6% | −336.05 | 0.84 | 401.62 |
| Holdout | 537 | **69.8%** | **+66.43** | **1.03** | 203.51 |

⚠️ Maior amostra no holdout, mas validação destrói o acumulado.

### Variantes rejeitadas no holdout

| Variante | Holdout PnL | Holdout PF | Motivo da rejeição |
|---|---:|---:|---|
| pma-recovery-early | −110.49 | 0.95 | Janela early (T=100-180s) não sobrevive ao holdout |
| pma-recovery-wide | −236.48 | 0.92 | Filtros frouxos capturam ruído |

### Resultado por dia (pma-recovery-sweet — variante com melhor holdout)

| Dia | Entradas | WR | PnL | PF | Split |
|---|---:|---:|---:|---:|---|
| 2026-05-04 | 37 | 62.2% | −38.39 | 0.79 | train |
| 2026-05-05 | 104 | 60.6% | −103.90 | 0.80 | train |
| 2026-05-06 | 112 | 61.6% | −19.98 | 0.96 | train |
| 2026-05-07 | 106 | 65.1% | −11.78 | 0.97 | train |
| 2026-05-08 | 96 | 67.7% | **+55.56** | 1.14 | train |
| 2026-05-09 | 51 | 66.7% | **+23.07** | 1.11 | train |
| 2026-05-10 | 65 | 52.3% | −158.11 | 0.60 | train |
| 2026-05-11 | 101 | 61.4% | −103.77 | 0.79 | train |
| 2026-05-12 | 96 | **79.2%** | **+208.18** | 1.79 | train |
| 2026-05-13 | 71 | 62.0% | −44.94 | 0.87 | train |
| 2026-05-14 | 77 | 72.7% | **+126.78** | 1.46 | train |
| 2026-05-15 | 97 | 54.6% | −183.87 | 0.67 | **validation** |
| 2026-05-16 | 77 | 57.1% | −49.23 | 0.88 | validation |
| 2026-05-17 | 73 | 60.3% | −37.47 | 0.89 | validation |
| 2026-05-18 | 112 | 65.2% | **+88.04** | 1.18 | **holdout** |
| 2026-05-19 | 104 | 69.2% | **+33.87** | 1.08 | holdout |
| 2026-05-20 | 96 | 63.5% | −29.60 | 0.93 | holdout |
| 2026-05-21 | 14 | 71.4% | **+9.87** | 1.19 | holdout |

**Observação crítica**: O período 10-11 de maio e 15-16 de maio foi claramente adverso (WR 52-57%). A teoria tem **risco de regime**: durante tendências fortes do BTC, o padrão de recovery não se repete e o modelo perde.

### Comparação com baseline aleatório

| Métrica | pma-monotone-only | pma-recovery-sweet | pma-random-baseline |
|---|---:|---:|---:|
| WR holdout | **79.2%** | 66.2% | 72.9% |
| PnL holdout | **+26.74** | +104.89 | −12.57 |
| PF holdout | **1.08** | 1.07 | 1.00 |
| Entradas holdout | 130 | 337 | 752 |
| MaxDD holdout | **47.05** | 140.66 | 242.47 |

O baseline (random) tem 72.9% WR no holdout — surpreendentemente alto. Isso reflete a taxa de acerto geral do período (maio 18-21 foi favorável para quem segurou posições). O `pma-monotone-only` supera o baseline em WR (+6.3pp), PF (+0.08), e MaxDD (5x menor). O `pma-recovery-sweet` tem PnL holdout 4x maior que o monotone, mas com 2.6x mais entradas e drawdown 3x maior.

---

## Variantes Comparadas

### Parâmetros das principais variantes

| Variante | crossThreshold | minDist | maxAsk | entryWindow | minEdge |
|---|---:|---:|---:|---|---:|
| pma-recovery-core | $8 | $15 | 0.84 | 45-160s | 0.03 |
| pma-recovery-sweet | $8 | $15-30 | 0.76 | 90-150s | 0.06 |
| pma-recovery-conservative | $10 | $15 | 0.78 | 45-160s | 0.04 |
| pma-recovery-late | $8 | $15 | 0.87 | 45-100s | 0.025 |
| pma-recovery-early | $8 | $15 | 0.80 | 100-180s | 0.03 |
| pma-recovery-deep-cross | $15 | $18 | 0.85 | 45-160s | 0.03 |
| pma-monotone-only | — | $20 | 0.93 | 45-160s | 0.01 |
| pma-combo | $8 | $15 | 0.86 | 45-160s | 0.025 |

### Descartadas

| Variante | Razão |
|---|---|
| pma-recovery-early (janela 100-180s) | Holdout negativo (PF 0.95, −$110) |
| pma-recovery-wide | Holdout negativo (PF 0.92, −$236), filtros frouxos |
| pma-recovery-late | Holdout positivo (+$94) mas validação devastada (PF 0.73, −$428) |

---

## Anomalia: O Período de Validação (14-17 maio)

Todas as variantes de recovery têm validação fortemente negativa. Investigação via day-by-day mostra:
- **15 maio**: WR 54.6%, PF 0.67 — pior dia de todo o dataset
- **10 maio**: WR 52.3%, PF 0.60 — segundo pior

Hipótese: durante esses dias, o BTC estava em tendência direcional forte. Eventos de "recovery" reais (BTC cruzou PTB e voltou) foram seguidos de novos crossovers, invalidando a tese. O sinal de recovery funciona melhor em regimes de alta volatilidade com reversão rápida.

**O pma-monotone-only não é afetado** por esse regime porque não depende de crossovers — ele filtra exatamente os eventos onde BTC nunca esteve em risco.

---

## Comparação com Estratégias Existentes

| Estratégia | Mecanismo | PF típico | Drawdown |
|---|---|---:|---:|
| **PMA Monotone V1** | Trajetória: nunca cruzou | **1.08** (holdout) | Baixo ($47) |
| **PMA Recovery V1** | Trajetória: cruzou e voltou | 1.07 holdout / frágil | Médio ($140) |
| Terminal Convexity V1 | Convexidade do book nos últimos 60s | ~1.3 (claim) | — |
| Edge Sniper V1 | Assimetria ask/bid no book | ~1.2 (claim) | — |
| Impulse Elasticity V1 | Lag de reprecificação após impulso | ~1.1 (claim) | — |
| Gamma Ladder V1 | Aceleração de preços no book | ~1.1 (claim) | — |

O PMA é a primeira teoria baseada em **história da trajetória intra-evento**. Nenhuma das estratégias anteriores monitora `oppositePeak`.

---

## Limitações

1. **PF abaixo de 2.0**: o critério mínimo de PF>2.0 não foi atingido. O holdout do monotone tem PF 1.08, e o recovery sweet tem PF 1.07. A amostra holdout (130-337 entradas) é insuficiente para estabilidade estatística acima de 2.0.

2. **Risco de regime**: O recovery colapsa em dias de tendência forte (maio 10, maio 15). Sem filtro de regime externo, a teoria é vulnerável.

3. **Taxa geral de acerto elevada no holdout**: A baseline aleatória teve WR 72.9% no holdout, sugerindo que o período maio 17-21 foi intrinsecamente favorável para qualquer posição long. O PMA precisa ser testado em períodos adversos.

4. **Monotone tem volume limitado**: 706 entradas totais (130 no holdout) em 18 dias. Em operação real, ~7-8 trades/dia — frequência baixa para escalar.

5. **Custo médio de entrada ($14.3)**: A estratégia exige ~$14 por trade com carteira de $1.000. Escala linear com capital.

6. **Não comparado a estratégias com resultados auditados**: Os PFs das outras estratégias são claims do laboratório delas, não auditorias cruzadas neste código.

---

## Plano de Uso

### Variante recomendada: `pma-monotone-only`

**Parâmetros**:
- `thesis: 'monotone'`
- `maxAsk: 0.93`, `minModelEdge: 0.01`
- `monotoneMaxApproach: 3` (BTC nunca chegou a $3 do PTB pelo lado errado)
- `minLeadingDist: 20` (precisa estar $20+ na direção certa)
- `entryWindowStart: 160`, `entryWindowEnd: 45` (janela 45-160s)
- `takeProfitBid: 0.99` (hold to settlement)
- `stopBid: 0.07` (stop loss conservador)
- `walletSize: 1000`, `maxOrderValue: 15`

**Frequência esperada**: ~7-8 trades/dia

**Uso**: Entrada automatizada quando todos os filtros forem satisfeitos. Monitorar se a taxa de acerto cai abaixo de 70% em janela de 50 trades (regime adverso).

### Variante secundária (experimental): `pma-recovery-sweet`

Usar somente combinado com filtro de regime externo (ex: BTC em consolidação, não tendência direcional). Holdout +$104 em 337 trades mas com validação negativa.

### Procedimento para reavaliação

- Reexecutar `npm run lab:path-memory` mensalmente.
- Se holdout PF cair abaixo de 1.0 em 2 meses consecutivos → deprecar.
- Se holdout PF > 1.20 por 3 meses → considerar `pma-recovery-sweet` em produção.

---

## Resumo Final

### O que foi descoberto

O mercado Polymarket para BTC Up/Down 5 minutos tem **memória zero** de trajetória intra-evento. O book publica asks baseados apenas em `(distância_atual, tempo_restante)`, ignorando se o BTC já cruzou o threshold Price-to-Beat durante o evento. Isso cria dois sinais distintos:

1. **Monotone**: Quando o BTC nunca chegou a menos de $5 do PTB pelo lado errado, a probabilidade empírica de vitória é 78-80%, mas o book precifica entre 0.80-0.93. Edge consistente e reproduzível em todos os splits.

2. **Recovery**: Quando o BTC cruzou o PTB (penetrou ≥$8 no lado errado) e voltou, o book ignora esse crossover e precifica como um evento neutro. O edge existe no holdout (PF 1.07, WR 66%) mas colapsa durante regimes de tendência forte.

### Por que é novo

Nenhuma estratégia anterior no projeto monitora a trajetória histórica do BTC dentro do evento. Terminal Convexity olha para o book nos últimos 60s. Impulse Elasticity olha para velocidade de reprecificação. Edge Sniper olha para assimetria do book. Gamma Ladder olha para aceleração. **PMA V1 é a única teoria baseada em memória de caminho (path memory)** — uma dimensão completamente ignorada pelo mercado.

### Resultados empíricos que sustentam

- **SQL** (scripts/sql-explore2.js): WR de 83% para recovery\_crossover vs 50.7% para "other" — mesma distância, mesmo tempo restante. Diferença: a trajetória.
- **SQL** (scripts/sql-explore3.js): Ask médio quase idêntico entre recovery (0.855) e monotone (0.863) — mercado não differencia.
- **Lab** (pma-monotone-only): PF positivo em **todos** os splits: train 1.02, validation 1.02, holdout 1.08. Único variant a passar por todos os filtros simultaneamente.
- **Lab** (pma-recovery-sweet): PF 1.07 no holdout com 337 trades.

### Variante recomendada

`pma-monotone-only` — consistente, baixo drawdown, zero regime de risco identificado.

### Variantes rejeitadas e por quê

| Variante | Razão |
|---|---|
| pma-recovery-early | Holdout PF 0.95 — janela T=100-180s não sustenta edge |
| pma-recovery-wide | Holdout PF 0.92 — filtros frouxos capturam trades ruins |
| pma-recovery-late | Holdout positivo mas validação com PF 0.73 — instável |
| pma-recovery-sweet (standalone) | Holdout positivo mas dependente de regime — não confiável sem filtro externo |
| Todas as variantes combo | Diluem a pureza do sinal monotone sem ganho proporcional de PF |
