# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-05-01→2026-07-31** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 24870 |
| Trades | 32495 |
| Win rate | 74.1% |
| PnL | 36520.79 |
| Profit factor | 3.433 |
| Fees (entry/exit) | 17092.36 (12758.57/4333.8) |
| Maker exit % | 62.9% |
| Fee drag | 0.257 |
| Avg hold (s) | 10.96 |
| Trades/event | 1.307 |
| Max DD | 67.1 |
| GO preliminar | YES |

### Exit reasons

- ladder_timeout_partial: 6291
- ladder_timeout: 2672
- ladder_full: 17023
- ladder_stop: 6509

### Config

```json
{
  "from": "2026-05-01",
  "to": "2026-07-31",
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
  "tag": "full-E"
}
```
