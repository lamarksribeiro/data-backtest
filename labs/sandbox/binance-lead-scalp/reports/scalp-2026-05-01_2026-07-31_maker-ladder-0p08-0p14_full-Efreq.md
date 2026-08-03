# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-05-01→2026-07-31** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 24870 |
| Trades | 59444 |
| Win rate | 68.4% |
| PnL | 49109.87 |
| Profit factor | 2.443 |
| Fees (entry/exit) | 32627.76 (23217.59/9410.18) |
| Maker exit % | 55.8% |
| Fee drag | 0.278 |
| Avg hold (s) | 11.86 |
| Trades/event | 2.390 |
| Max DD | 241.61 |
| GO preliminar | YES |

### Exit reasons

- ladder_timeout_partial: 12096
- ladder_timeout: 6494
- ladder_full: 26616
- ladder_stop: 14237
- ladder_eod: 1

### Config

```json
{
  "from": "2026-05-01",
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
  "tag": "full-Efreq"
}
```
