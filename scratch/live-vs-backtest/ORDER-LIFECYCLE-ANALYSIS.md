# Ciclo de vida real das ordens — live 24–25/07

Registros: 22330 · submits: 60 · terminals: 61

## 1. O que foi efetivamente submetido

| intent / tipo de ordem | submits |
|---|--:|
| `ENTER/FAK` | 58 |
| `REVERSE/FAK` | 2 |

## 2. Desfecho

| intent / tipo | terminais | preenchidos | fill % | shares |
|---|--:|--:|--:|--:|
| `ENTER/FAK` | 59 | 35 | 59.3 | 93.720168 |
| `REVERSE/FAK` | 2 | 1 | 50.0 | 2 |

### Razões de término, por intent


**ENTER/FAK**

- 24× `user_ws_trade_matched`
- 23× `no orders found to match with FAK order. FAK orders are partially fill`
- 11× `rest_reconcile`
- 1× `CANCEL_FAILED`

**REVERSE/FAK**

- 1× `REVERSE_EXIT_INCOMPLETE`
- 1× `late_flip_reverse`

## 3. Havia liquidez no momento do submit?

| intent | tipo | resultado | qty | bid no submit | spread | latência ms |
|---|---|---|--:|--:|--:|--:|
| REVERSE | FAK | REJECT | 0 | 0.06 | 0.010 | 398 |
| REVERSE | FAK | FILL | 2 | 0.9 | 0.050 | 1413 |

## 4. ENTER — falhas com liquidez visível no book

ENTER terminais: 59 · falhas: 24 (40.7%)

| resultado | ask no submit | maxPrice | liq visível | qty | latência ms |
|---|--:|--:|--:|--:|--:|
| REJECT | 0.83 | 0.85 | 92.38000000000001 | 0 | 578 |
| REJECT | 0.6 | 0.62 | 76 | 0 | 3806 |
| REJECT | 0.77 | 0.79 | 135 | 0 | 549 |
| REJECT | 0.75 | 0.77 | 184.41 | 0 | 362 |
| REJECT | 0.58 | 0.6 | 95.1 | 0 | 645 |
| REJECT | 0.62 | 0.64 | 221.04000000000002 | 0 | 376 |
| REJECT | 0.68 | 0.7 | 177.07999999999998 | 0 | 674 |
| REJECT | 0.73 | 0.75 | 118.87 | 0 | 376 |
| REJECT | 0.93 | 0.95 | 95.71 | 0 | 493 |
| REJECT | 0.83 | 0.85 | 72.98 | 0 | 793 |
| REJECT | 0.6 | 0.62 | 125.16 | 0 | 818 |
| REJECT | 0.55 | 0.57 | 114.97 | 0 | 389 |
| REJECT | 0.6 | 0.62 | 66.39999999999999 | 0 | 392 |
| REJECT | 0.88 | 0.9 | 71.33 | 0 | 487 |
| REJECT | 0.62 | 0.64 | 191.42000000000002 | 0 | 3406 |
| REJECT | 0.91 | 0.93 | 260.75 | 0 | 466 |
| REJECT | 0.91 | 0.93 | 168.13 | 0 | 1252 |
| REJECT | 0.89 | 0.91 | 53.32 | 0 | 505 |
| REJECT | 0.82 | 0.84 | 115 | 0 | 478 |
| REJECT | 0.94 | 0.96 | 257.78 | 0 | 485 |
| REJECT | 0.88 | 0.9 | 368.27 | 0 | 376 |
| REJECT | 0.9 | 0.92 | 233.55999999999997 | 0 | 496 |
| REJECT | 0.88 | 0.9 | 59.38 | 0 | 512 |
| REJECT | 0.56 | 0.58 | 48 | 0 | 494 |

Falhas em que o book **mostrava liquidez** no submit: 24 de 24 amostradas.

## 5. Latência submit → terminal (n=37)

p50 **645 ms** · p90 **1413 ms** · p99 **3805 ms** · máx **3806 ms**

Com ticks de mercado a ~500 ms, uma latência p50 nessa ordem significa que
o book pode ter andado 1–2 atualizações entre a decisão e a chegada da ordem.