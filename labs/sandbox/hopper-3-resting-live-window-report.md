# Hopper 3 — janela real (optimistic vs resting vs taker)

Gerado: 2026-07-11T07:03:32.822Z
Janela: 2026-06-01 → 2026-06-03 | ticks: 345519
Preset base: btc-champion (params) + override executionMode

| mode | entries | no_entry | win% | PnL bruto | fees | PnL pós-fee | DD | resting P/F/C | fill% | sec |
|------|---------|----------|------|-----------|------|-------------|----|---------------|-------|-----|
| optimistic_maker | 560 | 16 | 48.75 | 503.77 | 127.68 | 376.08 | 75.18 | 0/0/0 | — | 10 |
| resting_maker | 505 | 71 | 36.039603960396036 | -272.26 | 55.3 | -327.56 | 272.26 | 1553/649/904 | 42% | 9.2 |
| taker | 560 | 16 | 46.07142857142857 | -114.81 | 140.69 | -255.51 | 114.81 | 0/0/0 | — | 9.3 |

## Leitura

- `resting_maker` é o modo mais próximo da conta real (LIMIT postOnly + fill por atravessamento).
- Se resting for bem pior que optimistic, o edge do campeão dependia do fill otimista.
- Compare resting vs taker: resting deve ter menos fees e fill rate < 100%.
