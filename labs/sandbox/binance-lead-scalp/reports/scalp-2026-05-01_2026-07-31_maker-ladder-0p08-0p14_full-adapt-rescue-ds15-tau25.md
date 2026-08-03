# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-05-01→2026-07-31** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 24870 |
| Trades | 51887 |
| Win rate | 74.5% |
| PnL | 50395.23 |
| Profit factor | 3.055 |
| Fees (entry/exit) | 21386.35 (19994.76/1391.59) |
| Maker exit % | 89.4% |
| Fee drag | 0.215 |
| Avg hold (s) | 16.27 |
| Trades/event | 2.086 |
| Max DD | 126.85 |
| GO preliminar | YES |

### Exit reasons

- rescue_full: 19342
- ladder_full: 26292
- rescue_stop: 6058
- rescue_eod: 195

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
  "minTau": 25,
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
  "tag": "full-adapt-rescue-ds15-tau25"
}
```
