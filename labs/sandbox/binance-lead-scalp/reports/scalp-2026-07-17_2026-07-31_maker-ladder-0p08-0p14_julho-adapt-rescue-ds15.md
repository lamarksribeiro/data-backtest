# Binance-lead scalp lab (maker-ladder-0p08-0p14)

Range **2026-07-17→2026-07-31** · Binance grain **1s** (conservative)

## Summary

| Metric | Value |
|---|---:|
| Exit mode | maker-ladder-0p08-0p14 |
| Events | 3502 |
| Trades | 5654 |
| Win rate | 78.3% |
| PnL | 6810.81 |
| Profit factor | 4.110 |
| Fees (entry/exit) | 2315.79 (2188.81/126.98) |
| Maker exit % | 91.2% |
| Fee drag | 0.207 |
| Avg hold (s) | 14.18 |
| Trades/event | 1.615 |
| Max DD | 31.79 |
| GO preliminar | YES |

### Exit reasons

- ladder_full: 3178
- rescue_full: 1877
- rescue_stop: 584
- rescue_eod: 15

### Config

```json
{
  "from": "2026-07-17",
  "to": "2026-07-31",
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
  "rescue": true,
  "rescueOffset": 0.01,
  "rescueStop": 0.15,
  "exitMode": "maker-ladder",
  "ladderOffsets": [
    0.08,
    0.14
  ],
  "tag": "julho-adapt-rescue-ds15"
}
```
