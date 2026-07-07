# TFC V7 — Diagnóstico Quantitativo (V5 Practical / V6 Hybrid)

Janela: **2026-05-04 → 2026-07-01** | Split june: dt ≥ 2026-06-01

## Metodologia

- Motor: GLS `compiled-soa`, book depth 25, fee taker `0.07·p·(1-p)`.
- Eventos: backtest `fastRun:false` com `onEventFinalized` (ordens, marks, cross τ).
- Executabilidade: DuckDB direto no Parquet (`backtest_ticks`).
- Features de entrada: cubo `labs/mining/cube` cruzado com PnL real do motor.

## A. Decomposição de PnL por mecanismo

### A.1 V5 Practical — desfechos

#### train

| Desfecho | n | % | PnL | Exp |
| --- | --- | --- | --- | --- |
| hold_win | 1171 | 71.3% | $4482.29 | $3.83 |
| hold_loss | 193 | 11.8% | $-1662.19 | $-8.61 |
| late_flip_reverse | 278 | 16.9% | $-1063.97 | $-3.83 |

Flips perdidos após piso 4s: **n=96** (5.8%) custo=$-833.78 exp=$-8.69

#### june

| Desfecho | n | % | PnL | Exp |
| --- | --- | --- | --- | --- |
| hold_win | 1404 | 72.4% | $5600.73 | $3.99 |
| hold_loss | 212 | 10.9% | $-1866.56 | $-8.80 |
| late_flip_reverse | 322 | 16.6% | $-1430.54 | $-4.44 |

Flips perdidos após piso 4s: **n=119** (6.1%) custo=$-1043.72 exp=$-8.77

#### all

| Desfecho | n | % | PnL | Exp |
| --- | --- | --- | --- | --- |
| hold_win | 2575 | 71.9% | $10083.02 | $3.92 |
| hold_loss | 405 | 11.3% | $-3528.75 | $-8.71 |
| late_flip_reverse | 600 | 16.8% | $-2494.51 | $-4.16 |

Flips perdidos após piso 4s: **n=215** (6.0%) custo=$-1877.50 exp=$-8.73

### A.2 Valor do mecanismo tardio (8→4s)

| Split | PnL V5 | PnL hold (lateFlip off) | Δ mecanismo | % do PnL V5 |
| --- | --- | --- | --- | --- |
| train | $1756.13 | $916.65 | $839.48 | 47.8% |
| june | $2303.63 | $1699.52 | $604.11 | 26.2% |
| all | $4059.76 | $2616.17 | $1443.59 | 35.6% |

### A.3 V6 Hybrid — hedge stop + fallback taker

| Split | % hedge fill | n hedge | PnL whipsaw | PnL fav perdeu | n fallback taker | PnL fallback |
| --- | --- | --- | --- | --- | --- | --- |
| train | 1.1% | 18 | $-50.74 | $3.69 | 198 | $-1177.03 |
| june | 0.5% | 10 | $-27.39 | $16.31 | 241 | $-1471.49 |
| all | 0.8% | 28 | $-78.12 | $20.00 | 439 | $-2648.52 |

## B. Auditoria de executabilidade

### B.1 Cadência de snapshots

| Janela | p50 gap | p90 | p99 | % eventos buraco >2s |
| --- | --- | --- | --- | --- |
| últimos 30s | 0.50s | 0.50s | 0.50s | 0.0% |
| últimos 10s | 0.50s | 0.50s | 0.50s | 0.0% |

### B.2 Presença de book

| Zona τ | ticks | book válido | spread≤0.03 | depth≥$10 | depth≥$50 |
| --- | --- | --- | --- | --- | --- |
| entrada 5-30s | 886982 | 53.9% | 95.8% | 47.1% | 35.8% |
| ação 4-8s | 141924 | 38.1% | 93.0% | 31.9% | 23.9% |
| proibida 0-4s | 141859 | 21.0% | 94.8% | 17.8% | 13.8% |

### B.3 Entrada $10 — profundidade e slippage

- Entradas simuladas (primeiro tick com gates V5): **4133**
- Profundidade média no topo: **$132.27**
- Níveis consumidos (média): **1.20** (83.0% em 1 nível)
- Slippage efetivo vs best ask: **$0.017**

### B.4 Degradação por latência (late flip)

| Latência | n | PnL simulado médio | PnL proxy médio | Δ/trade |
| --- | --- | --- | --- | --- |
| 0s | 600 | $-4.16 | $-3.94 | $0.22 |
| 0.5s | 600 | $-4.16 | $-4.31 | $-0.16 |
| 1.0s | 600 | $-4.16 | $-4.32 | $-0.17 |

