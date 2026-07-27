# Gate anti-flip por valor esperado

Modelo congelado em 30 s. Piso escolhido apenas com treino + validação.

| piso EV previsto / US$10 | Δ treino | Δ validação | Δ julho | bloqueadas julho |
|---:|---:|---:|---:|---:|
| -4.00 | -0.00 | -0.00 | -0.00 | 0 |
| -3.00 | -0.00 | -0.00 | -0.00 | 0 |
| -2.50 | -0.00 | -0.00 | -0.00 | 0 |
| -2.00 | -0.00 | -0.00 | -0.00 | 0 |
| -1.50 | -16.97 | +10.30 | +12.81 | 3 |
| -1.00 | +6.09 | +4.88 | +39.32 | 15 |
| -0.75 | +25.22 | +16.19 | +63.74 | 40 |
| -0.50 | +133.02 | +16.54 | +92.24 | 200 |
| -0.25 | +379.04 | -80.43 | +179.60 | 717 |
| +0.00 | +589.36 | +74.92 | +191.25 | 1368 |

Selecionado: bloquear quando `E[PnL previsto] <= +0.00` por US$10.

| split | bloqueadas | precisão | ΔPnL | PnL novo | DD novo | IC95% Δ |
|---|---:|---:|---:|---:|---:|---:|
| train | 2514 | 17.2% | +589.36 | -44.65 | 241.58 | [+191.93; +990.73] |
| validation | 863 | 16.9% | +74.92 | -10.28 | 166.62 | [-220.50; +373.92] |
| holdout | 1368 | 15.4% | +191.25 | +314.59 | 133.44 | [-121.46; +515.16] |

Candidato com bloqueio limitado a 15%: `E[PnL previsto] <= -0.50` por US$10.

| split | bloqueadas | precisão | ΔPnL | PnL novo | DD novo | IC95% Δ |
|---|---:|---:|---:|---:|---:|---:|
| train | 509 | 23.4% | +133.02 | -501.00 | 625.10 | [-81.93; +349.60] |
| validation | 136 | 25.7% | +16.54 | -68.66 | 160.27 | [-100.46; +132.46] |
| holdout | 200 | 23.0% | +92.24 | +215.57 | 198.58 | [-33.82; +239.50] |

Aviso: julho é OOS para ajuste do modelo e escolha do piso, mas já foi consultado em pesquisas anti-flip anteriores; não é mais holdout analítico intocado.

## Controle com probabilidade bruta do próprio mid

| piso EV previsto / US$10 | Δ treino | Δ validação | Δ julho | bloqueadas julho |
|---:|---:|---:|---:|---:|
| -4.00 | -0.00 | -0.00 | -0.00 | 0 |
| -3.00 | -0.00 | -0.00 | -0.00 | 0 |
| -2.50 | -0.00 | -0.00 | -0.00 | 0 |
| -2.00 | -0.00 | -0.00 | -0.00 | 0 |
| -1.50 | -0.00 | -0.00 | -0.00 | 0 |
| -1.00 | -0.00 | -0.00 | -0.00 | 0 |
| -0.75 | -0.00 | -0.00 | -0.00 | 0 |
| -0.50 | -79.40 | -1.70 | -22.19 | 6 |
| -0.25 | +302.69 | -5.61 | -90.44 | 932 |
| +0.00 | +634.01 | +85.20 | -123.34 | 2083 |
