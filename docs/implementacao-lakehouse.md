# Implementacao Do Lakehouse

## Objetivo

Este documento e o guia de implementacao do lakehouse do `data-backtest`.

Ele complementa:

- `docs/arquitetura-lakehouse-backtest.md`
- `docs/operacao-lakehouse.md`
- `docs/contrato-archive-retencao.md`

Objetivo pratico: permitir implementar ou revisar o lakehouse sem depender de contexto de conversa.

## Escopo

Incluido neste documento:

- estrutura de pastas;
- configuracao;
- SQLite state store;
- manifest;
- datasets Parquet;
- sync/backfill;
- validacao;
- query layer DuckDB;
- prepare jobs;
- API/UI minima;
- archive publish;
- testes;
- criterios de pronto.

Fora do escopo deste documento:

- Backtest Studio (estrategias salvas, GLS, traces, Event Explorer);
- linguagem programavel;
- visualizacao detalhada de backtest;
- retencao real do Postgres.

Esses pontos ficam em `docs/arquitetura-editor-estrategias.md` e `docs/implementacao-editor-backtest.md`.

## Estado Atual Esperado

O lakehouse deve funcionar como uma camada derivada do `data-colector`.

```text
data-colector/Postgres
        |
        | leitura read-only
        v
data-backtest sync
        |
        v
Parquet validado + lake_manifest SQLite
        |
        v
DuckDB query layer / backtests / UI
```

Regra principal:

```text
Queries e backtests nunca escolhem arquivos por glob.
Eles sempre leem os active_path validos do lake_manifest.
```

## Status De Implementacao

Snapshot jun/2026. Detalhes no README.

| Fase | Status |
|---|---|
| L1 Base | concluida |
| L2 Sync scalars | concluida |
| L3 Books + backtest_ticks | concluida |
| L4 OHLC | concluida |
| L5 Query layer | parcial (`PostgresTickProvider`, `HybridTickProvider`, `streamEvents` pendentes) |
| L6 Prepare jobs + API/UI | concluida |
| L7 Backtest basico | concluida |
| L8 Operacao | parcial (docs prontos; validacao Coolify/backup pendente) |

Proximo trabalho documentado: traces/event explorer (pre-B1) e Backtest Studio B1–B7 em `docs/implementacao-editor-backtest.md`.

## Estrutura De Diretorios

Estrutura recomendada do projeto:

```text
data-backtest/
  src/
    api/
      server.js
    backtest/
      engine.js
      tickProvider.js
    config.js
    health.js
    lake/
      paths.js
      storage.js
    legacy/
      polymarketTestAdapter.js
    prepare/
      executor.js
      runner.js
    query/
      availability.js
      dataMode.js
      duckdbQuery.js
      request.js
    source/
      archiveApi.js
      postgres.js
    state/
      sqlite.js
      manifest.js
      prepareJobs.js
      backtestRuns.js
    sync/
      bookDatasets.js
      bookFlatten.js
      duckdbParquet.js
      fingerprint.js
      ohlc.js
      scalars.js
    strategies/
      edgeSniperV2.js
      stopReverse.js
    backtestStudio/   (futuro: runtime GLS, state de estrategias/traces, UI do Studio)
    cli.js
    server.js
  public/
    index.html
    app.js
    styles.css
  docs/
  tests/
```

Observacao de fronteira:

```text
src/lake, src/sync, src/query, src/source e src/state/manifest nao podem importar estrategias.
src/strategies existe apenas como registry nativo transitorio/golden test do Backtest Studio.
O lakehouse core deve continuar generico e sem acoplamento a edge-sniper ou qualquer outra estrategia.
```

## Configuracao

### Variaveis Obrigatorias Para Sync

```env
DATA_COLLECTOR_DATABASE_URL=postgres://...
```

### Variaveis Do Lakehouse

```env
LAKE_ROOT=./lake
STATE_DB_PATH=./state/data-backtest.db
BACKTEST_DATA_MODE=strict
BACKTEST_BOOK_DEPTH=10
SYNC_BATCH_SIZE=50000
SYNC_STATEMENT_TIMEOUT_MS=120000
SYNC_MARGIN_MINUTES=2
```

### Variaveis Da API

```env
DATA_BACKTEST_PORT=3100
```

### Variaveis De Archive Publish

```env
DATA_COLLECTOR_API_URL=http://localhost:3000
DATA_COLLECTOR_ARCHIVE_API_KEY=...
```

Se `DATA_COLLECTOR_API_URL` ou `DATA_COLLECTOR_ARCHIVE_API_KEY` estiverem vazios, publish de archive deve ser pulado de forma explicita:

