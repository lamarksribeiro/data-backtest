# Data Backtest

Lakehouse OLAP do ecossistema GoldenLens: sync incremental a partir do `data-colector`, Parquet/DuckDB, backtests rápidos, estratégias em blocos e UI visual.

O Postgres continua como fonte de verdade operacional; o lakehouse é derivado, validado e reconstruível.

## Documentação

- [Arquitetura e plano de implementação](docs/arquitetura-lakehouse-backtest.md)

## Projetos relacionados

- `data-colector` — coleta OLTP e API administrativa
- `data-robot` — robô de trading real
- `polymarket-test` — simulador/backtest legado (a migrar)
