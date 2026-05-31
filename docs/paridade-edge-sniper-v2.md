# Paridade Edge Sniper V2

## Objetivo

Validar que o runner nativo `edge-sniper-v2` do `data-backtest` reproduz o comportamento do engine legado do `polymarket-test` quando ambos consomem os mesmos ticks do lakehouse.

## Dataset Validado

- Origem: Postgres local do `data-colector` via `DATA_COLLECTOR_DATABASE_URL`.
- Dataset lakehouse: `backtest_ticks`.
- Underlying: `BTC`.
- Intervalo: `5m`.
- Book depth: `10`.
- Range: `2026-05-29T00:00:00.000Z` ate `2026-05-30T00:00:00.000Z`.
- Particao: `dt=2026-05-29`.
- Eventos: `11`.
- Linhas Parquet brutas: `5729`.
- Ticks validos para backtest apos filtro legado: `5719`.

Filtro de validade aplicado no adapter legado e no provider nativo:

```text
underlying_price IS NOT NULL
price_to_beat IS NOT NULL
price_to_beat > 1000
```

## Resultado Com Parametros Padrao

| Engine | Ticks | Eventos | Entradas | Wins | Losses | PnL | No Entry |
|---|---:|---:|---:|---:|---:|---:|---:|
| data-backtest nativo | 5719 | 11 | 0 | 0 | 0 | 0 | 11 |
| polymarket-test legado | 5719 | 11 | 0 | 0 | 0 | 0 | 11 |

Paridade: OK.

## Resultado Com Parametros Relaxados

Parametros usados para forcar o caminho de entrada/saida e validar simulacao de fills:

```json
{
  "minDistanceAbs": 0,
  "minDistanceNearExpiry": 0,
  "minDirectionalProb": 0.01,
  "minEdge": -0.5,
  "maxSpread": 0.99,
  "minLiquidityRatio": 0.01,
  "minAsk": 0.001,
  "maxAsk": 0.99,
  "entryWindowStart": 300,
  "entryWindowEnd": 0,
  "momentumSec": 1,
  "slowMomentumSec": 1
}
```

| Engine | Ticks | Eventos | Entradas | Wins | Losses | PnL | No Entry |
|---|---:|---:|---:|---:|---:|---:|---:|
| data-backtest nativo | 5719 | 11 | 10 | 3 | 7 | -37.74 | 1 |
| polymarket-test legado | 5719 | 11 | 10 | 3 | 7 | -37.74 | 1 |

Paridade: OK.

Primeira entrada tambem bateu entre os engines:

```text
event_start: 2026-05-29T19:10:00.000Z
side: DOWN
entry_time: 2026-05-29T19:12:19.968Z
avg_entry_price: 0.8
quantity: 9
exit_reason: trail
final_pnl: -0.8100000000000007
```

## Conclusao

O `data-backtest` ja consegue executar o Edge Sniper V2 de forma nativa sobre DuckDB/Parquet e reproduzir o resultado do engine legado para o dataset validado.

O `polymarket-test` permanece apenas como referencia temporaria de paridade. A execucao final de backtests deve acontecer no `data-backtest`.
