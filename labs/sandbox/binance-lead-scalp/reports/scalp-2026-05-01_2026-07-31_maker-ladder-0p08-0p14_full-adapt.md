# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-05-01→2026-07-31** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 24870 |
| Trades | 54089 |
| Win rate | 73.3% |
| PnL | 57802.05 |
| Profit factor | 3.376 |
| Fees (entry/exit) | 28160.56 (20856.38/7304.18) |
| Maker exit % | 62.1% |
| Fee drag | 0.265 |
| Avg hold (s) | 11.26 |
| Trades/event | 2.175 |
| Max DD | 81.88 |
| GO preliminar | YES |

### Exit reasons

- ladder_timeout_partial: 10943
- ladder_timeout: 4994
- ladder_full: 27170
- ladder_stop: 10982

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
  "rescue": false,
  "rescueOffset": 0.01,
  "rescueStop": 0.15,
  "exitMode": "maker-ladder",
  "ladderOffsets": [
    0.08,
    0.14
  ],
  "tag": "full-adapt"
}
```
