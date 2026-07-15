# Hopper 3 — A/B executionMode (sintético)

Gerado: 2026-07-11T06:59:27.395Z

Mesmos ticks sintéticos (3 eventos: 2 com atravessamento de ask, 1 timeout).

| mode | entries | no_entry | PnL bruto | fees | PnL pós-fee | resting placed/filled/cancel | fill rate |
|------|---------|----------|-----------|------|-------------|------------------------------|-----------|
| optimistic_maker | 3 | 0 | 9.4 | 0 | 9.4 | 0/0/0 | — |
| resting_maker | 2 | 1 | 6.2 | 0 | 6.2 | 4/2/2 | 50% |
| taker | 3 | 0 | 8.8 | 0.4351 | 8.3649 | 0/0/0 | — |

## Leitura

- optimistic_maker entries=3 (fill imediato no bid)
- resting_maker entries=2, fill rate=50% (só quando ask atravessa)
- taker entries=3, fees=0.4351

Critério OK: resting fill rate < 100% quando há timeout; optimistic entra em todos os sinais; taker paga fee.