### Limitações B

- Latência: primeiro snapshot ≥ t+latência após cruzamento na janela 4-8s; sem fila de ordens.
- Proxy PnL sob latência: exit no bid + reverse taker; não replica hedge stop V6.
- Entradas: primeiro tick com gates V5 no evento (pode divergir 1 tick do motor).
- eventTicks para latência mantidos só para eventos com ação tardia (memória).

## C. Bolsões de perda V5 Practical

### C.1 Expectância por ask_fav (PnL real motor)

| Bin ask | n_train | exp_train | n_june | exp_june |
| --- | --- | --- | --- | --- |
| >0.82 | 108 | $1.21 | 114 | $1.30 |
| 0.55-0.60 | 236 | $1.36 | 293 | $1.68 |
| 0.60-0.65 | 225 | $1.07 | 269 | $1.24 |
| 0.65-0.70 | 239 | $-0.07 | 302 | $0.74 |
| 0.70-0.75 | 282 | $1.92 | 360 | $1.31 |
| 0.75-0.82 | 552 | $0.98 | 600 | $1.05 |

### C.2 P(flip tardio) por dist/vol

#### train

| dist/vol | n | P(flip) | P(missed floor) |
| --- | --- | --- | --- |
| <0.5 | 72 | 45.8% | 4.2% |
| 0.5-1.0 | 68 | 23.5% | 7.4% |
| 1.0-1.5 | 77 | 35.1% | 3.9% |
| 1.5-2.5 | 163 | 22.1% | 4.3% |
| 2.5-4.0 | 166 | 19.3% | 4.8% |
| >=4.0 | 381 | 10.2% | 6.0% |
| NA | 715 | 13.3% | 6.6% |

#### june

| dist/vol | n | P(flip) | P(missed floor) |
| --- | --- | --- | --- |
| <0.5 | 90 | 38.9% | 4.4% |
| 0.5-1.0 | 107 | 29.0% | 4.7% |
| 1.0-1.5 | 113 | 26.5% | 3.5% |
| 1.5-2.5 | 215 | 20.0% | 6.5% |
| 2.5-4.0 | 202 | 12.4% | 5.9% |
| >=4.0 | 344 | 9.0% | 7.0% |
| NA | 867 | 14.6% | 6.5% |

### C.3 Impacto de filtros

#### minAsk065

| Split | n após filtro | ΔPnL | DD antes | DD depois |
| --- | --- | --- | --- | --- |
| train | 1181/1642 | $-561.02 | $57.72 | $49.98 |
| june | 1376/1938 | $-827.68 | $61.84 | $62.54 |
| all | 2557/3580 | $-1388.70 | $61.84 | $62.54 |

#### distVolLe1_5

| Split | n após filtro | ΔPnL | DD antes | DD depois |
| --- | --- | --- | --- | --- |
| train | 217/1642 | $-1684.64 | $57.72 | $42.66 |
| june | 310/1938 | $-1934.32 | $61.84 | $71.39 |
| all | 527/3580 | $-3618.96 | $61.84 | $71.39 |

#### both

| Split | n após filtro | ΔPnL | DD antes | DD depois |
| --- | --- | --- | --- | --- |
| train | 124/1642 | $-1742.87 | $57.72 | $32.92 |
| june | 168/1938 | $-2188.36 | $61.84 | $38.58 |
| all | 292/3580 | $-3931.24 | $61.84 | $65.01 |

## D. Upside de sizing

| Scheme | Split | n | PnL | Exp | DD≈ |
| --- | --- | --- | --- | --- | --- |
| fixed10 | train | 1642 | $1756.13 | $1.07 | $57.72 |
| fixed10 | june | 1938 | $2303.63 | $1.19 | $61.84 |
| fixed10 | all | 3580 | $4059.76 | $1.13 | $61.84 |
| prop_v1 | train | 1406 | $1355.89 | $0.96 | $38.55 |
| prop_v1 | june | 1645 | $1689.03 | $1.03 | $71.85 |
| prop_v1 | all | 3051 | $3044.92 | $1.00 | $71.85 |
| prop_v2 | train | 1406 | $1759.24 | $1.25 | $54.74 |
| prop_v2 | june | 1645 | $2127.50 | $1.29 | $70.43 |
| prop_v2 | all | 3051 | $3886.74 | $1.27 | $70.43 |
| prop_gate | train | 124 | $53.56 | $0.43 | $31.21 |
| prop_gate | june | 168 | $161.28 | $0.96 | $50.19 |
| prop_gate | all | 292 | $214.84 | $0.74 | $66.74 |

