# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-07-17→2026-07-31** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 3502 |
| Trades | 5824 |
| Win rate | 71.9% |
| PnL | 6261.21 |
| Profit factor | 3.203 |
| Fees (entry/exit) | 3053.9 (2281.34/772.57) |
| Maker exit % | 62.8% |
| Fee drag | 0.256 |
| Avg hold (s) | 10.46 |
| Trades/event | 1.663 |
| Max DD | 28.12 |
| GO preliminar | YES |

### Exit reasons

- ladder_full: 3017
- ladder_stop: 1335
- ladder_timeout_partial: 1054
- ladder_timeout: 418

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
  "impulseVolMult": 0,
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
  "tag": "month-jul-Efreq"
}
```
