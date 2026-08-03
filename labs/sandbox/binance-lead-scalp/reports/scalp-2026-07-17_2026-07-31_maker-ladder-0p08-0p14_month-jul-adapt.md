# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-07-17→2026-07-31** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 3502 |
| Trades | 5830 |
| Win rate | 76.3% |
| PnL | 7451.34 |
| Profit factor | 4.419 |
| Fees (entry/exit) | 2930.79 (2256.33/674.45) |
| Maker exit % | 67.6% |
| Fee drag | 0.248 |
| Avg hold (s) | 10.03 |
| Trades/event | 1.665 |
| Max DD | 22.1 |
| GO preliminar | YES |

### Exit reasons

- ladder_full: 3255
- ladder_stop: 1114
- ladder_timeout_partial: 1064
- ladder_timeout: 397

### Config

```json
{
  "from": "2026-07-17",
  "to": "2026-07-31",
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
  "rescue": false,
  "rescueOffset": 0.01,
  "rescueStop": 0.15,
  "exitMode": "maker-ladder",
  "ladderOffsets": [
    0.08,
    0.14
  ],
  "tag": "month-jul-adapt"
}
```
