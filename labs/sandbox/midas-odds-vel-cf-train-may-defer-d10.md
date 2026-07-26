# MIDAS — contrafactual v2 skip vs defer (train-may-defer-d10)

Janela: 2026-05-04 → 2026-06-01 · gate Δ=0.1 lb=2s

## Achado central

ΔPnL observado (gated−base): **-192.99**

| componente | n | efeito no ΔPnL |
|---|---:|---:|
| SKIP (nunca entrou) | 59 | -58.34 (−pnl dos skip) |
| DEFER (mesma event, entrada diferente) | 207 | -134.65 |
| only-gated | 0 | 0 |
| soma explicada | — | -192.99 |
| residual | — | 0 |

SKIP puro: TP=10 FP=49 · pnl se tivesse entrado=58.34 → **bloquear sozinho prejudica**
DEFER: improved=53 worsened=136 · avg Δsecs=-3.09 · avg Δask=0.0526

## Se o gate só fizesse SKIP (sem defer) — slices condicionais

| condição nos skipped | n | TP | FP | pnl se entrasse | net se skip | precisão |
|---|---:|---:|---:|---:|---:|---:|
| all | 59 | 10 | 49 | 58.34 | -58.34 | 0.169 |
| ask_lt_070 | 20 | 5 | 15 | 22.77 | -22.77 | 0.25 |
| ask_070_082 | 19 | 4 | 15 | 3.92 | -3.92 | 0.211 |
| ask_ge_082 | 20 | 1 | 19 | 31.66 | -31.66 | 0.05 |
| dist_ge_30 | 14 | 1 | 13 | 34 | -34 | 0.071 |
| dist_lt_20 | 26 | 6 | 20 | 3.64 | -3.64 | 0.231 |
| tau_20_30 | 16 | 4 | 12 | 3.34 | -3.34 | 0.25 |
| tau_12_20 | 16 | 5 | 11 | -14.87 | 14.87 | 0.313 |
| ask_lt_070_or_dist_ge_30 | 31 | 6 | 25 | 42.27 | -42.27 | 0.194 |
| ask_lt_070_and_tau_ge_12 | 13 | 5 | 8 | -7.22 | 7.22 | 0.385 |

Slices com **netIfSkip > 0** são candidatos a gate condicional (item 2).

## Top DEFER ganhos (entrada adiada melhorou PnL)

| event | dt | base→gate pnl | Δpnl | secs | ask |
|---|---|---:|---:|---:|---:|
| 0xbb8d8cbcbf | 2026-05-12 | -13.96→10.36 | 24.32 | 23→15 | 0.75→0.72 |
| 0x7766044185 | 2026-05-19 | -7.35→4.54 | 11.89 | 28→21 | 0.78→0.66 |
| 0xc7fc43351b | 2026-05-04 | -9.60→2.27 | 11.86 | 29→24 | 0.67→0.80 |
| 0x3ec06041d9 | 2026-05-25 | -8.01→3.10 | 11.11 | 29→23 | 0.59→0.85 |
| 0xc6c25cd23c | 2026-05-28 | -19.10→-9.73 | 9.37 | 29→27 | 0.85→0.80 |
| 0xb629ebafbb | 2026-05-17 | -4.08→4.57 | 8.65 | 30→25 | 0.63→0.65 |
| 0xced17a1df4 | 2026-05-08 | -13.04→-6.39 | 6.65 | 21→9 | 0.80→0.81 |
| 0x0a5059d096 | 2026-05-26 | 1.93→7.19 | 5.26 | 9→5 | 0.78→0.56 |
| 0x9ea3aae953 | 2026-05-23 | 3.44→7.40 | 3.96 | 27→21 | 0.62→0.55 |
| 0x7d7e0e7a63 | 2026-05-12 | -5.71→-2.35 | 3.36 | 18→13 | 0.82→0.74 |
| 0x1404884ad8 | 2026-05-22 | 3.58→6.61 | 3.02 | 28→25 | 0.71→0.57 |
| 0xa70a7828e7 | 2026-05-30 | 2.27→5.11 | 2.84 | 24→16 | 0.80→0.63 |

