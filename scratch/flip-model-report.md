# BTC 5m — estudo científico de flips terminais

Gerado: 2026-07-27T04:52:34.801Z
Dataset: 23829 eventos com consenso spot/book; 95304 linhas.
Split temporal: treino até 14/06, validação 15–30/06, holdout 01–26/07.

## Frequência natural de flip

| antecedência | eventos | flips | taxa |
|---:|---:|---:|---:|
| 60s | 23827 | 3714 | 15.6% |
| 30s | 23827 | 2645 | 11.1% |
| 20s | 23828 | 2171 | 9.1% |
| 10s | 23822 | 1654 | 6.9% |

## Modelos no holdout intocado

| antecedência | modelo | AUC | AP | Brier | log loss |
|---:|---|---:|---:|---:|---:|
| 60s | market_raw | 0.852 | 0.512 | 0.100 | 0.319 |
| 60s | brownian_raw | 0.751 | 0.359 | 0.124 | 0.506 |
| 60s | market_only | 0.852 | 0.512 | 0.101 | 0.323 |
| 60s | physics_only | 0.757 | 0.349 | 0.117 | 0.380 |
| 60s | combined | 0.850 | 0.498 | 0.102 | 0.324 |
| 30s | market_raw | 0.911 | 0.619 | 0.064 | 0.216 |
| 30s | brownian_raw | 0.751 | 0.326 | 0.092 | 0.422 |
| 30s | market_only | 0.911 | 0.619 | 0.066 | 0.221 |
| 30s | physics_only | 0.776 | 0.347 | 0.087 | 0.300 |
| 30s | combined | 0.909 | 0.598 | 0.066 | 0.222 |
| 20s | market_raw | 0.931 | 0.639 | 0.050 | 0.173 |
| 20s | brownian_raw | 0.726 | 0.264 | 0.079 | 0.386 |
| 20s | market_only | 0.931 | 0.639 | 0.052 | 0.177 |
| 20s | physics_only | 0.761 | 0.279 | 0.075 | 0.268 |
| 20s | combined | 0.928 | 0.617 | 0.052 | 0.179 |
| 10s | market_raw | 0.961 | 0.757 | 0.032 | 0.116 |
| 10s | brownian_raw | 0.708 | 0.228 | 0.064 | 0.335 |
| 10s | market_only | 0.961 | 0.757 | 0.035 | 0.123 |
| 10s | physics_only | 0.750 | 0.242 | 0.061 | 0.228 |
| 10s | combined | 0.955 | 0.684 | 0.038 | 0.129 |

## Detector combinado no holdout

### 60s antes

| risco mínimo | sinalizados | precisão | recall | taxa residual nos não sinalizados |
|---:|---:|---:|---:|---:|
| 15% | 2642 (40.0%) | 33.9% | 85.9% | 3.7% |
| 20% | 2094 (31.7%) | 38.1% | 76.4% | 5.4% |
| 25% | 1608 (24.3%) | 42.4% | 65.4% | 7.2% |
| 30% | 1266 (19.2%) | 45.4% | 55.1% | 8.8% |
| 40% | 662 (10.0%) | 54.5% | 34.6% | 11.5% |
| 50% | 263 (4.0%) | 63.9% | 16.1% | 13.8% |

### 30s antes

| risco mínimo | sinalizados | precisão | recall | taxa residual nos não sinalizados |
|---:|---:|---:|---:|---:|
| 15% | 1619 (24.5%) | 38.1% | 82.6% | 2.6% |
| 20% | 1254 (19.0%) | 44.7% | 75.1% | 3.5% |
| 25% | 987 (14.9%) | 50.6% | 66.8% | 4.4% |
| 30% | 791 (12.0%) | 55.5% | 58.8% | 5.3% |
| 40% | 482 (7.3%) | 66.2% | 42.7% | 7.0% |
| 50% | 267 (4.0%) | 76.4% | 27.3% | 8.6% |

### 20s antes

| risco mínimo | sinalizados | precisão | recall | taxa residual nos não sinalizados |
|---:|---:|---:|---:|---:|
| 15% | 1159 (17.5%) | 41.6% | 79.3% | 2.3% |
| 20% | 910 (13.8%) | 48.6% | 72.7% | 2.9% |
| 25% | 731 (11.1%) | 56.0% | 67.3% | 3.4% |
| 30% | 591 (8.9%) | 62.3% | 60.5% | 4.0% |
| 40% | 405 (6.1%) | 70.1% | 46.7% | 5.2% |
| 50% | 257 (3.9%) | 74.7% | 31.6% | 6.6% |

### 10s antes

| risco mínimo | sinalizados | precisão | recall | taxa residual nos não sinalizados |
|---:|---:|---:|---:|---:|
| 15% | 787 (11.9%) | 50.3% | 83.0% | 1.4% |
| 20% | 635 (9.6%) | 56.9% | 75.7% | 1.9% |
| 25% | 531 (8.0%) | 62.7% | 69.8% | 2.4% |
| 30% | 447 (6.8%) | 66.7% | 62.5% | 2.9% |
| 40% | 287 (4.3%) | 74.6% | 44.9% | 4.2% |
| 50% | 178 (2.7%) | 86.0% | 32.1% | 5.0% |

## Regra simples selecionada sem olhar o holdout

`bookRisk>=0.30 AND z<=4`

| split | sinais | precisão | recall | cobertura |
|---|---:|---:|---:|---:|
| train | 1753 | 46.9% | 57.8% | 13.6% |
| validation | 597 | 44.6% | 56.0% | 13.7% |
| holdout | 890 | 49.1% | 58.5% | 13.5% |

## Contrafactual de não entrada (proxy MIDAS, checkpoint 30s, holdout)

Baseline: 2014 entradas, WR 84.5%, PnL $678.24, DD $105.13.

| risco mínimo para bloquear | bloqueadas | flips evitados | precisão | recall | ΔPnL | PnL restante | DD |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 20% | 659 | 183 | 27.8% | 58.7% | $-281.68 | $396.56 | $61.41 |
| 30% | 226 | 71 | 31.4% | 22.8% | $-194.00 | $484.24 | $106.71 |
| 40% | 37 | 18 | 48.6% | 5.8% | $49.02 | $727.25 | $105.13 |
| 50% | 2 | 1 | 50.0% | 0.3% | $2.53 | $680.77 | $105.13 |

## Coeficientes do modelo combinado a 30s

| feature | coeficiente padronizado |
|---|---:|
| book_risk_logit | 1.383 |
| book_fall15 | 0.141 |
| log_z | -0.095 |
| brown_risk_logit | 0.085 |
| mom30_z | -0.039 |
| cross_fresh | 0.038 |
| spread | 0.036 |
| odds_sum_dev | -0.033 |
| crosses60 | -0.023 |
| stale_s | -0.023 |
| range_z | -0.010 |
| mom10_z | -0.004 |

## Limites

- O label é o último spot válido, aceito apenas quando o book final concorda; não é uma prova de settlement externo.
- O contrafactual usa best ask/bid e taxa configurada no projeto; não modela latência nem garante fill.
- A regra prevê risco, não certeza. Perto do PTB existe aleatoriedade irredutível.

