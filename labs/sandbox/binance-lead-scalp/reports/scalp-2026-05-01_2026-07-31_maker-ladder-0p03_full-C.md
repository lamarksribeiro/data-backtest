# Binance-lead scalp lab (maker-ladder-0p03)

Range **2026-05-01→2026-07-31** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p03 |
| Events | 24870 |
| Trades | 35206 |
| Win rate | 91.2% |
| PnL | 7279.14 |
| Profit factor | 2.240 |
| Fees (entry/exit) | 14914.2 (13702.49/1211.71) |
| Maker exit % | 89.9% |
| Fee drag | 0.784 |
| Avg hold (s) | 2.22 |
| Trades/event | 1.416 |
| Max DD | 220.41 |
| GO preliminar | NO |

### Exit reasons

- ladder_full: 32076
- ladder_timeout: 1591
- ladder_stop: 1538
- ladder_timeout_nobid: 1

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
  "timeoutSec": 8,
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
    0.03
  ],
  "tag": "full-C"
}
```
