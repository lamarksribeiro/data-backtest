# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-07-17→2026-07-31** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 3502 |
| Trades | 5392 |
| Win rate | 83.0% |
| PnL | 8422.1 |
| Profit factor | 29.609 |
| Fees (entry/exit) | 2177.61 (2081.74/95.87) |
| Maker exit % | 94.7% |
| Fee drag | 0.242 |
| Avg hold (s) | 24.4 |
| Trades/event | 1.540 |
| Max DD | 10.18 |
| GO preliminar | YES |

### Exit reasons

- ladder_full: 3045
- rescue_full: 2073
- rescue_eod: 274

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
  "rescue": true,
  "rescueOffset": 0.01,
  "rescueStop": 0,
  "exitMode": "maker-ladder",
  "ladderOffsets": [
    0.08,
    0.14
  ],
  "tag": "month-jul-adapt-rescue"
}
```