## Fatos para o design da V7

1. Flips após o piso de 4s custam $-1877.50 em 215 eventos (6.0% das entradas) — confirma o floor executável.
2. O mecanismo tardio 8→4s vale $1443.59 (35.6% do PnL V5) vs hold com mesmo envelope.
3. V6: hedge stop preenche em 0.5% dos eventos (june); whipsaw PnL hedge=$-27.39, fav perdeu=$16.31.
4. Janela de ação 4-8s: 31.9% dos ticks têm depth≥$10 vs 17.8% na zona 0-4s.
5. Latência 1.0s degrada ~$-0.17/trade na janela tardia (proxy).
6. Bolso 0.55-0.60 (V5 Practical): exp train=$1.36 june=$1.68 — **não** é bolsão fraco (contrasta com V4 hold).
7. Bolso 0.60-0.65 (V5 Practical): exp train=$1.07 june=$1.24 — **não** é bolsão fraco (contrasta com V4 hold).
8. Bolso 0.65-0.70: exp train=$-0.07 (fraco) vs june=$0.74 — inconsistente entre splits.
9. Filtro minAsk≥0.65 **destrói** PnL: Δ=$-1388.70 (retém 2557/3580); não recomendado.
10. dist/vol<0.5: P(flip tardio)=45.8% (train, n=72) — maior risco de reverse.
11. Sizing prop_v2 (15/12/10/5/0 por ask): PnL $4059.76→$3886.74, DD≈$61.84→$70.43.
12. V5 ($4059.76) supera V6 ($3607.35) em +$452.41; hedge stop preenche <1% — mecanismo V6 não substitui reverse taker.
13. 100% das ações tardias são late_flip_reverse (n=600); zero late_flip_exit puro.

## Run metadata

