# MIDAS — contrafactual oddsVelGate: julho vs treino

Gate: delta=0.1, lookback=2s

| métrica | julho | treino |
|---|---:|---:|
| ΔPnL gated−base | 118.33 | -363.63 |
| bloqueados n | 53 | 99 |
| TP (evitou loss) | 14 | 20 |
| FP (perdeu win) | 39 | 79 |
| precisão TP/n | 0.264 | 0.202 |
| PnL bloqueados | 40.82 | 146.14 |
| net de bloquear (−pnl bloq.) | -40.82 | -146.14 |
| avoided loss PnL | -106.57 | -189.92 |
| missed win PnL | 147.38 | 336.06 |

## Leitura

Bloquear não é claramente positivo nos dois lados — preferir gate condicional ou size-halve.