```json
{
  "skipped": true,
  "reason": "archive_api_not_configured"
}
```

## SQLite State Store

O SQLite e o estado operacional do `data-backtest`.

Requisitos:

- usar `node:sqlite`;
- habilitar WAL;
- habilitar foreign keys;
- configurar busy timeout;
- criar schema automaticamente na abertura.

Inicializacao:

```js
const db = new DatabaseSync(stateDbPath)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')
db.exec('PRAGMA busy_timeout = 5000')
db.exec(SCHEMA_SQL)
```

## Tabela `lake_manifest`

Responsabilidade:

```text
Registrar a particao ativa e confiavel de cada dataset.
```

Colunas obrigatorias:

```text
id INTEGER PRIMARY KEY AUTOINCREMENT
dataset TEXT NOT NULL
market_id TEXT NULL
underlying TEXT NOT NULL
interval TEXT NOT NULL
resolution TEXT NULL
book_depth INTEGER NULL
dt TEXT NOT NULL
active_path TEXT NULL
run_id TEXT NULL
rows INTEGER NOT NULL DEFAULT 0
events_count INTEGER NOT NULL DEFAULT 0
min_ts TEXT NULL
max_ts TEXT NULL
coverage_min REAL NULL
has_degraded INTEGER NOT NULL DEFAULT 0
source_tick_count INTEGER NULL
source_condition_count INTEGER NULL
source_quality_recorded_at_max TEXT NULL
source_fingerprint TEXT NULL
status TEXT NOT NULL
created_at TEXT NOT NULL
verified_at TEXT NULL
error TEXT NULL
```

Status permitidos:

```text
missing
pending
writing
valid
invalid
needs_review
rebuilding
stale
```

Indice unico logico:

```text
dataset + market_id + underlying + interval + resolution + book_depth + dt
```

Regras:

- `active_path` so deve apontar para arquivo final, nunca temporario;
- `valid` precisa ter `active_path` nao nulo;
- `verified_at` deve ser preenchido quando status vira `valid`;
- rebuild deve trocar `active_path` atomicamente;
- particoes antigas podem permanecer no disco ate haver rotina de limpeza segura.

## Tabela `prepare_jobs`

Responsabilidade:

```text
Persistir jobs de preparacao de dados criados pela API/UI.
```

Colunas:

```text
id
status
mode
dry_run
request_json
plan_json
result_json
error
created_at
started_at
completed_at
```

Status:

```text
queued
running
completed
failed
```

Regras:

- runner deve executar serialmente no MVP;
- `dry_run` deve ser true por padrao;
- job real com `rebuild=true` exige confirmacao forte na API;
- erro deve ficar persistido em `error`.

## Tabela `backtest_runs`

Responsabilidade inicial:

```text
Persistir execucoes de backtest nativo.
```

Colunas atuais/esperadas:

```text
id
strategy
source
underlying
interval
book_depth
from_ts
to_ts
batch_size
params_json
ticks
batches
summary_json
result_json
created_at
```

Evolucao futura:

```text
strategy_id
strategy_version_id
strategy_snapshot_json
dataset_request_json
trace_root_path
```

Hoje, `result_json` ja persiste o payload completo do runner nativo, incluindo `events`, `equity` e `log`. Isso basta para smoke tests, mas nao substitui `backtest_event_traces` nem endpoints de detalhe para o Event Explorer.

## Lake Storage

Layout:

```text
/lake/
  scalars/
  books/
  backtest_ticks/
  ohlc/
  features/
  manifests/
  .tmp/
```

Regras:

- garantir criacao dos diretorios no health/storage check;
- validar permissao de escrita;
- arquivos finais devem ser versionados;
- escrever sempre em `.tmp` antes de publicar;
- mover para path final so apos sucesso de escrita.

## Path Convention

### Scalars

```text
/lake/scalars/underlying=BTC/interval=5m/dt=2026-05-31/part-<run-id>.parquet
```

### Books

```text
/lake/books/underlying=BTC/interval=5m/dt=2026-05-31/part-<run-id>.parquet
```

### Backtest Ticks

```text
/lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=10/dt=2026-05-31/part-<run-id>.parquet
```

### OHLC

```text
/lake/ohlc/resolution=1m/underlying=BTC/interval=5m/dt=2026-05-31/part-<run-id>.parquet
```

## Fonte Postgres

Modulo:

```text
src/source/postgres.js
```

Responsabilidades:

- criar pool read-only;
- aplicar statement timeout;
- listar particoes seladas por `event_quality`;
- buscar eventos da particao;
- contar ticks por evento;
- buscar scalars;
- buscar ticks com books;
- fechar pool.

