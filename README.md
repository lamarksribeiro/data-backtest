# Data Backtest

Lakehouse OLAP do ecossistema GoldenLens: sync incremental a partir do `data-colector`, Parquet/DuckDB, backtests rápidos, estratégias em blocos e UI visual.

O Postgres continua como fonte de verdade operacional; o lakehouse é derivado, validado e reconstruível.

## Documentação

- [Arquitetura e plano de implementação](docs/arquitetura-lakehouse-backtest.md)
- [Paridade Edge Sniper V2](docs/paridade-edge-sniper-v2.md)

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
- Resolução dos modos `strict` e `prepare` para uma futura execução de backtest.
- Plano de preparação com comandos de sync quando faltarem partições.
- Adapter inicial para consumir `backtest_ticks` com shape compatível com `polymarket-test`.
- Runner nativo de backtest no `data-backtest` com `DuckDbTickProvider` em batches.
- Estratégia inicial nativa: `edge-sniper-v2`, usando `backtest_ticks` do lakehouse.

Próxima etapa do plano: validar paridade do `edge-sniper-v2` nativo contra o legado e avançar para API/UI do `data-backtest`.

## Configuração

Copie `.env.example` para `.env` quando precisar customizar caminhos:

```env
LAKE_ROOT=./lake
STATE_DB_PATH=./state/data-backtest.db
BACKTEST_DATA_MODE=strict
BACKTEST_BOOK_DEPTH=10
DATA_COLLECTOR_API_URL=http://localhost:3000
DATA_COLLECTOR_ARCHIVE_API_KEY=
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
npm run api
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
npm run query:resolve -- --mode prepare --dataset backtest_ticks --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10
npm run query:ticks -- --dataset backtest_ticks --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10 --limit 10
npm run query:candles -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --resolution 1m --limit 10
npm run legacy:smoke -- --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10 --limit 10
npm run backtest:run -- --strategy edge-sniper-v2 --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10 --batch-size 5000
npm run manifest:mark-stale -- --underlying BTC --interval 5m --dt 2026-05-31 --reason "repair-gap"
npm test
```

`npm run health` inicializa o banco local de estado, garante o layout básico do lakehouse e retorna estatísticas do manifest.

`npm run api` sobe a API HTTP do `data-backtest` em `DATA_BACKTEST_PORT` (default `3100`) e serve uma UI minima em `http://localhost:3100`. Endpoints iniciais: `GET /healthz`, `GET /api/manifest`, `GET /api/availability`, `GET /api/prepare`, `POST /api/prepare/run`, `GET /api/prepare/jobs`, `GET /api/prepare/jobs/:id`, `GET /api/backtest/strategies`, `GET /api/backtest/runs` e `POST /api/backtest/run`.

Exemplo de disponibilidade via API:

```bash
curl "http://localhost:3100/api/prepare?dataset=backtest_ticks&from=2026-05-01&to=2026-05-02&underlying=BTC&interval=5m&book_depth=10"
```

Jobs de preparação rodam serialmente e ficam registrados no SQLite em `prepare_jobs`. A UI cria jobs em `dry-run` por padrão; desmarque somente quando quiser executar o sync real contra `DATA_COLLECTOR_DATABASE_URL`.

Para reprocessar partições `stale`, `invalid` ou `needs_review`, marque `Reprocessar indisponiveis (--rebuild)`. Execução real com rebuild exige confirmação explícita `REBUILD_PARTITIONS`; `dry-run` continua liberado para validar o plano sem escrita.

`POST /api/backtest/run` executa `edge-sniper-v2` apenas quando `backtest_ticks` está pronto no modo estrito. Se faltar dado, retorna `409 DATA_NOT_READY` com disponibilidade e plano de preparação. Runs bem-sucedidos ficam persistidos em `backtest_runs` e aparecem em `GET /api/backtest/runs`.

`sync:backfill` exige `DATA_COLLECTOR_DATABASE_URL` e grava apenas o dataset `scalars` nesta fase.

`sync:incremental` usa `event_quality.event_end < now - SYNC_MARGIN_MINUTES` para evitar materializar eventos ainda instáveis. Use `--rebuild` para forçar rebuild de partições e `--allow-needs-review` apenas quando uma divergência já tiver sido analisada.

`sync:reconcile-scalars` recalcula o fingerprint da origem e marca partições como `stale` quando detectar divergência. Quando `DATA_COLLECTOR_API_URL` e `DATA_COLLECTOR_ARCHIVE_API_KEY` estiverem configurados, também marca os eventos arquivados como `stale` na API do `data-colector`. Use com `--dry-run` primeiro.

`sync:backfill-books` grava o book bruto como JSON em Parquet. `sync:backfill-backtest-ticks` grava scalars + book top-N flattenado; use `--book-depth N` ou `BACKTEST_BOOK_DEPTH`.

`sync:backfill-ohlc` lê apenas partições `scalars` válidas do manifest e gera candles derivados. Use `--resolution 1s,5s,1m,5m` ou omita para gerar todas as resoluções.

`query:availability`, `query:ticks` e `query:candles` nunca fazem glob no diretório do lakehouse. Eles resolvem a lista de arquivos exclusivamente pelo manifest e bloqueiam a consulta se houver partição ausente, `stale`, `invalid` ou sem `active_path`.

`query:resolve` aplica o modo de dados. Em `strict`, informa bloqueio quando falta Parquet válido. Em `prepare`, retorna um plano com os comandos de sync necessários antes do backtest.

`legacy:smoke` usa o adapter `src/legacy/polymarketTestAdapter.js` para retornar um batch no formato esperado pelo `polymarket-test`: `btc_price`, `price_to_beat`, best bid/ask e books JSON (`up_book_asks`, `up_book_bids`, `down_book_asks`, `down_book_bids`).

`backtest:run` executa estratégias nativas dentro do `data-backtest`. O primeiro alvo é `edge-sniper-v2`, que não depende de série temporal Binance externa; ele usa BTC/price-to-beat/preços UP/DOWN/best bid-ask/books já presentes no dataset `backtest_ticks`.

Parâmetros da estratégia podem ser passados como JSON:

```bash
npm run backtest:run -- --strategy edge-sniper-v2 --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10 --params '{"minDistanceAbs":40,"maxOrderValue":10}'
```

## Adapter legado

Para migrar labs do `polymarket-test`, crie o adapter com o state DB aberto e use as assinaturas equivalentes:

```js
import { createPolymarketTestAdapter } from './src/legacy/polymarketTestAdapter.js';

const adapter = createPolymarketTestAdapter(db, { underlying: 'BTC', interval: '5m', bookDepth: 10 });
const rows = await adapter.getTicksForBacktest(from, to, { limit: 100000 });

for await (const batch of adapter.getTicksForBacktestBatches(from, to, 1000)) {
  // batch tem o shape legado esperado pelos labs.
}
```

Primeiro alvo legado com source opt-in: `polymarket-test/scripts/tune-bs-lead.js`.

```bash
cd ../polymarket-test
npm run tune:bs-lead:lakehouse -- --from 2026-05-01 --to 2026-05-02 --book-depth 10
```

Sem `--data-source lakehouse`, o script continua usando Postgres.

## Projetos relacionados

- `data-colector` — coleta OLTP e API administrativa
- `data-robot` — robô de trading real
- `polymarket-test` — simulador/backtest legado (a migrar)
