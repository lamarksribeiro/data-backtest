# MIDAS — contrafactual v2 skip vs defer (july-defer-d10)

Janela: 2026-07-01 → 2026-07-26 · gate Δ=0.1 lb=2s

## Achado central

ΔPnL observado (gated−base): **118.33**

| componente | n | efeito no ΔPnL |
|---|---:|---:|
| SKIP (nunca entrou) | 53 | -40.82 (−pnl dos skip) |
| DEFER (mesma event, entrada diferente) | 248 | 159.14 |
| only-gated | 0 | 0 |
| soma explicada | — | 118.32 |
| residual | — | 0.01 |

SKIP puro: TP=14 FP=39 · pnl se tivesse entrado=40.82 → **bloquear sozinho prejudica**
DEFER: improved=101 worsened=134 · avg Δsecs=-3.56 · avg Δask=0.038

## Se o gate só fizesse SKIP (sem defer) — slices condicionais

| condição nos skipped | n | TP | FP | pnl se entrasse | net se skip | precisão |
|---|---:|---:|---:|---:|---:|---:|
| all | 53 | 14 | 39 | 40.82 | -40.82 | 0.264 |
| ask_lt_070 | 15 | 9 | 6 | -6.45 | 6.45 | 0.6 |
| ask_070_082 | 31 | 4 | 27 | 49.45 | -49.45 | 0.129 |
| ask_ge_082 | 7 | 1 | 6 | -2.19 | 2.19 | 0.143 |
| dist_ge_30 | 6 | 3 | 3 | -22.78 | 22.78 | 0.5 |
| dist_lt_20 | 30 | 9 | 21 | 30.99 | -30.99 | 0.3 |
| tau_20_30 | 22 | 7 | 15 | 18.41 | -18.41 | 0.318 |
| tau_12_20 | 21 | 5 | 16 | 0.23 | -0.23 | 0.238 |
| ask_lt_070_or_dist_ge_30 | 21 | 12 | 9 | -29.23 | 29.23 | 0.571 |
| ask_lt_070_and_tau_ge_12 | 12 | 8 | 4 | -16.54 | 16.54 | 0.667 |

Slices com **netIfSkip > 0** são candidatos a gate condicional (item 2).

## Top DEFER ganhos (entrada adiada melhorou PnL)

| event | dt | base→gate pnl | Δpnl | secs | ask |
|---|---|---:|---:|---:|---:|
| 0xd60e418603 | 2026-07-16 | -19.10→2.38 | 21.48 | 19→14 | 0.82→0.79 |
| 0x90a969bf10 | 2026-07-24 | 19.85→39.52 | 19.66 | 26→26 | 0.81→0.82 |
| 0x712929ec82 | 2026-07-01 | -9.60→6.29 | 15.89 | 29→23 | 0.67→0.59 |
| 0x0c955207ae | 2026-07-06 | -30.73→-15.19 | 15.54 | 28→26 | 0.82→0.72 |
| 0xc392f3fe47 | 2026-07-23 | -7.02→6.45 | 13.47 | 29→20 | 0.55→0.58 |
| 0xf8da305222 | 2026-07-18 | -8.10→4.54 | 12.64 | 20→16 | 0.58→0.66 |
| 0x276d2e4a87 | 2026-07-17 | -16.96→-4.83 | 12.13 | 22→19 | 0.55→0.63 |
| 0xe2ac2faa06 | 2026-07-22 | -9.73→2.27 | 12.00 | 29→21 | 0.68→0.80 |
| 0x488a9b2d26 | 2026-07-20 | -9.73→2.17 | 11.90 | 28→13 | 0.80→0.89 |
| 0x011496bc99 | 2026-07-12 | -8.60→3.15 | 11.75 | 26→16 | 0.79→0.74 |
| 0xe4d1c9631b | 2026-07-19 | -7.86→3.46 | 11.32 | 26→20 | 0.78→0.84 |
| 0xcb7236430d | 2026-07-06 | -9.55→1.57 | 11.12 | 29→23 | 0.62→0.92 |