Regras:

- sync deve falhar se `DATA_COLLECTOR_DATABASE_URL` estiver ausente;
- queries devem usar parametros, nunca interpolacao bruta;
- processar por ranges pequenos;
- limitar concorrencia;
- considerar replica read-only no futuro.

## Datasets

### `scalars`

Colunas minimas:

```text
market_id
underlying
interval
condition_id
event_start
event_end
ts
underlying_price
price_to_beat
up_price
down_price
up_best_bid
up_best_ask
down_best_bid
down_best_ask
coverage
degraded
```

Validacao:

- rows reais;
- eventos;
- min/max ts;
- `source_fingerprint`;
- checksum de valores mutaveis.

### `books`

Colunas minimas:

```text
market_id
underlying
interval
condition_id
event_start
ts
up_book_asks
up_book_bids
down_book_asks
down_book_bids
```

Validacao:

- rows reais;
- eventos;
- parse JSON quando aplicavel;
- checksum do book.

### `backtest_ticks`

Colunas:

- todas as colunas essenciais para estrategias;
- book top-N flattenado.

Para `book_depth=10`:

```text
up_ask_px_1 ... up_ask_px_10
up_ask_sz_1 ... up_ask_sz_10
up_bid_px_1 ... up_bid_px_10
up_bid_sz_1 ... up_bid_sz_10
```

Validacao:

- rows reais;
- eventos;
- `book_depth` correto;
- checksum de precos/books flattenados;
- Parquet legivel via DuckDB.

### `ohlc`

Resolucao suportada:

```text
1s
5s
1m
5m
```

Regras:

- derivar apenas de `scalars` validos;
- usar manifest como fonte de paths;
- se `scalars` virar `stale`, `ohlc` derivado deve virar `stale`.

## Fingerprint

Modulo:

```text
src/sync/fingerprint.js
```

Objetivo:

```text
Detectar mudancas na origem, mesmo quando a contagem nao muda.
```

Entradas recomendadas:

- dataset;
- market id;
- underlying;
- interval;
- dt;
- rows;
- eventos;
- ticks por evento;
- min/max ts;
- `event_quality.recorded_at` maximo;
- checksum de valores mutaveis.

Regras:

- ordenar eventos antes de hashear;
- resultado deve ser deterministico;
- mudanca de `price_to_beat` deve mudar fingerprint;
- mudanca de book deve mudar fingerprint de `books`/`backtest_ticks`.

## Escrita Parquet

Modulo:

```text
src/sync/duckdbParquet.js
```

Requisitos:

- usar DuckDB para escrever Parquet;
- compressao ZSTD;
- criar arquivo em `.tmp`;
- mover para final;
- validar leitura basica depois da escrita;
- nao publicar arquivo parcial.

## Fluxo De Export De Particao

Pseudo fluxo:

```text
1. Receber partition + dataset.
2. Consultar manifest existente.
3. Se valid e sem rebuild, pular.
4. Se needs_review e sem allowNeedsReview/rebuild, pular protegido.
5. Buscar eventos e contagens na origem.
6. Calcular rows esperados/reais.
7. Se dry-run, retornar plano e status esperado.
8. Criar run_id.
9. Upsert manifest como writing/rebuilding.
10. Buscar rows completas.
11. Transformar rows se necessario.
12. Calcular checksum/fingerprint.
13. Escrever Parquet temporario.
14. Mover para path final.
15. Validar Parquet final.
16. Atualizar manifest como valid ou needs_review.
17. Publicar archive status se aplicavel.
```

## Regras De Processamento

### Quando Pular

Pular particao quando:

- ja esta `valid`;
- nao houve `--rebuild`;
- nao esta `stale`/`invalid`;
- nao ha permissao manual para `needs_review`.

### Quando Processar

Processar quando:

- `missing`;
- `invalid`;
- `stale`;
- `writing` antigo;
- `--rebuild` explicito.

### Quando Bloquear

Bloquear quando:

- `needs_review` sem confirmacao;
- fonte sem `event_quality`;
- config obrigatoria ausente;
- dataset desconhecido;
- parametros invalidos.

## Query Layer

Modulos:

```text
src/query/availability.js
src/query/dataMode.js
src/query/duckdbQuery.js
src/query/request.js
```

Responsabilidades:

- normalizar request;
- calcular particoes esperadas por range;
- verificar manifest;
- retornar missing/unavailable;
- montar lista de `active_path` validos;
- executar query DuckDB somente nesses arquivos.

