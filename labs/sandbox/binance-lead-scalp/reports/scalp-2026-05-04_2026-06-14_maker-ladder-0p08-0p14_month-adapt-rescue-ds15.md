# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-05-04→2026-06-14** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 11696 |
| Trades | 26599 |
| Win rate | 72.8% |
| PnL | 23301.01 |
| Profit factor | 2.709 |
| Fees (entry/exit) | 11023.05 (10263.34/759.71) |
| Maker exit % | 88.5% |
| Fee drag | 0.218 |
| Avg hold (s) | 16.88 |
| Trades/event | 2.274 |
| Max DD | 126.85 |
| GO preliminar | YES |

### Exit reasons

- ladder_full: 12939
- rescue_full: 10290
- rescue_stop: 3249
- rescue_eod: 121

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
  "rescueStop": 0.15,
  "exitMode": "maker-ladder",
  "ladderOffsets": [
    0.08,
    0.14
  ],
  "tag": "month-adapt-rescue-ds15"
}
```
