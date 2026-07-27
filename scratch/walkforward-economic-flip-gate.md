# Gate econômico anti-flip — walk-forward semanal

OOS: 2026-05-18 a 2026-07-26; 10 folds. Treino sempre anterior ao teste.

Baseline: 5625 entradas, PnL -341.43, DD 505.47.

| gate | bloqueadas | precisão flip | ΔPnL | PnL novo | DD novo | semanas +/− | IC95% Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| `combined_ev_le_0` | 3674 (65.3%) | 16.4% | +608.73 | +267.30 | 195.89 | 9/2 | [+65.22; +1152.41] |
| `combined_ev_le_minus_0p5` | 574 (10.2%) | 24.2% | +177.82 | -163.61 | 415.98 | 8/3 | [-59.49; +425.74] |
| `combined_pflip_ge_0p40` | 185 (3.3%) | 45.9% | +190.91 | -150.52 | 368.75 | 7/4 | [-5.41; +395.93] |
| `combined_pflip_ge_0p45` | 32 (0.6%) | 50.0% | +46.22 | -295.21 | 499.27 | 8/3 | [-50.28; +142.37] |
| `combined_pflip_ge_0p50` | 3 (0.1%) | 66.7% | +12.85 | -328.58 | 495.15 | 2/1 | [-15.55; +51.55] |
| `market_only_calibrated_ev_le_0` | 3779 (67.2%) | 13.0% | +249.42 | -92.01 | 373.77 | 8/3 | [-242.91; +744.88] |
| `market_only_calibrated_pflip_ge_0p40` | 0 (0.0%) | — | -0.00 | -341.43 | 505.47 | 0/0 | [+0.00; +0.00] |
| `market_ev_coverage_matched` | 3674 (65.3%) | 25.2% | +192.16 | -149.27 | 235.93 | 7/4 | [-581.85; +951.18] |
| `market_risk_coverage_matched` | 216 (3.8%) | 40.3% | -63.86 | -405.29 | 567.28 | 6/5 | [-314.91; +189.84] |
| `market_ev_le_0` | 5625 (100.0%) | 19.5% | +341.43 | +0.00 | 0.00 | 8/3 | [-427.62; +1104.41] |

O controle `market_ev_le_0` usa apenas `1 - favMid`; ele mostra se o efeito vem simplesmente do preço ou da calibração residual do modelo.

## Comparações pareadas contra controles de preço

| comparação | vantagem ΔPnL | dias +/− | IC95% |
|---|---:|---:|---:|
| `combined_ev0_vs_market_only_ev0` | +359.31 | 42/28 | [-142.66; +856.51] |
| `combined_p40_vs_market_risk_matched` | +254.77 | 42/23 | [+27.98; +490.20] |

## Evolução por fold

| início teste | entradas | PnL base | EV≤0 bloqueadas | Δ EV≤0 | pFlip≥0,40 bloqueadas | Δ pFlip |
|---|---:|---:|---:|---:|---:|---:|
| 2026-05-18 | 569 | -28.91 | 411 | +26.73 | 19 | -8.76 |
| 2026-05-25 | 563 | -154.59 | 374 | +41.27 | 15 | -14.14 |
| 2026-06-01 | 468 | -164.34 | 325 | +162.42 | 23 | +66.47 |
| 2026-06-08 | 556 | -31.73 | 338 | +95.51 | 13 | +45.33 |
| 2026-06-15 | 668 | -13.25 | 420 | +93.81 | 29 | +13.33 |
| 2026-06-22 | 548 | -65.72 | 328 | -58.50 | 24 | +23.50 |
| 2026-06-29 | 626 | +29.88 | 374 | -13.15 | 19 | +22.88 |
| 2026-07-06 | 520 | -10.11 | 331 | +72.99 | 14 | +23.50 |
| 2026-07-13 | 587 | +171.69 | 387 | +81.22 | 14 | +21.71 |
| 2026-07-20 | 520 | -74.36 | 386 | +106.43 | 15 | -2.89 |
