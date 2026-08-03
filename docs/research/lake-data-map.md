# Mapa de dados do Lake — descoberta de teorias

Gerado em: **2026-08-02T05:46:30.716Z**
LAKE_ROOT: `D:\Projetos\projeto-goldenlens\data-backtest\lake`

## Por que este mapa existe

Antes de fixar a próxima teoria matemática, o lake define o **espaço amostral real**:
quais ativos, profundidade de book, gaps, e quais superfícies de anomalia são testáveis.
O programa OJD/Pivot C **continua válido** como linha de vol/jumps/caminho;
este mapa **expande** onde caçar hipóteses sem descartar o trabalho já feito.

## Inventário resumido

| Dataset | Asset | Depth | Dias | From | To | Cov% | Size MB | Gaps |
|---|---|---:|---:|---|---|---:|---:|---:|
| backtest_ticks | BNB | 25 | 63 | 2026-05-24 | 2026-07-25 | 100 | 961.7 | 0 |
| backtest_ticks | BTC | 10 | 1 | 2026-05-29 | 2026-05-29 | 100 | 0.7 | 0 |
| backtest_ticks | BTC | 25 | 100 | 2026-04-23 | 2026-07-31 | 100 | 4033.2 | 0 |
| backtest_ticks | DOGE | 25 | 63 | 2026-05-24 | 2026-07-25 | 100 | 1268.9 | 0 |
| backtest_ticks | ETH | 25 | 64 | 2026-05-24 | 2026-07-26 | 100 | 2049.4 | 0 |
| backtest_ticks | HYPE | 25 | 63 | 2026-05-24 | 2026-07-25 | 100 | 1097.2 | 0 |
| backtest_ticks | SOL | 25 | 63 | 2026-05-24 | 2026-07-25 | 100 | 1757.3 | 0 |
| backtest_ticks | XRP | 25 | 63 | 2026-05-24 | 2026-07-25 | 100 | 1316.2 | 0 |
| backtest_ticks_lite | BTC | — | 66 | 2026-04-23 | 2026-06-27 | — | 84 | 0 |
| books | — | — | — | — | — | — | 0 | EMPTY_LOCAL |
| features | — | — | — | — | — | — | 0 | EMPTY_LOCAL |
| manifests | — | — | — | — | — | — | 0 | EMPTY_LOCAL |
| ohlc | — | — | — | — | — | — | 0 | EMPTY_LOCAL |
| scalars | — | — | — | — | — | — | 0 | EMPTY_LOCAL |

## Mining cube (features rápidas)

- Path: `labs\mining\cube`
- Range: **2026-04-23 → 2026-07-13** (82 arquivos)
- ~**1.141.280** linhas, **441.4 MB**
- Colunas (46): `dt`, `condition_id`, `ts_ms`, `tau`, `spot`, `ptb`, `dist`, `dist_abs`, `fav`, `ask_fav`, `bid_fav`, `spread_fav`, `ask_up`, `ask_down`, `odds_sum`, `d_spot_5`, `d_spot_10`, `d_spot_15`, `d_spot_20`, `d_spot_30`, `d_spot_60`, `sigma_ps_90`, `flips_60`, `secs_since_flip`, `pin45`, `d_askfav_10`, `d_askfav_15`, `d_askfav_30`, `sigma_askfav_15`, `depth5_ask_fav`, `depth5_bid_fav`, `obi5`, `ladder_fav`, `fill_px_fav`, `fill_sh_fav`, `fill_px_non`, `fill_sh_non`, `p_phys`, `edge_phys`, `coverage`, `degraded`, `mkt_agree`, `winner`, `fav_won`, `pnl_fav`, `pnl_non`

## Schemas amostrados

### backtest_ticks BTC d25 2026-06-15

- Arquivo: `lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/dt=2026-06-15/part-backtest-ticks-20260616060045-d2c7dd58.parquet`
- Colunas: **219**
- Stats: ticks=172800 events=288 avg_cov=1 degraded=0 null_L1=8911

<details><summary>Lista de colunas</summary>

