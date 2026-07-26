# MIDAS — contrafactual v2 skip vs defer (train-defer-d10)

Janela: 2026-05-04 → 2026-07-01 · gate Δ=0.1 lb=2s

## Achado central

ΔPnL observado (gated−base): **-363.63**

| componente | n | efeito no ΔPnL |
|---|---:|---:|
| SKIP (nunca entrou) | 99 | -146.14 (−pnl dos skip) |
| DEFER (mesma event, entrada diferente) | 432 | -217.49 |
| only-gated | 0 | 0 |
| soma explicada | — | -363.63 |
| residual | — | 0 |

SKIP puro: TP=20 FP=79 · pnl se tivesse entrado=146.14 → **bloquear sozinho prejudica**
DEFER: improved=108 worsened=287 · avg Δsecs=-3.26 · avg Δask=0.047

## Se o gate só fizesse SKIP (sem defer) — slices condicionais

| condição nos skipped | n | TP | FP | pnl se entrasse | net se skip | precisão |
|---|---:|---:|---:|---:|---:|---:|
| all | 99 | 20 | 79 | 146.14 | -146.14 | 0.202 |
| ask_lt_070 | 37 | 13 | 24 | 1.45 | -1.45 | 0.351 |
| ask_070_082 | 32 | 6 | 26 | 83.1 | -83.1 | 0.188 |
| ask_ge_082 | 30 | 1 | 29 | 61.6 | -61.6 | 0.033 |
| dist_ge_30 | 26 | 2 | 24 | 65.39 | -65.39 | 0.077 |
| dist_lt_20 | 43 | 13 | 30 | 49.49 | -49.49 | 0.302 |
| tau_20_30 | 30 | 7 | 23 | 14.96 | -14.96 | 0.233 |
| tau_12_20 | 27 | 8 | 19 | -5.05 | 5.05 | 0.296 |
| ask_lt_070_or_dist_ge_30 | 56 | 14 | 42 | 42.98 | -42.98 | 0.25 |
| ask_lt_070_and_tau_ge_12 | 25 | 11 | 14 | -21.67 | 21.67 | 0.44 |

Slices com **netIfSkip > 0** são candidatos a gate condicional (item 2).

## Top DEFER ganhos (entrada adiada melhorou PnL)

| event | dt | base→gate pnl | Δpnl | secs | ask |
|---|---|---:|---:|---:|---:|
| 0xbb8d8cbcbf | 2026-05-12 | -13.96→10.36 | 24.32 | 23→15 | 0.75→0.72 |
| 0x0be8ea677f | 2026-06-24 | -19.32→2.61 | 21.93 | 24→11 | 0.83→0.77 |
| 0x7766044185 | 2026-05-19 | -7.35→4.54 | 11.89 | 28→21 | 0.78→0.66 |
| 0xc7fc43351b | 2026-05-04 | -9.60→2.27 | 11.86 | 29→24 | 0.67→0.80 |
| 0x607788fcff | 2026-06-12 | -8.28→3.10 | 11.39 | 21→10 | 0.78→0.85 |
| 0x082c8a871a | 2026-06-28 | -5.00→6.13 | 11.14 | 25→14 | 0.60→0.60 |
| 0x3ec06041d9 | 2026-05-25 | -8.01→3.10 | 11.11 | 29→23 | 0.59→0.85 |
| 0x13bc67e9ab | 2026-06-25 | -6.93→3.46 | 10.38 | 27→15 | 0.56→0.72 |
| 0xd7551b26a6 | 2026-06-03 | -6.77→3.40 | 10.17 | 22→15 | 0.58→0.72 |
| 0xc6c25cd23c | 2026-05-28 | -19.10→-9.73 | 9.37 | 29→27 | 0.85→0.80 |
| 0xfd1c3fbc5f | 2026-06-01 | -5.91→3.10 | 9.02 | 12→6 | 0.75→0.85 |
| 0x681306be4a | 2026-06-20 | -5.43→3.46 | 8.89 | 28→12 | 0.67→0.72 |

