# BTC 5m — estudo científico de flips terminais

Gerado: 2026-07-27T05:18:12.692Z
Dataset: 24716 eventos com outcome canônico; 98318 linhas.
Split temporal: treino até 14/06, validação 15–30/06, holdout 01–26/07.

## Frequência natural de flip

| antecedência | eventos | flips | taxa |
|---:|---:|---:|---:|
| 60s | 24709 | 4111 | 16.6% |
| 30s | 24598 | 3047 | 12.4% |
| 20s | 24541 | 2575 | 10.5% |
| 10s | 24470 | 2088 | 8.5% |

## Modelos no holdout intocado

| antecedência | modelo | AUC | AP | Brier | log loss |
|---:|---|---:|---:|---:|---:|
| 60s | market_raw | 0.842 | 0.511 | 0.109 | 0.341 |
| 60s | brownian_raw | 0.735 | 0.360 | 0.136 | 0.569 |
| 60s | market_only | 0.842 | 0.511 | 0.110 | 0.346 |
| 60s | physics_only | 0.741 | 0.353 | 0.127 | 0.407 |
| 60s | combined | 0.839 | 0.497 | 0.110 | 0.347 |
| 30s | market_raw | 0.899 | 0.612 | 0.074 | 0.243 |
| 30s | brownian_raw | 0.737 | 0.329 | 0.106 | 0.493 |
| 30s | market_only | 0.899 | 0.612 | 0.075 | 0.249 |
| 30s | physics_only | 0.763 | 0.359 | 0.099 | 0.332 |
| 30s | combined | 0.898 | 0.602 | 0.076 | 0.249 |
| 20s | market_raw | 0.920 | 0.613 | 0.060 | 0.202 |
| 20s | brownian_raw | 0.721 | 0.288 | 0.093 | 0.455 |
| 20s | market_only | 0.920 | 0.613 | 0.062 | 0.208 |
| 20s | physics_only | 0.758 | 0.312 | 0.086 | 0.300 |
| 20s | combined | 0.918 | 0.599 | 0.063 | 0.209 |
| 10s | market_raw | 0.948 | 0.692 | 0.044 | 0.149 |
| 10s | brownian_raw | 0.715 | 0.272 | 0.078 | 0.407 |
| 10s | market_only | 0.948 | 0.692 | 0.047 | 0.159 |
| 10s | physics_only | 0.765 | 0.294 | 0.073 | 0.261 |
| 10s | combined | 0.946 | 0.655 | 0.049 | 0.161 |

## Detector combinado no holdout

### 60s antes

| risco mínimo | sinalizados | precisão | recall | taxa residual nos não sinalizados |
|---:|---:|---:|---:|---:|
| 15% | 2913 (43.0%) | 34.7% | 86.7% | 4.0% |
| 20% | 2333 (34.5%) | 38.7% | 77.5% | 5.9% |
| 25% | 1808 (26.7%) | 42.6% | 66.2% | 7.9% |
| 30% | 1424 (21.0%) | 46.2% | 56.5% | 9.5% |
| 40% | 778 (11.5%) | 54.0% | 36.1% | 12.4% |
| 50% | 304 (4.5%) | 62.5% | 16.3% | 15.1% |

### 30s antes

| risco mínimo | sinalizados | precisão | recall | taxa residual nos não sinalizados |
|---:|---:|---:|---:|---:|
| 15% | 1873 (27.7%) | 38.8% | 82.8% | 3.1% |
| 20% | 1479 (21.8%) | 44.4% | 74.8% | 4.2% |
| 25% | 1184 (17.5%) | 49.8% | 67.3% | 5.1% |
| 30% | 950 (14.0%) | 54.7% | 59.3% | 6.1% |
| 40% | 593 (8.8%) | 65.9% | 44.6% | 7.9% |
| 50% | 333 (4.9%) | 73.6% | 27.9% | 9.8% |

### 20s antes

| risco mínimo | sinalizados | precisão | recall | taxa residual nos não sinalizados |
|---:|---:|---:|---:|---:|
| 15% | 1425 (21.0%) | 41.5% | 80.2% | 2.7% |
| 20% | 1131 (16.7%) | 48.7% | 74.7% | 3.3% |
| 25% | 911 (13.5%) | 54.4% | 67.2% | 4.1% |
| 30% | 730 (10.8%) | 60.3% | 59.6% | 4.9% |
| 40% | 492 (7.3%) | 68.3% | 45.5% | 6.4% |
| 50% | 305 (4.5%) | 71.1% | 29.4% | 8.1% |

### 10s antes

| risco mínimo | sinalizados | precisão | recall | taxa residual nos não sinalizados |
|---:|---:|---:|---:|---:|
| 15% | 1048 (15.5%) | 48.6% | 83.0% | 1.8% |
| 20% | 859 (12.7%) | 54.1% | 75.9% | 2.5% |
| 25% | 722 (10.7%) | 60.0% | 70.6% | 3.0% |
| 30% | 618 (9.1%) | 63.4% | 63.9% | 3.6% |
| 40% | 397 (5.9%) | 72.0% | 46.7% | 5.1% |
| 50% | 245 (3.6%) | 78.4% | 31.3% | 6.5% |

## Regra simples selecionada sem olhar o holdout

`bookRisk>=0.25 AND z<=4`

| split | sinais | precisão | recall | cobertura |
|---|---:|---:|---:|---:|
| train | 2352 | 43.8% | 62.2% | 17.5% |
| validation | 768 | 41.9% | 62.5% | 17.4% |
| holdout | 1154 | 46.2% | 60.8% | 17.0% |

## Contrafactual de não entrada (proxy MIDAS, checkpoint 30s, holdout)

Baseline: 2083 entradas, WR 82.0%, PnL $123.34, DD $201.60.

| risco mínimo para bloquear | bloqueadas | flips evitados | precisão | recall | ΔPnL | PnL restante | DD |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 20% | 803 | 226 | 28.1% | 60.4% | $-173.03 | $-49.70 | $196.66 |
| 30% | 307 | 98 | 31.9% | 26.2% | $-194.09 | $-70.76 | $231.08 |
| 40% | 51 | 25 | 49.0% | 6.7% | $72.27 | $195.61 | $157.39 |
| 50% | 2 | 1 | 50.0% | 0.3% | $2.53 | $125.87 | $201.60 |

## Coeficientes do modelo combinado a 30s

| feature | coeficiente padronizado |
|---|---:|
| book_risk_logit | 1.376 |
| book_fall15 | 0.128 |
| brown_risk_logit | 0.114 |
| log_z | -0.064 |
| range_z | -0.046 |
| odds_sum_dev | -0.044 |
| spread | 0.037 |
| mom30_z | -0.037 |
| crosses60 | -0.030 |
| cross_fresh | 0.021 |
| mom10_z | 0.019 |
| stale_s | -0.007 |

## Limites

- O label é o resultado resolvido publicado pela Gamma/Polymarket; nenhum filtro retrospectivo de consenso do book final foi aplicado.
- O contrafactual usa best ask/bid e taxa configurada no projeto; não modela latência nem garante fill.
- A regra prevê risco, não certeza. Perto do PTB existe aleatoriedade irredutível.

