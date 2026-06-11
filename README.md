# Data Backtest

Lakehouse OLAP do ecossistema GoldenLens: sync incremental a partir do `data-colector`, Parquet/DuckDB, backtests rápidos, estratégias em blocos e UI visual.

O Postgres continua como fonte de verdade operacional; o lakehouse é derivado, validado e reconstruível.

## Documentação

Índice completo em [docs/README.md](docs/README.md).

### Arquitetura e evolução
- [Arquitetura Backtest v2](arquitetura-backtest-v2.md)
- [Refatoração e melhorias](refatoracao-melhorias.md)

### Guia de docs

- **[Arquitetura V2 — backtest rápido, UX de estúdio](docs/arquitetura/arquitetura-v2-performance-ux.md)** (plano diretor atual)
- [Arquitetura e plano de implementação](docs/arquitetura/arquitetura-lakehouse-backtest.md)
- [Implementação do lakehouse](docs/implementacao/implementacao-lakehouse.md)
- [Operação do lakehouse](docs/operacao/operacao-lakehouse.md)
- [Deploy via Coolify](docs/operacao/deploy-coolify.md)
- [Contrato de archive e retenção opcional](docs/referencia/contrato-archive-retencao.md)
- [Arquitetura do Backtest Studio programável](docs/arquitetura/arquitetura-editor-estrategias.md)
- [Implementação do Backtest Studio](docs/implementacao/implementacao-editor-backtest.md)
- [Manual do Backtest Studio](docs/referencia/manual-backtest-studio.md)
- [Contratos de API e schemas](docs/referencia/contratos-api-schemas.md)
- [Paridade Edge Sniper V2](docs/referencia/paridade-edge-sniper-v2.md)

## Status atual

Snapshot operacional: lakehouse **L1–L7 concluído**; Backtest Studio **Pre-B1, B1–B7 concluídos**; pendente **L5** e validação **L8** em produção. Detalhes por fase em [Implementação do lakehouse](docs/implementacao/implementacao-lakehouse.md) e [Implementação do Backtest Studio](docs/implementacao/implementacao-editor-backtest.md).

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
- Engine de backtest no `data-backtest` com `DuckDbTickProvider` em batches.
- Estratégias salvas/versionadas executadas pelo Backtest Studio sobre `backtest_ticks` do lakehouse.

Paridade da estratégia seed Edge Sniper V2 GLS contra a referência legada já validada (ver [Paridade Edge Sniper V2](docs/referencia/paridade-edge-sniper-v2.md)). A API HTTP e a UI do lakehouse (`src/api/server.js`, `public/`) já estão no ar com disponibilidade, prepare jobs e execução de estratégias versionadas.

Runs são normalizados em `backtest_event_traces` após cada execução. A UI inclui **Run Detail & Event Explorer** (resumo do run, params, snapshot, tabela de eventos, gráfico BTC vs PTB com markers, logs) e endpoints `GET /api/backtest/runs/:id`, `/events`, `/events/:eventTraceId` e `/chart-data`. CRUD de `strategy_definitions` / `strategy_versions` (B1), editor GLS (B2), validador/runtime GLS (B3–B4), execução de estratégias salvas sobre o lakehouse (B5), visualização completa (B6) e seed GLS Edge Sniper V2 (B7) também estão disponíveis. Ver [Implementação do Backtest Studio](docs/implementacao/implementacao-editor-backtest.md) e [Paridade Edge Sniper V2](docs/referencia/paridade-edge-sniper-v2.md).

### Backtest Studio concluído (Pre-B1, B1–B7)

- `backtest_event_traces` + Event Explorer (Pre-B1).
- CRUD `strategy_definitions` / `strategy_versions` + `POST /api/strategies/validate` (B1).
- UI com aba **Estrategias GLS**: lista, editor CodeMirror, params detectados, validação inline, salvar versão (B2).
- Parser + validador GLS v1 em `src/backtestStudio/gls/` (B3).
- Runtime GLS: interpreter, biblioteca MVP (`market`, `book`, `prices`, `time`, `risk`, `math`, `model`, `debug`), simulador de ordens, trace collector (B4).
- `POST /api/backtest/run` aceita `strategy_id` + `strategy_version_id`, persiste snapshot da versão, traces e bloqueia sem availability strict (B5).
- `GET /api/strategy-blocks` lista assinaturas MVP da biblioteca padrão.
- **B6:** Run detail (summary, params, strategy snapshot), tabela de eventos, gráfico Chart.js BTC vs PTB com markers de entry/exit, logs formatados por evento.
- **B7:** GLS seed `src/backtestStudio/gls/strategies/edgeSniperV2.gls`, blocos `math`/`model`/`signals.effectiveMinDistance`, `seedEdgeSniperV2Strategy`, testes de paridade em `tests/edgeSniperGlsParity.test.js`.

