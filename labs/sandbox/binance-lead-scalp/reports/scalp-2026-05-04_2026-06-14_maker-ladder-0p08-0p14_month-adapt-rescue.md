# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-05-04→2026-06-14** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 11696 |
| Trades | 24724 |
| Win rate | 76.9% |
| PnL | 32526.52 |
| Profit factor | 15.698 |
| Fees (entry/exit) | 10007.2 (9462.13/545.07) |
| Maker exit % | 93.2% |
| Fee drag | 0.271 |
| Avg hold (s) | 29.56 |
| Trades/event | 2.114 |
| Max DD | 78.24 |
| GO preliminar | YES |

### Exit reasons

- ladder_full: 12100
- rescue_full: 11057
- rescue_eod: 1567

### Config

```json
{
  "from": "2026-05-04",
  "to": "2026-06-14",
  "leadSec": 2,
  "impulseUsd": 8,
  "minAsk": 0.15,
  "maxAsk": 0.7,
  "maxSpread": 0.04,
  "staleMidMoveMax": 0.03,
  "budget": 10,
  "takeProfit": 0.03,
  "stopLoss": 0.05,
  "stopPct": 0,
  "timeoutSec": 20,
  "cooldownSec": 3,
  "maxTradesPerEvent": 5,
  "minTau": 20,
  "maxTau": 280,
  "feeRate": 0.07,
  "impulseVolMult": 2.5,
  "impulseFloor": 5,
  "impulseCap": 12,
  "volWindowSec": 300,
  "rescue": true,
  "rescueOffset": 0.01,
  "rescueStop": 0,
  "exitMode": "maker-ladder",
  "ladderOffsets": [
    0.08,
    0.14
  ],
  "tag": "month-adapt-rescue"
}
```