`market_id` (VARCHAR) · `underlying` (VARCHAR) · `interval` (VARCHAR) · `condition_id` (VARCHAR) · `event_start` (VARCHAR) · `event_end` (VARCHAR) · `ts` (VARCHAR) · `underlying_price` (DOUBLE) · `price_to_beat` (DOUBLE) · `up_price` (DOUBLE) · `down_price` (DOUBLE) · `up_best_bid` (DOUBLE) · `up_best_ask` (DOUBLE) · `down_best_bid` (DOUBLE) · `down_best_ask` (DOUBLE) · `coverage` (DOUBLE) · `degraded` (BOOLEAN) · `book_depth` (BIGINT) · `up_ask_px_1` (DOUBLE) · `up_ask_sz_1` (DOUBLE) · `up_ask_px_2` (DOUBLE) · `up_ask_sz_2` (DOUBLE) · `up_ask_px_3` (DOUBLE) · `up_ask_sz_3` (DOUBLE) · `up_ask_px_4` (DOUBLE) · `up_ask_sz_4` (DOUBLE) · `up_ask_px_5` (DOUBLE) · `up_ask_sz_5` (DOUBLE) · `up_ask_px_6` (DOUBLE) · `up_ask_sz_6` (DOUBLE) · `up_ask_px_7` (DOUBLE) · `up_ask_sz_7` (DOUBLE) · `up_ask_px_8` (DOUBLE) · `up_ask_sz_8` (DOUBLE) · `up_ask_px_9` (DOUBLE) · `up_ask_sz_9` (DOUBLE) · `up_ask_px_10` (DOUBLE) · `up_ask_sz_10` (DOUBLE) · `up_ask_px_11` (DOUBLE) · `up_ask_sz_11` (DOUBLE) · `up_ask_px_12` (DOUBLE) · `up_ask_sz_12` (DOUBLE) · `up_ask_px_13` (DOUBLE) · `up_ask_sz_13` (DOUBLE) · `up_ask_px_14` (DOUBLE) · `up_ask_sz_14` (DOUBLE) · `up_ask_px_15` (DOUBLE) · `up_ask_sz_15` (DOUBLE) · `up_ask_px_16` (DOUBLE) · `up_ask_sz_16` (DOUBLE) · `up_ask_px_17` (DOUBLE) · `up_ask_sz_17` (DOUBLE) · `up_ask_px_18` (DOUBLE) · `up_ask_sz_18` (DOUBLE) · `up_ask_px_19` (DOUBLE) · `up_ask_sz_19` (DOUBLE) · `up_ask_px_20` (DOUBLE) · `up_ask_sz_20` (DOUBLE) · `up_ask_px_21` (DOUBLE) · `up_ask_sz_21` (DOUBLE) · `up_ask_px_22` (DOUBLE) · `up_ask_sz_22` (DOUBLE) · `up_ask_px_23` (DOUBLE) · `up_ask_sz_23` (DOUBLE) · `up_ask_px_24` (DOUBLE) · `up_ask_sz_24` (DOUBLE) · `up_ask_px_25` (DOUBLE) · `up_ask_sz_25` (DOUBLE) · `up_bid_px_1` (DOUBLE) · `up_bid_sz_1` (DOUBLE) · `up_bid_px_2` (DOUBLE) · `up_bid_sz_2` (DOUBLE) · `up_bid_px_3` (DOUBLE) · `up_bid_sz_3` (DOUBLE) · `up_bid_px_4` (DOUBLE) · `up_bid_sz_4` (DOUBLE) · `up_bid_px_5` (DOUBLE) · `up_bid_sz_5` (DOUBLE) · `up_bid_px_6` (DOUBLE) · `up_bid_sz_6` (DOUBLE) · `up_bid_px_7` (DOUBLE) · `up_bid_sz_7` (DOUBLE) · `up_bid_px_8` (DOUBLE) · `up_bid_sz_8` (DOUBLE) · `up_bid_px_9` (DOUBLE) · `up_bid_sz_9` (DOUBLE) · `up_bid_px_10` (DOUBLE) · `up_bid_sz_10` (DOUBLE) · `up_bid_px_11` (DOUBLE) · `up_bid_sz_11` (DOUBLE) · `up_bid_px_12` (DOUBLE) · `up_bid_sz_12` (DOUBLE) · `up_bid_px_13` (DOUBLE) · `up_bid_sz_13` (DOUBLE) · `up_bid_px_14` (DOUBLE) · `up_bid_sz_14` (DOUBLE) · `up_bid_px_15` (DOUBLE) · `up_bid_sz_15` (DOUBLE) · `up_bid_px_16` (DOUBLE) · `up_bid_sz_16` (DOUBLE) · `up_bid_px_17` (DOUBLE) · `up_bid_sz_17` (DOUBLE) · `up_bid_px_18` (DOUBLE) · `up_bid_sz_18` (DOUBLE) · `up_bid_px_19` (DOUBLE) · `up_bid_sz_19` (DOUBLE) · `up_bid_px_20` (DOUBLE) · `up_bid_sz_20` (DOUBLE) · `up_bid_px_21` (DOUBLE) · `up_bid_sz_21` (DOUBLE) · `up_bid_px_22` (DOUBLE) · `up_bid_sz_22` (DOUBLE) · `up_bid_px_23` (DOUBLE) · `up_bid_sz_23` (DOUBLE) · `up_bid_px_24` (DOUBLE) · `up_bid_sz_24` (DOUBLE) · `up_bid_px_25` (DOUBLE) · `up_bid_sz_25` (DOUBLE) · `down_ask_px_1` (DOUBLE) · `down_ask_sz_1` (DOUBLE) · `down_ask_px_2` (DOUBLE) · `down_ask_sz_2` (DOUBLE) · `down_ask_px_3` (DOUBLE) · `down_ask_sz_3` (DOUBLE) · `down_ask_px_4` (DOUBLE) · `down_ask_sz_4` (DOUBLE) · `down_ask_px_5` (DOUBLE) · `down_ask_sz_5` (DOUBLE) · `down_ask_px_6` (DOUBLE) · `down_ask_sz_6` (DOUBLE) · `down_ask_px_7` (DOUBLE) · `down_ask_sz_7` (DOUBLE) · `down_ask_px_8` (DOUBLE) · `down_ask_sz_8` (DOUBLE) · `down_ask_px_9` (DOUBLE) · `down_ask_sz_9` (DOUBLE) · `down_ask_px_10` (DOUBLE) · `down_ask_sz_10` (DOUBLE) · `down_ask_px_11` (DOUBLE) · `down_ask_sz_11` (DOUBLE) · `down_ask_px_12` (DOUBLE) · `down_ask_sz_12` (DOUBLE) · `down_ask_px_13` (DOUBLE) · `down_ask_sz_13` (DOUBLE) · `down_ask_px_14` (DOUBLE) · `down_ask_sz_14` (DOUBLE) · `down_ask_px_15` (DOUBLE) · `down_ask_sz_15` (DOUBLE) · `down_ask_px_16` (DOUBLE) · `down_ask_sz_16` (DOUBLE) · `down_ask_px_17` (DOUBLE) · `down_ask_sz_17` (DOUBLE) · `down_ask_px_18` (DOUBLE) · `down_ask_sz_18` (DOUBLE) · `down_ask_px_19` (DOUBLE) · `down_ask_sz_19` (DOUBLE) · `down_ask_px_20` (DOUBLE) · `down_ask_sz_20` (DOUBLE) · `down_ask_px_21` (DOUBLE) · `down_ask_sz_21` (DOUBLE) · `down_ask_px_22` (DOUBLE) · `down_ask_sz_22` (DOUBLE) · `down_ask_px_23` (DOUBLE) · `down_ask_sz_23` (DOUBLE) · `down_ask_px_24` (DOUBLE) · `down_ask_sz_24` (DOUBLE) · `down_ask_px_25` (DOUBLE) · `down_ask_sz_25` (DOUBLE) · `down_bid_px_1` (DOUBLE) · `down_bid_sz_1` (DOUBLE) · `down_bid_px_2` (DOUBLE) · `down_bid_sz_2` (DOUBLE) · `down_bid_px_3` (DOUBLE) · `down_bid_sz_3` (DOUBLE) · `down_bid_px_4` (DOUBLE) · `down_bid_sz_4` (DOUBLE) · `down_bid_px_5` (DOUBLE) · `down_bid_sz_5` (DOUBLE) · `down_bid_px_6` (DOUBLE) · `down_bid_sz_6` (DOUBLE) · `down_bid_px_7` (DOUBLE) · `down_bid_sz_7` (DOUBLE) · `down_bid_px_8` (DOUBLE) · `down_bid_sz_8` (DOUBLE) · `down_bid_px_9` (DOUBLE) · `down_bid_sz_9` (DOUBLE) · `down_bid_px_10` (DOUBLE) · `down_bid_sz_10` (DOUBLE) · `down_bid_px_11` (DOUBLE) · `down_bid_sz_11` (DOUBLE) · `down_bid_px_12` (DOUBLE) · `down_bid_sz_12` (DOUBLE) · `down_bid_px_13` (DOUBLE) · `down_bid_sz_13` (DOUBLE) · `down_bid_px_14` (DOUBLE) · `down_bid_sz_14` (DOUBLE) · `down_bid_px_15` (DOUBLE) · `down_bid_sz_15` (DOUBLE) · `down_bid_px_16` (DOUBLE) · `down_bid_sz_16` (DOUBLE) · `down_bid_px_17` (DOUBLE) · `down_bid_sz_17` (DOUBLE) · `down_bid_px_18` (DOUBLE) · `down_bid_sz_18` (DOUBLE) · `down_bid_px_19` (DOUBLE) · `down_bid_sz_19` (DOUBLE) · `down_bid_px_20` (DOUBLE) · `down_bid_sz_20` (DOUBLE) · `down_bid_px_21` (DOUBLE) · `down_bid_sz_21` (DOUBLE) · `down_bid_px_22` (DOUBLE) · `down_bid_sz_22` (DOUBLE) · `down_bid_px_23` (DOUBLE) · `down_bid_sz_23` (DOUBLE) · `down_bid_px_24` (DOUBLE) · `down_bid_sz_24` (DOUBLE) · `down_bid_px_25` (DOUBLE) · `down_bid_sz_25` (DOUBLE) · `dt` (DATE)

