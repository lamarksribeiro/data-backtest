# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-05-01→2026-07-31** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 24870 |
| Trades | 49913 |
| Win rate | 74.0% |
| PnL | 46210.28 |
| Profit factor | 2.937 |
| Fees (entry/exit) | 20526.09 (19167.66/1358.43) |
| Maker exit % | 89.2% |
| Fee drag | 0.219 |
| Avg hold (s) | 16.72 |
| Trades/event | 2.007 |
| Max DD | 136 |
| GO preliminar | YES |

### Exit reasons

- rescue_full: 19132
- ladder_full: 24686
- rescue_stop: 5918
- rescue_eod: 177

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
  "minTau": 60,
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
  "tag": "full-adapt-rescue-ds15-tau60"
}
```
