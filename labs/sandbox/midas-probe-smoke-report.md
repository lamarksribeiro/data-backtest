# MIDAS Probe V1 — Smoke 20–22/07/2026

**Experimento:** `labs/strategies/terminal/midas-probe-v1/experiments/smoke-probe-july20-22.json`  
**Report:** `reports/labs/midas-probe-v1/2026-07-26T17-36-54-720Z-smoke-probe-july20-22`

## Ranking

| Rank | Variante | PnL | WR | PF | **DD** | Fees |
|---:|---|---:|---:|---:|---:|---:|
| 1 | baseline-full (sem probe) | **+91,30** | **79,2%** | 1,41 | 26,45 | 28 |
| 2 | probe-dist-kill | +44,97 | 72,7% | 1,31 | 25,03 | 21 |
| 3 | **probe-confirm** | +39,72 | 66,2% | 1,32 | **17,74** | 18 |
| 4 | probe-strict-no-direct | +16,65 | 62,6% | 1,25 | **17,74** | 13 |

## Leitura

1. Lab operacional — probe kill + upgrade (exit→full) funciona no `compiled-soa`.
2. **Anti-wipeout funciona:** `probe-confirm` corta o DD de 26,5 → **17,7** (−33%) e fees caem.
3. Custo: PnL ~56% do baseline nestes 3 dias (mata probes que depois teriam virado win, e oppAsk=0,45 é agressivo).
4. `probe-dist-kill` (só cross de distância) fica no meio: mais PnL que confirm, DD quase igual ao baseline.
5. Vs Zone V1 (multi-zona −136…−212): probe **permanece lucrativo** em todas as variantes.

## Próximo

- Holdout 01–18/07 e jun stress (onde as bruscas do campeão doem).
- Calibrar `probeKillOppAsk` (0,50–0,55) e `confirmMinDist`.
- Micro budget ($2/$4) alinhado ao robot.
