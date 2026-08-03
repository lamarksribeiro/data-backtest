# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-05-01→2026-07-31** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 24870 |
| Trades | 54878 |
| Win rate | 75.0% |
| PnL | 50794.3 |
| Profit factor | 3.157 |
| Fees (entry/exit) | 21035.63 (19683.5/1352.13) |
| Maker exit % | 89.6% |
| Fee drag | 0.215 |
| Avg hold (s) | 16.25 |
| Trades/event | 2.207 |
| Max DD | 134.94 |
| GO preliminar | YES |

### Exit reasons

- rescue_full: 20303
- ladder_full: 28054
- rescue_stop: 6279
- rescue_eod: 242

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
  "sizingMode": "liqCap",
  "sharesCapAsk": 0.5,
  "askSizeMult": 1,
  "liqCapMult": 0.9,
  "minShares": 5,
  "tag": "full-adapt-rescue-ds15-depth1-liqcap"
}
```
