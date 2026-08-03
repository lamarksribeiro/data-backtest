# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-05-01→2026-07-31** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 24870 |
| Trades | 51727 |
| Win rate | 74.5% |
| PnL | 50003.26 |
| Profit factor | 3.041 |
| Fees (entry/exit) | 21318.91 (19928.85/1390.06) |
| Maker exit % | 89.3% |
| Fee drag | 0.215 |
| Avg hold (s) | 16.31 |
| Trades/event | 2.080 |
| Max DD | 126.85 |
| GO preliminar | YES |

### Exit reasons

- rescue_full: 19323
- ladder_full: 26158
- rescue_stop: 6052
- rescue_eod: 194

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
  "minTau": 30,
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
  "tag": "full-adapt-rescue-ds15-tau30"
}
```
