# Data Backtest

Lakehouse OLAP do ecossistema GoldenLens: sync incremental a partir do `data-colector`, Parquet/DuckDB, backtests rápidos, estratégias em blocos e UI visual.

O Postgres continua como fonte de verdade operacional; o lakehouse é derivado, validado e reconstruível.

## Documentação

- [Arquitetura e plano de implementação](docs/arquitetura-lakehouse-backtest.md)
- [Implementação do lakehouse](docs/implementacao-lakehouse.md)
- [Operação do lakehouse](docs/operacao-lakehouse.md)
- [Contrato de archive e retenção opcional](docs/contrato-archive-retencao.md)
- [Arquitetura do Backtest Studio programável](docs/arquitetura-editor-estrategias.md)
- [Implementação do Backtest Studio](docs/implementacao-editor-backtest.md)
- [Contratos de API e schemas](docs/contratos-api-schemas.md)
- [Paridade Edge Sniper V2](docs/paridade-edge-sniper-v2.md)

## Status atual

Snapshot operacional: lakehouse **L1–L7 concluído**; operação em produção (**L8**) e Backtest Studio (**B1–B7**) ainda pendentes. Detalhes por fase em [Implementação do lakehouse](docs/implementacao-lakehouse.md) e [Implementação do Backtest Studio](docs/implementacao-editor-backtest.md).

Os paths `arquitetura-editor-estrategias.md` e `implementacao-editor-backtest.md` são históricos; o conteúdo descreve o Backtest Studio.

### Lakehouse concluído (L1–L7)

- Projeto Node.js ESM, configuração por ambiente e CLI completa.
- State store SQLite em modo WAL.
- Tabela `lake_manifest` com status `missing`, `pending`, `writing`, `valid`, `invalid`, `needs_review`, `rebuilding` e `stale`.
- CLI para healthcheck, validação de storage e consulta do manifest.
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

Paridade do `edge-sniper-v2` nativo contra o legado já validada (ver [Paridade Edge Sniper V2](docs/paridade-edge-sniper-v2.md)). A API HTTP e a UI mínima do lakehouse (`src/api/server.js`, `public/`) já estão no ar com disponibilidade, prepare jobs e backtest nativo.

Runs persistidos em `backtest_runs` já incluem `events`, `equity` e `log` dentro de `result_json`. A próxima etapa é normalizar isso em `backtest_event_traces`, expor endpoints de detalhe do run e montar o Event Explorer antes do Backtest Studio programável. Ver [Implementação do Backtest Studio](docs/implementacao-editor-backtest.md).

### Pendente

- **L8:** validar deploy Coolify, backup/restore e runbook em produção (`docs/operacao-lakehouse.md`).
- **Pré-B1:** `backtest_event_traces`, `GET /api/backtest/runs/:id`, lista/detalhe de eventos (`eventTraceId`), Event Explorer básico.
- **B1–B7:** CRUD de estratégias, editor GLS, runtime programável e paridade `edge-sniper-v2` em GLS.

### Mapa de fases

| Arquitetura (`arquitetura-lakehouse-backtest.md`) | Lakehouse / Editor | Status |
|---|---|---|
| Fase 0 | — | decisões tomadas |
| Fase 1 | L1 | concluída |
| Fase 2 | L2 | concluída |
| Fase 3 | L3 | concluída |
| Fase 4 | L4 | concluída |
| Fase 5 | L5 | parcial (`PostgresTickProvider`, `HybridTickProvider`, `streamEvents` pendentes) |
| Fase 6 | L7 + adapter | parcial (golden test OK; adaptação de referências legadas pendente) |
| Fase 7 | archive API | parcial no `data-backtest`; `data-colector` pendente |
| Fases 8–10 | — | retencão opcional; fora do caminho padrão |
| Fase 9.1 | L6 | parcial (UI mínima de prepare/backtest) |
| Fase 9.2 | B1–B7 | pendente |
| Fase 11 | L8 | pendente |
| Fases 12–13 | — | opcionais futuras |

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