### Pendente

- **L8 (produção):** `Dockerfile` e `docker-compose.yml` existem no repositório com volumes `/lake` e `/state`, mas deploy Coolify, backup/restore conjunto e smoke em produção ainda **não foram validados**. Use `npm run ops:check` para validar health + `active_path` antes de backup; ver [Operação do lakehouse](docs/operacao/operacao-lakehouse.md). No Docker local, defina também `SESSION_SECRET` e credenciais admin (ver seção Login).
- **L5:** `PostgresTickProvider`, `HybridTickProvider`, `streamEvents` e `streamCandles` ainda pendentes (`queryCandles` pontual ja existe).
- **Archive `data-colector`:** endpoints e migracao `event_archive_status` no coletor ainda pendentes; o `data-backtest` ja publica status validado.
- **Pós-MVP Backtest Studio:** autocomplete rico, diff entre versões, comparador visual de runs, otimizador de parâmetros. Roteiro detalhado em [Arquitetura V2](docs/arquitetura/arquitetura-v2-performance-ux.md); ver também [Manual do Backtest Studio](docs/referencia/manual-backtest-studio.md).

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
| Fase 9.1 | L6 | concluída (prepare jobs, backtest, estratégias GLS, auth) |
| Fase 9.2 | Pre-B1 + B1 | concluída (explorer + CRUD estratégias) |
| Fase 9.2 | B2–B5 | concluída (editor GLS, runtime, execucao lakehouse) |
| Fase 9.2 | B6–B7 | concluída (visualizacao + GLS edge-sniper seed) |
| Fase 11 | L8 | parcial (Docker/ops:check no repo; produção não validada) |
| Fases 12–13 | — | opcionais futuras |

## Configuração

Copie `.env.example` para `.env` quando precisar customizar caminhos:

```env
LAKE_ROOT=./lake
STATE_DB_PATH=./state/data-backtest.db
BACKTEST_DATA_MODE=strict
BACKTEST_BOOK_DEPTH=10
DATA_BACKTEST_PORT=3100
SESSION_SECRET=change-me-to-a-long-random-string
SESSION_MAX_AGE_SEC=86400
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_PASSWORD=change-me
DATA_COLLECTOR_API_URL=http://localhost:3000
DATA_COLLECTOR_ARCHIVE_API_KEY=
```

### Login da UI

A interface web exige autenticação (mesmo padrão do `data-colector`: cookie HMAC + bcrypt).

1. Defina `SESSION_SECRET` (obrigatório em produção).
2. Na primeira subida, se a tabela `users` estiver vazia, o servidor cria o admin inicial com `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`.
3. Acesse `http://localhost:3100/login` e entre com essas credenciais.
4. Rotas `/api/*` (exceto `POST /api/login` e `GET /healthz`) retornam `401` sem sessão; `GET /` redireciona para `/login`.

Credenciais padrão do `.env.example`: usuário `admin`, senha `change-me` — altere antes de expor a rede.

Testes automatizados usam `TEST_MODE=true` (via `NODE_ENV=test`) para ignorar auth.

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
npm run ops:check
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
npm run backtest:run -- --strategy-id 1 --strategy-version-id 1 --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10 --batch-size 5000
npm run manifest:mark-stale -- --underlying BTC --interval 5m --dt 2026-05-31 --reason "repair-gap"
npm test
```

`npm run health` inicializa o banco local de estado, garante o layout básico do lakehouse e retorna estatísticas do manifest.

`npm run api` sobe a API HTTP do `data-backtest` em `DATA_BACKTEST_PORT` (default `3100`) e serve a UI **Data Runner · Backtest** (sidebar, login, rotas hash) em `http://localhost:3100`. Endpoints principais: auth (`POST /api/login`, `POST /api/logout`, `GET /api/me`), lakehouse (`/healthz`, `/api/manifest`, `/api/availability`, `/api/prepare`, `/api/prepare/run`, jobs), backtest (`/api/backtest/run`, `/api/backtest/runs`, eventos, chart-data) e estratégias GLS (`/api/strategies`, versões, `/api/strategies/validate`, `/api/strategy-blocks`). Fluxo de uso: [Manual do Backtest Studio](docs/referencia/manual-backtest-studio.md).

