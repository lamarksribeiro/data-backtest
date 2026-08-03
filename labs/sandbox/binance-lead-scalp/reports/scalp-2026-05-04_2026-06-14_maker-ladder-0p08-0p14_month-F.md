# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-05-04→2026-06-14** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 11696 |
| Trades | 7047 |
| Win rate | 80.2% |
| PnL | 9649.98 |
| Profit factor | 4.504 |
| Fees (entry/exit) | 3546.58 (2775.3/771.28) |
| Maker exit % | 69% |
| Fee drag | 0.234 |
| Avg hold (s) | 9.91 |
| Trades/event | 0.603 |
| Max DD | 27.74 |
| GO preliminar | YES |

### Exit reasons

- ladder_full: 4268
- ladder_stop: 1071
- ladder_timeout_partial: 1250
- ladder_timeout: 458

### Config

```json
{
  "from": "2026-05-04",
  "to": "2026-06-14",
  "leadSec": 2,
  "impulseUsd": 20,
  "minAsk": 0.15,
  "maxAsk": 0.7,
  "maxSpread": 0.04,
  "staleMidMoveMax": 0.02,
  "budget": 10,
  "takeProfit": 0.03,
  "stopLoss": 0.05,
  "stopPct": 0.15,
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
  "tag": "month-F"
}
```