`POST /api/backtest/run` hoje executa o runner nativo `edge-sniper-v2` como golden test transitório, apenas quando `backtest_ticks` está pronto no modo estrito. Isso não faz parte do lakehouse core: sync, manifest, query layer e Parquet seguem genéricos e sem acoplamento a estratégia. Se faltar dado, retorna `409 DATA_NOT_READY` com disponibilidade e plano de preparação. Runs bem-sucedidos ficam persistidos em `backtest_runs` e aparecem em `GET /api/backtest/runs`.

`sync:backfill` exige `DATA_COLLECTOR_DATABASE_URL` e exporta apenas o dataset `scalars`. Para `books`, `backtest_ticks` e `ohlc`, use os comandos `sync:backfill-books`, `sync:backfill-backtest-ticks` e `sync:backfill-ohlc`.

`sync:incremental` usa `event_quality.event_end < now - SYNC_MARGIN_MINUTES` para evitar materializar eventos ainda instáveis. Use `--rebuild` para forçar rebuild de partições e `--allow-needs-review` apenas quando uma divergência já tiver sido analisada.

`sync:reconcile-scalars` recalcula o fingerprint da origem e marca partições como `stale` quando detectar divergência. Quando `DATA_COLLECTOR_API_URL` e `DATA_COLLECTOR_ARCHIVE_API_KEY` estiverem configurados, também marca os eventos arquivados como `stale` na API do `data-colector`. Use com `--dry-run` primeiro.

`sync:backfill-books` grava o book bruto como JSON em Parquet. `sync:backfill-backtest-ticks` grava scalars + book top-N flattenado; use `--book-depth N` ou `BACKTEST_BOOK_DEPTH`.

`sync:backfill-ohlc` lê apenas partições `scalars` válidas do manifest e gera candles derivados. Use `--resolution 1s,5s,1m,5m` ou omita para gerar todas as resoluções.

`query:availability`, `query:ticks` e `query:candles` nunca fazem glob no diretório do lakehouse. Eles resolvem a lista de arquivos exclusivamente pelo manifest e bloqueiam a consulta se houver partição ausente, `stale`, `invalid` ou sem `active_path`.

`query:resolve` aplica o modo de dados. Em `strict`, informa bloqueio quando falta Parquet válido. Em `prepare`, retorna um plano com os comandos de sync necessários antes do backtest.

`legacy:smoke` usa o adapter `src/legacy/polymarketTestAdapter.js` para retornar um batch no formato esperado pelo `polymarket-test`: `btc_price`, `price_to_beat`, best bid/ask e books JSON (`up_book_asks`, `up_book_bids`, `down_book_asks`, `down_book_bids`).

`backtest:run` executa estratégias nativas transitórias dentro do engine de backtest. O primeiro alvo é `edge-sniper-v2`, usado como golden test para validar o motor e a paridade, não como dependência fixa do lakehouse. Ele usa BTC/price-to-beat/preços UP/DOWN/best bid-ask/books já presentes no dataset `backtest_ticks`.

Parâmetros da estratégia podem ser passados como JSON:

```bash
npm run backtest:run -- --strategy edge-sniper-v2 --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10 --params '{"minDistanceAbs":40,"maxOrderValue":10}'
```

## Research Labs e adapter legado

Research Labs externos (ex.: scripts do `polymarket-test`) consomem o lakehouse via adapter ou query layer. Estratégias candidatas entram no Backtest Studio quando precisam ser salvas, versionadas e comparadas.

Para adaptar códigos legados do `polymarket-test`, crie o adapter com o state DB aberto e use as assinaturas equivalentes:

```js
import { createPolymarketTestAdapter } from './src/legacy/polymarketTestAdapter.js';

const adapter = createPolymarketTestAdapter(db, { underlying: 'BTC', interval: '5m', bookDepth: 10 });
const rows = await adapter.getTicksForBacktest(from, to, { limit: 100000 });

for await (const batch of adapter.getTicksForBacktestBatches(from, to, 1000)) {
  // batch tem o shape legado esperado pelos códigos de pesquisa existentes.
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
- `polymarket-test` — Research Lab legado e referência de paridade (não faz parte do Backtest Studio)