</details>

### backtest_ticks ETH d25 2026-06-15

- Arquivo: `lake/backtest_ticks/underlying=ETH/interval=5m/book_depth=25/dt=2026-06-15/part-backtest-ticks-20260616061042-b3b1e0c1.parquet`
- Colunas: **219**
- Stats: ticks=172800 events=288 avg_cov=1 degraded=0 null_L1=10763

<details><summary>Lista de colunas</summary>

`market_id` (VARCHAR) · `underlying` (VARCHAR) · `interval` (VARCHAR) · `condition_id` (VARCHAR) · `event_start` (VARCHAR) · `event_end` (VARCHAR) · `ts` (VARCHAR) · `underlying_price` (DOUBLE) · `price_to_beat` (DOUBLE) · `up_price` (DOUBLE) · `down_price` (DOUBLE) · `up_best_bid` (DOUBLE) · `up_best_ask` (DOUBLE) · `down_best_bid` (DOUBLE) · `down_best_ask` (DOUBLE) · `coverage` (DOUBLE) · `degraded` (BOOLEAN) · `book_depth` (BIGINT) · `up_ask_px_1` (DOUBLE) · `up_ask_sz_1` (DOUBLE) · `up_ask_px_2` (DOUBLE) · `up_ask_sz_2` (DOUBLE) · `up_ask_px_3` (DOUBLE) · `up_ask_sz_3` (DOUBLE) · `up_ask_px_4` (DOUBLE) · `up_ask_sz_4` (DOUBLE) · `up_ask_px_5` (DOUBLE) · `up_ask_sz_5` (DOUBLE) · `up_ask_px_6` (DOUBLE) · `up_ask_sz_6` (DOUBLE) · `up_ask_px_7` (DOUBLE) · `up_ask_sz_7` (DOUBLE) · `up_ask_px_8` (DOUBLE) · `up_ask_sz_8` (DOUBLE) · `up_ask_px_9` (DOUBLE) · `up_ask_sz_9` (DOUBLE) · `up_ask_px_10` (DOUBLE) · `up_ask_sz_10` (DOUBLE) · `up_ask_px_11` (DOUBLE) · `up_ask_sz_11` (DOUBLE) · `up_ask_px_12` (DOUBLE) · `up_ask_sz_12` (DOUBLE) · `up_ask_px_13` (DOUBLE) · `up_ask_sz_13` (DOUBLE) · `up_ask_px_14` (DOUBLE) · `up_ask_sz_14` (DOUBLE) · `up_ask_px_15` (DOUBLE) · `up_ask_sz_15` (DOUBLE) · `up_ask_px_16` (DOUBLE) · `up_ask_sz_16` (DOUBLE) · `up_ask_px_17` (DOUBLE) · `up_ask_sz_17` (DOUBLE) · `up_ask_px_18` (DOUBLE) · `up_ask_sz_18` (DOUBLE) · `up_ask_px_19` (DOUBLE) · `up_ask_sz_19` (DOUBLE) · `up_ask_px_20` (DOUBLE) · `up_ask_sz_20` (DOUBLE) · `up_ask_px_21` (DOUBLE) · `up_ask_sz_21` (DOUBLE) · `up_ask_px_22` (DOUBLE) · `up_ask_sz_22` (DOUBLE) · `up_ask_px_23` (DOUBLE) · `up_ask_sz_23` (DOUBLE) · `up_ask_px_24` (DOUBLE) · `up_ask_sz_24` (DOUBLE) · `up_ask_px_25` (DOUBLE) · `up_ask_sz_25` (DOUBLE) · `up_bid_px_1` (DOUBLE) · `up_bid_sz_1` (DOUBLE) · `up_bid_px_2` (DOUBLE) · `up_bid_sz_2` (DOUBLE) · `up_bid_px_3` (DOUBLE) · `up_bid_sz_3` (DOUBLE) · `up_bid_px_4` (DOUBLE) · `up_bid_sz_4` (DOUBLE) · `up_bid_px_5` (DOUBLE) · `up_bid_sz_5` (DOUBLE) · `up_bid_px_6` (DOUBLE) · `up_bid_sz_6` (DOUBLE) · `up_bid_px_7` (DOUBLE) · `up_bid_sz_7` (DOUBLE) · `up_bid_px_8` (DOUBLE) · `up_bid_sz_8` (DOUBLE) · `up_bid_px_9` (DOUBLE) · `up_bid_sz_9` (DOUBLE) · `up_bid_px_10` (DOUBLE) · `up_bid_sz_10` (DOUBLE) · `up_bid_px_11` (DOUBLE) · `up_bid_sz_11` (DOUBLE) · `up_bid_px_12` (DOUBLE) · `up_bid_sz_12` (DOUBLE) · `up_bid_px_13` (DOUBLE) · `up_bid_sz_13` (DOUBLE) · `up_bid_px_14` (DOUBLE) · `up_bid_sz_14` (DOUBLE) · `up_bid_px_15` (DOUBLE) · `up_bid_sz_15` (DOUBLE) · `up_bid_px_16` (DOUBLE) · `up_bid_sz_16` (DOUBLE) · `up_bid_px_17` (DOUBLE) · `up_bid_sz_17` (DOUBLE) · `up_bid_px_18` (DOUBLE) · `up_bid_sz_18` (DOUBLE) · `up_bid_px_19` (DOUBLE) · `up_bid_sz_19` (DOUBLE) · `up_bid_px_20` (DOUBLE) · `up_bid_sz_20` (DOUBLE) · `up_bid_px_21` (DOUBLE) · `up_bid_sz_21` (DOUBLE) · `up_bid_px_22` (DOUBLE) · `up_bid_sz_22` (DOUBLE) · `up_bid_px_23` (DOUBLE) · `up_bid_sz_23` (DOUBLE) · `up_bid_px_24` (DOUBLE) · `up_bid_sz_24` (DOUBLE) · `up_bid_px_25` (DOUBLE) · `up_bid_sz_25` (DOUBLE) · `down_ask_px_1` (DOUBLE) · `down_ask_sz_1` (DOUBLE) · `down_ask_px_2` (DOUBLE) · `down_ask_sz_2` (DOUBLE) · `down_ask_px_3` (DOUBLE) · `down_ask_sz_3` (DOUBLE) · `down_ask_px_4` (DOUBLE) · `down_ask_sz_4` (DOUBLE) · `down_ask_px_5` (DOUBLE) · `down_ask_sz_5` (DOUBLE) · `down_ask_px_6` (DOUBLE) · `down_ask_sz_6` (DOUBLE) · `down_ask_px_7` (DOUBLE) · `down_ask_sz_7` (DOUBLE) · `down_ask_px_8` (DOUBLE) · `down_ask_sz_8` (DOUBLE) · `down_ask_px_9` (DOUBLE) · `down_ask_sz_9` (DOUBLE) · `down_ask_px_10` (DOUBLE) · `down_ask_sz_10` (DOUBLE) · `down_ask_px_11` (DOUBLE) · `down_ask_sz_11` (DOUBLE) · `down_ask_px_12` (DOUBLE) · `down_ask_sz_12` (DOUBLE) · `down_ask_px_13` (DOUBLE) · `down_ask_sz_13` (DOUBLE) · `down_ask_px_14` (DOUBLE) · `down_ask_sz_14` (DOUBLE) · `down_ask_px_15` (DOUBLE) · `down_ask_sz_15` (DOUBLE) · `down_ask_px_16` (DOUBLE) · `down_ask_sz_16` (DOUBLE) · `down_ask_px_17` (DOUBLE) · `down_ask_sz_17` (DOUBLE) · `down_ask_px_18` (DOUBLE) · `down_ask_sz_18` (DOUBLE) · `down_ask_px_19` (DOUBLE) · `down_ask_sz_19` (DOUBLE) · `down_ask_px_20` (DOUBLE) · `down_ask_sz_20` (DOUBLE) · `down_ask_px_21` (DOUBLE) · `down_ask_sz_21` (DOUBLE) · `down_ask_px_22` (DOUBLE) · `down_ask_sz_22` (DOUBLE) · `down_ask_px_23` (DOUBLE) · `down_ask_sz_23` (DOUBLE) · `down_ask_px_24` (DOUBLE) · `down_ask_sz_24` (DOUBLE) · `down_ask_px_25` (DOUBLE) · `down_ask_sz_25` (DOUBLE) · `down_bid_px_1` (DOUBLE) · `down_bid_sz_1` (DOUBLE) · `down_bid_px_2` (DOUBLE) · `down_bid_sz_2` (DOUBLE) · `down_bid_px_3` (DOUBLE) · `down_bid_sz_3` (DOUBLE) · `down_bid_px_4` (DOUBLE) · `down_bid_sz_4` (DOUBLE) · `down_bid_px_5` (DOUBLE) · `down_bid_sz_5` (DOUBLE) · `down_bid_px_6` (DOUBLE) · `down_bid_sz_6` (DOUBLE) · `down_bid_px_7` (DOUBLE) · `down_bid_sz_7` (DOUBLE) · `down_bid_px_8` (DOUBLE) · `down_bid_sz_8` (DOUBLE) · `down_bid_px_9` (DOUBLE) · `down_bid_sz_9` (DOUBLE) · `down_bid_px_10` (DOUBLE) · `down_bid_sz_10` (DOUBLE) · `down_bid_px_11` (DOUBLE) · `down_bid_sz_11` (DOUBLE) · `down_bid_px_12` (DOUBLE) · `down_bid_sz_12` (DOUBLE) · `down_bid_px_13` (DOUBLE) · `down_bid_sz_13` (DOUBLE) · `down_bid_px_14` (DOUBLE) · `down_bid_sz_14` (DOUBLE) · `down_bid_px_15` (DOUBLE) · `down_bid_sz_15` (DOUBLE) · `down_bid_px_16` (DOUBLE) · `down_bid_sz_16` (DOUBLE) · `down_bid_px_17` (DOUBLE) · `down_bid_sz_17` (DOUBLE) · `down_bid_px_18` (DOUBLE) · `down_bid_sz_18` (DOUBLE) · `down_bid_px_19` (DOUBLE) · `down_bid_sz_19` (DOUBLE) · `down_bid_px_20` (DOUBLE) · `down_bid_sz_20` (DOUBLE) · `down_bid_px_21` (DOUBLE) · `down_bid_sz_21` (DOUBLE) · `down_bid_px_22` (DOUBLE) · `down_bid_sz_22` (DOUBLE) · `down_bid_px_23` (DOUBLE) · `down_bid_sz_23` (DOUBLE) · `down_bid_px_24` (DOUBLE) · `down_bid_sz_24` (DOUBLE) · `down_bid_px_25` (DOUBLE) · `down_bid_sz_25` (DOUBLE) · `dt` (DATE)

