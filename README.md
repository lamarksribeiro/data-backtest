# Data Backtest

Lakehouse OLAP do ecossistema GoldenLens: sync incremental a partir do `data-colector`, Parquet/DuckDB, backtests rápidos, estratégias em blocos e UI visual.

O Postgres continua como fonte de verdade operacional; o lakehouse é derivado, validado e reconstruível.

## Documentação

- [Arquitetura e plano de implementação](docs/arquitetura-lakehouse-backtest.md)

## Status atual

Implementada a base da Fase 1:

- Projeto Node.js ESM.
- Configuração por ambiente.
- State store SQLite em modo WAL.
- Tabela `lake_manifest` com status `missing`, `pending`, `writing`, `valid`, `invalid`, `needs_review`, `rebuilding` e `stale`.
- CLI para healthcheck, validação de storage e consulta do manifest.

Implementado o início da Fase 2:

- Cliente read-only para o Postgres do `data-colector`.
- Descoberta de partições seladas por `event_quality`.
- Export `scalars` por partição diária para Parquet ZSTD.
- Escrita em `/lake/.tmp` antes da publicação final.
- Arquivos versionados `part-<run-id>.parquet`.
- Manifest com `active_path` e `source_fingerprint`.
- Validação por contagem real no Postgres e comparação com `event_quality.ticks_recorded`.
- Sync incremental de `scalars` com `SYNC_MARGIN_MINUTES` e lookback configurável por CLI.
- Incremental ignora partições `valid` e não reprocessa `needs_review` sem flag explícita.
- Checksum de valores escalares dentro do `source_fingerprint`, para detectar mudanças sem alteração de contagem.
- Reconciliação de `scalars` para marcar partições `stale` quando a origem mudar.
- Marcação manual de partições `scalars` como `stale`, com cascata para `ohlc` derivado.
- Export de `books` bruto para Parquet ZSTD.
- Export de `backtest_ticks` com book top-N flattenado para colunas numéricas.
- Checksums específicos para `books` e `backtest_ticks`.
- Export de `ohlc` a partir de partições `scalars` válidas.
- OHLC por resolução: `1s`, `5s`, `1m`, `5m`.
- Query layer DuckDB que lê Parquet apenas pelos `active_path` válidos do manifest.
- Checagem de disponibilidade no modo estrito antes de consultar ticks/candles.
- CLI para consultar disponibilidade, ticks e candles.

Próxima etapa do plano: modos `strict`/`prepare` para orquestrar execução de backtests sobre a query layer.

## Configuração

Copie `.env.example` para `.env` quando precisar customizar caminhos:

```env
LAKE_ROOT=./lake
STATE_DB_PATH=./state/data-backtest.db
BACKTEST_DATA_MODE=strict
BACKTEST_BOOK_DEPTH=10
```

No Coolify, os valores esperados são:

```env
LAKE_ROOT=/lake
STATE_DB_PATH=/state/data-backtest.db
BACKTEST_DATA_MODE=strict
BACKTEST_BOOK_DEPTH=10
```

Volumes recomendados:

```yaml
volumes:
  - /data/goldenlens/lakehouse:/lake
  - /data/goldenlens/backtest-state:/state
```

## Comandos

```bash
npm run health
npm run storage:check
npm run manifest:list
npm run sync:partitions -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m
npm run sync:backfill -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --dry-run
npm run sync:incremental -- --lookback-days 2 --underlying BTC --interval 5m --dry-run
npm run sync:reconcile-scalars -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --dry-run
npm run sync:backfill-books -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --dry-run
npm run sync:backfill-backtest-ticks -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10 --dry-run
npm run sync:backfill-ohlc -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --resolution 1m --dry-run
npm run query:availability -- --dataset backtest_ticks --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10
npm run query:ticks -- --dataset backtest_ticks --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10 --limit 10
npm run query:candles -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --resolution 1m --limit 10
npm run manifest:mark-stale -- --underlying BTC --interval 5m --dt 2026-05-31 --reason "repair-gap"
npm test
```

`npm run health` inicializa o banco local de estado, garante o layout básico do lakehouse e retorna estatísticas do manifest.

`sync:backfill` exige `DATA_COLLECTOR_DATABASE_URL` e grava apenas o dataset `scalars` nesta fase.

`sync:incremental` usa `event_quality.event_end < now - SYNC_MARGIN_MINUTES` para evitar materializar eventos ainda instáveis. Use `--rebuild` para forçar rebuild de partições e `--allow-needs-review` apenas quando uma divergência já tiver sido analisada.

`sync:reconcile-scalars` recalcula o fingerprint da origem e marca partições como `stale` quando detectar divergência. Use com `--dry-run` primeiro.

`sync:backfill-books` grava o book bruto como JSON em Parquet. `sync:backfill-backtest-ticks` grava scalars + book top-N flattenado; use `--book-depth N` ou `BACKTEST_BOOK_DEPTH`.

`sync:backfill-ohlc` lê apenas partições `scalars` válidas do manifest e gera candles derivados. Use `--resolution 1s,5s,1m,5m` ou omita para gerar todas as resoluções.

`query:availability`, `query:ticks` e `query:candles` nunca fazem glob no diretório do lakehouse. Eles resolvem a lista de arquivos exclusivamente pelo manifest e bloqueiam a consulta se houver partição ausente, `stale`, `invalid` ou sem `active_path`.

## Projetos relacionados

- `data-colector` — coleta OLTP e API administrativa
- `data-robot` — robô de trading real
- `polymarket-test` — simulador/backtest legado (a migrar)
