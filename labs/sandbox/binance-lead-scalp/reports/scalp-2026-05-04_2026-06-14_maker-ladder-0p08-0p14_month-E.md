# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-05-04→2026-06-14** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 11696 |
| Trades | 18568 |
| Win rate | 72.3% |
| PnL | 18889.08 |
| Profit factor | 3.007 |
| Fees (entry/exit) | 9947.18 (7300.74/2646.44) |
| Maker exit % | 60.3% |
| Fee drag | 0.264 |
| Avg hold (s) | 11.27 |
| Trades/event | 1.588 |
| Max DD | 67.1 |
| GO preliminar | YES |

### Exit reasons

- ladder_full: 9278
- ladder_stop: 3939
- ladder_timeout: 1689
- ladder_timeout_partial: 3662

### Config

```json
{
  "from": "2026-05-04",
  "to": "2026-06-14",
  "leadSec": 2,
  "impulseUsd": 12,
  "minAsk": 0.15,
  "maxAsk": 0.7,
  "maxSpread": 0.04,
  "staleMidMoveMax": 0.02,
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
  "tag": "month-E"
}
```