## Dataset Request

Formato canonico:

```json
{
  "dataset": "backtest_ticks",
  "from": "2026-05-29T00:00:00.000Z",
  "to": "2026-05-30T00:00:00.000Z",
  "underlying": "BTC",
  "interval": "5m",
  "bookDepth": 10,
  "resolution": null,
  "limit": 1000,
  "offset": 0,
  "rebuild": false
}
```

## Availability Response

```json
{
  "ok": false,
  "dataset": "backtest_ticks",
  "underlying": "BTC",
  "interval": "5m",
  "book_depth": 10,
  "from": "2026-05-29T00:00:00.000Z",
  "to": "2026-05-30T00:00:00.000Z",
  "expected_partitions": ["2026-05-29"],
  "files": [],
  "missing": ["2026-05-29"],
  "unavailable": []
}
```

## Data Modes

### `strict`

Bloqueia quando falta dado valido.

### `prepare`

Retorna plano de sync/rebuild.

### `hybrid`

Reservado para debug/futuro live-tail. Nao usar como padrao.

## Prepare Plan

Exemplo:

```json
{
  "mode": "prepare",
  "ready": false,
  "status": "prepare_required",
  "reason": "dataset_not_available",
  "preparation": [
    {
      "command": "sync:backfill-backtest-ticks",
      "args": [
        "--from", "2026-05-29T00:00:00.000Z",
        "--to", "2026-05-30T00:00:00.000Z",
        "--underlying", "BTC",
        "--interval", "5m",
        "--book-depth", "10"
      ]
    }
  ]
}
```

## Prepare Runner

Modulo:

```text
src/prepare/runner.js
```

Regras:

- criar job em SQLite;
- executar serialmente;
- marcar running/completed/failed;
- expor `waitForIdle` para testes;
- preservar plano gerado no momento da criacao.

## Prepare Executor

Modulo:

```text
src/prepare/executor.js
```

Mapeamento:

```text
sync:backfill                 -> exportScalarsPartition
sync:backfill-books           -> exportBooksPartition
sync:backfill-backtest-ticks  -> exportBacktestTicksPartition
sync:backfill-ohlc            -> exportOhlcFromScalarsPartition
```

Flags obrigatorias:

```text
--from
--to
--underlying
--interval
```

Flags adicionais:

```text
--book-depth
--resolution
--rebuild
--allow-needs-review
```

## API HTTP

Endpoints minimos do lakehouse:

```text
GET  /healthz
GET  /api/manifest
GET  /api/availability
GET  /api/prepare
POST /api/prepare/run
GET  /api/prepare/jobs
GET  /api/prepare/jobs/:id
```

Endpoints de backtest nativo (Fase L7, ja implementados):

```text
GET  /api/backtest/strategies
GET  /api/backtest/runs
POST /api/backtest/run
```

Contratos completos de request/response em `docs/contratos-api-schemas.md`.

Regras:

- erros de validacao retornam HTTP 400;
- job criado retorna HTTP 202;
- rebuild real sem confirmacao retorna HTTP 400;
- respostas JSON sempre devem ter content-type correto.

## UI Minima Do Lakehouse

Arquivos:

```text
public/index.html
public/app.js
public/styles.css
```

Funcionalidades minimas:

- mostrar health/particoes;
- formulario de dataset/range;
- verificar disponibilidade;
- mostrar missing/unavailable;
- mostrar plano de preparacao;
- criar job dry-run por padrao;
- permitir execucao real com confirmacao;
- permitir rebuild com confirmacao forte.

## Archive Publish

Modulo:

```text
src/source/archiveApi.js
```

Quando chamar:

- apos `backtest_ticks` valid;
- quando API URL e API key estiverem configuradas.

Payload deve incluir:

- condition ids/eventos;
- dataset;
- status;
- rows;
- path ativo;
- fingerprint;
- book depth/resolution se aplicavel.

Stale API:

- enviar condition ids em chunks;
- nao vazar secrets em logs;
- retornar contagem publicada.

## CLI

Comandos esperados:

```text
health
storage:check
manifest:list
manifest:mark-stale
query:availability
query:resolve
query:ticks
query:candles
sync:partitions
sync:backfill
sync:backfill-books
sync:backfill-backtest-ticks
sync:backfill-ohlc
sync:incremental
sync:reconcile-scalars
legacy:smoke
backtest:run
```

## Implementacao Em Fases

### Fase L1: Base — concluida

- [x] Criar estrutura Node ESM.
- [x] Criar config.
- [x] Criar SQLite WAL.
- [x] Criar `lake_manifest`.
- [x] Criar storage check.
- [x] Criar health.
- [x] Criar CLI basica.
- [x] Testes de config/storage/manifest.

