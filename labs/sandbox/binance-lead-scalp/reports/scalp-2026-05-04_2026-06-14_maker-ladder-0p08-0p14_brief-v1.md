# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-05-04→2026-06-14** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 11696 |
| Trades | 5963 |
| Win rate | 80.7% |
| PnL | 7998.46 |
| Profit factor | 4.643 |
| Fees (entry/exit) | 2889.78 (2286.67/603.12) |
| Maker exit % | 71% |
| Fee drag | 0.233 |
| Avg hold (s) | 9.66 |
| Trades/event | 0.510 |
| Max DD | 47.96 |
| GO preliminar | YES |

### Exit reasons

- ladder_full: 3693
- ladder_stop: 869
- ladder_timeout_partial: 1042
- ladder_timeout: 359

### Config

```json
{
  "from": "2026-05-04",
  "to": "2026-06-14",
  "leadSec": 1,
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
  "maxTradesPerEvent": 4,
  "minTau": 20,
  "maxTau": 295,
  "feeRate": 0.07,
  "exitMode": "maker-ladder",
  "ladderOffsets": [
    0.08,
    0.14
  ],
  "tag": "brief-v1"
}
```