Deploy local com Docker: `docker compose up --build` monta volumes nomeados em `/lake` e `/state`. Para Coolify, mapear volumes persistentes conforme [Operação do lakehouse](docs/operacao/operacao-lakehouse.md); validação de backup local: `npm run ops:check`.

Exemplo de disponibilidade via API:

```bash
curl "http://localhost:3100/api/prepare?dataset=backtest_ticks&from=2026-05-01&to=2026-05-02&underlying=BTC&interval=5m&book_depth=10"
```

Jobs de preparação rodam serialmente e ficam registrados no SQLite em `prepare_jobs`. A UI cria jobs em `dry-run` por padrão; desmarque somente quando quiser executar o sync real contra `DATA_COLLECTOR_DATABASE_URL`.

Para reprocessar partições `stale`, `invalid` ou `needs_review`, marque `Reprocessar indisponiveis (--rebuild)`. Execução real com rebuild exige confirmação explícita `REBUILD_PARTITIONS`; `dry-run` continua liberado para validar o plano sem escrita.

`POST /api/backtest/run` executa uma estrategia salva via `strategy_id` + `strategy_version_id`, apenas quando `backtest_ticks` esta pronto no modo estrito. Se faltar dado, retorna `409 DATA_NOT_READY`. Runs bem-sucedidos ficam persistidos em `backtest_runs` com snapshot da versao e normalizados em `backtest_event_traces`.

`sync:backfill` exige `DATA_COLLECTOR_DATABASE_URL` e exporta apenas o dataset `scalars`. Para `books`, `backtest_ticks` e `ohlc`, use os comandos `sync:backfill-books`, `sync:backfill-backtest-ticks` e `sync:backfill-ohlc`.

`sync:incremental` usa `event_quality.event_end < now - SYNC_MARGIN_MINUTES` para evitar materializar eventos ainda instáveis. Use `--rebuild` para forçar rebuild de partições e `--allow-needs-review` apenas quando uma divergência já tiver sido analisada.

`sync:reconcile-scalars` recalcula o fingerprint da origem e marca partições como `stale` quando detectar divergência. Quando `DATA_COLLECTOR_API_URL` e `DATA_COLLECTOR_ARCHIVE_API_KEY` estiverem configurados, também marca os eventos arquivados como `stale` na API do `data-colector`. Use com `--dry-run` primeiro.

`sync:backfill-books` grava o book bruto como JSON em Parquet. `sync:backfill-backtest-ticks` grava scalars + book top-N flattenado; use `--book-depth N` ou `BACKTEST_BOOK_DEPTH`.

`sync:backfill-ohlc` lê apenas partições `scalars` válidas do manifest e gera candles derivados. Use `--resolution 1s,5s,1m,5m` ou omita para gerar todas as resoluções.

`query:availability`, `query:ticks` e `query:candles` nunca fazem glob no diretório do lakehouse. Eles resolvem a lista de arquivos exclusivamente pelo manifest e bloqueiam a consulta se houver partição ausente, `stale`, `invalid` ou sem `active_path`.

`query:resolve` aplica o modo de dados. Em `strict`, informa bloqueio quando falta Parquet válido. Em `prepare`, retorna um plano com os comandos de sync necessários antes do backtest.

`legacy:smoke` usa o adapter `src/legacy/polymarketTestAdapter.js` para retornar um batch no formato esperado pelo `polymarket-test`: `btc_price`, `price_to_beat`, best bid/ask e books JSON (`up_book_asks`, `up_book_bids`, `down_book_asks`, `down_book_bids`).

`backtest:run` executa uma estrategia versionada pelo ID da definicao e da versao. Ele usa BTC/price-to-beat/preços UP/DOWN/best bid-ask/books já presentes no dataset `backtest_ticks`.

Parâmetros da estratégia podem ser passados como JSON:

```bash
npm run backtest:run -- --strategy-id 1 --strategy-version-id 1 --from 2026-05-01 --to 2026-05-02 --underlying BTC --interval 5m --book-depth 10 --params '{"minDistanceAbs":40,"maxOrderValue":10}'
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
