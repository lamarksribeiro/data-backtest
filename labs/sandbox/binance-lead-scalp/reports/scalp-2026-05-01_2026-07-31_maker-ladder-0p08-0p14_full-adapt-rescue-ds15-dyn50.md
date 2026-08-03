# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-05-01→2026-07-31** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 24870 |
| Trades | 53208 |
| Win rate | 74.7% |
| PnL | 36938.37 |
| Profit factor | 3.120 |
| Fees (entry/exit) | 16329.22 (15202.72/1126.51) |
| Maker exit % | 90.1% |
| Fee drag | 0.227 |
| Avg hold (s) | 16.33 |
| Trades/event | 2.139 |
| Max DD | 88.75 |
| GO preliminar | YES |

### Exit reasons

- rescue_full: 19779
- ladder_full: 27033
- rescue_stop: 6169
- rescue_eod: 227

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
  "sizingMode": "dynamicBudget",
  "sharesCapAsk": 0.5,
  "tag": "full-adapt-rescue-ds15-dyn50"
}
```