### Fase L2: Sync Scalars — concluida

- [x] Criar Postgres source.
- [x] Listar particoes seladas.
- [x] Exportar scalars.
- [x] Escrever Parquet ZSTD.
- [x] Validar rows/eventos.
- [x] Registrar manifest.
- [x] Criar incremental.
- [x] Criar reconcile scalars.
- [x] Testes de fingerprint e incremental.

### Fase L3: Books E Backtest Ticks — concluida

- [x] Exportar books bruto.
- [x] Criar flatten top-N.
- [x] Exportar backtest_ticks.
- [x] Calcular checksums especificos.
- [x] Publicar archive valid se configurado.
- [x] Testes de parser/flatten/checksum.

### Fase L4: OHLC — concluida

- [x] Gerar OHLC a partir de scalars validos.
- [x] Suportar 1s, 5s, 1m, 5m.
- [x] Registrar resolution no manifest.
- [x] Cascatear stale de scalars para ohlc.
- [x] Testes de writer/query.

### Fase L5: Query Layer — parcial

- [x] Implementar availability.
- [x] Implementar strict/prepare.
- [x] Implementar query ticks/candles via DuckDB.
- [x] Adicionar limit/offset.
- [x] Bloquear unavailable.
- [x] Testes de disponibilidade e DuckDB.
- [ ] Implementar `PostgresTickProvider` e `HybridTickProvider`.
- [ ] Implementar `streamEvents`.

### Fase L6: Prepare Jobs E API — concluida

- [x] Criar API HTTP.
- [x] Criar static UI.
- [x] Criar prepare jobs.
- [x] Criar runner serial.
- [x] Criar executor.
- [x] Criar rebuild confirmado.
- [x] Testes de API/jobs.

### Fase L7: Backtest Basico Nativo — concluida

Esta fase valida que o lakehouse alimenta um backtest real. Ela nao torna `edge-sniper-v2` parte do lakehouse core.

- [x] Criar `DuckDbTickProvider`.
- [x] Criar runner nativo `edge-sniper-v2` como golden test transitorio do Backtest Studio.
- [x] Criar `POST /api/backtest/run`.
- [x] Persistir `backtest_runs`.
- [x] Testes de backtest.

### Fase L8: Operacao — parcial

- [x] Documentar backfill.
- [ ] Validar ambiente temporario.
- [ ] Validar Coolify volumes.
- [ ] Configurar healthcheck.
- [ ] Configurar backup `/lake` + `/state`.

## Testes Obrigatorios

### Unitarios

- config;
- paths;
- manifest;
- fingerprint;
- book flatten;
- data modes;
- availability;
- prepare runner;
- archive API skip/publish;
- strategy native smoke.

### Integracao Local Com Arquivos

- escrever scalars Parquet;
- escrever books Parquet;
- escrever backtest_ticks Parquet;
- escrever OHLC Parquet;
- consultar via DuckDB usando manifest.

### Integracao Com Postgres Local

- sync dry-run;
- sync real pequeno;
- availability depois do sync;
- backtest pequeno.

### API

- health;
- static UI;
- availability;
- prepare;
- prepare job dry-run;
- rebuild bloqueado sem confirmacao;
- backtest bloqueado sem dados;
- backtest executado com dados.

## Criterios De Aceite Do Lakehouse

- `npm test` passa.
- `npm run health` passa.
- `storage:check` cria/verifica layout.
- `query:availability` identifica missing e valid corretamente.
- sync real pequeno gera Parquet e manifest valid.
- DuckDB le somente `active_path` do manifest.
- prepare job dry-run nao escreve Parquet.
- prepare job real escreve Parquet em lake configurado.
- rebuild real exige confirmacao.
- archive publish e pulado quando env ausente.
- archive publish funciona quando env configurada.
- backtest nativo roda sobre `backtest_ticks` valid.
- Postgres nao e apagado por nenhum fluxo padrao.

## Checklist De Revisao Antes De Entrar Na UI Avancada

- [x] Lakehouse tem docs de arquitetura.
- [x] Lakehouse tem runbook operacional.
- [x] Archive/retencao opcional esta documentado.
- [x] Retencao real esta claramente fora do caminho padrao.
- [x] Prepare jobs estao validados.
- [x] Backtest run basico esta persistido.
- [x] API bloqueia backtest sem dados validos.
- [x] Datasets principais estao definidos.
- [x] Manifest e fonte unica de paths.
- [x] Backup/restore esta documentado.
