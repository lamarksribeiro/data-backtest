# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-05-01→2026-07-31** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 24870 |
| Trades | 11516 |
| Win rate | 81.4% |
| PnL | 16567.87 |
| Profit factor | 4.985 |
| Fees (entry/exit) | 5708.86 (4522.13/1186.73) |
| Maker exit % | 70.7% |
| Fee drag | 0.229 |
| Avg hold (s) | 9.6 |
| Trades/event | 0.463 |
| Max DD | 27.74 |
| GO preliminar | YES |

### Exit reasons

- ladder_timeout: 696
- ladder_full: 7223
- ladder_stop: 1630
- ladder_timeout_partial: 1967

### Config

```json
{
  "from": "2026-05-01",
  "to": "2026-07-31",
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
  "tag": "full-F"
}
```