</details>

### backtest_ticks_lite BTC 2026-06-15

- Arquivo: `lake/backtest_ticks_lite/underlying=BTC/interval=5m/dt=2026-06-15/part-lite-1782974270748.parquet`
- Colunas: **19**
- Stats: ticks=172800 events=288 avg_cov=1 degraded=0 null_L1=null

<details><summary>Lista de colunas</summary>

`market_id` (VARCHAR) · `underlying` (VARCHAR) · `interval` (VARCHAR) · `condition_id` (VARCHAR) · `event_start` (VARCHAR) · `event_end` (VARCHAR) · `ts` (VARCHAR) · `underlying_price` (DOUBLE) · `price_to_beat` (DOUBLE) · `up_price` (DOUBLE) · `down_price` (DOUBLE) · `up_best_bid` (DOUBLE) · `up_best_ask` (DOUBLE) · `down_best_bid` (DOUBLE) · `down_best_ask` (DOUBLE) · `coverage` (DOUBLE) · `degraded` (BOOLEAN) · `book_depth` (BIGINT) · `dt` (DATE)

</details>

## Superfícies de hipótese (o que os dados permitem)

### S1_barrier_digital_path — Caminho barreira (spot vs PTB) + odds + settlement

- Presente em: backtest_ticks, backtest_ticks_lite, mining_cube
- Teorias habilitadas: OJD/vol-jumps; Terminal convexity; Brownian bridge / digital; Pivot C odds-path consistency
- Nota: Superfície principal já usada. BTC depth25 é a mais rica em range.