```json
{
  "ok": true,
  "from": "2026-05-04",
  "to": "2026-07-01",
  "variants": [
    {
      "id": "v5-practical",
      "summary": {
        "totalEvents": 16399,
        "totalNoEntry": 12819,
        "noEntryReasons": {
          "unknown": 12819
        },
        "eventsWithEntries": 3580,
        "totalEntries": 3580,
        "entries": 3580,
        "wins": 2681,
        "losses": 899,
        "totalWins": 2681,
        "totalLosses": 899,
        "winRate": 74.88826815642457,
        "totalPnl": 4059.759049999978,
        "avgPnl": 1.1340109078212228,
        "avgWin": 4.19749580380459,
        "avgLoss": 8.001921245828703,
        "maxWin": 93.95827000000001,
        "maxLoss": -18.36202,
        "profitFactor": 1.5643470953416332,
        "winLossRatio": 0.5686791992706833,
        "maxDrawdown": 84.34514000000036,
        "volume": 42039.56497999982,
        "ticksProcessed": 10631692,
        "pnl": 4059.759049999978,
        "grossProfit": 11253.486250000105,
        "grossLoss": 7193.727200000003,
        "sharpe": 0.18011499828683408,
        "sharpeRatio": 0.18011499828683408,
        "sortino": 0.34395983717296585,
        "sortinoRatio": 0.34395983717296585,
        "finalWallet": 4059.759049999978,
        "recoveryFactor": 48.1326967979419,
        "fees": {
          "applied": true,
          "model": "polymarket_taker",
          "category": "crypto",
          "currency": "USDC",
          "feeRate": 0.07,
          "totalFee": 945.48577,
          "entryFee": 833.43002,
          "exitFee": 112.05575,
          "entryNotional": 38937.94007999982,
          "exitNotional": 3101.6249000000003,
          "volume": 42039.56497999982,
          "tradesCharged": 5905,
          "entryTradesCharged": 5028,
          "exitTradesCharged": 877,
          "makerTradesFree": 0,
          "makerNotional": 0,
          "makerShares": 0
        },
        "totalFees": 945.48577,
        "feesPaid": 945.48577,
        "feeDrag": 0.18889900574334026,
        "timings": {
          "loadMs": 16630,
          "duckdbReadMs": 16611,
          "processMs": 21108,
          "finishMs": 38,
          "overheadMs": 19,
          "totalMs": 37776,
          "runStartedAt": 1783392091086,
          "strategyMeta": {
            "workerCount": 1,
            "preset_id": null
          }
        }
      },
      "events": 3580
    },
    {
      "id": "v5-hold-contrafactual",
      "summary": {
        "totalEvents": 16399,
        "totalNoEntry": 12819,
        "noEntryReasons": {
          "unknown": 12819
        },
        "eventsWithEntries": 3580,
        "totalEntries": 3580,
        "entries": 3580,
        "wins": 2718,
        "losses": 862,
        "totalWins": 2718,
        "totalLosses": 862,
        "winRate": 75.9217877094972,
        "totalPnl": 2616.1679199999753,
        "avgPnl": 0.7307731620111663,
        "avgWin": 3.9866698307579433,
        "avgLoss": 9.535499628770307,
        "maxWin": 7.972599999999999,
        "maxLoss": -10.08541,
        "profitFactor": 1.3182840653519539,
        "winLossRatio": 0.44862980539632863,
        "maxDrawdown": 117.18650000000116,
        "volume": 33385.89727999983,
        "ticksProcessed": 10631692,
        "pnl": 2616.1679199999753,
        "grossProfit": 10835.76860000009,
        "grossLoss": 8219.600680000005,
        "sharpe": 0.12254295577906452,
        "sharpeRatio": 0.12254295577906452,
        "sortino": 1.6639280315821114,
        "sortinoRatio": 1.6639280315821114,
        "finalWallet": 2616.1679199999753,
        "recoveryFactor": 22.324823422492774,
        "fees": {
          "applied": true,
          "model": "polymarket_taker",
          "category": "crypto",
          "currency": "USDC",
          "feeRate": 0.07,
          "totalFee": 715.0248,
          "entryFee": 715.0248,
          "exitFee": 0,
          "entryNotional": 33385.89727999983,
          "exitNotional": 0,
          "volume": 33385.89727999983,
          "tradesCharged": 4418,
          "entryTradesCharged": 4418,
          "exitTradesCharged": 0,
          "makerTradesFree": 0,
          "makerNotional": 0,
          "makerShares": 0
        },
        "totalFees": 715.0248,
        "feesPaid": 715.0248,
        "feeDrag": 0.21464528176562697,
        "timings": {
          "loadMs": 10535,
          "duckdbReadMs": 10531,
          "processMs": 20668,
          "finishMs": 48,
          "overheadMs": 4,
          "totalMs": 31251,
          "runStartedAt": 1783392128917,
          "strategyMeta": {
            "workerCount": 1,
            "preset_id": null
          }
        }
      },
      "events": 3580
    },
    {
      "id": "v6-hybrid",
      "summary": {
        "totalEvents": 16399,
        "totalNoEntry": 12819,
        "noEntryReasons": {
          "unknown": 12819
        },
        "eventsWithEntries": 3580,
        "totalEntries": 3580,
        "entries": 3580,
        "wins": 2705,
        "losses": 875,
        "totalWins": 2705,
        "totalLosses": 875,
        "winRate": 75.5586592178771,
        "totalPnl": 3607.3506499999817,
        "avgPnl": 1.00763984636871,
        "avgWin": 3.9394670609981834,
        "avgLoss": 8.055894571428576,
        "maxWin": 25.28624,
        "maxLoss": -18.36202,
        "profitFactor": 1.5117602298029904,
        "winLossRatio": 0.5293430266696926,
        "maxDrawdown": 78.35277000000019,
        "volume": 39278.04237999983,
        "ticksProcessed": 10631692,
        "pnl": 3607.3506499999817,
        "grossProfit": 10656.258400000086,
        "grossLoss": 7048.907750000004,
        "sharpe": 0.18057209693777204,
        "sharpeRatio": 0.18057209693777204,
        "sortino": 0.32810843843413345,
        "sortinoRatio": 0.32810843843413345,
        "finalWallet": 3607.3506499999817,
        "recoveryFactor": 46.0398611306272,
        "fees": {
          "applied": true,
          "model": "polymarket_taker",
          "category": "crypto",
          "currency": "USDC",
          "feeRate": 0.07,
          "totalFee": 857.25737,
          "entryFee": 783.20713,
          "exitFee": 74.05024,
          "entryNotional": 37835.44217999983,
          "exitNotional": 1442.6001999999992,
          "volume": 39278.04237999983,
          "tradesCharged": 5529,
          "entryTradesCharged": 4892,
          "exitTradesCharged": 637,
          "makerTradesFree": 0,
          "makerNotional": 0,
          "makerShares": 0
        },
        "totalFees": 857.25737,
        "feesPaid": 857.25737,
        "feeDrag": 0.1920117883047667,
        "timings": {
          "loadMs": 10120,
          "duckdbReadMs": 10118,
          "processMs": 20376,
          "finishMs": 32,
          "overheadMs": 2,
          "totalMs": 30528,
          "runStartedAt": 1783392160200,
          "strategyMeta": {
            "workerCount": 1,
            "preset_id": null
          }
        }
      },
      "events": 3580
    }
  ]
}
```