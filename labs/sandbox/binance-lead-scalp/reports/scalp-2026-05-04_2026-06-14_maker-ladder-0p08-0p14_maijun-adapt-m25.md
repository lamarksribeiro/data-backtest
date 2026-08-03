# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-05-04→2026-06-14** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 11696 |
| Trades | 27708 |
| Win rate | 71.6% |
| PnL | 27060 |
| Profit factor | 2.992 |
| Fees (entry/exit) | 14671.34 (10695.32/3976.02) |
| Maker exit % | 59.7% |
| Fee drag | 0.271 |
| Avg hold (s) | 11.57 |
| Trades/event | 2.369 |
| Max DD | 81.88 |
| GO preliminar | YES |

### Exit reasons

- ladder_full: 13320
- ladder_stop: 5891
- ladder_timeout: 2812
- ladder_timeout_partial: 5685

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
  "exitMode": "maker-ladder",
  "ladderOffsets": [
    0.08,
    0.14
  ],
  "tag": "maijun-adapt-m25"
}
```