### S2_l2_book_microstructure — Livro L2 depth 25 (UP/DOWN asks+bids px/sz)

- Presente em: backtest_ticks (depth=25)
- Ausente em: backtest_ticks_lite, mining_cube (só depth5 agregados)
- Teorias habilitadas: OBI / toxicidade; ladder / pair-path; maker feasibility; liquidity reconstitution
- Nota: ~14GB multi-asset. Melhor para microestrutura; I/O pesado.

### S3_cross_asset — Mesma janela multi-asset (ETH/SOL/BNB/XRP/DOGE/HYPE)

- Presente em: backtest_ticks depth25 ~2026-05-24→07-25
- Teorias habilitadas: lead-lag cross-asset; regime comum de vol; transfer de edge BTC→alt; portfolio correlation de losses
- Nota: Sobreposição multi-asset ~63 dias. Anomalias que só existem em alts são caça fértil e pouco explorada vs BTC.

### S4_cube_features_fast — Cubo de features pré-computado (CSV) para mining rápido

- Presente em: labs/mining/cube
- Teorias habilitadas: screening de hipóteses barato; calibragem p_phys vs mkt; flips/pinning
- Nota: ~1.1M linhas, 46 cols, Apr23–Jul13. Ideal para mapear anomalias ANTES de voltar ao parquet.

### S5_empty_planned_datasets — Datasets planejados mas vazios localmente

- Presente em: —
- Teorias habilitadas: OHLC multi-timeframe; features offline; books isolados
- Nota: EMPTY no lake local — se existirem no Brutus, lake:pull amplia o mapa.

### S6_external_binance_1s — Lead Binance 1s (scripts, não lake padrão)

- Presente em: scripts only — verificar se dados baixados fora do lake
- Teorias habilitadas: spot lead / latency arb; Hyperion lead lab
- Nota: Complementar ao lake Polymarket; não misturar sem join temporal explícito.

### Prioridade sugerida para novas hipóteses

- 1) Screening em mining/cube (rápido) por residual do book condicionado a flips, sigma, tau, dist
- 2) Cross-asset: mesma hipótese OJD/Pivot C em ETH/SOL no range sobreposto — se só BTC morre, pode ser artifact
- 3) Pivot C (odds-path) em backtest_ticks BTC depth25 (maio–julho, não só 22 dias)
- 4) Não gastar ciclos em ohlc/scalars locais (vazios) até pull
- 5) BTC depth25: 2026-04-23→2026-07-31 (100d, 4033.2MB) — eixo principal
- 6) Alts depth25: BNB, DOGE, ETH, HYPE, SOL, XRP ~2026-05-24→2026-07-25

## Relação com OJD / programa atual

| Trabalho | Status | Ação após o mapa |
|---|---|---|
| OJD jump-share η | KILL (Fase I) | Não reabrir sem medição nova |
| Pós-jump residual vs book | KILL | Idem |
| Pivot C odds-path | Pendente | **Continua prioritário** em BTC depth25 range completo |
| Screening cube residual | Novo | **Fazer cedo** — barato, gera hipóteses data-driven |
| Cross-asset replicate | Novo | Testar se anomalias BTC generalizam |
| ohlc/scalars/books locais | Vazios | Pull Brutus se necessário; não bloquear |

## Gaps relevantes

## Como regenerar

```bash
node labs/sandbox/ojd/map-lake-inventory.mjs
```
